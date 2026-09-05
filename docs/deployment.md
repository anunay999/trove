# Deployment

Trove can run as a compiled Node service or as a Docker Compose app service.

## Runtime Contract

Required in hosted mode:

- `DATABASE_URL`
- `TROVE_SERVICE_TOKENS`

Optional:

- `PORT`, default `8787`
- `RAW_BLOB_BUCKET`, reserved for object storage integration
- `TROVE_WORKER_ID`, default `inline-worker`
- `TROVE_WORKER_MAX_JOBS`, default `10` for the worker command
- `TROVE_EMBEDDING_PROVIDER=openai`, `TROVE_EMBEDDING_MODEL`, `TROVE_EMBEDDING_DIMENSIONS`, and `OPENAI_API_KEY` for real embedding refresh

`.env.example` is the complete list of what a deployment sets, and
`tests/env-surface.test.ts` enforces that: secrets, endpoints, identity,
topology, and the switches that decide which features are on. Nothing else is an
environment variable. Timeouts, intervals, retention windows, budgets and
calibrated thresholds are named constants beside the code they govern — thirty
of them were variables that no deployment had ever set, which is not
configuration but a claim of configurability nothing honours, and it made
"what is this set to in production?" answerable only from a dashboard.

One resolver (`src/llmProvider.ts`) picks the endpoint for every LLM call —
graph chat, recall reranking and the reconcile judge. `OPENROUTER_API_KEY` wins
when present; `OPENAI_API_KEY` is the fallback; `OPENAI_BASE_URL` names a
specific gateway. **Embeddings deliberately do not use it**: the vectors already
stored were produced by one model at one width, so pointing them elsewhere
corrupts a column rather than switching providers.

Service tokens use:

```text
token|actor_id|scope,scope
```

Example:

```bash
TROVE_SERVICE_TOKENS='agent-token|agent|graph:read,graph:write,graph:export;admin-token|admin-agent|graph:admin'
```

## Health Checks

- `GET /health` checks that the process is alive and reports store/auth mode.
- `GET /ready` checks that the backing store is reachable.

Use `/ready` for load balancer and container health checks.

## Local Production Build

```bash
npm ci
npm run build
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run db:migrate:prod
TROVE_SERVICE_TOKENS='agent-token|agent|graph:read,graph:write,graph:export;admin-token|admin-agent|graph:admin' \
  DATABASE_URL=postgres://trove:trove@localhost:5432/trove \
  npm run start:prod
```

## Docker Compose

Start Postgres only:

```bash
docker compose up -d postgres
```

Build and run the hosted service:

```bash
export TROVE_SERVICE_TOKENS='local-dev-token|local-agent|graph:admin'
docker compose --profile app up -d --build app
```

The container starts with:

```bash
npm run db:migrate:prod && npm run start:prod
```

This keeps migrations close to startup. The runner (`src/migrate.ts`) records each applied file in `schema_migrations` with its checksum, so a migration runs once per database and later boots skip it; the first boot against a database that predates the ledger re-applies every file once (they are idempotent) and records it. Concurrent starts serialise on an advisory lock. Postgres readiness is handled by the Compose health check.

Verify:

```bash
curl http://localhost:8787/ready
TROVE_SERVICE_TOKEN=local-dev-token TROVE_MCP_URL=http://localhost:8787/mcp npm run test:e2e
```

## Worker

Graph writes enqueue durable `graph_job` rows for:

- `refresh_obsidian_projection`
- `lint_graph`
- `refresh_embeddings`
- `reconcile_node` (write-time reconciliation; conservative heuristic by default — the LLM judge is opt-in via `TROVE_RECONCILE_JUDGE=1`. Cost is bounded by construction: candidates beyond the calibrated `SKIP_DISTANCE` (0.45, a constant in `src/reconcile.ts`) are gated out, survivors are judged in one batched call per write, and `TROVE_RECONCILE_JUDGE_BUDGET` is a per-owner-per-hour backstop (default 100, 0 disables). The budget is **in-process**: each worker tracks its own window and it resets on restart, so across N workers the effective ceiling is N×100 and a crash-loop re-arms it. The distance gate, not the budget, is the real cost bound — the budget only catches pathological bursts)

