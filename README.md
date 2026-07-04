# Trove

**A memory that your AI agents keep, so you don't have to.**

Trove is a hosted knowledge graph for agent memory. Claude, Codex, and any MCP-capable agent can write what they learn into it and recall it in later sessions — with every fact traceable back to the source text that justifies it. Your notes stay inspectable, contradictions are superseded instead of overwritten, and the whole graph is browsable in a built-in dashboard.

## What you get

- **Durable agent memory** — agents save facts, decisions, and notes through MCP tools (`graph.capture`, `graph.ingest`) and recall them later with `graph.recall`, which packs the most relevant memories into a token budget you set.
- **Time-travel, not overwrites** — facts carry validity intervals. When something changes, the old edge is invalidated, never deleted, so you can ask what the graph believed at any point in time.
- **Evidence, always** — every node links back to the exact source text it came from. Nothing in the graph is unsupported.
- **A dashboard** — memory KPIs, write-cadence heatmap, lint health, and an interactive force-directed graph explorer with a full-document reader.
- **Your notes, imported** — point the importer at an Obsidian vault and it becomes the seed of the graph. Append-heavy files like `log.md` are split into per-entry episodes and deduped, so re-imports only store what's new.

## Quick start (local, 5 minutes)

Requirements: Node 22+, Docker.

```bash
git clone https://github.com/anunay999/trove.git && cd trove
npm install

# 1. Start Postgres (pgvector, host port 5433) and create the schema
docker compose up -d postgres
export DATABASE_URL=postgres://trove:trove@localhost:5433/trove
npm run db:schema && npm run db:migrate

# 2. Start the API + dashboard
npm run web:build
npm start
```

Open **http://localhost:8787** — the dashboard is served by the API. With no tokens configured, local dev runs with auth disabled and needs no key.

## Generate an API key

Trove uses simple scoped bearer tokens. Generate one and put it in `.env` (copy `.env.example` first):

```bash
openssl rand -hex 16   # e.g. 9f2c...
```

```bash
# .env — format: token|actor-name|scopes  (separate multiple tokens with ;)
TROVE_SERVICE_TOKENS='trove_9f2c...|my-agent|graph:read,graph:write,graph:export'
```

| Scope | Allows |
|---|---|
| `graph:read` | search, recall, read, stats, dashboard |
| `graph:write` | capture, ingest, link, annotate |
| `graph:export` | Obsidian/markdown exports |
| `graph:admin` | everything, including running maintenance jobs |

Restart the server and every request now needs `Authorization: Bearer <token>`. The dashboard will prompt for the API key on first load and remember it.

## Connect your agents

**Claude Code / Claude Desktop (hosted or local HTTP):**

```bash
claude mcp add trove --transport http http://localhost:8787/mcp \
  --header "Authorization: Bearer <your-token>"
```

**Local stdio (no server needed):**

```bash
claude mcp add trove -- npx tsx /path/to/trove/src/mcpServer.ts
```

Agents get tools like `graph.recall`, `graph.capture`, `graph.ingest`, `graph.query`, and `graph.read`. Optionally install the companion skills so Claude uses them well:

```bash
npx skills add ./skills -g
```

## Bring your notes

Import an Obsidian vault (or any folder of markdown):

```bash
npm run import:scribe -- ~/path/to/vault
```

Re-running is safe: unchanged files are hash-deduped no-ops, and dated log files only store new entries.

## Semantic search (optional)

Lexical search works out of the box. For semantic recall, add an embedding provider to `.env`:

```bash
TROVE_EMBEDDING_PROVIDER=openai
TROVE_EMBEDDING_MODEL=text-embedding-3-small
TROVE_EMBEDDING_DIMENSIONS=1536
OPENAI_API_KEY=sk-...
```

New ingests are embedded automatically: a background worker in the server drains the job queue every 30 seconds. Nothing to run, nothing to schedule.

## Deploy

Trove ships a production Dockerfile (API + dashboard in one image) and a `railway.json`. The reference deployment is **Railway + Supabase Postgres** — see [docs/deployment.md](docs/deployment.md) for the walkthrough, including custom domains.

## Learn more

- [docs/development.md](docs/development.md) — architecture, data model, test suites, and design rationale (start here if you're hacking on Trove)
- [docs/mcp.md](docs/mcp.md) — full MCP tool and resource reference
- [docs/agent-api.md](docs/agent-api.md) — HTTP API contract
- [docs/cli.md](docs/cli.md) — the reference CLI
- [docs/memory-db-design.md](docs/memory-db-design.md) — the research behind the design
