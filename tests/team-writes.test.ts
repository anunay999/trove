import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createGraphStore } from "../src/createStore.js";
import { UserStore } from "../src/users.js";
import type { GraphStore } from "../src/graphCore.js";
import { TeamSpaceError, contextForSpace, ingest, looksLikeCredential, remember } from "../src/agentOps.js";
import type { RememberInput } from "../src/contracts.js";
import { closeStore, isolateDatabase } from "./helpers.js";

await isolateDatabase("team-writes");
const databaseUrl = process.env.DATABASE_URL;

describe("credential check on team writes", () => {
  const blocked = [
    // Shapes seen in real notes; every value here is fake.
    "postgresql://readonly.abc123:Zx81QWERtyuiop12AsdfGhjk@db.example.com:6432/app",
    "| password | `Zx81QWERtyuiop12AsdfGhjk` |",
    'APP_ENCRYPTION_KEY_B64="Qm9ndXNLZXlGb3JUZXN0c09ubHkxMjM0NTY3ODkwYWI="',
    "export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234567890",
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "AKIAABCDEFGHIJKLMNOP",
  ];
  const allowed = [
    "postgresql://postgres:postgres@localhost:5432/main_o200",
    "docker exec -e PGPASSWORD=postgres space-db psql -U postgres",
    "remote_user='directory_user', remote_password='<password>'",
    "Rotate the API key monthly; the token budget is 8000.",
    "postgres://user:${DB_PASSWORD}@db.internal/app",
    "tokenBudget: 8000, maxSemanticDistance: 0.5",
  ];
  for (const text of blocked) it(`blocks ${text.slice(0, 40)}`, () => assert.equal(looksLikeCredential(text), true));
  for (const text of allowed) it(`allows ${text.slice(0, 40)}`, () => assert.equal(looksLikeCredential(text), false));
});

describe("choosing the space for a write", () => {
  const base = { actorId: "a", interfaceId: "t", requestId: "r", ownerId: "private-1" };
  const inTeam = { ...base, sharedOwnerIds: ["team-1"] };

  it("defaults to the team when one is active", () => {
    assert.equal(contextForSpace(undefined, inTeam, "fact")?.ownerId, "team-1");
  });
  it("defaults to the private space without a team", () => {
    assert.equal(contextForSpace(undefined, base, "fact")?.ownerId, "private-1");
  });
  it("keeps team reads on a private write", () => {
    const context = contextForSpace("mine", inTeam, "fact");
    assert.equal(context?.ownerId, "private-1");
    assert.deepEqual(context?.sharedOwnerIds, ["team-1"]);
  });
  it("refuses an explicit team write with no team", () => {
    assert.throws(() => contextForSpace("team", base, "fact"), (error: unknown) => error instanceof TeamSpaceError && error.code === "no_team");
  });
  it("refuses a credential on the way into the team, but not into the private space", () => {
    const secret = "password = Zx81QWERtyuiop12AsdfGhjk";
    assert.throws(() => contextForSpace(undefined, inTeam, secret), (error: unknown) => error instanceof TeamSpaceError && error.code === "credential_in_team_write");
    assert.equal(contextForSpace("mine", inTeam, secret)?.ownerId, "private-1");
  });
});

describe("team writes through remember and ingest", { skip: databaseUrl ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const MARK = `TEAMWRITE${stamp}`;
  let store: GraphStore;
  let users: UserStore;
  let pool: pg.Pool;
  let alice: { actorId: string; interfaceId: string; requestId: string; ownerId: string; sharedOwnerIds: string[] };
  let bob: typeof alice;
  let teamId: string;

  before(async () => {
    store = createGraphStore().store;
    users = new UserStore({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl! });
    const org = { clerkOrgId: `org_tw_${stamp}`, name: "tw", role: "member" as const };
    const aliceId = (await users.ensureUser({ clerkUserId: `tw-alice-${stamp}` })).id;
    const bobId = (await users.ensureUser({ clerkUserId: `tw-bob-${stamp}` })).id;
    await users.joinOrg(aliceId, org);
    await users.joinOrg(bobId, org);
    const a = await users.spacesFor(aliceId);
    const b = await users.spacesFor(bobId);
    teamId = a.sharedOwnerIds[0]!;
    alice = { actorId: "tw-alice", interfaceId: "t", requestId: `a-${stamp}`, ownerId: a.ownerId, sharedOwnerIds: a.sharedOwnerIds };
    bob = { actorId: "tw-bob", interfaceId: "t", requestId: `b-${stamp}`, ownerId: b.ownerId, sharedOwnerIds: b.sharedOwnerIds };
  });

  after(async () => {
    if (pool) await pool.end();
    if (users) await users.close();
    if (store) await closeStore(store);
  });

  const ownerOf = async (nodeId: string) => String((await pool.query("select owner_id from node where id = $1", [nodeId])).rows[0].owner_id);

  it("a default write lands in the team, and a teammate recalls it", async () => {
    const result = await remember(store, { title: `Webhook retries ${MARK}`, summary: `Stripe retries carry the same event id ${MARK}.` } as RememberInput, alice);
    assert.equal(await ownerOf(result.node.id), teamId);
    const recall = await store.recall({ query: `stripe retries event id ${MARK}`, tokenBudget: 2000 }, bob);
    assert.ok(recall.atoms.some((atom) => atom.node.id === result.node.id), "teammate did not recall the team note");
  });

  it("a teammate's remember with the same title revises the team note", async () => {
    const title = `Deploy freeze ${MARK}`;
    const first = await remember(store, { title, summary: "No deploys after Friday noon." } as RememberInput, alice);
    const second = await remember(store, { title, summary: "No deploys after Friday 2pm." } as RememberInput, bob);
    assert.equal(second.node.id, first.node.id, "a teammate made a second team note instead of revising");
  });

  it("space mine keeps the note private", async () => {
    const result = await remember(store, { title: `My editor setup ${MARK}`, summary: "I use vim keys.", space: "mine" } as RememberInput, alice);
    assert.equal(await ownerOf(result.node.id), alice.ownerId);
    const recall = await store.recall({ query: `editor setup vim ${MARK}`, tokenBudget: 2000 }, bob);
    assert.ok(!recall.atoms.some((atom) => atom.node.id === result.node.id), "a private note reached a teammate");
  });

  it("a credential never reaches the team, through remember or ingest", async () => {
    const secret = `connect with postgresql://ro.user:Zx81QWERtyuiop12AsdfGhjk@db.example.com:6432/app ${MARK}`;
    await assert.rejects(remember(store, { title: `Prod DB ${MARK}`, summary: secret } as RememberInput, alice), TeamSpaceError);
    await assert.rejects(ingest(store, { kind: "paste", title: `Creds ${MARK}`, contentText: secret, metadata: {} }, alice), TeamSpaceError);
    const leaked = await pool.query("select count(*)::int as n from node where owner_id = $1 and title like $2", [teamId, `Prod DB ${MARK}%`]);
    assert.equal(leaked.rows[0].n, 0);
  });
});
