# Trove

**A memory that your AI agents keep, so you don't have to.**

Trove is a hosted knowledge graph for agent memory. Claude, Codex, and any MCP-capable agent can write what they learn into it and recall it in later sessions — with every fact traceable back to the source text that justifies it. Your notes stay inspectable, contradictions are superseded instead of overwritten, and the whole graph is browsable in a built-in dashboard.

## What you get

- **Durable agent memory** — agents save facts, decisions, and notes through MCP tools (`remember`, `ingest`) and retrieve them later with `recall`, which packs the most relevant memories into a token budget you set.
- **Time-travel, not overwrites** — facts carry validity intervals. When something changes, the old edge is invalidated, never deleted, so you can ask what the graph believed at any point in time.
- **Evidence, always** — every node links back to the exact source text it came from. Nothing in the graph is unsupported.
- **A dashboard** — memory KPIs, write-cadence heatmap, lint health, and an interactive force-directed graph explorer with a full-document reader.
- **Your notes, imported** — point the importer at an Obsidian vault and it becomes the seed of the graph. Append-heavy files like `log.md` are split into per-entry episodes and deduped, so re-imports only store what's new.

## How it works

Trove is an **evidence graph**: nothing is a free-floating fact. Everything an agent knows traces back to source text.

```
   raw source            addressable spans        distilled beliefs
  ┌───────────┐  ingest  ┌───────────────┐  remember  ┌──────────┐
  │ transcript│ ───────► │  text units   │ ─────────► │  nodes   │
  │ page/file │          │ (cited spans) │  (cites)   │ + edges  │
  └───────────┘          └───────────────┘            └──────────┘
                                                        ▲   recall / grep / read
                                              agents read back here
```

**Writing.** An agent stores raw material with `ingest`, which splits it into addressable **text units**. It then distills the few facts worth keeping with `remember` — small semantic **nodes**, each citing the text unit that justifies it — and links them with `connect`. `remember` is the single write door: it revises an existing node on an exact title/slug match, otherwise creates one, so agents never juggle create-vs-update.

**Reading.** Three verbs, each for a different question. `recall` builds a **token-budgeted context pack** — hybrid lexical+semantic search seeds a one-hop graph expansion, candidates are ranked by relevance plus ACT-R-style activation (recency and frequency), and a greedy packer fills the budget you set. `grep` is exact/regex search over nodes and raw sources, for when you know the string (a port, a slug, an error). `read` pulls one node or source by id or slug.

**Changing its mind.** Beliefs are **bitemporal** and never overwritten. When a fact changes, `connect` with `supersedesEdgeId` (or `forget`) invalidates the old edge — it gets an expiry timestamp but stays in the graph — so you can time-travel with `asOf` and ask what Trove believed at any past moment.

**Staying fresh.** A background worker inside the server drains a job queue every 30 seconds to embed new writes, refresh projections, and run lint. There's nothing to schedule.

**Tiered tools.** The MCP surface is filtered by your credential's scope. Read-only keys see only `recall`, `grep`, and `read`; write keys add `remember`, `connect`, `forget`, `ingest`, and the curation tools; admin keys also see the operator tools (`jobs`, `lint`, `export_obsidian`). Visibility is convenience — every call is still scope-checked server-side.

## Get started

Use the hosted service at **[mytrove.in](https://mytrove.in)** — sign in, create an API key on the dashboard, and point your agent at `https://mytrove.in/mcp`. Or run it yourself in about five minutes.

→ **[docs/quickstart.md](docs/quickstart.md)** — local setup, API keys and scopes, connecting agents (Claude Code, stdio, and the claude.ai OAuth connector), importing an Obsidian vault, and enabling semantic search.

```bash
# the short version, locally
git clone https://github.com/anunay999/trove.git && cd trove && npm install
docker compose up -d postgres
export DATABASE_URL=postgres://trove:trove@localhost:5433/trove
npm run db:schema && npm run db:migrate && npm run web:build && npm start
# → dashboard at http://localhost:8787
```

## Deploy

Trove ships a production Dockerfile (API + dashboard in one image) and a `railway.json`. The reference deployment is **Railway + Supabase Postgres** — see [docs/deployment.md](docs/deployment.md) for the walkthrough, including custom domains.

## Learn more

- [docs/quickstart.md](docs/quickstart.md) — setup, keys, connecting agents, importing notes
- [docs/oauth.md](docs/oauth.md) — the claude.ai OAuth connector (Clerk-backed)
- [docs/development.md](docs/development.md) — architecture, data model, test suites, and design rationale (start here if you're hacking on Trove)
- [docs/mcp.md](docs/mcp.md) — full MCP tool and resource reference
- [docs/agent-api.md](docs/agent-api.md) — HTTP API contract
- [docs/cli.md](docs/cli.md) — the reference CLI
- [docs/memory-db-design.md](docs/memory-db-design.md) — the research behind the design
