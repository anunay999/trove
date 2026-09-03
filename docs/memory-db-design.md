# If We Built a Purpose-Built Memory Database

Step-back design study: what would a database look like if it were invented *for* agent memory, the way LSM-trees were invented for write-heavy ingest or vector indexes for ANN? Grounded in a verified deep-research pass (July 2026) over agent-memory systems (Zep/Graphiti, Mem0, HippoRAG, LongMemEval, Letta, Cognee, Cloudflare Agent Memory, LangChain Agent Builder) and database-design history (XTDB bitemporality, Kuzu CIDR 2023, event sourcing, hybrid search).

## The Core Insight

Every database family exists because one workload invariant was expensive in the previous generation:

| Family | Invariant it made cheap |
|---|---|
| LSM-tree stores | sustained append-heavy writes |
| Datomic / XTDB | "what did we believe at time T?" — immutability + time-travel |
| Event sourcing | state as a fold over an append-only log |
| Property-graph DBs | k-hop traversal without join explosion |
| Vector DBs | approximate nearest-neighbor at scale |
| Search engines | lexical relevance ranking |
| CRDT stores | multi-writer convergence without coordination |

Agent memory is not any single one of these. It is a specific **bundle of invariants**, plus two that no existing engine provides:

1. **Beliefs change without history being lost.** Facts get superseded, contradicted, and corrected retroactively. This is exactly the workload bitemporal databases (XTDB, SQL:2011) were built for — and Zep/Graphiti independently converged on the same four-timestamp model for agent memory: `t_created`/`t_expired` (when the system learned/retired the fact) plus `t_valid`/`t_invalid` (when the fact was true in the world). Verified: Graphiti resolves contradictions by *edge invalidation, never deletion* — the old edge's `t_invalid` is set to the new edge's `t_valid`.
2. **The reader is an LLM with a token budget.** No existing database has a query operator whose result unit is "the best context pack that fits in N tokens." This is the genuinely novel primitive. Verified evidence that it matters: long-context models lose ~30% accuracy reading full history vs. oracle retrieval (LongMemEval, ICLR 2025); selective retrieval cuts p95 latency ~91% and token cost >90% (Mem0) — though full-context still wins on raw accuracy, so the budget operator is an economic primitive, not a quality one.
3. **The "index build" involves an LLM.** Writes are cheap appends of episodes; the expensive background work is extraction, entity resolution, and contradiction detection — the memory DB's equivalent of LSM compaction. Reconciliation is the compaction of meaning.
4. **Traversal substitutes for iterative retrieval.** HippoRAG (NeurIPS 2024, verified): single-step graph-based retrieval matches or beats iterative LLM retrieval loops while being 10–30× cheaper and 6–13× faster. A traversal operator seeded from hybrid-search hits is a first-class query primitive, not a nice-to-have.
5. **Salience is a ranking signal with 40 years of prior art.** ACT-R activation = f(recency, frequency, semantic alignment, noise). Store per-atom access counts and last-access timestamps; compute activation at query time. Verified caveat: the evidence supports forgetting as an *efficiency* mechanism (bounded working set), not as a *correctness* necessity — so decay ranks and archives, it never deletes.

## What You Would NOT Build

A new storage engine. Every serious system composes:

- Zep: Neo4j + embedded Lucene (BM25 + cosine + BFS)
- Cognee: LanceDB (vectors) + Kuzu (graph) + Postgres (metadata)
- Cloudflare Agent Memory: SQLite-in-Durable-Objects + Vectorize
- LangChain Agent Builder: Postgres, exposed to the agent as a virtual filesystem

The Kuzu CIDR 2023 paper's own criteria say a dedicated graph engine earns its keep only when recursive/multi-hop joins are the hot path; at personal/small-team scale (thousands–low-millions of atoms), recursive CTEs are fine and pgvector's known limits (HNSW build pain starts ~10M rows) are irrelevant. **The purpose-built part is the semantic layer and the query operators, not the pages-and-B-trees layer.** Trove's existing Postgres decision survives the step-back intact.

