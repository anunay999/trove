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

## Where Trove actually stands (updated 2026-07-30)

A consolidated read of everything measured so far. Each row points at the item
that owns it — this is an index, not a second copy of the list.

### The central gap

| | | |
|---|---|---|
| ✅ | **Corpus scaled to 7,202 units / 7,434 nodes** (was 100 units at `TOP_K=8` = 8% of everything per question; now top-8 = 0.11%). The judged re-run (2026-07-30) confirms retrieval finally filters — flat's top-8 is mostly distractors | ~~**#31**~~ |
| ✅ | **The "-18 pts multi-hop" was a fixture artifact — now confirmed, not just suspected.** At 7,202 units the sign flipped to **+6 pts** (trove 45% vs flat 39%, n=33). The -18 is dead; do not plan from it | #25, ~~**#31**~~, ~~**#30**~~ |
| ✅ | **The instrument itself is sound in design** — controls tie at 100%, `validateDataset` enforces the bridge property mechanically, and the shapes separate cleanly. It was the *corpus scale* that was wrong, not the experiment | #25 |
| ⚠️ | **The re-run's edge is marginal and broad, not a clean traversal win.** +6 multi-hop is exactly **2 items** on n=33 — sitting on the harness's own significance floor (it printed SUPPORTS only because the guard is strict `<`). Trove also leads controls **+11** (2 items, 100% vs 89%), which the label calls "level." #26 was written to explain a *loss* that no longer exists — its premise is gone | ~~**#26**~~ premise moot |
| ⚠️ | **Trove buys its +8-pt overall edge with ~6.5× context tokens (972 vs 149) and ~1.7× retrieval latency (780 vs 447 ms).** The triple (#30) reframes "Trove wins" as "wins narrowly, and pays materially for it" — the cost axis is where the graph must ultimately justify itself | ~~**#30**~~ |

**Track 2 measured (2026-07-30).** #31 + #30 landed and the judged re-run ran
at 7,202 units. Overall: **trove 65% / flat 57%**; multi-hop **+6 pts**, control
**+11 pts**; trove **972 ctx-tokens & 780 ms** vs flat **149 & 447**. The
retracted -18 is confirmed dead. The honest reading is a *modest, broad*
accuracy edge bought at ~6.5× tokens and ~1.7× latency — not the decisive
traversal win the harness's SUPPORTS label suggests. Full block under #25.

This is the **third** instance of the same error in this repository, and the
lesson was already written down twice before it recurred:

- The 222× HNSW regression was invisible at 245 rows — recorded at the top of
  this document as "verify performance claims at realistic scale".
- Semantic-search behaviour was verified on `trove_repro` (245 rows) and
  returned a false negative — recorded in `bench/FINDINGS.md`.
- The thesis harness then drew an **architectural** conclusion from 100 rows.

A small fixture does not merely add noise; it changes which system wins. Any
future claim about retrieval, ranking or the graph must state its corpus size
next to the number, and be disbelieved if it does not.

### Retrieval and ranking

| | | |
|---|---|---|
| ✅ | `trove-cov` 71-88% vs `flat-cov` 92-97% — Trove surfaces *less* evidence than naive top-k | #25 |
| ✅ | Six misses at **exactly 50% coverage** — traversal reaches the join hub and stops | #8/#10 |
| ✅ | Three misses at **100% coverage** — evidence present, model abstained. Atom presentation reads less naturally than raw spans | #10 |
| ✅ | Precision 22-23% against Hit@K 90-100% | #8 |
| ✅ | Activation ranking is recency+frequency+degree; no semantic-alignment term | #10 |
| ✅ | Extraction loses ~10 pts (85.4% in units, 75.6% into atoms) | #4 |

### Provenance — the differentiating claim

| | | |
|---|---|---|
| ✅ | **`weak_evidence` found 0%-containment citations in real vault data** — provenance present but wrong, in production, today | #17 |
| ✅ | Quote-form citation landed; rejected or unserved evidence now makes `remember.complete=false` with repair-shaped reasons | ~~#9(c)~~ |
| ✅ | #17 remains a read-side lint warning; #9(c) now supplies the write-result provenance gate | #17, ~~#9(c)~~ |
| ✅ | ~~No integrity suite~~ — five core claims now run on both stores in CI | ~~**#28**~~ |

### Cost and performance

| | | |
|---|---|---|
| ✅ | **Reconciliation was unconditional** — 335 nodes cost ~25 min and ~1,675 judge calls. **Gated + batched 2026-07-20**: calibrated distance gate (0.45), one call per write max, per-owner budget; measured 74 → 34 calls on the 56-atom calibration corpus | ~~**#27**~~ |
| ✅ | ~~`SearchResult` discards distance~~ — distance now rides on every semantic hit (`SearchResultNode.distance`, both drivers) | ~~**#27**~~ |
| ✅ | No backpressure on embedding calls · `OVERFETCH` is a guess · tuning constants hardcoded against a 245-row fixture | #21, #14, #13 |

### Measurement gaps

| | | |
|---|---|---|
| ✅ | **No competitor baseline has ever completed** (Mem0 failed 4x; Zep/Supermemory unfunded). Any ranking against rivals would be fabrication | FINDINGS |
| ✅ | The harness's distillation is one write policy, not Trove end-to-end — may **understate** Trove | #25 |
| ✅ | The flat baseline gets raw spans, which Trove deliberately never serves — may **overstate** the baseline | #25 |
| ✅ | **The thesis harness reports accuracy alone** — the same flaw this repo criticises in every vendor benchmark. Flat is served top-8 raw spans; Trove a token-budgeted brief. Until the triple is reported, "-18 pts" may be the wrong sentence | **#30** |
| ✅ | **No task-shaped eval.** The actual product question is untested | **#29** |
| ✅ | No realistic-scale fixture; no plan assertions for lexical/neighborhood/evidence paths | #20, #19 |

### Still unverified

| | | |
|---|---|---|
| ✅ | `read({ asOf })` selects the newest fact revision at that time; title, summary, and content are snapshotted | #18 |
| ✅ | README distinguishes node recorded-time history from edge bitemporality | #22 |

### A note on how these numbers were produced

The 2026-07-20 review found four harness defects **that all pushed in the same
direction**: reconciliation forced off (voiding the supersede items), its jobs
never drained (so no supersedes edges existed at recall), the `SUPERSEDED`
marker never taught to the answering model though `recall`'s tool description
teaches every real client, and a mid-edit tree tested and misread as a flake.
Each made Trove look worse than it is; teaching the marker alone moved supersede
from 50% to 100%. Systematic direction is not random error. When a number here
disfavours Trove, check the instrument before accepting it — and when one
favours Trove, check twice.

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

**Follow-through — provenance correct by construction, all three layers now
shipped:**

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
- **(c) Strict completion gate — done 2026-07-30.** `remember` now returns
  `complete: false` whenever a requested citation is rejected or was never
  served, while retaining the repair-shaped `evidenceRejected` /
  `evidenceUnserved` reasons and the independent `action` describing the node
  mutation. Evidence-free agent inference remains a valid complete write and
  is explicitly marked as inference when recalled. Failed requested links are
  likewise reported in `linkRejected` instead of disappearing.

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

**Status 2026-07-30:** semantic alignment from query↔node embedding distance now
ships as `w_s`; lexical-only hits and graph neighbors receive the mean known
alignment. Noise remains deliberately open to keep ranking deterministic.

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
  `TROVE_RECONCILE_JUDGE_MODEL`), otherwise a conservative heuristic that only
  flags near-identical titles. Verdicts: supersedes / duplicate / contradicts /
  related / distinct. **The LLM judge is opt-in (`TROVE_RECONCILE_JUDGE=1`) as
  of the PR #26 merge** — it originally activated on any `OPENAI_API_KEY`,
  which meant every deployment with semantic search silently paid up to 5 LLM
  calls per write. Cost is now bounded by construction (#27: calibrated
  distance gate, one batched call per write, per-owner budget); the flag stays
  opt-in until that bound has production mileage.
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

