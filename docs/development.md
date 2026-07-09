# Trove — development and technical reference

This is the technical companion to the product [README](../README.md): the data model, the full local-dev surface, test suites, and the design rationale.

## Design

Trove is an information substrate with three canonical layers:

1. **Raw long-form content** — documents, URLs, messages, PDFs, screenshots, notes, transcripts (`source`).
2. **Addressable text units** — spans, sections, chunks, and annotations that point back to exact source ranges (`text_unit`).
3. **Semantic graph atoms** — entities, claims, decisions, questions, tasks, relationships, communities, and views (`node`, `edge`, `claim`, `graph_view`).

Everything else — markdown, mind maps, search indexes, Obsidian vaults, chat summaries — is a **projection** of this substrate, exposed through an HTTP API plus an MCP server. That keeps the system lightweight but robust:

- one transactional database for documents, spans, nodes, edges, claims, annotations, embeddings, and audit events
- one service API for agents, CLIs, Obsidian, web UI, and mobile shortcuts
- one event log (`graph_event`) so every agent write is traceable and replayable back to source text
- one cursor event feed so interfaces can incrementally sync from the hosted graph
- saved graph views so mind maps are durable artifacts, not one-off renderings
- one durable job queue (`graph_job`) for projection refresh, lint, and embedding-maintenance work
- exported markdown and mind maps so interfaces stay useful without becoming the sync protocol

Key mechanics:

- **Bitemporal edges** — edges carry `valid_from/valid_until` (world time) and `created_at/expired_at` (system time). Supersession is edge invalidation (`connect({supersedesEdgeId})`, `forget`), never deletion; `neighborhood` time-travels with `asOf`.
- **Token-budgeted recall** — `recall` runs hybrid search → one-hop expansion → ACT-R-style activation ranking → a greedy packer with citations. Reads bump `access_count`, so recalled memories strengthen.
- **Provenance** — each write is appended to `graph_event` with actor, interface, and request attribution. HTTP callers can send `X-Trove-Interface` and `X-Request-Id`; hosted MCP defaults to `mcp`, local stdio MCP to `stdio-mcp`.

The deeper design docs:

- [architecture.md](architecture.md) — architecture, tradeoffs, data model, hosting plan
- [representation.md](representation.md) — data representation for long text, annotations, graph atoms, and projections
- [storage-decision.md](storage-decision.md) — database, traversal, search, and storage choices
- [memory-db-design.md](memory-db-design.md) — the deep-research synthesis the v2 design came from
- [../db/schema.sql](../db/schema.sql) — starter relational graph schema (migrations live in [../db/migrations](../db/migrations))
- [traversal-queries.sql](traversal-queries.sql) — Postgres traversal, evidence, search, and Kuzu projection query recipes

## Local storage

Start the canonical database (host port 5433 by default so it does not collide with another local Postgres on 5432; override with `TROVE_PG_PORT`):

```bash
docker compose up -d postgres
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm run db:schema   # fresh installs only
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm run db:migrate
```

The local database uses the `pgvector/pgvector:pg18` image so one store holds evidence tables, graph edges, full-text indexes, and embeddings.

Run the API against Postgres:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm start
```

Or run the full service via Docker Compose:

```bash
export TROVE_SERVICE_TOKENS='local-dev-token|local-agent|graph:admin'
docker compose --profile app up -d --build app
curl http://localhost:8787/ready
```

Without `DATABASE_URL`, the server and stdio MCP fall back to an in-memory development store.

## MCP

```bash
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm run mcp   # stdio
# hosted Streamable HTTP endpoint: http://localhost:8787/mcp
```


Read-only MCP resources: `trove://health`, `trove://lint`, `trove://timeline`, `trove://events`, `trove://jobs`, `trove://views`, `trove://graph`, `trove://projection/obsidian/manifest`.

Full contract: [mcp.md](mcp.md) and [agent-api.md](agent-api.md).

## CLI

```bash
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- query Trove --limit 5
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- query "transactional provenance" --mode lexical
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- capture --title "Example" --summary "Captured through the Trove service."
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- events --limit 25
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- create-view --title "Trove Map" --query Trove --depth 2
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- views
TROVE_SERVICE_TOKEN=local-dev-token npm run cli -- jobs --status pending
```

Reference: [cli.md](cli.md).

## Dashboard

`web/` holds a Vite + React + shadcn app with two views:

