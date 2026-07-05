import { timingSafeEqual } from "node:crypto";

export type TroveScope =
  | "graph:admin"
  | "graph:read"
  | "graph:write"
  | "graph:write:capture"
  | "graph:write:update"
  | "graph:write:link"
  | "graph:write:ingest"
  | "graph:export";

export type AuthIdentity = {
  userId: string;
  clerkUserId: string;
  email: string | null;
  role: "admin" | "member";
  status: "waitlisted" | "active" | "suspended";
};

export type AuthContext = {
  actorId: string;
  scopes: TroveScope[];
  mode: "disabled" | "token" | "api_key" | "clerk" | "oauth";
  interfaceId: string;
  requestId: string;
  identity?: AuthIdentity;
  /** app_user.id whose graph this credential reads/writes. */
  ownerId?: string | undefined;
  /** Auth disabled (local/CI): bypass owner scoping, see the whole graph. */
  superuser?: boolean | undefined;
};

/**
 * Pluggable async credential resolvers. `resolveApiKey` handles DB-backed
 * `trove_*` keys; `resolveClerkToken` handles Clerk session JWTs;
 * `resolveOAuthToken` handles Clerk `oat_*` OAuth access tokens from browser
 * MCP connectors. Any may return null to signal "not mine / not valid".
 */
export type AuthResolvers = {
  resolveApiKey?: (secret: string) => Promise<{ actorId: string; scopes: TroveScope[]; ownerId?: string; identity?: AuthIdentity } | null>;
  resolveClerkToken?: (token: string) => Promise<{ actorId: string; scopes: TroveScope[]; identity: AuthIdentity } | null>;
  resolveOAuthToken?: (token: string) => Promise<{ actorId: string; scopes: TroveScope[]; identity: AuthIdentity } | null>;
  /** app_user.id that env service tokens act as (config: TROVE_SERVICE_OWNER_EMAIL → oldest admin). */
  resolveServiceOwnerId?: () => Promise<string | undefined>;
};

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: "missing_token" | "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
  }
}

type ServiceToken = {
  token: string;
  actorId: string;
  scopes: TroveScope[];
};

const allLocalScopes: TroveScope[] = [
  "graph:admin",
  "graph:read",
  "graph:write",
  "graph:write:capture",
  "graph:write:update",
  "graph:write:link",
  "graph:write:ingest",
  "graph:export",
];

export async function requireAuthFromHeaders(
  headers: Headers,
  requiredScopes: TroveScope[],
  defaultInterfaceId = "http",
  resolvers: AuthResolvers = {},
): Promise<AuthContext> {
  const tokens = parseServiceTokens(process.env.TROVE_SERVICE_TOKENS);
  const interfaceId = interfaceIdFromHeaders(headers, defaultInterfaceId);
  const requestId = requestIdFromHeaders(headers);

  if (tokens.length === 0) {
    // Auth disabled (local dev / CI): single operator, sees the whole graph.
    return {
      actorId: "local-dev",
      scopes: allLocalScopes,
      mode: "disabled",
      interfaceId,
      requestId,
      superuser: true,
    };
  }

  const authorization = headers.get("authorization");
  const bearerToken = parseBearerToken(authorization);
  if (!bearerToken) {
    throw new AuthError(401, "missing_token", "Missing Bearer token.");
  }

  // Resolution order by cheapest-first / prefix. See docs/oauth.md and docs/mcp.md.
  // 1. Environment service tokens (agents, MCP, ops).
  const match = tokens.find((candidate) => constantTimeEqual(candidate.token, bearerToken));
  if (match) {
    // Service tokens act as a configured owner (TROVE_SERVICE_OWNER_EMAIL →
    // oldest admin), so your agents read/write your graph, not everyone's.
    const ownerId = resolvers.resolveServiceOwnerId ? await resolvers.resolveServiceOwnerId() : undefined;
    const context: AuthContext = {
      actorId: match.actorId,
      scopes: match.scopes,
      mode: "token",
      interfaceId,
      requestId,
      ownerId,
    };
    assertScopes(context, requiredScopes);
    return context;
  }

  // 2. Clerk OAuth access tokens from browser MCP connectors (claude.ai).
  if (bearerToken.startsWith("oat_") && resolvers.resolveOAuthToken) {
    const resolved = await resolvers.resolveOAuthToken(bearerToken);
    if (resolved) {
      const context: AuthContext = { ...resolved, mode: "oauth", interfaceId, requestId, ownerId: resolved.identity.userId };
      assertScopes(context, requiredScopes);
      return context;
    }
  }

  // 3. DB-backed per-user API keys.
  if (bearerToken.startsWith("trove_") && resolvers.resolveApiKey) {
    const resolved = await resolvers.resolveApiKey(bearerToken);
    if (resolved) {
      const ownerId = resolved.ownerId ?? resolved.identity?.userId;
      const context: AuthContext = { ...resolved, mode: "api_key", interfaceId, requestId, ownerId };
      assertScopes(context, requiredScopes);
      return context;
    }
  }

  // 4. Clerk JWTs. Two kinds share the eyJ… shape: dashboard *session* tokens,
  //    and OAuth *access* tokens when the Clerk instance is set to issue JWTs
  //    (vs opaque oat_). Try the session verifier first (the dashboard is the
  //    dominant caller), then fall back to OAuth-token verification so browser
  //    connectors work regardless of the instance's token-format setting.
  if (bearerToken.split(".").length === 3) {
    if (resolvers.resolveClerkToken) {
      const resolved = await resolvers.resolveClerkToken(bearerToken);
      if (resolved) {
        const context: AuthContext = { ...resolved, mode: "clerk", interfaceId, requestId, ownerId: resolved.identity.userId };
        assertScopes(context, requiredScopes);
        return context;
      }
    }
    if (resolvers.resolveOAuthToken) {
      const resolved = await resolvers.resolveOAuthToken(bearerToken);
      if (resolved) {
        const context: AuthContext = { ...resolved, mode: "oauth", interfaceId, requestId, ownerId: resolved.identity.userId };
        assertScopes(context, requiredScopes);
        return context;
      }
    }
  }

  throw new AuthError(401, "invalid_token", "Invalid Bearer token.");
}