### 18. Node-level time travel ✅

**Fixed 2026-08-06** — `node_revision` snapshots title, summary, and content;
`read({ asOf })` selects the newest revision recorded by that time and returns
`null` before creation. Evidence and annotations deliberately remain current.

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
  node/edge/claim writes. ✅ **fixed** — the doc now describes the dropped
  table (migration `010`) and current-revision embeddings, and `remember`
  hands evidence and links to `capture`/`update` so they land in the node's
  own transaction (`tests/remember-atomicity.test.ts`).
- `docs/deployment.md` says production needs an external scheduled worker, while
  `src/server.ts:686` starts one automatically. ⚠️ reported.
- `README.md` now documents recorded-time node snapshots separately from edge bitemporality. ✅ fixed with #18.
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

**Re-run at scale (2026-07-30, n=51, 33 multi-hop, 7,202-unit corpus, judged, triple reported):**

This is the first number that is not a fixture artifact — same 51 items, same
judge, same two arms, but the corpus is padded to 7,202 units / 7,434 nodes so
flat's `TOP_K=8` sees 0.11% of the world instead of 8%. Result, verbatim:

```
system   accuracy   ctx-tokens (mean)   retrieval-ms (mean)
--------------------------------------------------------------
trove     65%             972               780
flat      57%             149               447

--- verdict ---
multi-hop gap (trove - flat): 6 pts  (n=33, one item = 3 pts)
control gap   (trove - flat): 11 pts  (n=18)
SUPPORTS the thesis: ahead on multi-hop, level on single-hop — the graph is doing the work.
```