Also verified: memory interop is greenfeld — no framework's wire format has been adopted by any other (Letta's `.af` is the closest and even Letta calls cross-framework loading theoretical). A documented export format (the Obsidian projection already is one) is a differentiator, not a compliance requirement. MCP standardizes the *protocol*, nobody has standardized the *content format*.

## The Five Primitives of a Memory DB

If "MemDB" were a product, its data model and query surface would be:

### 1. Bitemporal belief atoms
The target model gives facts and relationships both world time and recorded time, with supersession represented by expiry rather than deletion. Trove's shipped model is deliberately narrower: edges carry `valid_from`/`valid_until`, `created_at`/`expired_at`, and `invalidated_by`; node revisions snapshot title, summary, and content on recorded time only. `read({ asOf })` reconstructs a node fact from `node_revision`, while `neighborhood` applies recorded-time visibility to edges. `recall` answers from present belief only and rejects `asOf`: its search, supersession marks, and evidence have no historical form, and a pack that mixed present bodies with past edge visibility would be temporally incoherent. Historical node reads currently keep evidence and annotations at their present state.

### 2. Mandatory provenance
No semantic atom without a path back to an episode/span (or an explicit `agent_inference` marker). Trove already has this via `annotation` + `text_unit`; it is the right call and rarer than it should be — Graphiti's episode subgraph is the only major production analogue.

### 3. Write-time reconciliation (semantic compaction)
`capture` is not an INSERT; it is: extract → resolve entities against existing nodes → detect contradictions among temporally overlapping claims → invalidate losers → link evidence → append event. Synchronously do the cheap part (exact/embedding-similarity candidate lookup); enqueue the LLM-judged part as a `graph_job`. The event log already makes this replayable.

### 4. Activation-ranked recall
`score = w_r·recency + w_f·frequency + w_s·semantic_match + w_c·graph_centrality`, computed at query time from `access_count`, `last_accessed_at`, embedding distance, and degree. Reads bump the counters (memory strengthens what it retrieves — the ACT-R loop). Low-activation atoms fall out of default retrieval and eventually archive; they remain queryable.

### 5. Token-budgeted context packs
The flagship read operator:

```
graph.recall({ query, token_budget, as_of?, mode? })
  → { atoms[], evidence_spans[], neighborhood_summary, citations[], spent_tokens }
```

Internally: hybrid retrieval (FTS + pgvector fused with RRF) seeds a 1–2-hop traversal; candidates are activation-ranked; the packer greedily fills the budget with claims-first-then-evidence, always carrying citations. This is the operator that makes the store "agent-native" rather than "a database an agent can use."

Index-side lessons to adopt from LongMemEval (all three verified to measurably improve recall): index extracted facts alongside raw text (Trove embeds the current `node_revision`), decompose long sources into session/section-granular units (already done via `text_unit`), and expand queries with temporal scoping (recorded-time fact reads now use `node_revision.created_at`).

## Trove v2 Delta

Ordered by leverage; the schema is already ~70% of the way there.

> Status (updated 2026-08-06): items 1, 3, and 4 below are implemented — bitemporal edges with
> `supersedesEdgeId`/`graph.invalidate_edge` (migration `003_bitemporal_activation.sql`) plus
> recorded-time node fact snapshots and `read({ asOf })` (migration `012_fact_revision_snapshots.sql`),
> `graph.recall` with `tokenBudget`, and activation columns bumped on read (batched: bumps buffer in
> process and drain in one `unnest` statement per window, `TROVE_ACTIVATION_FLUSH_MS`). Covered by
> the `bitemporal`, `fact-time-travel`, and `recall` suites on both drivers. Reconciliation
> is shipped (status below); embeddings index only the current node revision by design.

> Shipped vs designed (2026-07-19): hybrid retrieval fuses lexical and semantic rankings
> with RRF. Activation ranking uses recency, frequency, graph degree, and semantic
> alignment derived from embedding distance (`w_s`); explicit `read` bumps the counters,
> recall packing deliberately does not. The ACT-R noise term is the only activation
> element still unshipped, deliberately preserving deterministic ranking. Decay/archive
> are not implemented — low-activation atoms rank lower but are never archived or deleted.
> Tombstoned nodes (via `forget`) are soft-deleted, not archived.

