# Quick start

Get Trove running locally, generate a key, connect your agents, and import your notes. For the hosted service (mytrove.in) you can skip to [Connect your agents](#connect-your-agents) and use your dashboard API key.

## Run it locally

Requirements: Node 22+, Docker.

```bash
git clone https://github.com/anunay999/trove.git && cd trove
npm install                 # installs the server AND the web dashboard
cp .env.example .env        # sane local defaults (Postgres on :5433)
npm run setup               # starts Postgres, applies schema + migrations
npm run web:build && npm start
```

Open **http://localhost:8787** — the dashboard is served by the API. With no tokens configured, local dev runs with auth disabled and needs no key.

That's it. `npm install` pulls in the web app's dependencies too (via a postinstall step), and `npm run setup` bundles the database bootstrap, so there's nothing else to wire up. If you skip the `.env` copy, set `DATABASE_URL` in your shell instead.

## Generate an API key

Two ways to get a credential:

- **Hosted:** sign in at [mytrove.in](https://mytrove.in) and create a scoped key on the **API keys** page — it's copyable and you pick its permissions.
- **Self-hosted service tokens:** put scoped bearer tokens in `.env` (copy `.env.example` first):

```bash
openssl rand -hex 16   # e.g. 9f2c...
```

```bash
# .env — format: token|actor-name|scopes  (separate multiple tokens with ;)
TROVE_SERVICE_TOKENS='trove_9f2c...|my-agent|graph:read,graph:write,graph:export'
```

| Scope | Tools it unlocks |
|---|---|
| `graph:read` | `recall`, `grep`, `read` + stats/dashboard |
| `graph:write` | `remember`, `connect`, `forget`, `ingest`, `annotate`, views |
| `graph:export` | `export_obsidian` and markdown exports |
| `graph:admin` | everything, including `jobs`/`lint` and maintenance |

Restart the server and every request now needs `Authorization: Bearer <token>`. The dashboard prompts for the key on first load and remembers it.

## Connect your agents

**Claude Code / Claude Desktop (hosted or local HTTP):**

```bash
claude mcp add trove --transport http https://mytrove.in/mcp \
  --header "Authorization: Bearer <your-token>"
```

Swap the URL for `http://localhost:8787/mcp` when running locally.

**Local stdio (no server needed):**

```bash
claude mcp add trove -- npx tsx /path/to/trove/src/mcpServer.ts
```

**claude.ai / Claude Desktop Connectors panel (OAuth):** add a custom connector with the URL `https://mytrove.in/mcp` and sign in with Clerk — see [docs/oauth.md](oauth.md).

Agents get a small verb-per-job toolset: `remember`, `recall`, `grep`, `read`, `connect`, and `forget` (plus curation tools like `ingest` for write-scoped keys). Optionally install the companion skills so Claude uses them well:

```bash
npx skills add ./skills -g
```

## Bring your notes

Import an Obsidian vault (or any folder of markdown):

```bash
npm run import:vault -- ~/path/to/vault
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
