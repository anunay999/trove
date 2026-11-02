import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  IMPERSONATE_HEADER,
  applyImpersonation,
  operationContextFromAuth,
  requireAuthFromHeaders,
  type AuthIdentity,
} from "../src/auth.js";
import { activeOrgFromClaims } from "../src/clerkAuth.js";
import { UserStore } from "../src/users.js";
import { isolateDatabase } from "./helpers.js";

await isolateDatabase("tenants");
const databaseUrl = process.env.DATABASE_URL;

describe("active organization from a Clerk session token", () => {
  it("reads the v2 `o` claim", () => {
    assert.deepEqual(activeOrgFromClaims({ v: 2, o: { id: "org_1", slg: "acme", rol: "admin" } }), {
      clerkOrgId: "org_1",
      slug: "acme",
      role: "admin",
    });
  });

  it("reads the v1 org_* claims", () => {
    assert.deepEqual(activeOrgFromClaims({ org_id: "org_2", org_slug: "beta", org_role: "org:member" }), {
      clerkOrgId: "org_2",
      slug: "beta",
      role: "member",
    });
  });

  it("maps org:admin to admin and anything else to member", () => {
    assert.equal(activeOrgFromClaims({ org_id: "org_3", org_role: "org:admin" })?.role, "admin");
    assert.equal(activeOrgFromClaims({ v: 2, o: { id: "org_3", rol: "billing" } })?.role, "member");
  });

  it("is null on a personal session", () => {
    assert.equal(activeOrgFromClaims({ sub: "user_1" }), null);
    assert.equal(activeOrgFromClaims({ v: 2 }), null);
  });
});

describe("credentials act in the caller's spaces", () => {
  const identity: AuthIdentity = {
    userId: "user-uuid",
    clerkUserId: "user_1",
    email: null,
    role: "member",
    status: "active",
  };
  const spaces = { tenantId: "tenant-uuid", ownerId: "private-uuid", sharedOwnerIds: ["shared-uuid"] };
  let savedTokens: string | undefined;

  before(() => {
    savedTokens = process.env.TROVE_SERVICE_TOKENS;
    process.env.TROVE_SERVICE_TOKENS = "svc-token|svc|graph:read";
  });
  after(() => {
    if (savedTokens === undefined) delete process.env.TROVE_SERVICE_TOKENS;
    else process.env.TROVE_SERVICE_TOKENS = savedTokens;
  });

  it("owns writes in the private space and reads the shared one", async () => {
    const context = await requireAuthFromHeaders(
      new Headers({ authorization: "Bearer aaa.bbb.ccc" }),
      ["graph:read"],
      "http",
      { resolveClerkToken: async () => ({ actorId: "user_1", scopes: ["graph:read"], identity, spaces }) },
    );
    assert.equal(context.ownerId, "private-uuid");
    assert.deepEqual(context.sharedOwnerIds, ["shared-uuid"]);
    assert.equal(context.tenantId, "tenant-uuid");
    assert.deepEqual(operationContextFromAuth(context).sharedOwnerIds, ["shared-uuid"]);
  });

  it("gives API keys the same spaces", async () => {
    const context = await requireAuthFromHeaders(
      new Headers({ authorization: "Bearer trove_abc" }),
      ["graph:read"],
      "http",
      { resolveApiKey: async () => ({ actorId: "user_1", scopes: ["graph:read"], ownerId: "user-uuid", spaces }) },
    );
    assert.equal(context.ownerId, "private-uuid");
    assert.deepEqual(context.sharedOwnerIds, ["shared-uuid"]);
  });

  it("drops the admin's shared spaces while viewing as someone else", async () => {
    const admin: AuthIdentity = { ...identity, role: "admin", clerkUserId: "user_admin" };
    const member: AuthIdentity = { ...identity, userId: "member-uuid", clerkUserId: "user_member" };
    const viewed = await applyImpersonation(
      {
        actorId: "user_admin",
        scopes: ["graph:admin"],
        mode: "clerk",
        interfaceId: "http",
        requestId: "r",
        identity: admin,
        ownerId: "admin-private",
        sharedOwnerIds: ["admin-team-shared"],
        tenantId: "admin-team",
      },
      new Headers({ [IMPERSONATE_HEADER]: "user_member" }),
      async () => member,
    );
    assert.equal(viewed.ownerId, "member-uuid");
    assert.equal(viewed.sharedOwnerIds, undefined);
    assert.equal(viewed.tenantId, undefined);
  });
});