> Status (2026-07-19, reconciliation shipped): write-time reconciliation is now live as
> `reconcile_node` graph jobs — capture and content-changing updates enqueue a per-node
> pass that candidate-matches against existing nodes (lexical + semantic search) and
> judges the surviving candidates. An LLM judge (OpenAI, `TROVE_RECONCILE_JUDGE_MODEL`, heuristic
> fallback without a key) classifies supersedes / duplicate / contradicts / related /
> distinct. Cost is bounded (backlog #27, 2026-07-20): a calibrated distance gate
> (`TROVE_RECONCILE_SKIP_DISTANCE`, default 0.45) excuses far candidates without a
> call, survivors are judged in one batched call per write, and a per-owner hourly
> budget (`TROVE_RECONCILE_JUDGE_BUDGET`) is the backstop. A confident `supersedes`
> verdict writes a non-destructive `supersedes`
> edge and recall marks the replaced atom `SUPERSEDED by <title>`; contradictions and
> duplicates are flagged in the job result for an agent to resolve — auto-invalidation
> of genuine contradictions is deliberately not automated. See `src/reconcile.ts` and
> `tests/reconcile.test.ts` (both drivers). Current node-revision embeddings (5) are live and current-only.

1. **Bitemporalize relationships and facts.** Shipped for edges on both time axes and for node facts on recorded time: title, summary, and content are immutable revision snapshots, and `read({ asOf })` selects the newest eligible revision. The former `claim` table was removed; valid-time intervals for node facts and historical annotation filtering remain out of scope.
2. **Reconciliation in the write path.** On `capture`/`ingest` extraction: candidate-match against existing node facts (slug, FTS, embedding), auto-link or flag, and generate contradiction candidates for temporally overlapping facts. Wire the invalidation primitive into `graph.lint`'s contradiction pass.
3. **`graph.recall` with `token_budget`.** Compose the pieces that already exist (hybrid search, `neighborhood`, nodes, annotations) into one budgeted context-pack operator. This replaces "agent calls search then read then neighborhood" with one call — and it is the single biggest agent-UX win.
4. **Activation columns.** `access_count`, `last_accessed_at` on `node`; bump on read (batched); fold into ranking. Add a nightly `graph_job` that computes decay and tags dormant atoms.
5. **Embed facts, not just text units.** Shipped for the current `node_revision`: the searchable vector covers revision title, summary, and content. Superseded revision vectors are pruned so search cannot resurrect stale facts.
6. **Keep deferring Kuzu** until multi-hop traversal is demonstrably the bottleneck — the step-back research strengthened, not weakened, that call. Same for a separate vector DB.

## What Stays True From v1

- Postgres as the single canonical store: validated by every production composition surveyed.
- Sources → text units → atoms → edges layering: matches Graphiti's episode/entity/community tiers, the strongest production design found.
- Event log + jobs queue: exactly the substrate write-time reconciliation and decay jobs need.
- Markdown/Obsidian as projection: doubles as the export format the interop gap makes valuable.

## Verified Sources (key)

- Zep/Graphiti temporal KG: https://arxiv.org/abs/2501.13956
- XTDB bitemporality: https://v1-docs.xtdb.com/concepts/bitemporality/
- HippoRAG traversal-vs-iteration: https://arxiv.org/abs/2405.14831
- LongMemEval (long-context ≠ memory; index-side fixes): https://arxiv.org/abs/2410.10813
- Mem0 (selective-retrieval economics; marginal graph delta on simple recall): https://arxiv.org/abs/2504.19413 — vendor preprint, contested benchmark; treat magnitudes as directional
- Kuzu CIDR 2023 (when a graph engine is warranted): https://www.cidrdb.org/cidr2023/papers/p48-jin.pdf
- ACT-R activation for LLM agents: https://dl.acm.org/doi/10.1145/3765766.3765803

Caveats: much of the quantitative evidence is vendor self-benchmarking (Mem0 vs Zep dispute over LoCoMo scoring is active); architectural claims were preferred over benchmark numbers wherever possible. Coverage of Cognee/LangMem/Honcho/GraphRAG internals and CRDT sync stores was thin in the verified set.
