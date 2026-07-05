# MCP Access

Trove exposes the same evidence graph through MCP so agents can read, write, link, and project knowledge without touching storage directly.

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

## Tools

Tool visibility is tiered by credential scope: core tools are shown to every credential, curator tools require a write scope, operator tools require `graph:admin`. Call-time scope checks apply regardless of visibility.

Core (the everyday agent vocabulary):

- `remember` - save a memory; revises on exact title/slug match, else creates. Returns the action taken plus `similar` near-matches it did not merge into
- `recall` - token-budgeted context pack: hybrid search, graph expansion, activation ranking, citations
- `grep` - exact/regex text search over nodes and raw sources; invalid regex degrades to a literal match
- `read` - read a node (with evidence) or raw source document by id or slug
- `connect` - create a typed relationship; `supersedesEdgeId` replaces a belief on the record
- `forget` - retire beliefs; query mode previews (dryRun) first, explicit edgeIds apply immediately

Curator (ingestion and curation flows):

- `ingest` - store long-form source content as evidence text units
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

- `trove://health` - store health
- `trove://lint` - current graph health report
- `trove://events` - first page of the cursor event feed
- `trove://jobs` - recent durable maintenance jobs
- `trove://views` - saved mind-map and projection views
- `trove://graph` - current node and edge snapshot
- `trove://projection/obsidian/manifest` - current Obsidian projection manifest

Agents should prefer resources for read-only context and tools for operations that need input, write access, or large exports.

## Prompts

- `trove-recall` - answer a question from Trove memory with citations
- `trove-remember` - save durable knowledge with evidence-first discipline

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

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run mcp:test
```

HTTP MCP smoke test:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm start
TROVE_MCP_URL=http://localhost:8787/mcp npm run mcp:http:test
```

Token-mode auth smoke test:

```bash
TROVE_SERVICE_TOKENS='read-token|reader|graph:read;write-token|agent|graph:read,graph:write,graph:export' \
  DATABASE_URL=postgres://trove:trove@localhost:5432/trove \
  npm start

TROVE_READ_TOKEN=read-token TROVE_WRITE_TOKEN=write-token npm run auth:test
TROVE_SERVICE_TOKEN=write-token npm run mcp:http:test
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run events:test
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run retrieval:test
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run views:test
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run jobs:test
npm run export:obsidian:test
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
