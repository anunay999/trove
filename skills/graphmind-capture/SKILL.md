---
name: graphmind-capture
description: Use when the recent conversation produced decisions, facts, gotchas, or new concepts worth persisting to the GraphMind memory graph. Scans the session, proposes a checklist, and captures the selected items as evidence-linked graph atoms. Run at the end of substantial working sessions.
---

# graphmind-capture

> "We just had a useful conversation. Save the gold from it."

## When to use

- After a debugging or design session that produced new understanding.
- After the user stated a fact, constraint, or preference to remember.
- As an end-of-session "wrap up memory" pass.

When **not** to use:

- A specific external source to index → `graphmind-ingest`.
- A specific known fact changed → `graphmind-update`.
- Trivial Q&A.

## Process

### Step 1 — scan the conversation

| Candidate | Signal |
|---|---|
| Decision | "we'll do X because Y", tradeoff resolved |
| Fact | concrete values, IDs, paths, ports stated as authoritative |
| Gotcha / pattern | "watch out for…", "this fails if…" |
| Concept / system | term used 3+ times with no node yet |
| Preference | "always…", "never…", "I like…" from the user |

### Step 2 — dedupe against the graph

For each candidate: `graph.search { query, limit: 5 }`. If a node exists, plan an update/link, not a new node.

### Step 3 — propose

Present a numbered checklist (decisions / facts / gotchas / concepts), each with the intended node `type` and whether it's new or an update. The user picks; be conservative — 5 high-quality candidates beat 30 noisy ones.

### Step 4 — capture selected

- New atom: `graph.capture { title, type, summary, content?, evidence, links }`.
  - Evidence: cite `textUnitId`/`sourceId` when the fact came from a document; otherwise state "agent inference from session <date>" in the summary.
  - Links: connect to the relevant project/domain nodes via `links: [{toSlug, predicate}]`.
- Updated belief: `graph.update` (with `baseRevisionId` from `graph.read`) or `graph.link` with `supersedesEdgeId` when a relationship is replaced.

### Step 5 — mirror to the human surface

If the item is one a human should stumble on while reading the vault, also run the corresponding `/scribe-capture` flow (or note that the next vault import will not create it — captures live graph-first).

### Step 6 — confirm

One sentence: how many atoms landed, with slugs.

## Anti-patterns

- **Don't** save without proposing first — the user picks.
- **Don't** capture Claude's own speculation as fact; decisions are things the user agreed to.
- **Don't** create a node for every term mentioned once.
