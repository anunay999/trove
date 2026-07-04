# GraphMind

GraphMind is a hosted, agent-first information graph for Scribe-style personal and project memory.

The goal is not "markdown in the cloud." The goal is to preserve what the current Obsidian/Scribe workflow gives you:

- agents maintain the knowledge base
- answers compound into durable pages
- sources, decisions, facts, and links remain inspectable
- Obsidian can remain one good reading and editing interface

But the source of truth becomes a small hosted knowledge substrate that every interface can call.

## Proposed Direction

Use an information substrate with three canonical layers:

1. Raw long-form content: documents, URLs, messages, PDFs, screenshots, notes, transcripts.
2. Addressable text units: spans, sections, chunks, and annotations that point back to exact source ranges.
3. Semantic graph atoms: entities, claims, decisions, questions, tasks, relationships, communities, and views.

Expose this through an HTTP API plus an MCP server. Treat markdown, mind maps, search indexes, Obsidian vaults, and chat summaries as projections.

This keeps the system lightweight but robust:

- one transactional database for documents, spans, nodes, edges, claims, annotations, embeddings, and audit events
- one service API for agents, CLIs, Obsidian, web UI, and mobile shortcuts
- one event log so every agent write is traceable and replayable back to source text
- one cursor event feed so interfaces can incrementally sync from the hosted graph
- saved graph views so mind maps are durable artifacts, not one-off renderings
- one durable job queue for projection refresh, lint, and embedding-maintenance work
- exported markdown and mind maps so interfaces stay useful without becoming the sync protocol

The deeper design lives in [docs/architecture.md](/Users/anunay/dev/graphmind/docs/architecture.md).

## Core Artifacts

- [docs/architecture.md](/Users/anunay/dev/graphmind/docs/architecture.md) - architecture, tradeoffs, data model, hosting plan
- [docs/representation.md](/Users/anunay/dev/graphmind/docs/representation.md) - data representation for long text, annotations, graph atoms, and projections
- [docs/storage-decision.md](/Users/anunay/dev/graphmind/docs/storage-decision.md) - database, traversal, search, and storage choices
- [docs/agent-api.md](/Users/anunay/dev/graphmind/docs/agent-api.md) - MCP and HTTP contract for agent access
- [docs/mcp.md](/Users/anunay/dev/graphmind/docs/mcp.md) - local stdio and hosted Streamable HTTP MCP setup for agents
- [docs/cli.md](/Users/anunay/dev/graphmind/docs/cli.md) - reference HTTP client and CLI for command palettes, shortcuts, and plugin prototypes
- [docs/deployment.md](/Users/anunay/dev/graphmind/docs/deployment.md) - compiled service, Docker Compose, health checks, and hosted runtime notes
- [docs/schema.sql](/Users/anunay/dev/graphmind/docs/schema.sql) - starter relational graph schema
- [docs/traversal-queries.sql](/Users/anunay/dev/graphmind/docs/traversal-queries.sql) - Postgres traversal, evidence, search, and Kuzu projection query recipes

## Local Storage

Start the canonical database (host port 5433 by default, so it does not collide with another local Postgres on 5432; override with `GRAPHMIND_PG_PORT`):

```bash
docker compose up -d postgres
DATABASE_URL=postgres://graphmind:graphmind@localhost:5433/graphmind npm run db:schema   # fresh installs only
DATABASE_URL=postgres://graphmind:graphmind@localhost:5433/graphmind npm run db:migrate
```

The local database uses the `pgvector/pgvector:pg18` image so the same store can hold evidence tables, graph edges, full text indexes, and first-pass embeddings.

Run the API against Postgres:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm start
```

Run the hosted service via Docker Compose:

```bash
export GRAPHMIND_SERVICE_TOKENS='local-dev-token|local-agent|graph:admin'
docker compose --profile app up -d --build app
curl http://localhost:8787/ready
```

Use the hosted service from the CLI:

```bash
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- query GraphMind --limit 5
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- query "transactional provenance" --mode lexical
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- capture --title "Example" --summary "Captured through the GraphMind service."
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- events --limit 25
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- create-view --title "GraphMind Map" --query GraphMind --depth 2
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- views
GRAPHMIND_SERVICE_TOKEN=local-dev-token npm run cli -- jobs --status pending
```

Hosted agents can connect to the API's MCP endpoint:

```text
http://localhost:8787/mcp
```

For a hosted service, configure scoped Bearer tokens:

```bash
GRAPHMIND_SERVICE_TOKENS='read-token|reader|graph:read;agent-token|agent|graph:read,graph:write,graph:export;admin-token|admin-agent|graph:admin'
```

Local development runs without auth if that variable is unset.

Each write is appended to `graph_event` with actor, interface, and request attribution. HTTP callers can send `X-GraphMind-Interface` and `X-Request-Id`; hosted MCP defaults to `mcp`, and local stdio MCP defaults to `stdio-mcp`.

Run the MCP server for local agents:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run mcp
```

