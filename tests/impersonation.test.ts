import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthError, IMPERSONATE_HEADER, applyImpersonation, type AuthContext, type AuthIdentity } from "../src/auth.js";

const admin: AuthIdentity = {
  userId: "admin-uuid",
  clerkUserId: "user_admin",
  email: "admin@example.com",
  role: "admin",
  status: "active",
};

const member: AuthIdentity = {
  userId: "member-uuid",
  clerkUserId: "user_member",
  email: "member@example.com",
  role: "member",
  status: "active",
};

const suspendedMember: AuthIdentity = {
  userId: "frozen-uuid",
  clerkUserId: "user_frozen",
  email: "frozen@example.com",
  role: "member",
  status: "suspended",
};

const directory = new Map<string, AuthIdentity>([
  [admin.clerkUserId, admin],
  [member.clerkUserId, member],
  [suspendedMember.clerkUserId, suspendedMember],
]);

const lookup = async (clerkUserId: string) => directory.get(clerkUserId) ?? null;

function contextFor(identity: AuthIdentity | undefined, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    actorId: identity?.clerkUserId ?? "local-dev",
    scopes: ["graph:admin"],
    mode: identity ? "clerk" : "disabled",
    interfaceId: "http",
    requestId: "req-1",
    ...(identity ? { identity, ownerId: identity.userId } : {}),
    ...extra,
  };
}

const headersFor = (target?: string) => new Headers(target ? { [IMPERSONATE_HEADER]: target } : {});

describe("admin view-as (impersonation)", () => {
  it("is a no-op without the header", async () => {
    const context = contextFor(admin);
    const result = await applyImpersonation(context, headersFor(), lookup);
    assert.equal(result, context);
    assert.equal(result.impersonating, undefined);
  });

  it("points an admin at the target's graph without changing who they are", async () => {
    const result = await applyImpersonation(contextFor(admin), headersFor(member.clerkUserId), lookup);
    assert.equal(result.ownerId, member.userId, "reads/writes must be scoped to the impersonated user");
    assert.deepEqual(result.impersonating, member);
    assert.deepEqual(result.identity, admin, "the real admin stays the identity, so admin routes keep working");
    assert.equal(result.actorId, admin.clerkUserId, "the audit trail must name the human who acted");
  });

  it("refuses members", async () => {
    await assert.rejects(
      applyImpersonation(
        contextFor(member, { scopes: ["graph:read", "graph:write", "graph:export"] }),
        headersFor(admin.clerkUserId),
        lookup,
      ),
      (error: unknown) =>
        error instanceof AuthError && error.status === 403 && error.code === "insufficient_scope",
    );
  });

  it("refuses admins whose access was revoked", async () => {
    const suspended: AuthIdentity = { ...admin, status: "suspended" };
    await assert.rejects(
      applyImpersonation(
        // Suspension zeroes the scopes, so nothing is left to authorize with.
        contextFor(suspended, { scopes: [] }),
        headersFor(member.clerkUserId),
        lookup,
      ),
      (error: unknown) => error instanceof AuthError && error.status === 403,
    );
  });

  it("lets an env service token (graph:admin, no identity) act as a user", async () => {
    const serviceToken: AuthContext = {
      actorId: "agent",
      scopes: ["graph:admin"],
      mode: "token",
      interfaceId: "http",
      requestId: "req-2",
      ownerId: admin.userId,
    };
    const result = await applyImpersonation(serviceToken, headersFor(member.clerkUserId), lookup);
    assert.equal(result.ownerId, member.userId);
  });

  it("refuses to thaw a frozen account", async () => {
    // The target's own scopes are zeroed when suspended; borrowing the admin's
    // would make a deliberately frozen graph writable again.
    await assert.rejects(
      applyImpersonation(contextFor(admin), headersFor(suspendedMember.clerkUserId), lookup),
      (error: unknown) => error instanceof AuthError && error.code === "inactive_user",
    );
  });

  it("never lets impersonation reach someone else's credentials", async () => {
    // /v1/keys reads `identity`, not `impersonating` — API keys outlive the
    // "view as" session, so they must stay the caller's own.
    const result = await applyImpersonation(contextFor(admin), headersFor(member.clerkUserId), lookup);
    assert.deepEqual(result.identity, admin);
    assert.notEqual(result.identity?.userId, member.userId);
  });

  it("rejects an unknown target instead of silently staying yourself", async () => {
    await assert.rejects(
      applyImpersonation(contextFor(admin), headersFor("user_ghost"), lookup),
      (error: unknown) => error instanceof AuthError && error.code === "unknown_user",
    );
  });

  it("treats impersonating yourself as being yourself", async () => {
    const context = contextFor(admin);
    const result = await applyImpersonation(context, headersFor(admin.clerkUserId), lookup);
    assert.equal(result, context);
  });

  it("lets the local-dev superuser narrow into one user's graph", async () => {
    const result = await applyImpersonation(
      contextFor(undefined, { superuser: true }),
      headersFor(member.clerkUserId),
      lookup,
    );
    assert.equal(result.ownerId, member.userId);
    assert.equal(result.superuser, false, "see-all must drop, or scoping would be a no-op");
  });
});
