<p align="center">
  <img src="web/public/favicon.svg" width="72" alt="Trove" />
</p>

<h1 align="center">Trove</h1>

<p align="center"><strong>A memory that your AI agents keep, so you don't have to.</strong></p>

<p align="center">
  <a href="https://github.com/anunay999/trove/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/anunay999/trove/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" /></a>
  <a href="https://github.com/anunay999/trove/issues"><img alt="Issues" src="https://img.shields.io/github/issues/anunay999/trove?color=0088ff" /></a>
  <a href="https://github.com/anunay999/trove/pulls"><img alt="Pull requests" src="https://img.shields.io/github/issues-pr/anunay999/trove?color=0088ff" /></a>
  <a href="https://github.com/anunay999/trove/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/anunay999/trove" /></a>
  <a href="https://mytrove.in"><img alt="Live at mytrove.in" src="https://img.shields.io/badge/live-mytrove.in-863bff" /></a>
</p>

<p align="center">
  <a href="https://mytrove.in">Website</a> ·
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="docs/agent-usage.md">Agent usage</a> ·
  <a href="docs/mcp.md">MCP tools</a> ·
  <a href="docs/oauth.md">OAuth connector</a>
</p>

---

Trove is a hosted knowledge graph for agent memory. Claude, Codex, and any MCP-capable agent can write what they learn into it and recall it in later sessions — with every fact traceable back to the source text that justifies it. Your notes stay inspectable, contradictions are superseded instead of overwritten, and the whole graph is browsable in a built-in dashboard.

## Connect your agent

Point any MCP-capable agent at Trove and it reads and writes your graph across sessions. Create an API key on the dashboard at **[mytrove.in](https://mytrove.in)**, then:

```bash
# Claude Code (hosted)
claude mcp add trove --transport http https://mytrove.in/mcp \
  --header "Authorization: Bearer <your trove_ key>"
```

Running your own instance? Use `http://localhost:8787/mcp` (no key needed when auth is disabled). For the claude.ai / Claude Desktop **Connectors** panel, add `https://mytrove.in/mcp` and sign in with Clerk — see [docs/oauth.md](docs/oauth.md).

Your agent gets a small verb-per-job toolset: `remember`, `recall`, `grep`, `read`, `connect`, `forget` (plus `ingest` and curation tools for write-scoped keys). Nothing else to pass — each credential is scoped to its own private graph automatically.

**How agents should use it** — not as an end-of-day diary, but as working memory: load before re-deriving, capture mid-session, many small linked atoms. See **[docs/agent-usage.md](docs/agent-usage.md)**. The same doctrine is also on the MCP server (`instructions`, resource `trove://doctrine`, tool descriptions).

**Companion skills (optional, Claude Code).** The MCP tools work in any client on their own. Install the skills straight from this repo so Claude uses them with the right discipline — recall before re-deriving, cite evidence, supersede instead of delete:

```bash
npx skills add anunay999/trove -g
```

Full setup — keys, scopes, stdio, importing a vault — is in [docs/quickstart.md](docs/quickstart.md).

## What you get

- **Durable agent memory** — agents save facts, decisions, and notes through MCP tools (`remember`, `ingest`) and retrieve them later with `recall`, which packs the most relevant memories into a token budget you set.
- **Time-travel, not overwrites** — beliefs carry validity intervals. When something changes, the old edge is invalidated, never deleted, so you can ask what the graph believed at any point in time.
- **Evidence, by construction** — recalled atoms either resolve to cited source text or are explicitly marked `AGENT INFERENCE`; the linter flags evidence-free nodes (`missing_evidence`) for review.
- **A dashboard** — memory KPIs, write-cadence heatmap, lint health, and an interactive force-directed graph explorer with a full-document reader.
- **Your notes, imported** — point the importer at an Obsidian vault and it becomes the seed of the graph. Append-heavy files like `log.md` are split into per-entry episodes and deduped, so re-imports only store what's new.

## How it works

Trove is an **evidence graph**: sourced facts trace back to cited text, while evidence-free conclusions stay visibly marked as agent inference.
<img width="550" height="409" alt="image" src="https://github.com/user-attachments/assets/d19b60e1-086a-48ff-9522-31e518ec0f06" />



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

**Changing its mind.** Facts and relationships keep recorded history instead of being overwritten. Each node revision snapshots its title, summary, and content; `read({ asOf })` returns the newest snapshot recorded by that time, or `null` if the fact did not exist yet. Relationship supersession remains non-destructive: `connect` with `supersedesEdgeId` (or `forget`) expires the old edge, while `neighborhood`/`recall` use `asOf` for recorded-time edge visibility and `validFrom`/`validUntil` for world-time filtering. Evidence and annotations on a historical node read currently reflect their present state.

**Staying fresh.** A background worker inside the server drains a job queue every 30 seconds to embed new writes, refresh projections, and run lint. There's nothing to schedule.

**Tiered tools.** The MCP surface is filtered by your credential's scope. Read-only keys see only `recall`, `grep`, and `read`; write keys add `remember`, `connect`, `forget`, `ingest`, and the curation tools; admin keys also see the operator tools (`jobs`, `lint`, `export_obsidian`). Visibility is convenience — every call is still scope-checked server-side.

## Get started

Use the hosted service at **[mytrove.in](https://mytrove.in)** — sign in, create an API key on the dashboard, and point your agent at `https://mytrove.in/mcp`. Or run it yourself in about five minutes.

→ **[docs/quickstart.md](docs/quickstart.md)** — local setup, API keys and scopes, connecting agents (Claude Code, stdio, and the claude.ai OAuth connector), importing an Obsidian vault, and enabling semantic search.

```bash
# the short version, locally
git clone https://github.com/anunay999/trove.git && cd trove
npm install                 # server + web dashboard
cp .env.example .env
npm run setup               # Postgres + schema + migrations
npm run web:build && npm start
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

## Contributing & license

Pull requests are welcome — CI runs typecheck, the store test suites, and the web build, and `main` requires a reviewed PR. Please don't include secrets or real connection strings in a diff. Security issues: see [SECURITY.md](SECURITY.md).

Licensed under the [GNU AGPL-3.0](LICENSE). You're free to use, modify, and self-host Trove; if you run a modified version as a network service, you must make your source available under the same license.
