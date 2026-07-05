import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { UserStore, generateApiKey } from "../src/users.js";

const databaseUrl = process.env.DATABASE_URL;

// The user/API-key model lives only in Postgres (the in-memory store is
// single-user by construction), so this suite is skipped without a database.
describe("user & api keys", { skip: databaseUrl ? false : "requires DATABASE_URL" }, () => {
  const stamp = Date.now();
  const clerkId = `user_smoke_${stamp}`;
  const adminClerkId = `user_smoke_admin_${stamp}`;
  let users: UserStore;

  before(() => {
    users = new UserStore({ connectionString: databaseUrl! });
  });

  after(async () => {
    if (users) {
      await users.cleanupSmoke("user_smoke_");
      await users.close();
    }
  });

  it("first sight of a Clerk user creates a waitlisted member", async () => {
    const created = await users.ensureUser({ clerkUserId: clerkId, email: `smoke-${stamp}@example.com` });
    assert.equal(created.status, "waitlisted");
    assert.equal(created.role, "member");
  });

  it("admin emails become active admins on sight, idempotently", async () => {
    const admin = await users.ensureUser(
      { clerkUserId: adminClerkId, email: `admin-${stamp}@example.com` },
      { adminEmails: [`admin-${stamp}@example.com`] },
    );
    assert.equal(admin.role, "admin");
    assert.equal(admin.status, "active");

    const again = await users.ensureUser({ clerkUserId: adminClerkId, email: `admin-${stamp}@example.com` });
    assert.equal(again.role, "admin", "ensureUser must not demote an existing admin");
    assert.equal(again.status, "active");
  });

  it("waitlisted users cannot create keys until approved", async () => {
    const created = await users.ensureUser({ clerkUserId: clerkId, email: `smoke-${stamp}@example.com` });
    await assert.rejects(
      users.createApiKey(created.id, { name: "nope", scopes: ["graph:read"] }),
      "waitlisted user was allowed to create an API key",
    );

    const admin = await users.ensureUser({ clerkUserId: adminClerkId, email: `admin-${stamp}@example.com` });
    const approved = await users.approveUser(created.clerkUserId, admin.id);
    assert.equal(approved?.status, "active", "approval did not activate the user");
    assert.ok(approved?.approvedAt, "approval must stamp approvedAt");
  });

  it("issues a resolvable, retrievable, revocable key", async () => {
    const created = await users.ensureUser({ clerkUserId: clerkId, email: `smoke-${stamp}@example.com` });
    const issued = await users.createApiKey(created.id, { name: "laptop", scopes: ["graph:read", "graph:write"] });
    assert.ok(issued.secret.startsWith("trove_"), `unexpected key format: ${issued.secret}`);

    const resolved = await users.resolveApiKey(issued.secret);
    assert.ok(resolved && resolved.userId === created.id, "issued key did not resolve to its owner");
    assert.ok(resolved.scopes.includes("graph:write"), "resolved key missing scope");
    assert.equal(resolved.actorId, created.clerkUserId, "resolved key should carry the owner clerk id as actor");

    // Listing returns the retrievable secret to the owner but never the hash.
    const listed = await users.listApiKeys(created.id);
    const entry = listed.find((key) => key.id === issued.id);
    assert.ok(entry && entry.name === "laptop" && entry.keyPrefix, "key missing from listing");
    assert.equal(entry.secret, issued.secret, "listing should return the retrievable secret");
    assert.ok(!("keyHash" in entry) && !("key_hash" in entry), "listing leaked the key hash");

    // Revocation kills resolution immediately.
    await users.revokeApiKey(created.id, issued.id);
    assert.equal(await users.resolveApiKey(issued.secret), null, "revoked key still resolves");
  });

  it("resolves garbage keys to null and generates well-shaped secrets", async () => {
    assert.equal(await users.resolveApiKey("trove_not_a_real_key"), null, "garbage key resolved");
    const { secret } = generateApiKey();
    assert.match(secret, /^trove_[a-f0-9]{40}$/, `unexpected generated key shape: ${secret}`);
  });

  it("admin user listing includes the smoke users", async () => {
    const roster = await users.listUsers();
    const ids = new Set(roster.map((u) => u.clerkUserId));
    assert.ok(ids.has(clerkId) && ids.has(adminClerkId), "listUsers missed smoke users");
  });
});