describe("teams from Clerk organizations", { skip: databaseUrl ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  let users: UserStore;
  let pool: pg.Pool;
  let aliceId: string;
  let bobId: string;

  before(async () => {
    users = new UserStore({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl! });
    aliceId = (await users.ensureUser({ clerkUserId: `tn-alice-${stamp}` })).id;
    bobId = (await users.ensureUser({ clerkUserId: `tn-bob-${stamp}` })).id;
  });

  after(async () => {
    if (pool) await pool.end();
    if (users) await users.close();
  });

  it("starts everyone in their personal space with nothing shared", async () => {
    const spaces = await users.spacesFor(aliceId);
    assert.equal(spaces.ownerId, aliceId);
    assert.deepEqual(spaces.sharedOwnerIds, []);
    assert.equal(spaces.clerkOrgId, null);
  });

  it("joining an org gives a private space there and the team's shared space", async () => {
    const org = { clerkOrgId: `org_acme_${stamp}`, name: "acme", role: "admin" as const };
    await users.joinOrg(aliceId, org);
    await users.joinOrg(bobId, { ...org, role: "member" });

    const alice = await users.spacesFor(aliceId);
    const bob = await users.spacesFor(bobId);
    assert.equal(alice.clerkOrgId, org.clerkOrgId);
    assert.notEqual(alice.ownerId, aliceId, "team work landed in the personal space");
    assert.notEqual(alice.ownerId, bob.ownerId, "two members share a private space");
    assert.equal(alice.sharedOwnerIds.length, 1);
    assert.deepEqual(alice.sharedOwnerIds, bob.sharedOwnerIds, "members see different team spaces");

    const roles = await pool.query(
      `select m.user_id, m.role from tenant_member m join tenant t on t.id = m.tenant_id where t.clerk_org_id = $1`,
      [org.clerkOrgId],
    );
    const roleOf = new Map(roles.rows.map((r) => [String(r.user_id), r.role]));
    assert.equal(roleOf.get(aliceId), "admin");
    assert.equal(roleOf.get(bobId), "member");
  });

  it("joining again is a no-op that keeps the same spaces and follows a role change", async () => {
    const org = { clerkOrgId: `org_acme_${stamp}`, name: "acme", role: "member" as const };
    const before = await users.spacesFor(aliceId);
    await users.joinOrg(aliceId, org);
    const after = await users.spacesFor(aliceId);
    assert.deepEqual(after, before);
    const role = await pool.query(
      `select m.role from tenant_member m join tenant t on t.id = m.tenant_id where t.clerk_org_id = $1 and m.user_id = $2`,
      [org.clerkOrgId, aliceId],
    );
    assert.equal(role.rows[0].role, "member");
  });

  it("switching back to personal restores the personal space", async () => {
    await users.usePersonalSpace(bobId);
    const bob = await users.spacesFor(bobId);
    assert.equal(bob.ownerId, bobId);
    assert.deepEqual(bob.sharedOwnerIds, []);
  });

  it("a membership row deleted elsewhere stops the team spaces even while the tenant is still active", async () => {
    const org = { clerkOrgId: `org_side_${stamp}`, name: "side", role: "member" as const };
    await users.joinOrg(bobId, org);
    await pool.query(
      `delete from tenant_member m using tenant t where m.tenant_id = t.id and t.clerk_org_id = $1 and m.user_id = $2`,
      [org.clerkOrgId, bobId],
    );
    const bob = await users.spacesFor(bobId);
    assert.equal(bob.ownerId, bobId);
    assert.deepEqual(bob.sharedOwnerIds, []);
  });

  it("a removed member falls back to personal and loses the team's spaces", async () => {
    const orgId = `org_acme_${stamp}`;
    await users.removeMembership(aliceId, orgId);
    const alice = await users.spacesFor(aliceId);
    assert.equal(alice.ownerId, aliceId);
    assert.deepEqual(alice.sharedOwnerIds, []);
    const frozen = await pool.query(
      `select s.id from space s join tenant t on t.id = s.tenant_id
       where t.clerk_org_id = $1 and s.kind = 'private' and s.user_id = $2`,
      [orgId, aliceId],
    );
    assert.equal(frozen.rowCount, 1, "a leaver's private space should stay with the team");
  });
});
