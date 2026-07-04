---
name: trove-lint
description: Use to health-check the Trove memory graph - orphan nodes, missing evidence, duplicate titles, dangling edges. Interprets graph.lint findings, separates real issues from noise, and proposes fixes (linking passes, evidence backfill, merges) without auto-applying them.
---

# trove-lint

> A memory that isn't inspected quietly rots.

## When to use

- Periodic health check (after a stretch of captures/ingests, or weekly).
- After an import, to see what arrived unlinked.
- When recall quality feels off.

## Process

### Step 1 — run

`graph.lint` (or read the `trove://lint` resource). Findings: `orphan_node`, `missing_evidence`, `duplicate_title`, `dangling_edge`.

### Step 2 — triage

- **Orphans**: real pages nothing links to. For each (or the top N), `graph.recall` its title to find candidate hubs; propose `graph.link { predicate: "mentions" | "part_of" }` connections.
- **Missing evidence**: agent-captured claims without citations. Propose evidence backfill (`graph.annotate` against a source span) or an explicit inference note via `graph.update`.
- **Duplicate titles**: read both; propose merging (repoint edges to the survivor, then the loser is soft-deleted server-side) — surface, don't auto-merge.
- **Dangling edges**: endpoints deleted; propose `graph.invalidate_edge`.

### Step 3 — propose, then apply

Present findings grouped with proposed fixes as a checklist; apply what the user picks. Bulk linking passes are fine once approved.

### Step 4 — confirm

Summary counts before/after; what remains open.

## Notes

- Smoke-test debris (actors ending `-smoke`) is cleaned with `npm run db:clean:smoke -- --apply` in the repo, not by hand.
- Jobs pending/failed counts come with the lint report on the dashboard's health card.

## Anti-patterns

- **Don't** auto-fix without proposing — especially merges.
- **Don't** link orphans to hubs on title similarity alone; read the node first.
- **Don't** treat every warning as urgent; a leaf note with no links can be legitimate.