- **Overview** — memory KPIs, writes-over-time (domain-dated), composition by node type, most-recalled memories, relationship types, write-cadence heatmap, lint health, and the recent event log, all from `GET /v1/stats`.
- **Graph** — an interactive force-directed view from `GET /v1/graph`: ⌘K search, click-to-focus, neighbor highlighting, per-type legend filtering, node card with a full-document reader (`POST /v1/document`).

```bash
npm run web:build        # build web/dist once; npm start serves it at :8787
npm run web:dev          # or: HMR dev server on :5173 proxying /v1 to :8787
```

The dashboard reads a service token from `localStorage.trove_token` when auth is enabled.

## Importer and episodic ingestion

```bash
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm run import:scribe -- ~/Documents/obsidian/claude
# or, against hosted: TROVE_API_URL=https://mytrove.in npm run backfill:vault -- ~/Documents/obsidian/claude
```

The importer is evidence-first and episodic-aware:

- append-heavy files (`log.md`, anything with 3+ dated `## [YYYY-MM-DD]` entries) and `index.md` split into per-entry/per-section sources deduped by content hash, so re-imports store only new entries; `POST /v1/document` (and `read` for single sources) reconstructs the full file
- `*.sync-conflict-*` files are skipped
- each ordinary markdown file becomes a `source`, its text becomes addressable `text_unit` rows, the page-level concept becomes a semantic `node` annotated back to evidence, and resolvable Obsidian wikilinks become `mentions` edges

Export the Obsidian-readable projection:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5433/trove npm run export:obsidian -- exports/obsidian
```

The export writes `Trove Index.md`, `Trove Log.md`, `Trove Views.md`, `Trove.canvas`, `views/*.canvas`, `nodes/*.md`, and `.trove/manifest.json`. It only removes stale files listed in the previous manifest.

## Jobs and embeddings

Graph mutations enqueue maintenance jobs (`refresh_embeddings`, `lint_graph`, `refresh_obsidian_projection`) into `graph_job`, deduped by a `maintenance:<kind>` key while pending.

The API server runs a background worker (`src/jobWorker.ts`) that drains the queue every `TROVE_JOB_INTERVAL_MS` (default 30s). Each tick runs up to 20 jobs; when a `refresh_embeddings` batch reports more missing rows than it embedded, the worker re-enqueues a follow-up batch, so large imports catch up across ticks. Claiming uses `for update skip locked`, so multiple instances never double-run a job. Disable with `TROVE_AUTORUN_JOBS=0`; manual draining still works via `npm run jobs:run`, `POST /v1/jobs/run` (admin scope), or the `run_job` MCP tool.

Embedding refresh is provider-gated (`TROVE_EMBEDDING_PROVIDER`) and embeds up to `TROVE_EMBEDDING_JOB_LIMIT` (default 24) missing rows per run. Search stays functional without embeddings via the lexical path.

## Test suites

Tests live under `tests/` and run on Node's built-in test runner (`node:test`). Each file is a `*.test.ts` suite; `tests/helpers.ts` holds the shared store/context fixtures.

```bash
npm test            # run every suite once
npm run test:watch  # re-run on change
```

By default the store-backed suites run against the in-memory store (fast, no database). Point them at Postgres by exporting `DATABASE_URL` — CI runs the whole suite this way. Two suites (`user-keys`, `isolation`) require Postgres and self-skip without it. Pointed at a real database they write real rows — clean up with `npm run db:clean:smoke -- --apply`.

The end-to-end suites (`auth`, `mcp-http`) need a running server and are skipped unless you opt in:

```bash
# start the server first, then:
TROVE_READ_TOKEN=read-token TROVE_WRITE_TOKEN=write-token TROVE_ADMIN_TOKEN=admin-token \
  npm run test:e2e
```

## Source signals

- PostgreSQL stays canonical: transactions, constraints, recursive traversal, full-text search, and operational maturity in one store — https://www.postgresql.org/docs/current/
- pgvector keeps first-pass embedding search inside Postgres so vectors stay near evidence and graph metadata — https://github.com/pgvector/pgvector
- MCP Streamable HTTP is the hosted agent access protocol; stdio remains useful for local spawned agents — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Kuzu is a strong later projection for analytical graph traversal, not the first write system — https://kuzudb.github.io/docs/
- JSON-LD and Web Annotation are interchange/selector standards, not the canonical database model — https://www.w3.org/TR/json-ld11/ and https://www.w3.org/TR/annotation-model/