Per-bucket (from the miss lists): multi-hop **trove 15/33 (45%) vs flat 13/33
(39%)**; control **trove 18/18 (100%) vs flat 16/18 (89%)**. The entire win is
**4 questions out of 51** — +2 multi-hop, +2 control.

**What this settles.** The retracted **-18 flipped to +6** at scale. That is the
decisive confirmation that the 100-unit number was a fixture artifact and not a
property of the graph: the sign of the headline result reversed when the only
thing that changed was corpus size. Plan from this, not from the -18.

**What this does NOT settle — read the SUPPORTS label with discipline.** The
harness's own guard refuses to conclude when the gap is within two items of
zero. The multi-hop gap here is **exactly two items** (2/33 = 6.06 pts) and the
floor is `perItem*2` = 6.06 pts — it cleared the gate only because the
comparison is strict `<`, not `<=`. It is real-but-marginal, sitting on the
line the repo drew precisely to stop overclaiming (see the LongMemEval "40 vs
30 off ten questions" lesson). And Trove leads the *controls* by +11 pts (also
two items) — the harness treats ≤15 pts as "level," but proportionally the
single-hop edge (2/18) is larger than the multi-hop edge (2/33). So the data
fits "atom distillation helps modestly across the board" at least as well as
"the graph is doing the [traversal] work." Do not upgrade the sentence beyond
"no longer loses multi-hop at scale, wins narrowly overall."