For a Codex/Claude-style stdio connector, the command is:

```bash
npx tsx /Users/anunay/dev/graphmind/src/mcpServer.ts
```

Set `DATABASE_URL` in that connector environment to use the hosted Postgres store. Without `DATABASE_URL`, the MCP server falls back to the in-memory development store.

Smoke test the hosted MCP endpoint:

```bash
GRAPHMIND_SERVICE_TOKEN=agent-token GRAPHMIND_MCP_URL=http://localhost:8787/mcp npm run mcp:http:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run scribe:mcp:test
GRAPHMIND_READ_TOKEN=read-token GRAPHMIND_WRITE_TOKEN=agent-token npm run auth:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run events:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run retrieval:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run recall:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run bitemporal:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run views:test
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run jobs:test
```

## Dashboard And Graph Explorer

`web/` holds a Vite + React + shadcn dashboard with two views:

- **Overview**: memory KPIs, writes-over-time, composition by node type, most-recalled memories, relationship types, write-cadence heatmap, lint health, and the recent event log — all from `GET /v1/stats`.
- **Graph**: an interactive force-directed view of the whole memory graph from `GET /v1/graph` — search, click-to-focus, neighbor highlighting, per-type legend filtering, and an edge panel per node.

```bash
npm run web:build        # build web/dist once
npm start                # the API now serves the dashboard at http://localhost:8787/
npm run web:dev          # or: HMR dev server on :5173 proxying /v1 to :8787
```

The dashboard reads a service token from `localStorage.graphmind_token` when the API runs with `GRAPHMIND_SERVICE_TOKENS` set; local dev without tokens needs no setup.

Export an Obsidian-readable projection:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run export:obsidian -- exports/obsidian
```

The export writes `GraphMind Index.md`, `GraphMind Log.md`, `GraphMind Views.md`, `GraphMind.canvas`, `views/*.canvas`, `nodes/*.md`, and `.graphmind/manifest.json`. It only removes stale files that were listed in the previous manifest.

Import the current Scribe vault:

```bash
DATABASE_URL=postgres://graphmind:graphmind@localhost:5432/graphmind npm run import:scribe -- /Users/anunay/Documents/obsidian/claude
```

The importer is intentionally evidence-first and episodic-aware:

- append-heavy files (`log.md`, anything with 3+ dated `## [YYYY-MM-DD]` entries) and `index.md` split into per-entry/per-section sources deduped by content hash, so re-imports store only new entries; `POST /v1/document` (and `graph.read_source` for single sources) reconstructs the full file
- `*.sync-conflict-*` files are skipped
- each ordinary markdown file becomes a `source`
- source text becomes addressable `text_unit` rows
- the page-level concept becomes a semantic `node`
- the node is annotated back to evidence
- resolvable Obsidian wikilinks become `mentions` edges

## First Build Slice

1. Import the current Scribe vault as long-form source documents, not as the permanent model.
2. Split each source into stable text units with source offsets and section paths.
3. Extract semantic graph atoms from the text units: entities, claims, decisions, tasks, and relationships.
4. Serve `query`, `read`, `capture`, `ingest`, `annotate`, `update`, `lint`, and `project` as MCP tools.
5. Generate markdown and mind maps from the graph, proving interfaces are projections.
6. Queue maintenance work after graph mutations so projections, lint, and embeddings can be refreshed by workers.
7. Save mind-map views as durable `graph_view` records that can be read through MCP/HTTP and exported to Obsidian Canvas.

Scribe-compatible MCP aliases are available for agents that should think in the old wiki workflow:

- `scribe.query`
- `scribe.capture`
- `scribe.ingest`
- `scribe.update`
- `scribe.lint`
- `scribe.export_obsidian`

MCP also exposes read-only resources:

- `graphmind://health`
- `graphmind://lint`
- `graphmind://timeline`
- `graphmind://events`
- `graphmind://jobs`
- `graphmind://views`
- `graphmind://graph`
- `graphmind://projection/obsidian/manifest`

Do not start with a markdown sync engine, full graph database, CRDT editor, vector database, or complex app shell. The first durable primitive is an addressable evidence graph: every semantic statement can point back to the source span that justifies it.

## Source Signals

- PostgreSQL stays canonical because it gives transactions, constraints, recursive traversal, full text search, and ordinary operational maturity in one store: https://www.postgresql.org/docs/current/
- pgvector belongs inside Postgres for first-pass embedding search so vectors stay near evidence and graph metadata. Embedding refresh is provider-gated and writes vectors only when real credentials are configured: https://github.com/pgvector/pgvector
- MCP Streamable HTTP is the hosted agent access protocol; stdio remains useful for local spawned agents: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Kuzu is a strong later projection for analytical graph traversal, not the first write system: https://kuzudb.github.io/docs/
- JSON-LD and Web Annotation are useful interchange and selector standards, not the canonical database model: https://www.w3.org/TR/json-ld11/ and https://www.w3.org/TR/annotation-model/
