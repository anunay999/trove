# LongMemEval pilot — findings

**Run:** `trove-smoke`, 2026-07-19 · 3 questions (`-l 3`)
**Trove:** `c4be6b0` (working tree dirty) · **MemoryBench:** `118209a`
**Dataset:** `longmemeval_s_cleaned` (500 questions, 264 MB, HuggingFace `xiaowu0162/longmemeval-cleaned`)
**Judge:** `gpt-4o` · **Answering model:** `gpt-4o` · **Embeddings:** `text-embedding-3-small`
**Trove config:** `tokenBudget=8000`, `depth=1`, evidence on, write-time extraction via `gpt-4o-mini`

```
MemScore:  33% / 548ms / 290tok
Retrieval: Hit@K 33.3% · Precision 11.1% · Recall 33.3% · F1 16.7% · MRR 0.333
```

Three questions is far too small a sample to say anything about accuracy. It was enough to find a
correctness bug, which is what a pilot is for. **Do not quote the 33% anywhere** — it is a sample of
three against a broken retrieval path.

> ## ⚠ Validity status — read before acting on anything below
>
> This document is a **discovery record, not a measurement**. A review pass (2026-07-19, second
> session) found real defects in it. Corrections are inlined; the load-bearing ones:
>
> 1. **Every measurement below predates the in-flight retrieval fix.** `src/queryNormalize.ts` and the
>    lexical OR-fallback (`pgStore.ts:347`) landed in this working tree *while these numbers were
>    being collected*. Re-measured after the fix, the same failing query returns **30 lexical nodes**
>    instead of 0. Any number here describes pre-fix code and must be regenerated.
> 2. **MemoryBench drops `questionDate`.** `initQuestion` copies question/groundTruth/questionType but
>    not the date (`orchestrator/index.ts:241`), so all three pilot questions were answered with no
>    "today". "How many weddings … *this year*?" is unanswerable without it regardless of retrieval,
>    so that question cannot be used as retrieval evidence. **Fix this before re-running.**
> 3. **The benchmark is not yet a valid instrument.** It has earned its keep as a *bug-finding* tool —
>    two real defects came out of it — but it is not yet trustworthy enough to guide a production
>    change or publish a score. Treat the findings below as hypotheses with evidence attached.
>
> What survives review: `recall` can return empty or near-empty seed sets for natural-language
> questions. That is independently supported by `d24813b1`, a *preference* question with no temporal
> component, which retrieved 2 atoms and neither was the relevant one.

---

## Finding 1 — `recall` returns empty packs for natural-language questions

**Severity: product bug, not a benchmark artifact.** The `290tok` average against a `tokenBudget` of
8000 was the signal. One question retrieved two atoms; another retrieved zero.

Reproduce with `npx tsx bench/diagnose-recall.ts` against the pilot's scratch database:

```
container gpt4_2f8be40d-trove-smoke: 291 nodes, 3361 text units
query: "How many weddings have I attended in this year?"

grep "weddings"            -> 2 node matches
grep "<the full question>" -> 0 node matches

lexical   -> 0 nodes
semantic  -> 0 nodes
hybrid    -> 0 nodes

--- same question, keyword-shaped ---
  "How many weddings have I attended in thi…" -> lexical=0  semantic=0 recall=0  atoms (14 tok)
  "weddings"                                  -> lexical=20 semantic=2 recall=11 atoms (937 tok)

recall(maxSemanticDistance=default 0.55) -> 0 atoms,   14/8000 tokens
recall(maxSemanticDistance=0.7)          -> 10 atoms, 2622/8000 tokens
```

The atoms are there — 23 nodes in this container match `ilike '%wedding%'`. Nothing is missing from
the index. The same `recall`, against the same graph, returns 11 atoms and 937 tokens when asked
`"weddings"` and 0 atoms when asked the question that means the same thing, so **query shape is a
genuine and sufficient cause of the empty seed set**.

