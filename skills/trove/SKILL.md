---
name: trove
description: Use the Trove hosted memory graph (MCP server "trove") to recall prior work, decisions, preferences, and system knowledge before re-deriving them, and to capture durable new facts back. Trigger whenever a question touches past projects, "how does my setup work", preferences, decision history, or when a session produces a decision or fact worth remembering. Routes to the trove-recall, trove-capture, trove-ingest, trove-update, and trove-lint skills; the mcp__trove__* tools are the interface.
---

# trove

> The hosted memory substrate. The Obsidian vault is a projection; this graph is the queryable truth for agents.

Trove (repo `~/dev/trove`, service `:8787`, MCP server `trove`) holds the knowledge base as an evidence graph: typed nodes (projects, patterns, decisions, infrastructure, claims), typed edges with bitemporal lifecycle, full source documents, and an append-only audit log. Every write is attributed; every semantic statement can cite its evidence span.

## Routing

| Situation | Skill | Core tools |
|---|---|---|
| Question about prior work, systems, preferences, decisions | `trove-recall` | `graph.recall`, `graph.read`, `graph.read_source` |
| Session produced decisions/facts worth keeping | `trove-capture` | `graph.search`, `graph.capture`, `graph.link` |
| A specific source (URL, file, paste) should be indexed | `trove-ingest` | `graph.ingest`, `graph.capture`, `graph.annotate` |
| A known fact changed | `trove-update` | `graph.search`, `graph.update`, `graph.link` (supersede), `graph.invalidate_edge` |
| Health check / housekeeping | `trove-lint` | `graph.lint`, `graph.link` |

## Invariants (all skills)

- **Recall before re-deriving.** One `graph.recall` call with a `tokenBudget` beats grepping the vault: it returns activation-ranked atoms, edges, evidence excerpts, and citations, and never exceeds the budget.
- **Beliefs change by supersession, never deletion.** `graph.link({supersedesEdgeId})` replaces a belief; `graph.invalidate_edge` retires one. History stays queryable (`graph.neighborhood` with `asOf` / `includeExpired`).
- **No capture without provenance.** Cite `sourceId`/`textUnitId` evidence, or state agent-inference explicitly in the summary.
- **Search before creating.** Duplicates are graph rot; link or update instead.
- **Two surfaces, one memory.** Human-readable syntheses also go to the Scribe vault (`/scribe-*`); the importer reconciles vault → graph. Don't fork the two.

## Operations

If tools fail: `cd ~/dev/trove && docker compose up -d postgres && npm start`. Tokens in `~/dev/trove/.env` (`TROVE_SERVICE_TOKENS`); dashboard `http://localhost:8787/` (set `localStorage.trove_token`); health `curl localhost:8787/health`.
