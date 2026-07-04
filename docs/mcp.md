# MCP Access

GraphMind exposes the same evidence graph through MCP so agents can read, write, link, and project knowledge without touching storage directly.

Use stdio when an agent runs on the same machine and can spawn GraphMind as a child process. Use Streamable HTTP when GraphMind is hosted and multiple agents or interfaces need one shared service endpoint.

Relevant MCP references:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://ts.sdk.modelcontextprotocol.io/

## Local Stdio Server

Run against the local Postgres store:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run mcp
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
  "args": ["tsx", "/Users/anunay/dev/graphmind/src/mcpServer.ts"],
  "env": {
    "DATABASE_URL": "postgres://graphmind:graphmind@localhost:5432/graphmind"
  }
}
```

## Hosted Streamable HTTP

Start the API:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm start
```

Then point remote MCP clients at:

```text
http://localhost:8787/mcp
```

For production, put this endpoint behind TLS plus OAuth or scoped service tokens. The MCP endpoint and the JSON API share the same store and validation layer.

### Service Tokens

Local development runs without auth if `GRAPHMIND_SERVICE_TOKENS` is unset. Hosted deployments should set it.

Token format:

```bash
GRAPHMIND_SERVICE_TOKENS='read-token|reader|graph:read;agent-token|agent|graph:read,graph:write,graph:export;admin-token|admin-agent|graph:admin'
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
X-GraphMind-Interface: obsidian-plugin
X-Request-Id: request-123
```

The service stores these on `graph_event.interface_id` and `graph_event.request_id`. MCP Streamable HTTP defaults to `interface_id = mcp`; plain JSON HTTP defaults to `interface_id = http`.

Supported scopes:

- `graph:read` - search, read, neighborhood, timeline, project
- `graph:write` - all write tools
- `graph:write:capture` - capture semantic nodes
- `graph:write:update` - update nodes and annotations
- `graph:write:link` - create relationships
- `graph:write:ingest` - ingest sources
- `graph:export` - export Obsidian projections
- `graph:admin` - all operations

## Tools

- `graph.search` - search semantic nodes and source text units
- `graph.read` - read a node with evidence and annotations
- `graph.neighborhood` - expand graph neighbors for mind maps or context
- `graph.link` - create typed relationships between nodes
- `graph.ingest` - ingest long-form source content
- `graph.capture` - capture a semantic graph atom
- `graph.annotate` - attach meaning to evidence
- `graph.update` - update a node with revision checking
- `graph.project` - render markdown, mind map, or agent context
- `graph.timeline` - inspect graph mutation events
- `graph.events` - read cursor-paginated graph mutation events for interface sync
- `graph.lint` - inspect graph health issues
- `graph.views` - list saved mind-map and projection views
- `graph.read_view` - read a saved view with included nodes and edges
- `graph.create_view` - save a durable mind-map view from a root, query, or explicit node set
- `graph.delete_view` - delete a saved view by id or slug
- `graph.jobs` - list durable maintenance jobs
- `graph.enqueue_job` - enqueue projection, lint, or embedding maintenance work
- `graph.run_job` - claim and run one pending maintenance job inline
- `graph.export_obsidian` - export an Obsidian vault projection with files and a manifest

Scribe-compatible aliases:

- `scribe.query` - query the hosted knowledge graph
- `scribe.capture` - save a durable semantic note
- `scribe.ingest` - ingest a raw source into the evidence layer
- `scribe.update` - update a graph node with revision checking
- `scribe.lint` - run the GraphMind health check with Scribe naming
- `scribe.export_obsidian` - export the Obsidian projection

## Resources

GraphMind exposes read-only MCP resources for stable agent context:

- `graphmind://health` - store health
- `graphmind://lint` - current graph health report
- `graphmind://timeline` - recent graph mutation events
- `graphmind://events` - first page of the cursor event feed
- `graphmind://jobs` - recent durable maintenance jobs
- `graphmind://views` - saved mind-map and projection views
- `graphmind://graph` - current node and edge snapshot
- `graphmind://projection/obsidian/manifest` - current Obsidian projection manifest

Agents should prefer resources for read-only context and tools for operations that need input, write access, or large exports.

## Prompts

Reusable Scribe workflow prompts:

- `scribe-query` - query the hosted graph and cite durable context
- `scribe-capture` - prepare an evidence-first capture
- `scribe-lint` - review graph health without mutating data

## Obsidian Projection

`graph.export_obsidian` and `GET /v1/export/obsidian` return:

- `files`: a deterministic map of vault-relative paths to content
- `manifest`: `formatVersion`, generation time, file count, content hash, and per-file hashes

The generated files include:

- `GraphMind Index.md`
- `GraphMind Log.md`
- `GraphMind.canvas`
- `GraphMind Views.md`
- `views/*.canvas`
- `nodes/*.md`
- `.graphmind/manifest.json`

To write the projection to disk:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run export:obsidian -- exports/obsidian
```

The writer uses the previous manifest to remove stale generated files without touching unrelated files in the target folder.

## Smoke Test

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run mcp:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run scribe:mcp:test
```

HTTP MCP smoke test:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm start
GRAPHMIND_MCP_URL=http://localhost:8787/mcp npm run mcp:http:test
```

Token-mode auth smoke test:

```bash
GRAPHMIND_SERVICE_TOKENS='read-token|reader|graph:read;write-token|agent|graph:read,graph:write,graph:export' \
  DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind \
  npm start

GRAPHMIND_READ_TOKEN=read-token GRAPHMIND_WRITE_TOKEN=write-token npm run auth:test
GRAPHMIND_SERVICE_TOKEN=write-token npm run mcp:http:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run events:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run retrieval:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run views:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run jobs:test
npm run export:obsidian:test
```

Expected result:

- MCP server starts on stdio.
- Tool list includes all `graph.*` tools.
- Resource list includes `graphmind://lint` and other stable graph URIs.
- Prompt list includes the `scribe-*` workflows.
- `graph.search` returns results from the configured store.
- `graph.events` returns a cursor-paginated feed with `nextCursor` and `hasMore`.
- Lexical search uses Postgres full text ranking over nodes, revisions, and text units; semantic/hybrid search uses pgvector only when real embeddings exist.
- `graph.jobs` and `graphmind://jobs` expose queue state.
- `graph.views` and `graphmind://views` expose saved mind maps.
- A read-only token can search but cannot capture or export.
- HTTP and MCP writes appear in `graph.timeline` with actor, interface, and request attribution.
- Obsidian projection includes index, log, canvas mind map, node files, and a hash manifest.

## Design Rule

Agents should call MCP tools, not mutate Postgres, Obsidian files, or Kuzu projections directly. The service owns write validation, evidence annotations, event logging, and projection rebuilds.
