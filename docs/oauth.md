# OAuth connector (claude.ai / Claude Desktop)

Claude Code and the CLI connect to Trove with a static `Authorization: Bearer` header. The **account-level Connectors panel** in claude.ai and Claude Desktop is different: it only speaks OAuth. This doc explains how Trove supports that flow using Clerk as the authorization server.

## How it fits together

Trove is the OAuth **resource server**. It doesn't run login screens or mint tokens — Clerk does. Trove only advertises where to authenticate and validates the token it receives.

```
  claude.ai ──GET /.well-known/oauth-protected-resource/mcp──► Trove
     │  ◄──── { authorization_servers: ["https://clerk.mytrove.in"] }
     │
     ├──discover, register (DCR), authorize + PKCE, token──► Clerk
     │  ◄──── access token (JWT or opaque oat_…)
     │
     └──POST /mcp  Authorization: Bearer <token>──────────► Trove
                                     (verifies token with Clerk → user → scopes)
```

- **Trove serves:** `/.well-known/oauth-protected-resource` (and the `/mcp`-suffixed variant), and a `401` with `WWW-Authenticate: Bearer resource_metadata="…"` on unauthenticated `/mcp` calls.
- **Clerk serves:** authorization-server metadata, `/authorize`, `/token`, `/userinfo`, JWKS, and dynamic client registration.
- **Trove validates** the access token via `@clerk/backend` `authenticateRequest({ acceptsToken: "oauth_token" })` — this handles both opaque `oat_` tokens and JWT access tokens (the "Generate access tokens as JWTs" instance setting). The token's subject is the Clerk user id, mapped to an `app_user` exactly like a dashboard session. Graph scopes come from the user's Trove role — a waitlisted user can authenticate but holds no scopes until approved.

## One-time Clerk setup

In the Clerk dashboard for the production instance (clerk.mytrove.in):

1. **OAuth applications → Settings → Dynamic client registration: ON** so claude.ai registers itself automatically. (Without DCR you must pre-create an OAuth app and paste its Client ID/Secret into the connector's "Advanced settings", and add `https://claude.ai/api/mcp/auth_callback` as a Redirect URI.)
2. **Generate access tokens as JWTs** may be ON or OFF — Trove accepts both formats.
3. Ensure the `email` and `profile` scopes are available — that's all Trove requests for identity.

Server env (Railway) must include, in addition to the existing `CLERK_SECRET_KEY`:

- `CLERK_PUBLISHABLE_KEY` (or the build-time `VITE_CLERK_PUBLISHABLE_KEY`, which Trove also reads) — used to derive the Clerk authorization-server URL for the metadata document.

No new database migration is needed; OAuth users land in the same `app_user` table via the waitlist.

## Adding the connector

In claude.ai or Claude Desktop → **Settings → Connectors → Add custom connector**:

- **Name:** Trove
- **Remote MCP server URL:** `https://mytrove.in/mcp`
- **Advanced settings:** leave OAuth Client ID/Secret blank (DCR handles it). Fill them only if you disabled DCR and registered an app manually.

Click **Add**, then **Connect** — you'll be sent to Clerk to sign in with GitHub, and returned with an active connection. First-time sign-ins are waitlisted; approve them on the Admin page before their agent gets read/write scopes.

## Verifying

```bash
# metadata is public
curl https://mytrove.in/.well-known/oauth-protected-resource/mcp

# an unauthenticated /mcp call advertises the auth server
curl -i -X POST https://mytrove.in/mcp -d '{}' | grep -i www-authenticate
```

Local unit test of the metadata/derivation logic (no database needed):

```bash
npm test
```

## Troubleshooting

- **"Connection issue" in the dialog** — almost always DCR is off in Clerk and no Client ID/Secret was provided, or `CLERK_PUBLISHABLE_KEY` isn't set on the server (the metadata endpoint then returns 404 `oauth_not_configured`).
- **Connects but every tool call fails** — the user is still waitlisted; approve them on the Admin page.
- **Wrong resource URL in metadata** — Trove derives the origin from `X-Forwarded-Host`/`X-Forwarded-Proto`; make sure the proxy sets them (Railway does).

The CLI path (`claude mcp add … --header`) is unchanged and remains the simplest option for Claude Code — see [quickstart.md](quickstart.md).
