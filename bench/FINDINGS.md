# Benchmark state and what publication requires

**Status:** the retrieval defects this harness found are **fixed**. The benchmark itself is **not yet
a valid instrument** — no number produced so far belongs on the website. This document records where
things stand and exactly what has to change before a number can be published.

**Last run:** `trove-postfix`, 2026-07-19 · 3 questions · LongMemEval `longmemeval_s_cleaned`
· judge `gpt-4o` · answering model `gpt-4o` · embeddings `text-embedding-3-small`
· MemoryBench `118209a` · Trove `fix/retrieval-perf-and-ci-isolation`

---

## Current state

### What the benchmark found, and what was fixed

The 3-question pilot found that `recall` returned **empty context packs for natural-language
questions** — its own documented usage. Both retrieval arms failed on question-shaped input: the
lexical tsquery ANDed every term, and the semantic ceiling excluded question/answer pairs. All fixed
(`37b3cbe`, then PR #25):

| Defect | Resolution |
|---|---|
| Lexical AND matched nothing for NL questions | OR-fallback when the strict query returns zero rows |
| Semantic arm missed question-shaped queries | Dual-embed raw + normalized, min distance |
| `least()` sort key disabled `embedding_hnsw_idx` | One indexable probe per vector, merged in JS — **222× on a 50k-row table** (0.214 ms → 47.6 ms as a seq scan) |
| Query and document sides used different stop-word lists | Both share `contentTerms()`; negation matches no longer capped at 0.5 |
| `embeddingDrainRemaining` read an object as a number → `NaN` | Typed contract (`EmbeddingCounts`); production embeddings now catch up |
| CI red on `main` — job-worker precondition raced global maintenance dedupe | Precondition anchored on a uniquely-keyed job |

Two verification lessons worth keeping:

- The HNSW regression is **invisible on the `trove_repro` fixture** (245 embedding rows), where the
  planner ignores HNSW and both query forms plan a `Sort`. It only appears at realistic scale. Verify
  index behaviour on a table large enough for the planner to care.
- The CI failure was attributed to a Railway builder flake. The Railway *deploy* and the GitHub *CI*
  failures were separate; a passing local Docker build says nothing about a failing assertion.

### Current measurement

| | Pre-fix | Post-fix |
|---|---|---|
| MemScore | 33% / 548 ms / **290 tok** | 67% / 654 ms / **1,783 tok** |
| Hit@K | 33.3% | **100%** |
| Precision | 11.1% | 23.3% |

Empty packs are gone and the pilot's flagship question now passes. **This is n=3 — directional only.
Do not publish it.**

The shape of those numbers is itself the most useful current finding: **Hit@K 100% with precision
23.3%** means retrieval now surfaces the answering evidence every time and ranking fails to prioritise
it. The one remaining failure returns 11 search results (was 2) without ranking the relevant memory in.
**Ranking, not retrieval, is the current bottleneck.**

---

## Blockers to publication

Ordered by severity. Every one of these must close before a number goes on the landing page.

### 1. No competitor baseline has been run

The entire reason for using MemoryBench is that it ships Mem0, Zep and Supermemory as providers, so
every system runs one dataset, one judge, one scoring path. So far **only the `trove` provider has
been run**. A lone score invites the obvious question: *67% compared to what?*

Lifting published numbers is not an option — they are mutually incomparable. Zep is variously cited at
71.2% (own blog, overall), 63.8% (its temporal sub-task, widely requoted as the overall) and ~82%
(third party); Mem0 at 94.4%, 49.0% and ~85%. Much of the ecosystem compares one vendor's *overall*
against a rival's *sub-task*.

**Partially attempted, 2026-07-19.** `compare -p trove,rag` completed on 10 questions with
`questionDate` fixed:

| Provider | Accuracy | Search | Answer | Hit@K | Precision |
|---|---|---|---|---|---|
| trove | 40.0% (4/10) | **109 ms** | 1,284 ms | 90.0% | **22.0%** |
| rag | 30.0% (3/10) | 437 ms | 1,605 ms | **100.0%** | 15.0% |

Ten questions is one question of separation — **not a result**. Two things in it are worth keeping:
search latency is ~4× better (the HNSW node-path fix showing end-to-end), and per-category,
**temporal-reasoning scored 0% against rag's 66.7%** — a real signal, but follow-up verification
**falsified the initial attribution** to `queryNormalize` stripping `today`/`now`/`ago`/`many`/`count`:
all three failing temporal questions retrieved the relevant memory (hitAtK=1), and not one of the
3,015 ingested atoms carried a date ("Stated on" landed after that ingest), so "10 days ago" was
unanswerable answer-side. Date rendering is in the provider now; re-measure on the stratified rerun.

**Mem0 did not complete.** Four attempts. First failed because the API key never reached the harness
(`. .env` in zsh searches `$PATH`, not the cwd, unless written `./.env` — and the error was
redirected away). After that, one question sat `in_progress` in Mem0's cloud indexing phase;
`--from-phase indexing` does not reset an `in_progress` item, and a surgical checkpoint reset to
`pending` did restart it (52 episodes) but it never converged within ~1 hour of wall clock. State
left at `ingest 10/10, indexing 9/10`. This appears to be provider-side latency rather than anything
fixable here.

**To close:** re-attempt `mem0` when its indexing is responsive, and add `zep` / `supermemory` if
their keys are funded — free tiers likely will not cover a full run. Note that a stuck `in_progress`
phase blocks resume and needs the checkpoint reset above.

### 2. Sample size is 3

One question moves the score by 33 points.

**To close:** a stratified sample of **≥100** questions covering all six LongMemEval categories, or
the full 500. State the sample size and selection method next to any number.

### 3. MemoryBench drops `questionDate`

`initQuestion` copies question / groundTruth / questionType but not the date
(`orchestrator/index.ts:241`), so every question is answered with no notion of "today". LongMemEval's
**temporal-reasoning** category — a sixth of the benchmark — is unanswerable under that condition no
matter how good retrieval is. Publishing now means publishing a score depressed by a harness bug.

**To close:** patch `initQuestion` to carry `questionDate` through the checkpoint, and thread it into
the answer phase. Fix this **first** — nothing re-run before it is trustworthy.

### 4. Extraction quality is unmeasured

Nobody has verified that the atom containing the ground-truth answer was ever written. If a fact was
never extracted, the retrieval score is measuring nothing, and a retrieval problem is indistinguishable
from a write problem.

**To close:** for each question, check whether any stored atom contains the ground-truth answer, and
report extraction recall alongside MemScore. Do this **before** further retrieval or ranking tuning.

### 5. The adapter's write policy is not Trove's `remember` semantics

Two deliberate deviations in `bench/providers/trove/index.ts`:

- Titles are suffixed with the session id (`:186`) to defeat `remember`'s exact-title revise path, so
  two sessions asserting different values for the same attribute both survive.
- Every extracted fact cites **every** text unit in its session (`:174`); those spans do not
  necessarily support that fact.

Both are defensible for a first pass — LongMemEval's knowledge-update questions need both values, and
over-citing is cheap given per-node evidence caps. But together they mean any published figure is the
score of *a bespoke agent*, not of Trove as shipped. Labelling it "Trove's MemScore" would be
inaccurate.

**To close:** either route conflicting facts through `connect(..., supersedesEdgeId)` so the benchmark
exercises the real bitemporal machinery, or publish an ablation showing what title-scoping is worth.
"Does revise-on-title lose knowledge-update answers?" is a product question worth answering.

### 6. The number is about to move

Precision 23.3% against Hit@K 100% is a known, fixable ranking gap. Publishing now guarantees a
revision within days.

**To close:** fix ranking, re-measure, then publish.

---

## Secondary issues

Not publication blockers, but they degrade confidence in the harness:

- **MemoryBench is a competitor's harness.** Supermemory maintains it and ships a provider in it. It
  is open source and the dataset and judge are standard, so this is auditable rather than
  disqualifying — but re-read `orchestrator/phases/{evaluate,report}.ts` on every upstream bump and
  record the pinned commit with results.
- **Zep overrides the judge prompt** (`src/providers/zep/prompts.ts:130`) — alone among the built-in
  providers, its answers are graded against a rubric it wrote. Run it both ways and report both; if
  they differ materially, the with-override number is not comparable. Trove overrides `answerPrompt`
  only, deliberately.
- **Ingest is ~169 s/question and sequential** — ~24 h for the full 500, ~25k LLM calls. Concurrency is
  pinned at 1 because `refresh_embeddings` converges globally rather than per-owner. Batch multiple
  sessions per extraction call, or accept a sample.
- **Extraction failures are silent** (`index.ts:177`) — a container can be under-populated with no
  signal.
- **The pg test suite is not idempotent** — re-running against a used database produces spurious
  failures; several suites assert on global job state.

---

## Recommended sequence

1. Patch `questionDate` into the checkpoint — everything else is untrustworthy until this lands.
2. Add an extraction-recall metric; establish whether facts are being written before tuning reads.
3. Fix ranking (precision 23.3% at Hit@K 100%).
4. Run `compare -p trove,rag` on a ≥100-question stratified sample; add funded vendor providers.
5. Publish the **MemScore triple** — accuracy / latency / **context tokens** — not accuracy alone. The
   token column is the genuinely differentiated axis, since `recall` takes a `tokenBudget` and cost is
   a dial rather than a byproduct.
6. Stamp every number with dataset version, judge model, answering model, MemoryBench commit and Trove
   SHA, and link the methodology. Their absence is what makes everyone else's numbers uncitable.

**Publishable today, honestly:** the engineering story, not a score — *we ran the standard academic
benchmark against ourselves, found our own natural-language recall returned empty packs, and fixed
it.* That is true right now and more credible than an uncomparable number.

---

## Reproducing

```bash
./bench/setup.sh
docker exec trove-postgres-1 psql -U trove -d postgres -c "CREATE DATABASE trove_bench;"
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:schema
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:migrate

cd bench/.memorybench && bun install
TROVE_BENCH_DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench \
  bun run src/index.ts run -p trove -b longmemeval -j gpt-4o -l 3 -r pilot

bun run src/index.ts show-failures -r pilot   # per-question retrieved context
npx tsx bench/diagnose-recall.ts              # retrieval-level probe
```

Always pass `-l/--limit` or `-s/--sample` — they exist but are undocumented in `--help`, and an
unbounded run is all 500 questions. The first `longmemeval` invocation downloads a 264 MB dataset.
