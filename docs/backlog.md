# Trove engineering backlog

Findings from a review pass on 2026-07-19: a four-angle cleanup review of the
natural-language retrieval fix, a LongMemEval benchmark pilot, and direct
measurement of query plans, extraction quality and test stability.

**Verification legend** — this matters, because two items in this review looked
true and were not, and one looked false and was:

| | meaning |
|---|---|
| ✅ **verified** | reproduced or measured directly during the review; evidence inline |
| ⚠️ **reported** | raised by a second reviewer, plausible, **not** independently confirmed — verify before acting |

Two cautionary examples worth remembering when working this list:

- The 222× HNSW regression was **invisible on the `trove_repro` fixture** (245
  rows), where Postgres ignores the index and both the fast and slow query forms
  plan a `Sort`. A first verification attempt returned a false negative. Verify
  performance claims at realistic scale.
- CI being red was attributed to a Railway builder flake. The Railway *deploy*
  failure and the GitHub *CI* failure were unrelated; the CI failure was a real,
  deterministic test-isolation race.

---

## P0 — blocks scale or loses to a naive baseline

### 1. `refresh_embeddings` is not owner-scoped ✅ **fixed 2026-07-19**

**Evidence** — `src/pgStore.ts` (~line 1630). The missing-count query has no owner
filter:

```sql
select count(*) from node n
  join node_revision nr on nr.id = n.current_revision_id
 where n.deleted_at is null and not exists (…)
```

Neither does the backfill it drives.

**Impact** — the job converges the *whole database*, not one owner's slice. Bulk
import is O(entire corpus) per tenant, per-tenant progress is unobservable, and
any caller waiting for "my data is indexed" must wait for everyone's. This is why
the benchmark adapter must pin provider concurrency to 1.

**Action** — add an owner filter to both the count and the backfill; let callers
request convergence for one owner. Keep a global mode for the background worker.

**Done** — `refresh_embeddings` accepts `payload.ownerId`: the missing-count and
both backfill selects take the same filter, the result envelope echoes the scope,
and the worker's drain-follow-up preserves it (dedupe key gains the owner suffix,
so two owners' drains no longer absorb each other). Global mode is unchanged.
Callers pass `ownerId` via the normal enqueue path (API/CLI/payload). Covered by
`tests/embedding-backfill.test.ts`: a scoped drain embeds exactly the owner's
rows and leaves the rest of the corpus missing. **Note for the bench:** the
adapter can now request per-container convergence instead of pinning concurrency
to 1 — worth rewiring before the stratified rerun.

---

### 2. Embedding backfill drains ≤100 rows per job ✅ **fixed 2026-07-19**

**Evidence** — `refreshMissingEmbeddings` clamps to
`Math.max(1, Math.min(100, limit))`; default 24. Measured: 22,730 pending rows ⇒
~228 sequential job runs, each its own round trip.

**Impact** — importing an Obsidian vault or any real corpus takes hours of
queue churn. Compounds with #1.

**Action** — raise the cap (the clamp predates batched embedding calls), and
embed in provider-sized batches rather than job-sized ones. Depends on #1 for
per-owner progress reporting.

**Done** — the clamp is now 1000 (default 256, `TROVE_EMBEDDING_JOB_LIMIT`
override unchanged), and `embedRows` chunks provider calls at 128 texts per
request — the job size and the API batch size are decoupled. A 22,730-row
backlog is now ~90 jobs, not ~950. Covered by the `payload.limit` end-to-end
test in `tests/embedding-backfill.test.ts`.

---

### 3. `queryNormalize` strips meaning-bearing terms — ❌ **falsified; strip list kept**

The measured 0%-temporal loss is real, but the strip list is not its cause
(falsified 2026-07-19 against `trove_bench3`, the compare-run containers):

- All three failing temporal-reasoning questions retrieved the relevant memory
  in the top 10 **with the strip list active** (checkpoint `retrievalMetrics`:
  hitAtK=1). The answer failed anyway — the failure is downstream of retrieval.