> **Corrected.** This section previously claimed the bug was "entirely" query shape and that "nothing
> is wrong with ranking". Both overstated the evidence:
> - The keyword comparison shows seeds are *reachable*, not that the *right* atoms rank highly enough
>   to answer. The container holds 23 wedding-related atoms — planning, traditions, unrelated
>   weddings, duplicates — while ground truth needs three specific couples. Fixing seed retrieval may
>   still yield a wrong answer. Ranking quality is **untested**.
> - The wedding question also lacked its `questionDate` (see validity notice), so its failure is
>   confounded and cannot be attributed to retrieval alone.

Note also that `grep` fails on the full question too. It is not a fallback — it is documented as an
exact-string tool ("a ticket id, product code, error text") and behaves correctly as one. The whole
read surface is keyword-shaped; `recall` is the only verb that advertises natural language, so it is
the only one that is wrong.

Two independent mechanisms both fail on question-shaped input, and since hybrid is the union of the
two, the pack comes back empty.

### Mechanism A — the semantic ceiling is too strict

`semanticMaxDistance()` (`src/pgStore.ts:2245`, mirrored in `src/store.ts:1216`) defaults to `0.55`
cosine distance, overridable by `TROVE_SEMANTIC_MAX_DISTANCE`. Sweeping it on the failing query:

| `maxSemanticDistance` | nodes returned |
|---|---|
| 0.55 (default) | **0** |
| 0.7 | 12 |
| 0.8 | 20 |
| ≥0.9 | 20 (saturated) |

Question-phrased queries sit just outside the ceiling. A question and the fact that answers it are
not near-paraphrases — "How many weddings have I attended?" against "Sister's Wedding" is a real
semantic gap — so a threshold tuned on statement-like text excludes them.

### Mechanism B — lexical search ANDs every term

Lexical goes through `websearch_to_tsquery`, which requires *all* terms to be present in one node.
No node contains "how" ∧ "many" ∧ "weddings" ∧ "attended" ∧ "year", so a well-formed question matches
nothing. The longer and more natural the question, the more certain the miss.

This is adjacent to the R7 fix in `scripts/repro-eval.ts` (empty-tsquery short-circuit), which is
working as designed — the issue is the AND semantics on non-empty queries, not the short-circuit.

### Why this matters beyond the benchmark

Trove's own MCP doctrine instructs agents to do the failing thing:

> Ask recall in plain language: "How do we handle refunds for annual plans?" — not "refund annual
> plan keywords".

The documented, recommended usage returns an empty pack. Worse, it fails **silently**: an empty pack
is indistinguishable from "the graph knows nothing about this," so an agent will confidently
re-derive knowledge that Trove already holds. Every `recall`-before-re-deriving workflow is affected.

### Fix options

> **Corrected ranking.** This section originally put normalization first and called it "the real
> repair". Measured against the pilot database, that was wrong: normalizing to `"weddings attended
> year"` still stems to `'wed' & 'attend' & 'year'`, which under AND semantics returns **0 nodes**.
> Normalization alone does not fix the lexical arm. **OR-fallback is doing the work.**

1. **OR-fallback for lexical — the load-bearing fix.** When the AND-tsquery returns nothing, retry
   with `|` between stemmed terms. This is what actually recovers the case (0 → 30 nodes on the full
   question), and it is what shipped in `pgStore.ts:347`.
2. **Query-side normalization.** Strips interrogative scaffolding and stopwords before the tsquery and
   the embedding. Useful for the *semantic* arm and for precision, but insufficient alone. Two open
   risks in `src/queryNormalize.ts`: it removes meaning-bearing terms (`not`, `today`, `many`,
   `count`), which can damage negation, temporal and aggregation queries — and it needs evaluating
   over **positive and negative** query sets, not just this one case.
3. **Raise the semantic default** from `0.55` toward `0.7`. Recovers the case on its own
   (`0.7` → 12 nodes) but widens the net for every query to compensate for badly-shaped ones. Treat
   as mitigation, not fix.

