# MCP Access

Trove exposes the same evidence graph through MCP so agents can read, write, link, and project knowledge without touching storage directly.

**How agents should use the tools** (session loop, grep/read/recall routing, continuous capture): see **[agent-usage.md](agent-usage.md)**.

Use stdio when an agent runs on the same machine and can spawn Trove as a child process. Use Streamable HTTP when Trove is hosted and multiple agents or interfaces need one shared service endpoint.

Relevant MCP references:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://ts.sdk.modelcontextprotocol.io/

## Local Stdio Server

Run against the local Postgres store:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run mcp
```

Run against the in-memory development store:

```bash
npm run mcp
```

## Connector Command

For an agent client that spawns stdio MCP servers:

```json
{
  "command": "npx",
  "args": ["tsx", "/Users/anunay/dev/trove/src/mcpServer.ts"],
  "env": {
    "DATABASE_URL": "postgres://trove:trove@localhost:5432/trove"
  }
}
```

## Hosted Streamable HTTP

Start the API:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm start
```

Then point remote MCP clients at:

```text
http://localhost:8787/mcp
```

For production, put this endpoint behind TLS plus OAuth or scoped service tokens. The MCP endpoint and the JSON API share the same store and validation layer.

Trove resolves a `Authorization: Bearer <token>` in four ways, by prefix: env **service tokens** (agents/ops), `oat_` **Clerk OAuth access tokens** (browser connectors — see [oauth.md](oauth.md)), `trove_` **per-user API keys** (dashboard-managed), and Clerk **session JWTs** (dashboard). CLI/stdio clients use service tokens or per-user keys; the claude.ai/Claude Desktop Connectors panel uses the OAuth flow.

### Service Tokens

Local development runs without auth if `TROVE_SERVICE_TOKENS` is unset. Hosted deployments should set it.

Token format:

```bash
TROVE_SERVICE_TOKENS='read-token|reader|graph:read;agent-token|agent|graph:read,graph:write,graph:export;admin-token|admin-agent|graph:admin'
```

Each entry is:

```text
token|actor_id|scope,scope
```

Clients send:

```http
Authorization: Bearer agent-token
```

Optional attribution headers:

```http
X-Trove-Interface: obsidian-plugin
X-Request-Id: request-123
```

The service stores these on `graph_event.interface_id` and `graph_event.request_id`. MCP Streamable HTTP defaults to `interface_id = mcp`; plain JSON HTTP defaults to `interface_id = http`.

Supported scopes:

- `graph:read` - recall, grep, read, neighborhood, project
- `graph:write` - all write tools
- `graph:write:capture` - remember (create path)
- `graph:write:update` - remember (revise path), annotations, views
- `graph:write:link` - connect and forget
- `graph:write:ingest` - ingest sources
- `graph:export` - export Obsidian projections
- `graph:admin` - all operations

## Agent operating doctrine (any LLM)

MCP clients do **not** need Claude skills. Doctrine is baked into the server:

1. **Server `instructions`** — returned on MCP initialize; hosts that surface them inject the full loop (grep/read/recall + ingest→remember→connect + mid-session capture).
2. **Resource `trove://doctrine`** — same text; agents can `resources/read` it at session start if instructions are ignored.
3. **Tool descriptions** — each tool states when to use it (shared source: `src/toolDefinitions.ts`, used by both MCP and `GET /v1/tools`).
4. **Prompts** — `trove-recall`, `trove-remember`, `trove-session` for structured workflows.

**Session loop:** load before re-deriving → work → capture crystallised beliefs mid-session (several small linked atoms) → supersede corrections → close with 3–8 atoms, never one mega-node.

**Read routing:** exact string → `grep` → optional `read` · known slug → `read` · open question → `recall` (~8000 tokens) → `read` if pack is thin.

**Write routing:** long material → `ingest` then `remember` 3–7 atoms with evidence then `connect` · single fact → `remember` + links · check `similar` on remember.

Optional Claude skills (`npx skills add anunay999/trove -g`) add progressive-disclosure workflow docs; they are not required for MCP hosts.

## Tools

Tool visibility is tiered by credential scope: core tools are shown to every credential, curator tools require a write scope, operator tools require `graph:admin`. Call-time scope checks apply regardless of visibility.

Core (the everyday agent vocabulary):