- Re-running the lexical arm with the temporal terms kept: the Crown/GoT tsquery
  is byte-identical (nothing temporal was in that query); the smoker question
  reshuffles noise (relevant atom 16→8 by cover-density luck while unrelated
  "days ago" atoms jumped ahead); the Nightingale question only gains a dead
  `'mani'` probe. No principled gain on the positive set.
- The semantic arm already embeds the raw, unstripped question (dual-embed,
  `pgStore.ts:451`), so intent was never destroyed before "either retrieval
  arm" — only the lexical probes lose the terms.
- Negative-set risk confirmed: `ago`/`today`/`mani` appear in 25/12/18 of 3015
  atoms, so keeping them converts strict-AND hits into OR-fallback floods on
  virtually every temporal query.

**Actual causes of the 0%, in order** — (a) the compare run's atoms carried
**no dates at all** (0/3015 contain "Stated on"; the provider's date suffix
landed after that ingest), so "10 days ago" was unanswerable no matter what
retrieval returned; (b) extraction relativizes dates ("got a smoker *on the day
of the conversation*") — that is #4; (c) relevant atoms rank under OR-fallback
noise — that is #8/#10.

**Action taken** — strip list unchanged. The constructive fix is date anchoring
in what agents actually read: `renderRecallAtom` headers and
`renderAgentContext` now carry the node's updated date (`graphCore.ts`). The
bench provider already appends "Stated on ‹timestamp›" per atom; the temporal
score should be re-measured on the stratified rerun, with extraction
absolute-dating (#4) as the remaining lever.

---

### 4. Extraction is lossy ✅

**Evidence** — `bench/extraction-recall.ts` over the pilot: **85.4%** of
ground-truth answer terms present in ingested text, **75.6%** surviving into
atoms. The one question that still failed scored 74.2% with 3/31 terms dropped.

**Impact** — ~10 points of answer-bearing content is discarded by the write path.
No amount of retrieval or ranking work recovers it, and it is invisible to any
end-to-end accuracy metric.

**Action** — the distillation prompt summarizes where it should extract. Rework
it to preserve specifics (names, numbers, dates), and track extraction recall as
a first-class metric rather than a benchmark-only diagnostic.

---

## P1 — correctness and structural risk

### 5. `GraphJob.result` is an untyped envelope ✅ **fixed 2026-07-19**

**Evidence** — `src/graphCore.ts:60`: `result: Record<string, unknown> | null`.
This is why `Number({nodeRevisions, textUnits})` → `NaN` compiled silently and
stalled the production embedding drain.

**Impact** — producer and consumer are never checked against each other for *any*
job kind. `RefreshEmbeddingsResult` now types one of them; the rest are
unprotected, and the same failure can recur in any of them.

**Action** — a discriminated union of result types keyed by `GraphJobKind`, with
producers annotated and consumers narrowing through it.

**Done** — `src/jobResults.ts` defines `GraphJobResultMap` (one entry per kind:
lint, embeddings, projection, reconcile) and `jobResultAs(job, kind)`, the only
sanctioned way to read a result. Every performJob branch on both drivers is
annotated with its kind's type (a branch returning the wrong shape fails to
compile), and `embeddingDrainRemaining` narrows through the helper. The wire
shape stays `Record<string, unknown>` — the contract lives at the
producer/consumer boundary, and adding a job kind without a map entry now
fails to compile.

---

### 6. The two store drivers have drifted ✅ **decision made + sharpest gaps closed 2026-07-19**

**Evidence** — same commit, same stated policy, different implementations:

| | `src/store.ts` (memory) | `src/pgStore.ts` |
|---|---|---|
| term matching | raw substring `includes()` | `to_tsvector` — **stemmed** |
| `"weddings"` vs stored `"wedding"` | no match | matches |
| semantic query | normalized only | dual-embed raw + normalized, `least()` |
| text-unit ordering | insertion order, **no scoring** | ranked |

**Impact** — tests passing against the memory driver say little about Postgres
behaviour, and the code reads as though the two are equivalent.

**Action** — pick one and state it: either make the semantics genuinely shared
(a stemmer + token-boundary matching in-memory), or declare the in-memory store a
test double in its module doc and accept the asymmetry explicitly.

**Done — the second option, with the sharpest divergences closed anyway:**
`store.ts`'s module doc now declares it the test double and lists the residual
asymmetries. On top of that declaration: lexical term matching is tokenized +
lightly singularized (`tokenizeForMatch`) so "weddings" finds "wedding" and
"all" no longer finds "call"; the semantic arm dual-embeds raw + normalized and
takes min distance like pg; and the stop-word gate gained the pg-dictionary
words whose absence made memory-only probes ("all/any/some/most/just/after/
before/because/during/while/until/each/both" — this is the #24 extension
landing). `tests/driver-parity.test.ts` locks the boundary, including the
declared residual (run/running/ran is NOT approximated).

---

### 7. Maintenance jobs use global dedupe keys ✅ **fixed 2026-07-19**

**Evidence** — `src/pgStore.ts:1558`: `dedupeKey: \`maintenance:${kind}\``.
Reproduced deterministically: after one capture, a second capture 1.2s later
added **0** new job rows — it deduped onto the existing one, which kept the
original `createdAt`.

**Impact** — any concurrent writer can absorb another's enqueue. Caused two
distinct CI flakes at ~20% (worked around in tests via per-file databases in
`tests/helpers.ts:isolateDatabase`, but the underlying design is unchanged).

**Action** — scope dedupe keys by owner, or make enqueue return whether it
created or joined so callers can reason about it.

**Done — the second option, after scoping analysis showed the first was wrong
here.** Absorption is only harmful when the work is scoped: lint and global
embedding refresh are genuinely global (one pending row covers everyone's data),
so per-owner keys would only multiply identical work. Reconciliation was the
scoped case and already dedupes per node (`reconcile:<nodeId>`); owner-scoped
embedding drains dedupe per owner (#1). What was missing was observability:
`enqueueJob` now marks the returned job `dedupeJoined: true` when it joined an
existing pending/running row (never stored, never set on a fresh row), on both
drivers, with the rationale recorded at the enqueue sites. Covered by
`tests/jobs.test.ts`.

---

### 8. OR-fallback over-retrieves; ranking absorbs the cost ✅

**Evidence** — post-fix, a natural-language question returns **30 lexical nodes**
in a container holding **23** relevant atoms. Benchmark: Hit@K 90% with precision
**22%**.

**Impact** — retrieval reaches the evidence and fails to prioritise it. The
fallback is correct by construction; the ranker behind it is not strong enough.

**Action** — see #10. Consider ranking AND-matches above OR-matches within one
result set rather than switching wholesale between them.

---

### 9. `remember` may accept and silently discard evidence ✅→**fixed 2026-07-19; follow-through 2026-07-20**

**Verified 2026-07-19** — true, with one refinement: on the update path every
evidence ref was annotated inside a catch-all, so invalid refs vanished
silently (`agentOps.ts:126`); on the create path an invalid ref actually failed
the whole write loudly (FK constraint). Zero-evidence nodes are accepted on
both paths, which is the doctrine-sanctioned "agent inference" route — the
README overstatement is a #22 matter.

**Done** — both store drivers now throw a named `UnknownEvidenceReferenceError`
for refs that don't resolve (pg maps FK 23503; the in-memory driver checks
explicitly — previously it stored anything). `remember` attaches evidence
uniformly on create and revise: each ref is attempted individually, bogus refs
come back in the result as `evidenceRejected` with reasons, and any other
failure still throws (no more swallow-all). The remember tool description
teaches the field. Covered in `tests/agent-ops.test.ts` on both drivers.

**Follow-through (2026-07-20) — provenance correct by construction, layers
(a) and (b) shipped; (c) deliberately not done:**

- **(a) Cite by quote** — `remember` evidence accepts `{ quote: "..." }` and
  the store resolves it to a text unit (`resolveTextQuote` on both drivers):
  verbatim containment first (case-insensitive `position()` on pg, no ILIKE
  escaping hazards), then term-containment fuzzy scored with the #17
  `evidenceSupportScore` helper — quote-resolution yields containment at write
  time, the composition the lint needed. Ambiguous-exact and fuzzy-near-tie
  quotes are REJECTED with repairable reasons (candidate spans, `add
  sourceId`, `quote a longer passage`, `ingest the source first`) — a wrong
  auto-citation is worse than an error the agent can act on. `quote +
  textUnitId` verifies containment in the cited unit and, on mismatch, says
  where the quote actually is. Successful resolutions store
  `selector: { type: "TextQuoteSelector", exact, match }` — the field was
  always W3C-shaped; now it is W3C-typed in practice. Resolution is
  owner-scoped, so a quote fails closed against another tenant's text.
- **(b) Session-served validation** — a `ServedUnitLog` (graphCore, shared by
  both drivers: per-owner, capped, TTL'd, in-process by design) records the
  units a session was actually shown: ingest/search/grep/read/project mark
  their returned units, and `performRecall` marks exactly the evidence that
  made the pack (units cut by the budget were never shown). `remember` flags
  an attached UUID ref the session never received in `evidenceUnserved` —
  warning, not rejection, with the repair (`re-cite as { quote }, or fetch
  the span first`). Quote-resolved citations are exempt: resolution grounds
  them by construction.
- **(c) Strict rejection — NOT done, by design.** Only (a)+(b) were additive
  and non-breaking; making rejection strict belongs after real clients have
  run with the quote form. When it lands, the `evidenceRejected` reasons are
  already repair-shaped.

Covered by `tests/evidence-quote.test.ts` on both drivers: exact, fuzzy,
ambiguous-exact (+ sourceId repair), fuzzy-ambiguous, no-match, quote+id
verify/mismatch, mixed refs, unserved-UUID warning, grep-serves, recall-serves,
and cross-owner fail-closed (pg).

---

## P2 — improve what exists

### 10. Activation ranking is a stub ✅

Recency + frequency + degree only — no semantic-alignment term, no noise term,
despite ACT-R's formula being the documented intent (`docs/memory-db-design.md`).
With #8 pushing more candidates through, this is now the binding constraint on
precision.

### 11. No decay or archive ✅

Low-activation atoms rank lower but are never archived. The working set grows
without bound; `docs/memory-db-design.md` specifies decay + dormancy tagging.

### 12. Atoms are not the primary semantic index ✅

Fact-augmented keys are the cheapest documented retrieval win, and atoms already
*are* fact-augmented keys — they just aren't indexed as the primary target.

### 13. Hardcoded tuning constants ✅

RRF `k=60`; `GIANT_CONTENT_CHARS=12000`; per-node evidence cap `5`;
`maxNodes=100`; semantic floor `0.55`; `OVERFETCH=10`. None are tunable as a set
or documented together, and several were chosen against a 245-row fixture.

### 14. `OVERFETCH` is a guess ✅

The HNSW probe runs *before* owner, type and content filters, so a heavily
filtered query can return short. pgvector 0.8's `hnsw.iterative_scan` removes the
guess entirely — worth adopting when the deployment's pgvector supports it.

### 15. Duplicated infrastructure ✅

- `process.loadEnvFile(new URL("../.env", …))` in 5+ scripts
- the store-close dance in 5 places, while `closeStore` sits stranded in `tests/`
- the OR-tsquery SQL fragment written twice in `pgStore.ts` (matching arm and
  evidence-ranking arm) — a change to one will not reach the other

---

## ADD — missing capability

### 16. Write-time reconciliation / contradiction detection ✅ **implemented 2026-07-19**

Shipped as the `reconcile_node` graph job (migration `011`):

- **On write** — capture and content-changing updates enqueue a per-node
  reconcile job (dedupe `reconcile:<nodeId>`, priority 30) in the same
  transaction as the write itself.
- **Candidate-match** — lexical + semantic search against the node's own owner
  scope (the semantic arm contributes when an embedding provider is configured).
- **Judge** — pluggable `ReconcileJudge`; OpenAI (`gpt-4o-mini`,
  `TROVE_RECONCILE_JUDGE_MODEL`) when a key is configured, otherwise a
  conservative heuristic that only flags near-identical titles. Verdicts:
  supersedes / duplicate / contradicts / related / distinct.
- **Act, conservatively** — a confident `supersedes` writes a non-destructive
  `supersedes` edge; `contradicts`/`duplicate` become flags in the job result.
  Nothing is tombstoned or invalidated automatically: a wrong auto-invalidation
  destroys a belief, a wrong edge only annotates it.
- **Read-side** — recall marks a superseded atom `SUPERSEDED by <title>` in its
  header (via `supersededBy` on both drivers), so the reader prefers the
  successor. The recall tool description teaches the mark.

Deliberately out of scope: auto-invalidation of contradicted edges (needs
temporal judgement we don't trust a heuristic with), entity resolution during
extraction (the bench-side distillation), and decay/archive (#11). The
superseded-mark is annotation, not a ranking change — whether superseded atoms
should rank lower is a #8/#10 question to answer with the ranking work.

### 17. Provenance quality measurement ✅ **first-class signal added 2026-07-19**

Nothing scores whether an answer traces to a genuinely supporting span. The core
thesis is currently an unverified claim, and there is no guard against citations
that are present but wrong.

**Done** — a `weak_evidence` lint finding on both drivers: for every node with
citations, containment of the node's content terms in its best-matching cited
unit (`evidenceSupportScore`, floor 15%), capped at 50 findings. It is a
reviewable warning, not a gate — paraphrases can score low honestly, and
LLM-judged entailment is the future upgrade (the reconcile judge
infrastructure now exists for exactly that). First real-data result: the
scribe-vault import produces a flood of 0%-containment findings, i.e. the
signal immediately found suspicious citations in production data. Covered by
`tests/lint.test.ts`.

### 18. Node-level time travel ⚠️

**Reported** — `read` cannot request an older node revision; time travel covers
edges only. **Not verified.** If true, the README's fact-level bitemporal history
claim overstates the implementation.

### 19. Broader query-plan coverage ✅

`tests/query-plans.test.ts` covers the semantic paths. Lexical search, the
neighborhood recursive CTE, and evidence ranking have no plan assertions.

### 20. A realistic-scale fixture ✅

Everything is verified against ~245 rows, where Postgres ignores HNSW entirely.
This is precisely how a 222× regression stayed invisible through typecheck, lint,
103 tests and a 17-item repro harness.

### 21. Backpressure on embedding provider calls ✅

No concurrency control beyond job batching; a large backfill is limited only by
job cadence.

---

## DELETE — dead, stale or wrong

### 22. Stale documentation

- `docs/architecture.md` describes the `claim` table and transactional
  node/edge/claim writes. ✅ **verified stale** — migration `010` dropped the
  table and repro `S2` asserts `to_regclass('public.claim') = null`;
  `remember` performs node update, links and annotations as separate operations.
- `docs/deployment.md` says production needs an external scheduled worker, while
  `src/server.ts:686` starts one automatically. ⚠️ reported.
- `README.md` advertises fact-level bitemporal history. ⚠️ reported (see #18).
- `README.md` says "nothing is a free-floating fact". ⚠️ reported (see #9).

### 23. `repro-eval` reports `18/17 PASS` ✅ **fixed 2026-07-19**

`R9` calls `report()` twice under one id, incrementing `passCount` twice against
a hardcoded denominator. A harness that reports more passes than it has tests
undermines confidence in its own output.

**Done** — verdicts are tracked per R-id in a map and AND-combined across calls
(a second report for the same id can never upgrade a fail back to a pass), and
the denominator is the map's size instead of a hardcoded 17. The summary now
reads `17/17`.

**Harness flake notes (2026-07-20)** — three transient failure modes observed
across four runs on two days, none in shipped code, never the same id twice in
a row: (1) **R5 flaps at the 0.55 semantic floor** — the deleted-phrase query
and the node's current revision share the run's `stamp` tokens, so the
distance sits on the floor and varies per run; the fix under test held every
run (0 stale embedding rows). (2) **R9b's 4-way concurrent remember** asserts
4 distinct nodes, but racers that see each other's commit revise instead —
`fulfilled=4, rejected=0` in every run, i.e. the 23505 slug retry (the thing
under test) never failed. (3) One run reported R8/R12
`Cannot read properties of undefined (reading 'id')` harness errors,
unreproduced in two later runs with full-stack capture armed — that run
overlapped the thesis benchmark's reconcile-judge drain on the same API key
and same Postgres host. Treat single-run failures in *different* R-ids as
harness noise; investigate when the *same* id fails twice.

### 24. The `queryNormalize` stop-word list as a concept ✅

Its header claimed to be "a superset of the pg english dictionary list". It is
not — Postgres also strips `after`, `because`, `all`, `each`, `before`, `during`,
`while`, `until`, `just`, `some`, `most`, `any`, `both`, none of which are in the
set. On the Postgres path the list is largely redundant, since `to_tsvector`
filters again downstream. On the in-memory path the omissions become live
substring probes: `all` matches *call* / *small* / *finally*.

The comment is corrected; the design question stands. Consider reducing it to the
handful of meta-words Postgres genuinely does not strip, and letting the
dictionary do the rest.

---

### 25. The benchmark measured the wrong shape ✅ **replaced 2026-07-20**

LongMemEval is question-answering over chat history; Trove is a memory
substrate for working agents. Optimising against it would have made Trove a
better LongMemEval system and only incidentally a better memory — extraction
recall and Hit@K are that benchmark's shape, not Trove's. The pilot earned its
keep (it found empty recall packs for natural-language questions, and two lost
HNSW indexes) but `bench/FINDINGS.md` lists six blockers between it and a
publishable number, and closing them would have described a bespoke benchmark
agent rather than Trove as shipped.

`bench/providers/trove` and `bench/setup.sh` are deleted; `bench/thesis/`
replaces them, testing the claim that actually justifies the graph: multi-hop
questions whose joining entity never appears in the question, with single-hop
controls so a win is attributable to traversal rather than to a rigged corpus.

**First run (n=15, 9 multi-hop):** multi-hop gap **+22 pts**, control gap
**0 pts**, supersede **100% vs 50%**. The harness declares this INCONCLUSIVE —
9 items means one item is 11 pts — and that is the correct reading. Running it
also exposed that Trove's `SUPERSEDED` marker only works when the consumer has
been told what it means: teaching it in the answer prompt (as `recall`'s tool
description already teaches every real MCP client) moved supersede from 50% to
100% with the edges unchanged.

**Grown dataset + full run (2026-07-20, n=51, 33 multi-hop — the first
verdict-grade number):** the dataset grew to 17 bridge / 8 chain / 8 supersede
+ 18 controls (35.3%), `validateDataset` clean, each new item designed so no
single span suffices (the answer-bearing span carries multiple candidate
values; only the join selects). Result, verbatim:

```
shape       n   trove   flat    trove-cov  flat-cov
--------------------------------------------------------
bridge     17    59%    76%        79%       97%
chain       8    63%   100%        71%       92%
supersede   8    75%    75%        88%       94%
control    18   100%   100%        94%       94%

multi-hop gap (trove - flat): -18 pts  (n=33, one item = 3 pts)
control gap   (trove - flat): 0 pts  (n=18)
DOES NOT support the thesis: no multi-hop advantage at adequate n.
```

This is a real negative result, not a rigged-corpus artifact: controls tie at
100% (distillation costs nothing on single-span answers), and the deficit is
concentrated where the graph was supposed to win. The diagnostics point at the
machinery, in order:

1. **Retrieval coverage, not answering, is the main gap** — trove-cov trails
   flat-cov by 18-21 pts on bridge/chain. Flat gets raw spans top-8 over a
   ~100-unit corpus and simply HAS both hops; Trove's recall reaches the join
   hub and stops (same signature as `bridge-invoice-owner` at 50% in the first
   run — it recurred: 5 more items missed at exactly 50% coverage). That is
   #8/#10's target, now measured at adequate n.
2. **Three misses at 100% coverage are answering failures** — the facts were
   in the pack and the model still abstained (`bridge-standup-timezone`,
   `bridge-lunch-vegan-count`, `chain-golive-approval`). Atom presentation
   (headers/slugs/marks) reads less naturally than raw spans; worth one prompt
   pass before blaming retrieval for these.
3. **Supersession parity hides a split** — both systems missed
   `supersede-standup-time` at 50% coverage, but flat's misses were stale-value
   answers (`Every two weeks`) while Trove's were abstentions or non-answers
   (`end of every iteration`). The SUPERSEDED machinery prevents confident
   wrong answers; it does not yet produce confident right ones.
4. **Caveat — the harness's distillation is a specific write policy** (its own
   prompt, hub entities, no quote-form evidence), not Trove-the-product
   end-to-end; the flat baseline faces no such lossy stage. This cuts both
   ways: it may understate Trove (extraction loss, #4) and overstate the
   baseline (raw spans are what Trove deliberately does NOT serve agents).
   Both are instrument facts, recorded here rather than litigated after.

**To close:** #8/#10 (traversal stops at the join hub) and #4 (extraction
loss) are the measured follow-ups, in the Suggested-order tracks below. A
re-run after those land is the same command; the dataset is the instrument
they get evaluated against.

---

## Suggested order

Three tracks, and the dependency between them is the point: **#4 and #8/#10 are
accuracy work, and accuracy work needs a valid instrument.** Sequencing them
first — as this document originally did — means shipping changes nobody can
evaluate. That is how the 222× regression stayed invisible.

**Track 1 — correctness of the core claim.** Needs no benchmark; assertions are
local. Largely closed 2026-07-19/20: ~~#9~~, ~~#17~~, ~~#5~~, ~~#6~~, ~~#7~~,
~~#23~~, ~~#16~~, ~~#1+#2~~, ~~#9 follow-through (a)+(b)~~. Remaining:

1. **#9(c) strict rejection** — deliberately deferred until real clients have
   run with the quote form; the repair-shaped reasons are already in place.
2. **An integrity suite** — every recalled atom has resolvable provenance; a
   superseded atom never outranks its successor; no silently partial write.
   Converts the README from asserted to enforced.

**Track 2 — does the graph earn its complexity.** Blocked on instrument, now
unblocked by #25.

3. ~~**Grow `bench/thesis` to ≥30 multi-hop items**~~ — done 2026-07-20: 33
   multi-hop (17 bridge / 8 chain / 8 supersede) + 18 controls (35.3%),
   `validateDataset` clean. Result recorded in #25: **−18 pts multi-hop at
   n=33, controls level — the graph currently does NOT earn its complexity.**
4. **#8 + #10 ranking** — measured target from the full run: six multi-hop
   misses sat at exactly 50% coverage, traversal reaching the join hub and
   stopping. The instrument is verdict-grade now; this is the first thing to
   evaluate against it.
5. **#4 extraction loss** — the write path discards answers; flat-cov 92-97%
   vs trove-cov 71-88% bounds how much the distill stage can be costing.

**Track 3 — competitive comparison.** Deliberately last. No baseline has ever
completed (`FINDINGS.md`), and a number here is meaningless while tracks 1 and 2
are open. Rebuilding a MemoryBench provider is ~a day against FINDINGS.md's
notes on the harness's quirks.

**Verify before acting** on every ⚠️ item — #18 and the `README.md` claims in
#22. (#9, and the `deployment.md` half of #22, were verified true on 2026-07-19
and are safe to work from; #9 is now fixed.)