**Precision is now the open risk, not recall.** Post-fix, the full question returns 30 lexical nodes
in a container holding only 23 wedding-relevant atoms — OR-fallback over-retrieves by construction.
Whatever ranking sits on top of it now carries the burden.

> **R6 is not "encoding the bug".** An earlier draft said so. R6 is a legitimate *negative precision*
> test — it asserts that an unrelated query returns nothing at the default ceiling. It should be
> **preserved**, and only revisited if option (3) is taken. It is not blocking options (1) or (2).

An alternative worth weighing: leave `recall` alone and change the doctrine to tell agents to query
with keywords. Cheaper, but it contradicts the premise of a natural-language memory interface.

> **Blocked test:** `scripts/repro-eval.ts` **R6 asserts the current 0.55 behavior** ("unrelated
> query: 0 rows at the default 0.55 floor"). That check encodes the bug and must be updated
> alongside any fix, or it will fail and look like a regression.

---

## Finding 2 — write-time extraction dominates wall-clock

Per-question ingest latency: **min 158.1s, max 181.0s, mean 169.4s**. Almost all of it is the
per-session `gpt-4o-mini` extraction call — a LongMemEval haystack is ~50 sessions, so ~50 sequential
LLM calls per question.

Extrapolated to the full 500 questions: **~24 hours and ~25,000 LLM calls** for ingest alone, before
search, answering, or judging. That is not a nightly run.

Options, roughly in order of leverage: batch multiple sessions into one extraction call; raise
provider concurrency (currently blocked by Finding 3); use a cheaper/faster extraction model; or
publish a defensible 50–100 question sample via `-s/--sample` rather than the full set.

---

## Finding 3 — `refresh_embeddings` is global, not per-owner

The missing-count query in `PgGraphStore.performJob` (`src/pgStore.ts` ~1630) has **no owner filter**:

```sql
select count(*) from node n
  join node_revision nr on nr.id = n.current_revision_id
 where n.deleted_at is null and not exists (…)
```

Neither does the backfill it drives. So `refresh_embeddings` converges the *whole database*, not one
owner's slice. Consequences for benchmarking:

- `awaitIndexing(containerTag)` cannot wait on just its own container; it waits on global state. The
  provider documents this and loops on **progress** rather than a fixed round count.
- Provider concurrency must stay at **1**. Concurrent containers would each spin the same global
  backfill and stall each other's convergence checks.
- Throughput is `payload.limit` rows per job, default **24**, hard-capped at **100** by
  `refreshMissingEmbeddings`. The pilot's 3 questions produced 11,598 embeddable rows (873 node
  revisions + 10,725 text units) — ~116 job runs at the cap. The first attempt failed here because
  the provider's original 50-round ceiling was far too low.

### Escalated: the production auto-catch-up is broken

This section originally concluded "nothing to fix for production necessarily". That was wrong, and
review found the reason — a **type-shape mismatch that silently disables the drain loop**:

```ts
// src/pgStore.ts:1673 — returns an OBJECT
embedded: { nodeRevisions, textUnits }

// src/jobWorker.ts:17 — reads it as a NUMBER
const embedded = Number(result.embedded ?? 0);   // Number({...}) === NaN
if (!Number.isFinite(before) || !Number.isFinite(embedded)) return 0;
```

`Number({nodeRevisions, textUnits})` is `NaN`, so `embeddingDrainRemaining` returns `0` — "no work
left" — and the worker never queues the follow-up batch. Reproduced independently: 100 missing rows
with 24 embedded reports **0 remaining instead of 76**.

The unit test does not catch it because it fabricates the obsolete numeric shape
(`tests/job-worker.test.ts:33`), so it asserts the bug rather than the contract. This contradicts the
automatic catch-up guarantee documented in `docs/development.md:131`: in production, embeddings stop
draining after the first batch of 24 until something else enqueues a job.

