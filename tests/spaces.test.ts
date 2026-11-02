import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createGraphStore } from "../src/createStore.js";
import { UserStore } from "../src/users.js";
import type { GraphStore } from "../src/graphCore.js";
import { remember } from "../src/agentOps.js";
import type { RememberInput } from "../src/contracts.js";
import { closeStore, isolateDatabase } from "./helpers.js";

await isolateDatabase("spaces");
const databaseUrl = process.env.DATABASE_URL;

const GRAPH_OWNER_TABLES = [
  "annotation", "edge", "graph_event", "graph_job", "graph_view",
  "node", "reconcile_flag", "source", "text_chunk", "text_unit",
];

describe("tenants and spaces", { skip: databaseUrl ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const MARK = `SPACEMARK${stamp}`;
  const ctx = (ownerId: string, tag: string, sharedOwnerIds?: string[]) => ({
    actorId: `${tag}-smoke`,
    interfaceId: `${tag}-smoke`,
    requestId: `${tag}-${stamp}`,
    ownerId,
    ...(sharedOwnerIds ? { sharedOwnerIds } : {}),
  });

  let store: GraphStore;
  let users: UserStore;
  let pool: pg.Pool;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let workspaceId: string;

  before(async () => {
    store = createGraphStore().store;
    users = new UserStore({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl! });
    aliceId = (await users.ensureUser({ clerkUserId: `sp-alice-${stamp}` })).id;
    bobId = (await users.ensureUser({ clerkUserId: `sp-bob-${stamp}` })).id;
    carolId = (await users.ensureUser({ clerkUserId: `sp-carol-${stamp}` })).id;
    const tenant = await pool.query(`insert into tenant (name) values ($1) returning id`, [`Acme ${stamp}`]);
    const shared = await pool.query(
      `insert into space (tenant_id, kind) values ($1, 'shared') returning id`,
      [tenant.rows[0].id],
    );
    workspaceId = String(shared.rows[0].id);
  });

  after(async () => {
    if (pool) await pool.end();
    if (users) await users.close();
    if (store) await closeStore(store);
  });

  it("gives every new user a personal tenant and a private space that reuses their id", async () => {
    const space = await pool.query(`select kind, user_id, tenant_id from space where id = $1`, [aliceId]);
    assert.equal(space.rowCount, 1, "no private space with the user's id");
    assert.equal(space.rows[0].kind, "private");
    assert.equal(String(space.rows[0].user_id), aliceId);
    const tenant = await pool.query(`select personal_user_id from tenant where id = $1`, [space.rows[0].tenant_id]);
    assert.equal(String(tenant.rows[0].personal_user_id), aliceId);
    const member = await pool.query(
      `select role from tenant_member where tenant_id = $1 and user_id = $2`,
      [space.rows[0].tenant_id, aliceId],
    );
    assert.equal(member.rows[0]?.role, "admin");
  });

  it("points every graph owner column at space, not app_user", async () => {
    const fks = await pool.query(
      `select conrelid::regclass::text as tbl, confrelid::regclass::text as target
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.contype = 'f' and a.attname = 'owner_id' and conrelid::regclass::text = any($1)`,
      [GRAPH_OWNER_TABLES],
    );
    const byTable = new Map(fks.rows.map((r) => [r.tbl as string, r.target as string]));
    for (const table of GRAPH_OWNER_TABLES) assert.equal(byTable.get(table), "space", `${table}.owner_id`);
  });

  it("lets a context read a shared space while its writes stay in its own", async () => {
    const shared = await store.capture({
      title: `Team fact ${MARK}`,
      type: "claim",
      summary: `Shared knowledge ${MARK}: retries carry the same event id.`,
      evidence: [],
      links: [],
    }, ctx(workspaceId, "ws"));

    const alice = ctx(aliceId, "sp-alice", [workspaceId]);
    const recall = await store.recall({ query: `retries event id ${MARK}`, tokenBudget: 2000 }, alice);
    assert.ok(recall.atoms.some((a) => a.node.id === shared.id), "member recall missed the shared node");
    assert.ok(await store.read({ slug: shared.slug }, alice), "member read missed the shared node");
    const grep = await store.grep({ pattern: MARK, scope: "nodes", caseSensitive: false, limit: 50 }, alice);
    assert.ok(grep.matches.some((m) => m.nodeId === shared.id), "member grep missed the shared node");

    const bob = ctx(bobId, "sp-bob");
    assert.equal(await store.read({ nodeId: shared.id }, bob), null, "a non-member read the shared node");
    const bobRecall = await store.recall({ query: `retries event id ${MARK}`, tokenBudget: 2000 }, bob);
    assert.ok(!bobRecall.atoms.some((a) => a.node.id === shared.id), "a non-member recalled the shared node");

    const own = await store.capture({ title: `Alice note ${MARK}`, type: "claim", summary: "mine", evidence: [], links: [] }, alice);
    const owner = await pool.query(`select owner_id from node where id = $1`, [own.id]);
    assert.equal(String(owner.rows[0].owner_id), aliceId, "a member's write landed outside their own space");
  });

  it("does not let a reader of a shared space change it", async () => {
    const shared = await store.capture({ title: `Locked ${MARK}`, type: "claim", summary: "team", evidence: [], links: [] }, ctx(workspaceId, "ws"));
    const alice = ctx(aliceId, "sp-alice", [workspaceId]);
    const baseRevisionId = shared.revisionId;
    await Promise.resolve(store.update({ nodeId: shared.id, baseRevisionId, summary: "rewritten by a reader" }, alice)).catch(() => null);
    const after = await store.read({ nodeId: shared.id }, ctx(workspaceId, "ws"));
    assert.equal(after?.summary, "team", "a shared-space reader rewrote the shared node");
  });

  it("makes a private remember with a shared node's title create the member's own note, not revise the shared one", async () => {
    const title = `Retry policy ${MARK}`;
    const shared = await store.capture({ title, type: "decision", summary: "team says 3 retries", evidence: [], links: [] }, ctx(workspaceId, "ws"));
    const alice = ctx(aliceId, "sp-alice", [workspaceId]);
    const result = await remember(store, { title, summary: "alice says 5 retries", type: "decision", space: "mine" } as RememberInput, alice);
    assert.notEqual(result.node.id, shared.id, "remember revised the shared node");
    const after = await store.read({ nodeId: shared.id }, ctx(workspaceId, "ws"));
    assert.equal(after?.summary, "team says 3 retries");
    const bySlug = await store.read({ slug: shared.slug }, alice);
    assert.equal(bySlug?.id, result.node.id, "a slug in both spaces did not resolve to the member's own node");
  });

  it("refuses a private remember aimed at a shared node by id", async () => {
    const shared = await store.capture({ title: `Owned elsewhere ${MARK}`, type: "claim", summary: "team copy", evidence: [], links: [] }, ctx(workspaceId, "ws"));
    const alice = ctx(aliceId, "sp-alice", [workspaceId]);
    await assert.rejects(
      remember(store, { nodeId: shared.id, title: shared.title, summary: "member rewrite", space: "mine" } as RememberInput, alice),
      /no node with id/,
    );
    const after = await store.read({ nodeId: shared.id }, ctx(workspaceId, "ws"));
    assert.equal(after?.summary, "team copy");
  });

  it("keeps a member's private link to a shared node out of other members' view", async () => {
    const shared = await store.capture({ title: `Hub ${MARK}`, type: "project", summary: "hub", evidence: [], links: [] }, ctx(workspaceId, "ws"));
    const alice = ctx(aliceId, "sp-alice", [workspaceId]);
    const mine = await store.capture({ title: `Private ${MARK}`, type: "claim", summary: "secret", evidence: [], links: [] }, alice);
    const edge = await store.link({ fromNodeId: mine.id, toNodeId: shared.id, predicate: "relates_to", weight: 1 }, alice);
    assert.ok(edge, "a member could not link their note to a shared node");

    const carol = ctx(carolId, "sp-carol", [workspaceId]);
    const hood = await store.neighborhood({ nodeId: shared.id, depth: 1, includeExpired: true }, carol);
    assert.ok(!hood.nodes.some((n) => n.id === mine.id), "another member saw Alice's private node");
    assert.ok(!hood.edges.some((e) => e.id === edge.id), "another member saw Alice's private link");
  });
});