- `remember` - distilled belief (not raw dump); revises on exact title/slug; check `similar`; mid-session small atoms + links
- `recall` - open questions only; token-budgeted pack (default 8000); follow with `read` if thin
- `grep` - prefer over recall for ports/IPs/errors/flags; then `read` for full doc
- `read` - full node body or raw source by id/slug; node reads accept `asOf` for recorded fact history
- `connect` - typed edges; `supersedesEdgeId` replaces a belief on the record
- `forget` - retire beliefs; query mode previews (dryRun) first, explicit edgeIds apply immediately

Curator (ingestion and curation flows):

- `ingest` - raw evidence text units only — then remember distilled facts citing them
- `annotate` - attach meaning to evidence without rewriting it
- `neighborhood` - expand graph neighbors, optionally `asOf` a past time
- `project` - render markdown, mind map, or agent context
- `views` / `read_view` / `create_view` / `delete_view` - saved mind-map views

Operator (admin credentials only):

- `events` - cursor-paginated graph mutation events for interface sync
- `lint` - graph health issues
- `jobs` / `enqueue_job` / `run_job` - durable maintenance queue
- `export_obsidian` - Obsidian vault projection with files and a manifest

## Resources

Trove exposes read-only MCP resources for stable agent context:

- `trove://doctrine` - **agent operating model** (read at session start if needed)
- `trove://health` - store health
- `trove://lint` - current graph health report
- `trove://events` - first page of the cursor event feed
- `trove://jobs` - recent durable maintenance jobs
- `trove://views` - saved mind-map and projection views
- `trove://graph` - current node and edge snapshot
- `trove://projection/obsidian/manifest` - current Obsidian projection manifest

Agents should prefer resources for read-only context and tools for operations that need input, write access, or large exports.

## Prompts

- `trove-recall` - answer a question with grep/read/recall routing + citations
- `trove-remember` - save with ingest→remember→connect discipline
- `trove-session` - full boot→work→capture→close loop for a task

## Obsidian Projection

`export_obsidian` and `GET /v1/export/obsidian` return:

- `files`: a deterministic map of vault-relative paths to content
- `manifest`: `formatVersion`, generation time, file count, content hash, and per-file hashes

The generated files include:

- `Trove Index.md`
- `Trove Log.md`
- `Trove.canvas`
- `Trove Views.md`
- `views/*.canvas`
- `nodes/*.md`
- `.trove/manifest.json`

To write the projection to disk:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run export:obsidian -- exports/obsidian
```

The writer uses the previous manifest to remove stale generated files without touching unrelated files in the target folder.

## Smoke Test

The store, MCP-stdio, and Obsidian suites run with `npm test` (add `DATABASE_URL` to exercise Postgres):

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm test
```

The HTTP-transport and token-auth suites need a running server and are opt-in via `TROVE_E2E=1` (which `test:e2e` sets):

```bash
TROVE_SERVICE_TOKENS='read-token|reader|graph:read;write-token|agent|graph:read,graph:write,graph:export;admin-token|ops|graph:admin' \
  DATABASE_URL=postgres://trove:trove@localhost:5432/trove \
  npm start

# in another shell, against the running server:
TROVE_READ_TOKEN=read-token TROVE_WRITE_TOKEN=write-token TROVE_ADMIN_TOKEN=admin-token \
  TROVE_SERVICE_TOKEN=write-token TROVE_MCP_URL=http://localhost:8787/mcp \
  npm run test:e2e
```

Expected result:

- MCP server starts on stdio.
- Tool list includes the core, curator, and operator tools for an admin credential.
- Resource list includes `trove://lint` and other stable graph URIs.
- Prompt list includes the `trove-*` workflows.
- `grep` returns results from the configured store.
- `events` returns a cursor-paginated feed with `nextCursor` and `hasMore`.
- Lexical search uses Postgres full text ranking over nodes, revisions, and text units; semantic/hybrid search uses pgvector only when real embeddings exist.
- `jobs` and `trove://jobs` expose queue state.
- `views` and `trove://views` expose saved mind maps.
- A read-only token sees only core tools and cannot remember or export.
- HTTP and MCP writes appear in the event feed with actor, interface, and request attribution.
- Obsidian projection includes index, log, canvas mind map, node files, and a hash manifest.

## Design Rule

Agents should call MCP tools, not mutate Postgres, Obsidian files, or Kuzu projections directly. The service owns write validation, evidence annotations, event logging, and projection rebuilds.
