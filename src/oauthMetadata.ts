/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
 *
 * Trove is the OAuth *resource server*: it advertises which authorization
 * server protects /mcp, but delegates the authorize/token/register flow to
 * Clerk. Browser MCP clients (claude.ai custom connectors) read this metadata,
 * discover the Clerk authorization server, run auth-code + PKCE (registering
 * themselves via Dynamic Client Registration), and call /mcp with the issued
 * `oat_` access token.
 */

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
};

/**
 * Derive the Clerk Frontend API origin (the OAuth authorization server) from a
 * publishable key. `pk_live_<base64("clerk.mytrove.in$")>` → `https://clerk.mytrove.in`.
 */
export function clerkAuthorizationServer(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;
  const match = /^pk_(?:test|live)_(.+)$/.exec(publishableKey.trim());
  const encoded = match?.[1];
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const host = decoded.replace(/\$+$/, "").trim();
  if (!host || /\s/.test(host)) return null;
  return `https://${host}`;
}

/** Publishable key from server env, tolerating the Vite-prefixed name used at build time. */
export function clerkPublishableKeyFromEnv(): string | undefined {
  return process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;
}

/** The origin a request arrived on, honoring a proxy's forwarded host/proto (Railway). */
export function requestOrigin(url: string, headers: Headers): string {
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  const forwardedProto = headers.get("x-forwarded-proto");
  if (forwardedHost) {
    const proto = forwardedProto ?? (forwardedHost.startsWith("localhost") ? "http" : "https");
    return `${proto}://${forwardedHost}`;
  }
  return new URL(url).origin;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}${PROTECTED_RESOURCE_PATH}/mcp`;
}

/**
 * Build the protected-resource metadata document, or null when OAuth isn't
 * configured (no publishable key → can't name an authorization server).
 */
export function buildProtectedResourceMetadata(origin: string): ProtectedResourceMetadata | null {
  const authorizationServer = clerkAuthorizationServer(clerkPublishableKeyFromEnv());
  if (!authorizationServer) return null;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [authorizationServer],
    scopes_supported: ["email", "profile"],
    bearer_methods_supported: ["header"],
  };
}
