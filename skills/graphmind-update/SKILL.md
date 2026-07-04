---
name: graphmind-update
description: Use when a specific known fact in the GraphMind memory graph has changed - a project finished, a value corrected, a relationship replaced. Edits the node with optimistic revision checking and supersedes edges instead of deleting them, preserving belief history.
---

# graphmind-update

> The graph never forgets; it changes its mind on the record.

## When to use

- "PR merged — mark it done." / "That port is 5433, not 5432." / "X replaced Y."

When **not** to use:

- New source to index → `graphmind-ingest`.
- Open-ended session harvest → `graphmind-capture`.

## Process

### Step 1 — locate

`graph.search { query }` → `graph.read { nodeId | slug }`. The read returns the current `revisionId` — you need it to write.

### Step 2 — edit the node

```
graph.update { nodeId, baseRevisionId: <revisionId from read>, title?, summary?, content? }
```

A conflict response means someone wrote since your read: re-read, merge, retry. Never blind-retry with the new token without looking.

### Step 3 — supersede relationships

If the change replaces a belief between nodes:

- `graph.link { fromNodeId, toNodeId, predicate, supersedesEdgeId: <old edge id> }` — atomically creates the new edge and invalidates the old one (`expired_at`, `valid_until`, `invalidated_by`).
- Belief retired with no replacement: `graph.invalidate_edge { edgeId }`.
- Find the edge ids via `graph.read` (connections) or `graph.neighborhood`.

Never express change by deleting: `asOf` time-travel depends on the trail.

### Step 4 — propagate

`graph.neighborhood { nodeId, depth: 1 }` — check adjacent nodes whose summaries restate the old fact; update or flag them.

### Step 5 — mirror

If the same fact lives on a vault page, run `/scribe-update` for the human surface (or note the divergence).

### Step 6 — confirm

What changed, which edges were superseded, what was propagated.

## Anti-patterns

- **Don't** rewrite a whole node when a summary tweak suffices.
- **Don't** skip `baseRevisionId` handling — silent overwrites are how memories rot.
- **Don't** delete edges. Supersede or invalidate.
