---
name: trove-recall
description: Use when a question should be answered from the Trove memory graph rather than re-derived - prior projects, decisions, system knowledge, preferences, "what was I working on". Routes grep → read → recall by query shape (exact string, known slug, open question), synthesizes with citations, and remembers non-trivial answers back so exploration compounds.
---

# trove-recall

> Good answers don't disappear into chat history — they become graph atoms.
> Match Scribe depth: exact lookup and full-page read first; `recall` is for open questions.

## When to use

- A factual question about anything previously ingested or remembered.
- A synthesis ("compare X and Y", "state of Z", "what am I working on").
- A recommendation grounded in the user's own context.

When **not** to use:

- The answer is in the current working directory's code — read it directly.
- Fresh research with no coverage — research first, then offer `trove-ingest`.

## Process

### Step 1 — pick the retrieval tool (order matters)

| Query shape | Tool | Notes |
|---|---|---|
| **Exact string** — ticket id, product code, error text, config key, email | `grep { pattern }` | Prefer over `recall`. Example: `INV-1042`, `ECONNRESET`. Then `read` if you need the full note. |
| **Known note** — you have the name (`billing-pricing-rules`, `onboarding-checklist`) | `read { slug }` | Full body. Do not rely on a short pack alone. |
| **Open question** — "how do we handle refunds?", "what's the plan for mobile?" | `recall { query, tokenBudget }` | Default budget **8000**. Phrase as a real question. |

- The `recall` pack is a **brief**, not always the whole note.
- If the top hit is right but thin → **`read` that slug**.
- Never use `recall` for a lone ticket id or error string.

### Step 2 — drill down (only if needed)

- `read { id | slug }` for full body + evidence, or a raw source document by source id.
- `neighborhood { nodeId, depth, asOf? }` when structure or belief history matters.
- Time travel lives on `read { asOf }` and `neighborhood { asOf }` only; `recall` answers from present belief and rejects `asOf`.

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

- **Don't** call `recall` for an exact identifier — use `grep`.
- **Don't** answer a known runbook from a thin pack — `read` the slug for the full body.
- **Don't** chain grep→read→read→neighborhood when one well-chosen `recall` already answers an open question.
- **Don't** dump the raw context pack on the user. Synthesize.
- **Don't** remember trivial lookups back into the graph.
