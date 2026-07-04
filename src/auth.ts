import { timingSafeEqual } from "node:crypto";

export type GraphMindScope =
  | "graph:admin"
  | "graph:read"
  | "graph:write"
  | "graph:write:capture"
  | "graph:write:update"
  | "graph:write:link"
  | "graph:write:ingest"
  | "graph:export";

export type AuthContext = {
  actorId: string;
  scopes: GraphMindScope[];
  mode: "disabled" | "token";
  interfaceId: string;
  requestId: string;
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
  scopes: GraphMindScope[];
};

const allLocalScopes: GraphMindScope[] = [
  "graph:admin",
  "graph:read",
  "graph:write",
  "graph:write:capture",
  "graph:write:update",
  "graph:write:link",
  "graph:write:ingest",
  "graph:export",
];

export function requireAuthFromHeaders(
  headers: Headers,
  requiredScopes: GraphMindScope[],
  defaultInterfaceId = "http",
): AuthContext {
  const tokens = parseServiceTokens(process.env.GRAPHMIND_SERVICE_TOKENS);

  if (tokens.length === 0) {
    return {
      actorId: "local-dev",
      scopes: allLocalScopes,
      mode: "disabled",
      interfaceId: interfaceIdFromHeaders(headers, defaultInterfaceId),
      requestId: requestIdFromHeaders(headers),
    };
  }

  const authorization = headers.get("authorization");
  const bearerToken = parseBearerToken(authorization);
  if (!bearerToken) {
    throw new AuthError(401, "missing_token", "Missing Bearer token.");
  }

  const match = tokens.find((candidate) => constantTimeEqual(candidate.token, bearerToken));
  if (!match) {
    throw new AuthError(401, "invalid_token", "Invalid Bearer token.");
  }

  const context: AuthContext = {
    actorId: match.actorId,
    scopes: match.scopes,
    mode: "token",
    interfaceId: interfaceIdFromHeaders(headers, defaultInterfaceId),
    requestId: requestIdFromHeaders(headers),
  };

  assertScopes(context, requiredScopes);
  return context;
}

export function operationContextFromAuth(context: AuthContext) {
  return {
    actorId: context.actorId,
    interfaceId: context.interfaceId,
    requestId: context.requestId,
  };
}

export function assertScopes(context: AuthContext, requiredScopes: GraphMindScope[]): void {
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
  return headers.get("x-graphmind-interface")?.trim() || defaultInterfaceId;
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
      .filter(isGraphMindScope);

    return scopes.length > 0 ? [{ token, actorId, scopes }] : [];
  });
}

function isGraphMindScope(scope: string): scope is GraphMindScope {
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

function hasScope(scopes: GraphMindScope[], required: GraphMindScope): boolean {
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
