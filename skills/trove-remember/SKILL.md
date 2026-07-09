---
name: trove-remember
description: Save durable knowledge into the Trove memory graph — new facts, decisions, gotchas, AND corrections to known facts. Replaces the old trove-capture and trove-update skills; the remember tool handles create-vs-revise itself. Trigger after a session produced insight worth keeping, when the user states a fact or preference to remember, or when a known fact changed (PR merged, port moved, X replaced Y).
---

# trove-remember

> "Save the gold — the graph decides whether it's new or a change of mind."

## When to use

- **Mid-session** when a decision, root cause, gotcha, or durable fact crystallises (do not wait for wrap-up).
- After a debugging or design session that produced new understanding.
- The user stated a fact, constraint, or preference to remember.
- A known fact changed: "PR merged — mark it done", "that port is 5433, not 5432", "X replaced Y".
- End-of-session pass: 3–8 high-value atoms with links — **not** one mega session-summary node.

When **not** to use:

- A specific external source to index → `trove-ingest` first, then remember distilled atoms citing text units.
- A question to answer → `trove-recall`.
- Trivial Q&A / ephemeral debugging chatter.

## Process

### Step 1 — scan and propose

Collect candidates: decisions ("we'll do X because Y"), facts (values, IDs, paths, ports stated as authoritative), gotchas ("this fails if…"), preferences ("always…", "never…"). Present a short numbered checklist; the user picks. Be conservative — 5 high-quality atoms beat 30 noisy ones. For a single explicit correction ("port is 5433"), skip the proposal and just do it.

### Step 2 — remember

One call per atom:

```
remember { title, type, summary, content?, evidence, links }
```

- `remember` searches for an exact title/slug match itself: match → new revision of that node; no match → new node. No baseRevisionId to manage.
- **Check the response.** `action` tells you what happened; `similar` lists near-matches it did NOT merge into. If one of those is the node you meant, re-call with `slug: <that-slug>` to force the revision.
- Evidence: cite `sourceId`/`textUnitId` when the fact came from a document; otherwise say "agent inference from session <date>" in the summary.
- Links: connect to the relevant project/domain nodes via `links: [{toSlug, predicate}]`.

### Step 3 — supersede relationships (only when a belief between nodes changed)

- `connect { fromNodeId, toNodeId, predicate, supersedesEdgeId }` — atomically creates the new edge and expires the old one.
- Belief retired with no replacement: `forget { edgeIds: [...] }`, or `forget { query, dryRun: true }` to preview first.
- Find edge ids via `read` (connections) or `neighborhood`.
- Never express change by deleting: `asOf` time-travel depends on the trail.

### Step 4 — propagate

`neighborhood { nodeId, depth: 1 }` on changed nodes — adjacent summaries restating the old fact get their own `remember` (slug-targeted) or get flagged to the user.

### Step 5 — mirror

If the fact belongs on a human-readable vault page, run the matching `/scribe-*` flow. Note that vault import is one-way (vault → graph); graph edits don't write back to the vault automatically.

### Step 6 — confirm

One sentence: how many atoms landed (created vs revised), with slugs.

## Anti-patterns

- **Don't** save without proposing first when harvesting a session — the user picks. (Direct corrections are exempt.)
- **Don't** capture speculation as fact; decisions are things the user agreed to.
- **Don't** ignore `similar` — a near-match you should have merged into is graph rot.
- **Don't** rewrite a whole node when a summary tweak suffices; pass only the fields that changed.
- **Don't** delete edges. Supersede (`connect`) or retire (`forget`).
