import { UserStore, generateApiKey } from "../src/users.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the user-keys suite.");
}

const users = new UserStore({ connectionString: databaseUrl });
const stamp = Date.now();
const clerkId = `user_smoke_${stamp}`;

try {
  // 1. First sight of a Clerk user creates a waitlisted member.
  const created = await users.ensureUser({ clerkUserId: clerkId, email: `smoke-${stamp}@example.com` });
  if (created.status !== "waitlisted" || created.role !== "member") {
    throw new Error(`Expected waitlisted member, got ${created.status}/${created.role}.`);
  }

  // 2. Admin emails become active admins on sight.
  const adminClerkId = `user_smoke_admin_${stamp}`;
  const admin = await users.ensureUser(
    { clerkUserId: adminClerkId, email: `admin-${stamp}@example.com` },
    { adminEmails: [`admin-${stamp}@example.com`] },
  );
  if (admin.role !== "admin" || admin.status !== "active") {
    throw new Error(`Expected active admin, got ${admin.status}/${admin.role}.`);
  }

  // 3. ensureUser is idempotent and does not demote.
  const again = await users.ensureUser({ clerkUserId: adminClerkId, email: `admin-${stamp}@example.com` });
  if (again.role !== "admin" || again.status !== "active") {
    throw new Error("ensureUser demoted an existing admin.");
  }

  // 4. Waitlisted users cannot create keys; approval unlocks it.
  let refused = false;
  try {
    await users.createApiKey(created.id, { name: "nope", scopes: ["graph:read"] });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("Waitlisted user was allowed to create an API key.");

  const approved = await users.approveUser(created.clerkUserId, admin.id);
  if (approved?.status !== "active" || !approved.approvedAt) {
    throw new Error("Approval did not activate the user.");
  }

  // 5. Key create returns the secret exactly once; lookup resolves scopes.
  const issued = await users.createApiKey(created.id, { name: "laptop", scopes: ["graph:read", "graph:write"] });
  if (!issued.secret.startsWith("trove_")) throw new Error(`Unexpected key format: ${issued.secret}`);
  const resolved = await users.resolveApiKey(issued.secret);
  if (!resolved || resolved.userId !== created.id || !resolved.scopes.includes("graph:write")) {
    throw new Error("Issued key did not resolve to its owner and scopes.");
  }
  if (resolved.actorId !== created.clerkUserId) {
    throw new Error("Resolved key should carry the owner clerk id as actor.");
  }

  // 6. Listing returns the retrievable secret to the owner (copy-later UX),
  //    but never the hash.
  const listed = await users.listApiKeys(created.id);
  const entry = listed.find((key) => key.id === issued.id);
  if (!entry || entry.name !== "laptop" || !entry.keyPrefix) throw new Error("Key missing from listing.");
  if (entry.secret !== issued.secret) throw new Error("Listing should return the retrievable secret.");
  if ("keyHash" in entry || "key_hash" in entry) throw new Error("Listing leaked the key hash.");

  // 7. Revocation kills resolution immediately.
  await users.revokeApiKey(created.id, issued.id);
  if (await users.resolveApiKey(issued.secret)) {
    throw new Error("Revoked key still resolves.");
  }

  // 8. Garbage keys resolve to null, not errors.
  if (await users.resolveApiKey("trove_not_a_real_key")) {
    throw new Error("Garbage key resolved.");
  }
  const { secret: rawShape } = generateApiKey();
  if (!/^trove_[a-f0-9]{40}$/.test(rawShape)) {
    throw new Error(`Unexpected generated key shape: ${rawShape}`);
  }

  // 9. Admin user listing includes both smoke users.
  const roster = await users.listUsers();
  const ids = new Set(roster.map((u) => u.clerkUserId));
  if (!ids.has(clerkId) || !ids.has(adminClerkId)) throw new Error("listUsers missed smoke users.");

  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  await users.cleanupSmoke("user_smoke_");
  await users.close();
}
