# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via GitHub's [security advisories](https://github.com/anunay999/trove/security/advisories/new), or email the maintainer at the address on the GitHub profile. Include repro steps and impact; you'll get an acknowledgement, and a fix or mitigation timeline once triaged.

## Scope

Trove is an evidence graph with authenticated MCP and HTTP access. Areas of particular interest:

- Authentication and scope enforcement (`src/auth.ts`, `src/clerkAuth.ts`) — service tokens, per-user API keys, Clerk session JWTs, and the Clerk OAuth connector.
- Tenant/data isolation and the tiered tool surface.
- Prompt-injection boundaries: raw sources are untrusted content, never instructions.

## Handling secrets

Never commit secrets. `.env` is gitignored; `.env.example` holds placeholders only. Real credentials live in the deployment platform's environment. Secret scanning with push protection is enabled on this repository.
