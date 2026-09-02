import { createClerkClient, verifyToken } from "@clerk/backend";
import type { AuthIdentity, AuthResolvers, TroveScope } from "./auth.js";
import type { UserStore } from "./users.js";

const ADMIN_SCOPES: TroveScope[] = ["graph:admin"];
const MEMBER_SCOPES: TroveScope[] = ["graph:read", "graph:write", "graph:export"];

/**
 * Both identity caches below are keyed by Clerk subject and were write-only:
 * entries were checked for expiry on read but never removed, so a subject that
 * authenticated once and never returned kept its identity resident for the life
 * of the process. Storing through here drops what has already expired and caps
 * what survives, so the cache tracks *recent* callers rather than every caller.
 */
function cacheIdentity(
  cache: Map<string, { identity: AuthIdentity; expires: number }>,
  sub: string,
  identity: AuthIdentity,
  ttlMs: number,
  cap = 1000,
): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
  cache.delete(sub);
  cache.set(sub, { identity, expires: now + ttlMs });
  while (cache.size > cap) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function scopesFor(identity: AuthIdentity): TroveScope[] {
  if (identity.status !== "active") return [];
  return identity.role === "admin" ? ADMIN_SCOPES : MEMBER_SCOPES;
}

export function createClerkResolver(users: UserStore): NonNullable<AuthResolvers["resolveClerkToken"]> | null {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;

  const clerk = createClerkClient({ secretKey });
  const adminEmails = (process.env.TROVE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

  // Clerk profile lookups are rate-limited and slow; the sub → identity
  // mapping is stable enough to cache briefly.
  const cache = new Map<string, { identity: AuthIdentity; expires: number }>();
  const CACHE_TTL_MS = 60_000;

  return async (token: string) => {
    let sub: string;
    try {
      const payload = await verifyToken(token, { secretKey });
      sub = payload.sub;
    } catch {
      return null;
    }

    const cached = cache.get(sub);
    if (cached && cached.expires > Date.now()) {
      return { actorId: sub, scopes: scopesFor(cached.identity), identity: cached.identity };
    }

    let email: string | null = null;
    let displayName: string | null = null;
    try {
      const profile = await clerk.users.getUser(sub);
      email = profile.primaryEmailAddress?.emailAddress ?? profile.emailAddresses[0]?.emailAddress ?? null;
      displayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    } catch {
      // Profile fetch failing shouldn't kill auth; proceed with what the JWT proves.
    }

    const user = await users.ensureUser({ clerkUserId: sub, email, displayName }, { adminEmails });
    const identity: AuthIdentity = {
      userId: user.id,
      clerkUserId: user.clerkUserId,
      email: user.email,
      role: user.role,
      status: user.status,
    };
    cacheIdentity(cache, sub, identity, CACHE_TTL_MS);
    return { actorId: sub, scopes: scopesFor(identity), identity };
  };
}

export function createApiKeyResolver(users: UserStore): NonNullable<AuthResolvers["resolveApiKey"]> {
  return async (secret: string) => {
    const resolved = await users.resolveApiKey(secret);
    if (!resolved) return null;
    return { actorId: resolved.actorId, scopes: resolved.scopes, ownerId: resolved.userId };
  };
}

/**
 * Owner (app_user.id) that env service tokens act as. Cached briefly; before a
 * user has ever signed in it resolves to undefined, in which case service-token
 * writes fall back to unowned (superuser-null) rather than failing.
 */
export function createServiceOwnerResolver(users: UserStore): NonNullable<AuthResolvers["resolveServiceOwnerId"]> {
  const preferredEmail = process.env.TROVE_SERVICE_OWNER_EMAIL?.trim() || undefined;
  let cache: { ownerId: string | undefined; expires: number } | null = null;
  const CACHE_TTL_MS = 60_000;
  return async () => {
    if (cache && cache.expires > Date.now()) return cache.ownerId;
    const ownerId = await users.ownerForServiceToken(preferredEmail);
    cache = { ownerId, expires: Date.now() + CACHE_TTL_MS };
    return ownerId;
  };
}

/**
 * Resolve a Clerk OAuth access token (`oat_…`) issued to a browser MCP client
 * (claude.ai custom connector). The token's `subject` is the Clerk user id, so
 * the identity → Trove-scope mapping is identical to the dashboard session
 * path: waitlisted users authenticate but hold no graph scopes until approved.
 */
export function createOAuthResolver(users: UserStore): NonNullable<AuthResolvers["resolveOAuthToken"]> | null {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;

  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY;
  const clerk = createClerkClient(publishableKey ? { secretKey, publishableKey } : { secretKey });
  const adminEmails = (process.env.TROVE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

  const cache = new Map<string, { identity: AuthIdentity; expires: number }>();
  const CACHE_TTL_MS = 60_000;

  return async (token: string) => {
    let sub: string;
    try {
      // authenticateRequest inspects the Authorization header and, for an
      // oauth_token, verifies it against Clerk without needing session context.
      const request = new Request("https://trove.local/mcp", {
        headers: { authorization: `Bearer ${token}` },
      });
      const requestState = await clerk.authenticateRequest(request, { acceptsToken: "oauth_token" });
      if (!requestState.isAuthenticated) return null;
      const auth = requestState.toAuth();
      if (!auth || auth.tokenType !== "oauth_token" || !auth.subject) return null;
      sub = auth.subject;
    } catch {
      return null;
    }

    const cached = cache.get(sub);
    if (cached && cached.expires > Date.now()) {
      return { actorId: sub, scopes: scopesFor(cached.identity), identity: cached.identity };
    }

    let email: string | null = null;
    let displayName: string | null = null;
    try {
      const profile = await clerk.users.getUser(sub);
      email = profile.primaryEmailAddress?.emailAddress ?? profile.emailAddresses[0]?.emailAddress ?? null;
      displayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    } catch {
      // Profile fetch failing shouldn't kill auth; proceed with what the token proves.
    }

    const user = await users.ensureUser({ clerkUserId: sub, email, displayName }, { adminEmails });
    const identity: AuthIdentity = {
      userId: user.id,
      clerkUserId: user.clerkUserId,
      email: user.email,
      role: user.role,
      status: user.status,
    };
    cacheIdentity(cache, sub, identity, CACHE_TTL_MS);
    return { actorId: sub, scopes: scopesFor(identity), identity };
  };
}
