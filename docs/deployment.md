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

This keeps migrations idempotent and close to startup. Postgres readiness is handled by the Compose health check.

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
- `reconcile_node` (write-time reconciliation; conservative heuristic by default — the LLM judge is opt-in via `TROVE_RECONCILE_JUDGE=1` and costs up to 5 calls per write, unbounded and proportional to write volume, until backlog #27 gates it on embedding distance)

Run a bounded worker pass:

```bash
DATABASE_URL=postgres://trove:trove@localhost:5432/trove npm run jobs:run
```

In production, run `npm run jobs:run:prod` from a cron, platform scheduled job, or separate worker process. The worker claims pending jobs with database row locking, so multiple workers can run safely. Embedding jobs report missing coverage when no provider is configured; with `TROVE_EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY`, they batch missing node revisions and text units into `pgvector`.

Stop only the app:

```bash
docker compose --profile app stop app
```

## Production Notes

- Put the service behind TLS.
- Replace local service tokens with managed secrets.
- Keep Postgres backups and point-in-time recovery enabled.
- Use `GET /v1/export/obsidian` or `npm run export:obsidian` for Obsidian projections; do not sync generated markdown as canonical truth.
- Agents should use MCP Streamable HTTP at `/mcp`.
- Use `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/jobs/run`, or the MCP job tools for maintenance visibility and admin operations.
- Interfaces should use `GET /v1/events?afterCursor=...` or `events` for incremental sync checkpoints.
