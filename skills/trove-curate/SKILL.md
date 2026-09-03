---
name: trove-curate
description: Use to clean up and maintain a Trove memory graph from inside an agent session - merge duplicates, record supersession, retire stale beliefs, tighten summaries - using the session's own model as the judge. Bounded passes, reversible actions only, proposals for anything destructive. Trigger on "clean up my trove", "make my graph healthy", after a burst of captures, or weekly.
---

# trove-curate

> The session's model is the cheapest curator Trove will ever have. It is already here, already paid for, and already knows what was just written.

## When to use

- The user asks to clean up, tidy, dedupe, or "make healthy" their Trove graph.
- `remember` returned a non-empty `similar` list and you did not act on it.
- After an `ingest` burst or a long session that captured many atoms.
- Weekly, as a scheduled routine, if the user has one.

## Ground rules (read before acting)

1. **Reversible only.** Beliefs change by supersession and invalidation, never deletion. `connect { supersedesEdgeId }` and `forget` are the only retirement tools. Never rewrite `content`: it cites evidence. Only `summary` and `title` may be regenerated.
2. **Bounded.** Curate at most 25 nodes per pass. Do not read the whole graph. Work from `lint` findings, `similar` lists, and `recall` neighbourhoods.
3. **Two tiers of autonomy.**
   - *Apply without asking:* a `supersedes` edge between two atoms that state the same fact with different values and you are confident which is newer; a `connect` from an orphan to a hub **after reading the orphan**; a regenerated `summary` on a node whose summary no longer matches its content.
   - *Propose, then apply only what the user picks:* merging two nodes; `forget` on anything; invalidating a belief as stale; any change touching more than 5 nodes at once.
4. **Every action carries a reason.** Say why in the `summary` or the edge, so the event log explains itself later.
5. **Stability.** Two recalls a minute apart must return the same answer. Do not reshuffle what is not broken.

## Process

### Pass 1 - duplicates and supersession (highest value)

1. Run `lint`. Collect `duplicate_title`, `reconcile_duplicate` and `reconcile_contradiction` findings — the reconcile ones already name both nodes and carry the judge's reason.
2. For each pair (cap 10): `read` both. Decide one of:
   - **Same fact, one is newer** -> `connect` newer -> older with predicate `supersedes`. Apply.
   - **Same fact, same value, two wordings** -> propose a merge: keep the one with better evidence, `connect` the other with `supersedes`, note the survivor. Propose.
   - **Different facts with a shared title** -> propose retitling the less specific one via `remember` with its `slug`. Propose.
3. Also check anything you wrote this session where `remember` returned `similar`: `read` the top match and treat it as a pair above.

### Pass 2 - orphans and weak evidence

1. From `lint`: `orphan_node`, `missing_evidence`, `weak_evidence`.
2. Orphans (cap 10): `read` the node, `recall` its title with a small `tokenBudget` (2000) to find its hub, then `connect` with `mentions` or `part_of`. Apply only when the hub is unambiguous; otherwise propose.
3. Missing or weak evidence: if the session has the source, `annotate` the span. If not, propose a `remember` revision that states "agent inference" in the summary. Never invent a citation.

### Pass 3 - stale beliefs (propose only)

1. Candidates are nodes of type `claim`, `decision`, or `task` that (a) have no inbound edges and (b) have not been recalled in 90 days (`lastAccessedAt`), or that describe something the session knows has changed.
2. For each (cap 5): `read` it. If it is clearly obsolete, propose `forget` with a one-line reason. If it is still true but unlinked, treat it as an orphan (Pass 2).
3. Do not touch `person`, `infrastructure`, or `pattern` nodes in this pass; they go stale slowly and are cheap to keep.

### Pass 4 - condense (only when asked, or when a chain is long)

1. Find nodes with more than three revisions or a `supersedes` chain longer than three.
2. Regenerate `summary` (not `content`) to state the current belief in two sentences, keeping the citations. Write it with `remember` using the node's `slug` so it lands as a new revision. History stays.

### Close

Report in this shape:

```
Curated <N> nodes.
Applied: <k> supersedes edges, <k> orphan links, <k> summaries.
Proposed (needs your OK): <list, one line each, with the reason>
Skipped: <what was looked at and left alone, briefly>
Open findings after: <lint summary>
```

Apply proposals the user approves, then re-run `lint` and show the before/after counts.

## Anti-patterns

- **Don't** delete, and don't `forget` without proposing first.
- **Don't** merge on title similarity alone. Read both.
- **Don't** rewrite `content`; the citations live there.
- **Don't** curate the whole graph in one go. Twenty-five nodes, then stop and report.
- **Don't** treat a leaf note with no links as broken. Some facts are leaves.
