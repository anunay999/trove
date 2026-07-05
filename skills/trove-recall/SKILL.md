---
name: trove-recall
description: Use when a question should be answered from the Trove memory graph rather than re-derived - prior projects, decisions, system knowledge, preferences, "what was I working on". Calls recall for a token-budgeted context pack (or grep for exact strings), synthesizes with citations, and remembers non-trivial answers back so exploration compounds.
---

# trove-recall

> Good answers don't disappear into chat history — they become graph atoms.

## When to use

- A factual question about anything previously ingested or remembered.
- A synthesis ("compare X and Y", "state of Z", "what am I working on").
- A recommendation grounded in the user's own context.

When **not** to use:

- The answer is in the current working directory's code — read it directly.
- Fresh research with no coverage — research first, then offer `trove-ingest`.

## Process

### Step 1 — pick the retrieval tool

- Question contains an **exact string** (port, slug, env var, error message, identifier) → `grep { pattern }` first. Exact match beats semantic search there.
- Otherwise → `recall { query: "<the question, as natural language>", tokenBudget: 2000 }`.
  - Budget 1500–3000 for most questions; toward 4000 only for broad syntheses.
  - Phrase the query as the actual question, not keywords.
  - The pack contains atoms (matched + graph-expanded), connecting edges, evidence excerpts, and citations.

### Step 2 — drill down (only if needed)

- `read { id | slug }` for a specific atom's full summary and evidence, or a raw source document.
- `neighborhood { nodeId, depth, asOf? }` when structure or history matters.

### Step 3 — synthesize

- Lead sentence answers the question.
- Cite node titles/slugs for every non-trivial claim.
- Surface gaps explicitly; offer `trove-ingest` for missing coverage.
- Surface contradictions with both citations; recommend `trove-lint`.

### Step 4 — file the answer back (when non-trivial)

- Synthesis across several atoms → `remember { type: "claim" | "decision" | "pattern", title, summary, evidence, links }` citing the atoms it drew from.
- Plain fact lookup → nothing to file.

### Step 5 — confirm

One-sentence recap; note anything remembered back.

## Anti-patterns

- **Don't** chain grep→read→read→neighborhood when one `recall` call answers it.
- **Don't** dump the raw context pack on the user. Synthesize.
- **Don't** remember trivial lookups back into the graph.