Run a bounded worker pass:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run jobs:run
```

In production, run `npm run jobs:run:prod` from a cron, platform scheduled job, or separate worker process. The worker claims pending jobs with database row locking, so multiple workers can run safely. Embedding jobs report missing coverage when no provider is configured; with `TROVE_EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY`, they batch missing node revisions and **text chunks** into `pgvector`.

Stop only the app:

```bash
docker compose --profile app stop app
```

## Embedding Storage

The vector index is built on `text_chunk`, not `text_unit`: a chunk is a contiguous run of text units inside one section, capped by `CHUNK_TARGET_CHARS` (1200) and embedded with a written context prefix. Text units remain the citation grain — a semantic hit expands back to the units its chunk covers. One vector per line was 98% of the vector bytes and the direct cause of the 3 September disk-full outage.

### 1. Chunk backfill — no window needed

Nothing to run by hand. Every `refresh_embeddings` job chunks up to 50 un-chunked sources, embeds what is missing, then retires up to 500 per-line vectors whose source is fully chunked and embedded. The background worker drains it; watch `chunkedSources`, `embedded.textChunks` and `retiredTextUnitVectors` in the job results and wait for them to reach zero. Measured on the 188-file Scribe vault: 13,756 embeddable lines become 3,184 chunks, 76.9% fewer vectors.

Deleting rows does not shrink the table. The space comes back with the rewrite in step 2.

### 2. halfvec + tenant conversion — maintenance window

`scripts/convertEmbeddingStorage.ts` converts `embedding.embedding` to `halfvec(1536)` and stamps `embedding.tenant_id` on every row. Measured on 5,000 real-shaped 1536-dimension vectors: 16,669 → 8,404 bytes per row including the index, HNSW build 17.5 s → 7.6 s, recall unchanged. It is not a migration because the rewrite plus the HNSW rebuild cannot finish inside Railway's 120-second healthcheck window, and a retried boot would restart it.

**Run it after step 1 has drained** — the conversion is proportional to row count, so converting the smaller table is the whole point of the ordering.

```bash
# 1. Deploy first. Migration 021 adds the empty tenant_id column (catalog-only,
#    milliseconds), so every new vector is stamped from that moment on and the
#    script only has history to backfill.
# 2. Stop writers: pause the worker, put the API in maintenance.
# 3. Dry run — prints the plan, changes nothing.
DATABASE_URL=... npm run db:convert:embeddings
# 4. Apply.
DATABASE_URL=... npm run db:convert:embeddings -- --apply --parallel=2
```

What it does, and what it locks:

| Step | Lock | Notes |
| --- | --- | --- |
| `drop index embedding_hnsw_idx` | `ACCESS EXCLUSIVE`, instant | Semantic search falls back to an exact scan for the rest of the window: correct, just slower, and after step 1 the table is small enough to bear it. Migration 016 measured the tenant backfill *with* the index in place at 176 s, and the index doubling 481 MB → 996 MB with no way back but a REINDEX. Dropping first avoids both, and the index has to be rebuilt at the end regardless. |
| batched `update … set tenant_id` | row locks only | Resumable: the predicate (`tenant_id is null`) is the progress marker, so an interrupted run continues rather than restarting. `--batch=N`, default 5000. |
| `alter column … type halfvec(1536)` | `ACCESS EXCLUSIVE` for the whole rewrite | The long step. One pass reclaims the dead tuples the batch update just made *and* the space left by the per-line vectors step 1 retired. |
| `create index … halfvec_cosine_ops` | `ACCESS EXCLUSIVE` | ~18k vectors rebuild in seconds. `analyze` follows. |

Sizing the rebuild: an HNSW build wants `maintenance_work_mem` (`--maintenance-work-mem=`, default `256MB`) and, for parallel workers, shared memory. **The Trove container has only 62 MB of `/dev/shm`, so a build there needs `max_parallel_maintenance_workers = 0`** — the script's default. Production is Supabase, not the container, and has room; `--parallel=2` is safe there.

Safe to re-run: every step checks the catalog first, so a second run reports `already converted` and changes nothing.

### Before the script has run

Nothing breaks. `PgGraphStore` reads the embedding column's type and whether every row is stamped from the catalog at startup (`EmbeddingLayout` in `src/pgStore.ts`) and builds its probes to match: `::vector` with the tenant filter reached through the owning row before, `::halfvec` with a filter on `embedding.tenant_id` after. It re-checks an unconverted layout at most once a minute, so a server that was up while the script ran picks the conversion up without a restart. A fresh database (local, CI, a new deployment) is born converted: migration 021 does the same rewrite when the table is empty, where it is catalog-only.

## Production Notes

- Put the service behind TLS.
- Replace local service tokens with managed secrets.
- Keep Postgres backups and point-in-time recovery enabled.
- Use `GET /v1/export/obsidian` or `npm run export:obsidian` for Obsidian projections; do not sync generated markdown as canonical truth.
- Agents should use MCP Streamable HTTP at `/mcp`.
- Use `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/jobs/run`, or the MCP job tools for maintenance visibility and admin operations.
- Interfaces should use `GET /v1/events?afterCursor=...` or `events` for incremental sync checkpoints.