/**
 * Env-configured service tokens for the admin keys page: masked preview for
 * display plus the full value so admins can copy agent credentials.
 */
export function listServiceTokenSummaries(): Array<{ actorId: string; scopes: TroveScope[]; tokenPreview: string; token: string }> {
  return parseServiceTokens(process.env.TROVE_SERVICE_TOKENS).map((token) => ({
    actorId: token.actorId,
    scopes: token.scopes,
    tokenPreview: `${token.token.slice(0, 9)}…`,
    token: token.token,
  }));
}

export function operationContextFromAuth(context: AuthContext) {
  return {
    actorId: context.actorId,
    interfaceId: context.interfaceId,
    requestId: context.requestId,
    ownerId: context.ownerId,
    superuser: context.superuser,
  };
}

export function assertScopes(context: AuthContext, requiredScopes: TroveScope[]): void {
  const missing = requiredScopes.filter((scope) => !hasScope(context.scopes, scope));
  if (missing.length > 0) {
    throw new AuthError(403, "insufficient_scope", `Missing required scope: ${missing.join(", ")}`);
  }
}

export function authErrorBody(error: AuthError) {
  return {
    error: error.code,
    message: error.message,
  };
}

function parseBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function interfaceIdFromHeaders(headers: Headers, defaultInterfaceId: string): string {
  return headers.get("x-trove-interface")?.trim() || defaultInterfaceId;
}

function requestIdFromHeaders(headers: Headers): string {
  return headers.get("x-request-id")?.trim() || globalThis.crypto.randomUUID();
}

function parseServiceTokens(raw: string | undefined): ServiceToken[] {
  if (!raw?.trim()) return [];

  return raw.split(";").flatMap((entry) => {
    const [token, actorId, scopesRaw] = entry.split("|").map((part) => part?.trim());
    if (!token || !actorId || !scopesRaw) return [];

    const scopes = scopesRaw
      .split(",")
      .map((scope) => scope.trim())
      .filter(isTroveScope);

    return scopes.length > 0 ? [{ token, actorId, scopes }] : [];
  });
}

function isTroveScope(scope: string): scope is TroveScope {
  return [
    "graph:admin",
    "graph:read",
    "graph:write",
    "graph:write:capture",
    "graph:write:update",
    "graph:write:link",
    "graph:write:ingest",
    "graph:export",
  ].includes(scope);
}

function hasScope(scopes: TroveScope[], required: TroveScope): boolean {
  if (scopes.includes("graph:admin")) return true;
  if (scopes.includes(required)) return true;
  if (required.startsWith("graph:write") && scopes.includes("graph:write")) return true;
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