**The triple is the real story (#30).** Trove's +8-pt overall edge is bought
with **~6.5× the context tokens** (972 vs 149) and **~1.7× the retrieval
latency** (780 vs 447 ms). Accuracy-alone reads "Trove wins"; the triple reads
"Trove wins narrowly and spends materially more to do it" — which is exactly the
cost axis Trove exists to argue about, now measured instead of asserted. Whether
the graph *earns* its complexity at this scale is a cost/accuracy tradeoff
question, not a clean yes.

**Provenance / reproduction.** pg driver, `text-embedding-3-small` (1536-dim),
`TROVE_RECONCILE_JUDGE=1`, scratch DB `trove_thesis`, `distractors.json` (fixed
haystack). 162 item reconciles drained cleanly (0 skipped after the hardened
retry loop — see #30); distractor reconciles left pending by design.

---

**Grown dataset + full run (2026-07-20, n=51, 33 multi-hop) — RETRACTED, kept for the record:**

> ❌ **RETRACTED AS A FINDING — see #31.** This run used a **100-text-unit
> corpus** against `TOP_K = 8`, so the flat baseline retrieved 8% of everything
> in existence per question. That accounts for its 92-97% coverage and makes
> the comparison meaningless. The number below is kept for the record and
> because its per-item diagnostics are still useful, but **it is not evidence
> about the graph.** The thesis is *unmeasured*, not disproved. Everything in
> the reading that follows is conditional on a fixture that should have been
> questioned first.

The dataset grew to 17 bridge / 8 chain / 8 supersede + 18 controls (35.3%),
`validateDataset` clean, each new item designed so no single span suffices (the
answer-bearing span carries multiple candidate values; only the join selects).
Result, verbatim:

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

The reading below was written before #31 was noticed. Its claim to be "a real
negative result" is exactly the sentence #31 retracts — the corpus, not the
dataset, was the rigged variable, and controls tying at 100% does not rescue it
because both arms were operating where retrieval is nearly free. The per-item
diagnostics (the exactly-50% coverage signature, the abstentions at 100%
coverage) remain worth keeping as leads. Original text follows:

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

### 26. Separate distillation loss from traversal failure ⚠️ **conditional on #31**

> **Do not run this yet.** It was written when the n=33 run's "−18 pts" looked
> real. #31 retracted that: the corpus was 100 text units against `TOP_K=8`, so
> there may be no gap to explain. Run #31 first; if a gap survives the rescaled
> re-run, this becomes the gate again, unchanged.

*If* a real multi-hop gap exists, two causes fit equally well and imply
completely different work:

- **Distillation loss (#4)** — Trove serves distilled atoms, flat serves raw
  spans. Controls tie at 100%, so distillation costs nothing when one span
  suffices; the deficit is concentrated exactly where facts must be composed.
- **Traversal stopping (#8/#10)** — six misses at exactly 50% coverage, recall
  reaching the join hub and going no further.

**Action** — three variants of the same run, same dataset, same judge:

| variant | Trove's context is | isolates |
|---|---|---|
| A (current) | distilled atom bodies | baseline: 59% / 63% |
| B | the **raw text units those atoms cite** | distillation |
| C | atoms at `depth=2` | traversal depth |

B ≈ flat ⇒ distillation is the whole problem; fund #4 and leave ranking alone.
B ≈ A ⇒ retrieval never reaches the right atoms; fund #8/#10.
C > A ⇒ traversal stops one hop short, a much smaller fix than either.

B is nearly free: `pack.citations` already maps atom → text unit, so it also
exercises provenance end-to-end and double-checks #17.

**Why this gates #4 and #8/#10:** funding either before it is a coin flip, and
#3 is what that costs — an obvious causal story, wrong, cheap to falsify. Note
this item was itself briefly labelled "first" on the strength of a number that
did not survive review; #31 now precedes it.

### 27. Reconciliation is unconditional and expensive ✅ **gated + batched 2026-07-20**

**Evidence** — a 335-node corpus took **~25 minutes and ~1,675 judge calls** to
drain, and killed two thesis runs before the process was detached. In
production it was up to 5 LLM calls per write, proportional to write volume.

**Root cause** — the judge was asked two bundled questions: *are these about the
same thing?* (which the embedding already answers numerically, for free) and
*same attribute, newer value?* (which genuinely needs a model). `SearchResult`
was `{nodes, textUnits}` — the distance was computed and then discarded, so the
first question was re-derived at model prices for every candidate, and the
answer was "no" for almost all of them.

**Done — gate + batch + budget.** `SearchResult` nodes now carry the semantic
arm's cosine distance (`SearchResultNode.distance`, both drivers; lexical-only
hits carry none). `performReconcileNode` partitions candidates on it, judges
the survivors in ONE batched call (worst case 5 calls → 1; a write with no near
neighbour makes **0**), and reports `judgeCalls` plus a per-candidate `via`
(judge / heuristic / distance_gate / budget) in the job result. A per-owner
hourly budget (`TROVE_RECONCILE_JUDGE_BUDGET`, default 100, 0 disables) is the
backstop; overflow is flagged `judge_budget_exceeded`, not retried into the
same window.

**The thresholds are calibrated, not guessed** — the 0.05/0.35 bands originally
proposed here were measured first, and the measurement rejected half the plan
(`scripts/calibrateReconcileBands.ts`, 56-atom labelled corpus, 1 owner,
`text-embedding-3-small`, pg driver):

```
partner distances:  supersede   0.076-0.408 (n=8)   duplicate 0.050-0.399 (n=6)
                    contradicts 0.073-0.286 (n=4)   related   0.388-0.548 (n=5)
gate simulation:    T=0.40  *** loses a real supersession (standup-930 at 0.408)
                    T=0.45  34 calls / 56 writes, 22 writes make 0 calls,
                            no actionable partner skipped
                    T=0.50  34 calls / 56 writes, same zero-call count
```

- **The no-call duplicate band is REJECTED by the data.** Duplicate and
  supersede pairs occupy the *same* distance range (0.050-0.399 vs 0.076-0.408,
  overlapping almost completely) — anything close enough to flag blindly is
  close enough to be a supersession. Flagging duplicates without judgment would
  have flagged supersessions as duplicates and never written the edge: the
  trap, measured in advance.
- **The skip band landed at 0.45** (`TROVE_RECONCILE_SKIP_DISTANCE`), not 0.35
  as guessed: the guessed value would have skipped 3 of 8 real supersessions
  (they measured 0.307-0.408). 0.40 was already too low — it lost one. 0.45
  keeps a measured margin above every actionable class (max 0.408; contradicts
  pairs land in the supersede range at 0.073-0.286).
- Before/after on the calibration corpus (56 atoms, adversarially dense with
  near neighbours — real corpora are sparser): **74 → 34 judge calls** for the
  same 56 writes, measured against the shipped `performReconcileNode` with
  `judgeCalls` summed from job results — with no actionable partner ever gated
  away. Lexical-only candidates (renamed facts) are always judged — a candidate
  with no distance is never treated as far.

**The batch prompt needed grounding, measured live.** First version of the
batched prompt let gpt-4o-mini copy a strong verdict onto an unrelated
candidate — banana bread judged "supersedes" of a volleyball record at 0.9
confidence, reason and all; the edge would have been written. The reply schema
now requires each entry to echo its candidate's `Title` verbatim, and
`parseReconcileJudgments` rejects entries whose echo is missing or mismatched
(safe default, no action). After grounding, the live judge classifies
supersede / distinct / related correctly on the smoke pairs. This is the same
lesson as the thresholds, one layer up: the batching-is-better claim was
plausible, and only the live run showed where it broke.

**Interim mitigation shipped earlier** — the judge was flipped from opt-out to
**opt-in** so PR #26 could merge without sending unbounded spend to production.
The flag stays opt-in for now: the bound is measured on a 56-atom calibration
corpus, not yet on production mileage. Flipping the default is a separate
decision.

Rejected: read-time reconciliation. It re-pays on every read of the same
conflict and puts model latency on the read path. Write-time amortises once.

Covered by `tests/reconcile.test.ts`: the gate partition (unknown ≠ far),
zero-call writes, skipped candidates recorded `distance_gate`, batched
single-call judging, budget overflow, batch reply parsing, and the standing
trap guard — "volleyball record is 4-2" → "5-2" still produces a `supersedes`
edge end-to-end on both drivers.

### 28. No integrity suite ✅

Every claim in the README is asserted; none is enforced. #9 and #17 both found
the core provenance claim failing silently in production — the pattern is that
nothing *checks*.

**Action** — roughly five assertions, cheap and permanent:

1. Every recalled atom has a resolvable citation, or is explicitly marked agent
   inference
2. `remember` with an unresolvable ref never reports success
3. A superseded atom is labelled, and an in-pack successor receives no lower
   body fidelity (supersession is annotation-first, not a ranker)
4. No silently partial write — if annotations fail, the write says so
5. Token budget is never exceeded *(already covered by repro `R3`)*

These need no benchmark: they are local assertions. That is what makes them
track 1 and available now.

**Done 2026-07-30** — `tests/integrity.test.ts` enforces all five claims on
both stores. Recall exposes citation-vs-agent-inference provenance; `remember`
reports incomplete evidence/link attachments; and packing transfers body
fidelity from a superseded atom to its in-pack successor without changing
relevance order. This matches the production-graph check that motivated the
honest invariant: the highest-risk live successor already ranked naturally
above its labelled predecessor (0.85 vs 0.43), so supersession remains
annotation-first rather than becoming a general reranker.

### 29. No task-shaped evaluation ⚠️ **the untested product question**

Every number so far — LongMemEval, and now the thesis harness — grades
question-answering over a fixed corpus. Trove's actual job is being the memory
behind an agent doing work: picking up context it lacked, not re-deriving what
is known, not acting on stale beliefs, and being auditable afterwards. **Three
of those four are not accuracy metrics, and none is measured.**

This is the gap most likely to make the other numbers misleading rather than
merely incomplete: a system can lose a QA benchmark and still be the better
working memory, and #25's own caveat (the flat baseline is served raw spans
Trove deliberately never serves) is a small instance of exactly that.

**Action** — not obvious, and worth designing rather than improvising. One
credible shape: replay real Claude Code sessions against Trove and against a
scratchpad, and score re-derivation, stale-belief actions, and citation
traceability. Deliberately left open.

### 30. The thesis harness reports accuracy alone ✅ **done 2026-07-30 — the triple is reported**

`bench/FINDINGS.md`, written during the LongMemEval pilot, says:

> Publish the **MemScore triple** — accuracy / latency / **context tokens** —
> not accuracy alone. The token column is the genuinely differentiated axis,
> since `recall` takes a `tokenBudget` and cost is a dial rather than a
> byproduct.

`bench/thesis/run.ts` was then written ignoring that. It reports accuracy per
shape and nothing else, which is the same flaw this repository criticises in
every vendor benchmark it has looked at.

**Why it may change #25's reading** — the two systems are not spending the same
budget. Flat is served **top-8 raw spans**; Trove is served a **token-budgeted
brief** and deliberately withholds the rest. `RecallResult` already carries
`spentTokens`, and it is discarded. If Trove reaches 59% on ~1,200 tokens while
flat reaches 76% on ~6,000, "Trove loses multi-hop by 18 pts" is the wrong
sentence — those are two points on a cost curve, on the axis Trove exists to
win. Right now nobody knows which it is, because it was never measured.

**Done** — `run.ts` now times each arm's retrieval (`retrievalMs` around
`performRecall` for trove, around embed+cosine+slice for flat) and estimates
context tokens with a single char/4 heuristic applied to *both* arms
(`estimateTokens`, deliberately not `pack.spentTokens`, so the comparison is
apples-to-apples rather than one arm's accounting vs a guess). `report()` prints
the triple: `system  accuracy  ctx-tokens  retrieval-ms`. Hardened alongside:
`chat()` retries network/429/5xx with backoff, and the job drain
(`runJobWithRetry`) survives transient failures instead of killing a two-hour
run on one blip — reconcile skips are disclosed, embedding failures still throw.

**Result (2026-07-30, full block under #25):** trove **65% / 972 tok / 780 ms**
vs flat **57% / 149 tok / 447 ms**. The triple changed the sentence exactly as
predicted — not "Trove loses multi-hop by 18 pts" (retracted) and not simply
"Trove wins," but **"Trove wins narrowly (+8 pts) and pays ~6.5× the tokens and
~1.7× the latency for it."** The cost axis, the one Trove exists to win, is now
measured. #26's premise (explain a multi-hop *loss*) no longer exists.

**Note** — this closes the fifth 2026-07-20 harness defect; like the other four,
it had made Trove look worse than it is (the retracted -18). See the methodology
note at the top.

### 31. The thesis corpus is too small to measure retrieval ✅ **padded 2026-07-20; judged re-run done 2026-07-30**

**Evidence** — the n=51 run ingested **100 text units** and the flat baseline
uses `TOP_K = 8`. It retrieves **8% of the entire corpus** for every question.
Trove meanwhile holds 331 nodes behind a token budget and selects far more
aggressively.

**Impact** — at 8% recall-by-default, retrieval is close to handing the model
the whole dataset, which fully accounts for `flat-cov` of 92-97% and makes the
comparison meaningless. The regime does not resemble production by orders of
magnitude:

| corpus | top-8 is | |
|---|---|---|
| thesis harness | **8%** | retrieval barely filters |
| LongMemEval container (~11.6k rows) | 0.07% | |
| a real vault (10^4-10^6 units) | 0.008% or less | where structure should pay |

A graph exists to beat similarity search *when the corpus is large enough that
similarity search misses things*. The harness removed that condition and then
reported that the graph did not help.

**This does not mean Trove wins at scale** — it means the experiment has not
been run. The honest status of the thesis is **unmeasured**, not disproved.

**Update 2026-07-30 — the experiment has now been run.** At 7,202 units the
retracted -18 flipped to **+6 pts multi-hop** (trove 65% / flat 57% overall).
The corpus scaling was the load-bearing fix: the sign of the headline reversed
with corpus size as the only changed variable. Full result and the (marginal,
broad, cost-heavy) reading are under #25's re-run block; the triple is #30.

**Done — the haystack is built and verified at scale; the judged re-run waits
for #30 (reporting the triple) so the first real number is not accuracy-only
again.** `bench/thesis/genDistractors.ts` generated **7,102 distractor notes**
(committed as `bench/thesis/distractors.json` — the haystack is identical
across runs; regenerating makes runs incomparable). Safety is mechanical:
every item's answers/bridgeTerms/requiredFacts plus item proper nouns are
banned substrings (1,216 candidate notes dropped), domains are adjacent-but-
different-subject, exact dupes dropped. `run.ts` ingests them symmetrically —
sources for the flat units, pre-atomic claim nodes for the graph (no LLM
distillation: they are already single-fact; padding only one side would rig
the comparison in the other direction). `TROVE_THESIS_DISTRACTORS=0`
reproduces the retracted regime for A/B.

**Verified at full scale** (prepare-only run, ~15 min, pg driver,
`text-embedding-3-small`): **7,202 text units** (100 item + 7,102 distractor)
and **7,434 nodes**; top-8 is now **0.11%** of the corpus, not 8% — retrieval
finally filters. 136 judged calls for 161 item reconciles (the #27 gate doing
its work), 5 supersedes edges written, embeddings complete (0 missing on both
tables), and a spot-check recall over the full graph returns a sane pack while
the flat top-8 is now 5/8 distractors.

**Two drain bugs found by that verification, both fixed:**
`runJob` drains stopped after one 256-row batch because the embedding
follow-up is only ever enqueued by the background *worker* — direct `runJob`
loops must queue it themselves (now `enqueueEmbeddingDrainFollowUp`, shared
between worker and harness, covered in `tests/jobs.test.ts`); and the harness
drained reconciles *before* embeddings, leaving the semantic arm empty (10
judged calls, 1 edge) — the old blanket drain had gotten the order for free
from job priorities. Embeddings now drain first; reconciles follow.

**Cost note** — reconciliation (#27) landed 2026-07-20 (calibrated distance
gate, one batched call per write, per-owner budget), so the multiplier on
distractor material is ~1 gated call per write worst-case, most writes zero —
and distractor reconcile jobs are never drained at all (no measurement value),
which is why 7,102 extra nodes cost zero judge calls.

**Provenance of the error** — flagged during the 2026-07-20 review, after the
number had been recorded, analysed in detail, and used to re-sequence this
document. The analysis in #25 is careful and entirely conditional on a fixture
that was never questioned. Being thorough downstream of an unchecked assumption
produces confident, well-documented, wrong conclusions.

---

## Suggested order

Three tracks, and the dependency between them is the point: **#4 and #8/#10 are
accuracy work, and accuracy work needs a valid instrument.** Sequencing them
first — as this document originally did — means shipping changes nobody can
evaluate. That is how the 222× regression stayed invisible.

**Track 1 — correctness of the core claim.** Needs no benchmark; assertions are
local. Closed 2026-07-19 through 2026-07-30: ~~#9~~, ~~#17~~, ~~#5~~, ~~#6~~,
~~#7~~, ~~#23~~, ~~#16~~, ~~#1+#2~~, ~~#9 follow-through (a)+(b)+(c)~~, and
~~#28 integrity suite~~. The README's core integrity claims are now enforced
on both stores rather than left as prose.

**Track 2 — does the graph earn its complexity.** Still **blocked on
instrument.** #25 built the dataset and #31 then found the corpus it runs
against is too small to measure retrieval at all, so the question is exactly as
open as it was before the harness existed — with better items to ask it with.

3. ~~**Grow `bench/thesis` to ≥30 multi-hop items**~~ — done 2026-07-20: 33
   multi-hop (17 bridge / 8 chain / 8 supersede) + 18 controls (35.3%),
   `validateDataset` clean. **The sample size is sufficient; the corpus is
   not** — see #31. The run's "−18 pts" is retracted and must not be planned
   from; its per-item diagnostics survive only as leads to reconfirm at scale.
4. ~~**#27 gate the reconcile judge**~~ — **done 2026-07-20.** Distance surfaced
   on `SearchResultNode` (both drivers), candidates gated at a *calibrated* 0.45
   (the guessed 0.35 would have skipped 3 of 8 real supersessions; the no-call
   duplicate band was measured and rejected — duplicates and supersessions share
   the same distance range), survivors judged in one batched call, per-owner
   hourly budget. Measured 74 → 34 calls on the 56-atom calibration corpus, no
   labelled partner ever gated away. The opt-in default stays until the bound
   has production mileage. PR #26's merge blocker is resolved.
5. ~~**#31 scale the corpus to 5-10k text units**~~ — **done 2026-07-20.**
   7,202 text units / 7,434 nodes, verified at scale; top-8 is now 0.11% of
   the corpus. `genDistractors.ts` → committed `distractors.json`; the 51
   items are untouched, only the haystack changed. Two harness drain bugs
   found and fixed in the doing (embedding follow-up is worker-only; drains
   ordered embeddings-before-reconcile).
6. **#30 report the triple** — accuracy / latency / tokens. ~20 lines,
   `spentTokens` is already on the pack. **Now the step before the re-run**,
   so the first real number is not accuracy-only again.
7. **#26 the ablation** — **THE GATE**, once the instrument is real.
   Distillation loss and traversal-stopping both explain a multi-hop gap and
   imply different work. ~1 hour; `pack.citations` already carries what variant
   B needs.
8. **#8 + #10 ranking** — *if #26 says traversal.* The exactly-50% coverage
   signature is a lead, not yet a measured target: it was observed in the
   invalid regime and must be reconfirmed at scale.
9. **#4 extraction loss** — *if #26 says distillation.* Independently supported
   by `extraction-recall.ts` (85.4% → 75.6%), which does **not** depend on the
   thesis corpus, so this one lead survives #31 intact.

**Track 3 — competitive comparison.** Still last for *publishing*, but its
sanity-check value was underrated when the MemoryBench provider was deleted on
2026-07-20. That deletion left the flat baseline as the **sole comparator**, and
nothing tells us whether it is unusually strong — #31 says it very likely was.
Had a second system been runnable, "everything loses to raw-span retrieval at
100 units" would have surfaced immediately instead of being written up as a
finding about Trove.

**Revised guidance:** with #31 landed, rebuild **one** provider (~a day against
`FINDINGS.md`'s notes on the harness's quirks) and run it as an instrument check,
not for a number. A comparator that shares Trove's distillation-shaped
disadvantage is the cheapest available guard against another single-system
artifact. The reasoning for deleting it — LongMemEval is the wrong *shape* —
still holds for publication; it did not hold for calibration.

**Track 4 — the question none of this answers.** #29: every number here grades
question-answering over a fixed corpus, while Trove's actual job is being the
memory behind an agent doing work. Three of its four real jobs are not accuracy
metrics and none is measured. Left open deliberately — it needs designing, not
improvising — but it is the gap most likely to make the numbers above
misleading rather than merely incomplete.

**Verify before acting** on every ⚠️ item — #18 and the `README.md` claims in
#22. (#9, and the `deployment.md` half of #22, were verified true on 2026-07-19
and are safe to work from; #9 is now fixed.)

---

## Path to a defensible position

The tracks above say what to fix. This says what to fix *toward*, because the
list is long enough that "do the next item" stops being a strategy.

### Step zero, before anything else

**#31** — make the corpus realistic. Everything downstream currently measures a
regime where the flat baseline sees 8% of the world per query. #30 and #26 are
both well-designed instruments pointed at an artifact; running them first buys
precision about nothing.

### Phase 1 — find out whether we are losing at all (weeks)

1. ~~**#27** gate the reconcile judge~~ — **done 2026-07-20.** Calibrated
   distance gate (0.45), batched single-call judging, per-owner budget; 74 → 34
   calls on the 56-atom calibration corpus. PR #26's merge blocker is resolved.
2. ~~**#31** pad the corpus to 5-10k units, same 51 items~~ — **done 2026-07-20**
   (7,202 units, fixed `distractors.json` haystack)
3. ~~**#30** report accuracy / latency / tokens~~ — **done 2026-07-30**
4. ~~**Re-run**~~ — **done 2026-07-30.** trove 65% / flat 57%; multi-hop **+6**,
   control +11; trove 972 tok / 780 ms vs flat 149 / 447. The -18 is dead
5. ~~**#26** ablation, *if a gap survives*~~ — **premise gone.** There is no
   multi-hop *loss* to attribute; Trove is (narrowly) ahead. #26 would now only
   answer a different question — why the win is small and broad, not traversal-
   shaped — and that is not urgent
6. Fix whichever it names — deferred with #26

Note the change of title. The earlier version of this section was called "stop
losing", which presumed the loss was real. It has not been established.

A prior worth recording so it can be falsified: the **exactly-50%** signature on
six two-hop items points at traversal, since distillation loss would degrade
both hops rather than precisely one. But controls tying at 100% while multi-hop
collapses is equally what distillation-that-only-hurts-composition looks like.
**Both readings are now additionally suspect** — they describe behaviour in a
regime where the baseline was near-oracle, so the signature itself may not
survive #31. Treat as a lead to reconfirm, not a diagnosis.

### Phase 2 — find the edge that is actually defensible

Ranked by evidence, not by how good the story sounds:

| candidate | status |
|---|---|
| **Search latency** | ✅ **4× verified** (109 ms vs 437 ms) — but that is *raw semantic search*. Note the thesis harness measured *full recall pack assembly* at **780 ms vs flat's 447 ms cosine** (2026-07-30): the traversal+brief path is ~1.7× slower than naive top-k. Both are true of different operations; don't quote the 4× for the recall path |
| **Token efficiency** | ⚠️ **Measured 2026-07-30 and it cuts the other way at this scale** — Trove spent **6.5× the context tokens** (972 vs 149) for +8 pts. The budget *dial* is real; the default write policy is not token-cheap. #30 closed the measurement |
| **Provenance / audit** | Genuinely unique. Currently *failing*: `weak_evidence` found 0%-containment citations in live vault data |
| **Multi-hop reasoning** | ✅ **Measured 2026-07-30: narrowly ahead, not behind.** +6 pts at 7,202 units (the -18 was a fixture artifact, #31). But it is 2 items on the significance floor, and controls lead by more — a modest broad edge, not a proven traversal win |

The honest read: **QA accuracy is a crowded lane and a hard one**, and it is the
axis every competitor already optimises. Latency + token cost + auditable
provenance is a lane nobody is seriously contesting — but the 2026-07-30 re-run
is a caution against assuming Trove already owns it: on the recall path Trove
was *slower* (780 vs 447 ms) and *token-heavier* (972 vs 149) than a naive
baseline. What is architecturally real is that both are **dials** (the HNSW
search is 4× faster in isolation; `recall` takes a `tokenBudget`), not that the
default configuration is already cheap. Provenance remains the one genuinely
uncontested axis. That argument never needed the multi-hop number — which is
fortunate, because an earlier version of this section leaned on "Trove is behind
an untuned baseline" as though it were established. It was not; and it is now
narrowly ahead.

### Phase 3 — make it undeniable

- **Track 3 competitive baseline** — meaningless before Phase 1, essential after
- **#29 task-shaped eval** — the actual product question, still unanswered
- **Publish with full methodology** — sample size, judge, models, Trove SHA. The
  absence of exactly that is what makes the rest of the ecosystem's numbers
  uncitable; matching it is a positioning advantage available for free

### The decision to take on evidence — but not yet

If a real multi-hop gap survives #31, and #26 says traversal, and fixing
traversal does not close it, then the defensible position becomes: **Trove is
auditable, token-efficient, low-latency memory**, and the graph is *how it
works* rather than *why anyone buys it*.

That is not failure — it is the same product with a claim that survives
scrutiny. But note the three conditionals. An earlier version of this section
presented that repositioning as a live decision on the strength of a number
that has since been retracted. **Do not reposition on #25.** The failure mode
cuts both ways: chasing a benchmark Trove is not built to win wastes months,
and abandoning the graph on an artifact throws away the thing that might
actually differentiate it.

---

## Standing rule, earned three times

**State the corpus size next to every retrieval, ranking or performance
number in this repository, and disbelieve any that does not.**

Three instances, each after the lesson was already written down:

1. 222× HNSW regression — invisible at 245 rows
2. Semantic-search verification on `trove_repro` — false negative at 245 rows
3. The thesis harness — an *architectural* conclusion from 100 rows

A small fixture does not add noise. It changes which system wins.