**This is a P0 independent of the benchmark** and is not obviously covered by the in-flight retrieval
work. Fix the return-shape contract and rewrite the test to use the real shape.

---

## Finding 4 — harness fairness (carried from the pre-run audit)

Of MemoryBench's built-in providers, only `zep` overrides the **judge** prompt
(`src/providers/zep/prompts.ts:130`), so its answers are graded against a rubric it authored while
other providers get the built-in one. Supermemory and Mem0 override only `answerPrompt`, which is
legitimate. The Trove provider overrides `answerPrompt` only, deliberately. See `bench/README.md` for
how this is handled when Zep is in the comparison.

---

## Corrections to earlier assumptions

Things the pilot disproved, recorded so they are not re-assumed:

| Assumed | Actual |
|---|---|
| `scripts/repro-eval.ts` is a benchmark starting point | It is a fix-validation harness (R1–R16, S1–S5) for internal regressions |
| MemoryBench has no `--limit` | `-l/--limit` and `-s/--sample` exist, just undocumented in `--help` |
| MemoryBench can run under node | Requires **bun** — `bun:sqlite` backs checkpointing, `Bun.serve` the UI |
| `test -q <id>` works standalone | Requires a run that already completed the ingest phase |
| `RecallResult.evidence` links to atoms | It is a flat `TextUnit[]` (field `text`, no `nodeId`); the join is `RecallResult.citations` |

---

## Threats to validity

Known ways this harness could be measuring the wrong thing. All open.

1. **The write policy is not Trove's `remember` semantics.** The provider titles every atom
   `"<fact> (<sessionId>)"` to stop same-attribute facts from colliding via exact-title revise
   (`bench/providers/trove/index.ts:182`). That deliberately bypasses the documented dedupe/revise
   path, so the benchmark measures a custom writing policy, not `remember` as shipped.
2. **Provenance is fabricated.** Each extracted fact cites *every* text unit in its session
   (`index.ts:171`); those spans do not necessarily support that fact. This inflates apparent
   evidence coverage and makes any provenance-quality claim meaningless.
3. **Extraction failures are silent.** Both the JSON parse and the `remember` call swallow errors
   (`index.ts:177`), so a container can be under-populated with no signal.
4. **Extraction quality is unmeasured.** No check that the atoms written actually contain the ground
   truth. A retrieval score is meaningless if the fact was never extracted — this should be measured
   *before* any further retrieval tuning.
5. **Ranking quality is unmeasured.** See finding 1.
6. **`questionDate` is dropped** by the harness. See validity notice.
7. **Single-case tuning.** Every retrieval conclusion rests on one question in one container.
   Query strategies need evaluating across all six LongMemEval categories, including negation and
   temporal, with negative sets to catch precision regressions.

## Open decisions

1. **Fix the defaults, then re-benchmark — or override for the benchmark only?** Recommendation:
   fix. Publishing a number produced by `TROVE_SEMANTIC_MAX_DISTANCE=0.8` when no deployment runs
   that value is exactly the vendor self-benchmarking this project set out not to do.
2. **Full 500 or a sample?** At ~24h for ingest, a 50–100 question sample is the realistic first
   publishable artifact. Sample size and selection method must be stated next to any number.
3. **Which competitors?** `rag` (built in, free) is available now. Mem0/Zep/Supermemory need paid
   accounts, and their free tiers likely will not cover a full run.

## Reproducing

```bash
./bench/setup.sh
docker exec trove-postgres-1 psql -U trove -d postgres -c "CREATE DATABASE trove_bench;"
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:schema
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:migrate

cd bench/.memorybench && bun install
TROVE_BENCH_DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench \
  bun run src/index.ts run -p trove -b longmemeval -j gpt-4o -l 3 -r trove-smoke

# inspect
bun run src/index.ts show-failures -r trove-smoke
npx tsx bench/diagnose-recall.ts
```
