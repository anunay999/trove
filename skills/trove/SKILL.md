---
name: trove
description: Use the Trove hosted memory graph (MCP server "trove") to recall prior work, decisions, preferences, and system knowledge before re-deriving them, and to save durable new facts back. Trigger whenever a question touches past projects, "how does my setup work", preferences, decision history, or when a session produces a decision or fact worth remembering. Routes to the trove-recall, trove-remember, trove-ingest, and trove-lint skills; the mcp__trove__* tools (remember, recall, grep, read, connect, forget) are the interface.
---

# trove

> The hosted memory substrate. The Obsidian vault is a projection; this graph is the queryable truth for agents.

Trove (repo `~/dev/trove`, hosted at `https://mytrove.in`, MCP server `trove`) holds the knowledge base as an evidence graph: typed nodes, typed edges with bitemporal lifecycle, full source documents, and an append-only audit log. Every write is attributed; every semantic statement can cite its evidence span.

## The tool surface (one verb each, no overlaps)

| Tool | Use when |
|---|---|
| `grep` | **First** for exact strings — ticket id, error text, config key. Regex over notes + sources. |
| `read` | Full note by name/id, or raw source. After grep/recall when the brief is thin. |
| `recall` | **Open questions** only ("how do we handle refunds?"). Budgeted brief (default 8000), not a full dump. |
| `remember` | Saving a fact/decision/gotcha, new or changed. One write door: revises on exact title/slug match, else creates. Check the returned `similar` list — retarget with `slug` if the dedupe missed. |
| `connect` | Relating two memories. Pass `supersedesEdgeId` to replace a belief on the record. |
| `forget` | Retiring beliefs. Query mode previews (dryRun) first; explicit edgeIds apply immediately. |
| `ingest` | Storing long-form raw material (transcript, page, file) as evidence. Then `remember` the distilled facts citing it. |
| `annotate` | Attaching meaning to evidence without minting a belief. |
| `neighborhood` / `project` / `views` | Subgraphs, renders, saved views (curator flows). |
| `events` / `jobs` / `lint` / `export_obsidian` | Operator plumbing (admin credentials only). |

**Retrieval routing (match Scribe):** exact string → `grep` → optional `read` · known slug → `read` · open question → `recall` → `read` if the top atom is right but incomplete.

**remember vs ingest:** `remember` writes a belief — a small distilled atom that recall ranks. `ingest` stores evidence — a whole document split into citable text units that never competes as a belief. Pipeline: ingest the transcript → remember the few facts worth believing → connect them.

**Session loop (not end-of-day only):** boot with load → work → `remember` mid-session when a decision/fact/gotcha crystallises → `connect` hubs → supersede corrections → close with 3–8 small linked atoms. Never one mega "session summary" node.

**MCP-only clients:** the same doctrine ships as MCP server `instructions`, resource `trove://doctrine`, prompts `trove-recall` / `trove-remember` / `trove-session` / `trove-curate`, and tool descriptions — skills are optional sugar for Claude Code. Every skill is also served at `https://mytrove.in/skills/<name>.md` (index at `/skills.md`), so any agent can be told to read one and follow it.

## Routing

| Situation | Skill |
|---|---|
| Question about prior work, systems, preferences, decisions | `trove-recall` |
| Session produced decisions/facts worth keeping, or a known fact changed | `trove-remember` |
| A specific source (URL, file, paste) should be indexed | `trove-ingest` |
| Health check (read-only report) | `trove-lint` |
| Cleanup: merge duplicates, supersede, link orphans, retire stale beliefs | `trove-curate` |

## Invariants (all skills)

- **Recall before re-deriving; grep before recall when the query is an exact string; read for full runbooks when you know the slug.**
- **Beliefs change by supersession, never deletion.** `connect({supersedesEdgeId})` replaces; `forget` retires. History stays queryable (`neighborhood` with `asOf` / `includeExpired`).
- **No memory without provenance.** Cite `sourceId`/`textUnitId` evidence, or state agent-inference explicitly in the summary.
- **Trust remember's dedupe, verify its choice.** It only merges on exact title/slug; review `similar` in the response and re-call with `slug` when it should have merged.
- **Two surfaces, one memory.** Human-readable syntheses also go to the Scribe vault (`/scribe-*` plugin commands edit the vault directly); the vault importer reconciles vault → graph. Don't fork the two.

## Operations

Hosted MCP: `https://mytrove.in/mcp` with a `trove_*` API key or service token. Local dev: `cd ~/dev/trove && docker compose up -d postgres && npm start`; tokens in `.env` (`TROVE_SERVICE_TOKENS`); health `curl localhost:8787/health`. Vault import (`npm run import:vault`) targets `DATABASE_URL` — local by default; set it explicitly for production.
