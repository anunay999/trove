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

### 1. `refresh_embeddings` is not owner-scoped ✅

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

---

### 2. Embedding backfill drains ≤100 rows per job ✅

**Evidence** — `refreshMissingEmbeddings` clamps to
`Math.max(1, Math.min(100, limit))`; default 24. Measured: 22,730 pending rows ⇒
~228 sequential job runs, each its own round trip.

**Impact** — importing an Obsidian vault or any real corpus takes hours of
queue churn. Compounds with #1.

**Action** — raise the cap (the clamp predates batched embedding calls), and
embed in provider-sized batches rather than job-sized ones. Depends on #1 for
per-owner progress reporting.

---

### 3. `queryNormalize` strips meaning-bearing terms ✅

**Evidence** — `src/queryNormalize.ts` strips `today`, `now`, `ago`,
`currently`, `many`, `count`, `number`, `amount`. Verified:
`retrievalQueryTerms("How long ago did I move and how many boxes are left today?")`
→ `['long','move','boxes','left']` — every temporal and quantity marker gone.

**Impact** — temporal and aggregation intent is destroyed *before* either
retrieval arm sees it, so nothing downstream can recover it. Measured on
LongMemEval: **0% on temporal-reasoning vs 66.7% for plain RAG.**

**Action** — remove these terms from the strip list. Evaluate over positive
**and** negative query sets: the list also exists to stop noise terms matching
everything, so removing entries can regress precision. Consider stripping for the
lexical tsquery only and leaving the semantic arm the intact query.

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

### 5. `GraphJob.result` is an untyped envelope ✅

**Evidence** — `src/graphCore.ts:60`: `result: Record<string, unknown> | null`.
This is why `Number({nodeRevisions, textUnits})` → `NaN` compiled silently and
stalled the production embedding drain.

**Impact** — producer and consumer are never checked against each other for *any*
job kind. `RefreshEmbeddingsResult` now types one of them; the rest are
unprotected, and the same failure can recur in any of them.

**Action** — a discriminated union of result types keyed by `GraphJobKind`, with
producers annotated and consumers narrowing through it.

---

### 6. The two store drivers have drifted ✅

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

---

### 7. Maintenance jobs use global dedupe keys ✅

**Evidence** — `src/pgStore.ts:1558`: `dedupeKey: \`maintenance:${kind}\``.
Reproduced deterministically: after one capture, a second capture 1.2s later
added **0** new job rows — it deduped onto the existing one, which kept the
original `createdAt`.

**Impact** — any concurrent writer can absorb another's enqueue. Caused two
distinct CI flakes at ~20% (worked around in tests via per-file databases in
`tests/helpers.ts:isolateDatabase`, but the underlying design is unchanged).

**Action** — scope dedupe keys by owner, or make enqueue return whether it
created or joined so callers can reason about it.

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

### 9. `remember` may accept and silently discard evidence ⚠️

**Reported** — `src/agentOps.ts:116`: `remember` accepts nodes with no evidence
and silently ignores invalid evidence references. **Not independently verified.**

**Impact if true** — directly contradicts the README's "nothing is a
free-floating fact", and means `missing_evidence` lint findings are the only
signal that provenance broke.

**Action** — verify first. If confirmed, reject or loudly warn on invalid
references rather than dropping them.

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

### 16. Write-time reconciliation / contradiction detection ✅ — *highest value on this list*

**Evidence** — listed as open in `docs/memory-db-design.md`; no contradiction
pass exists in the write path.

**Why it matters more than anything else here** — supersession exists as a
*capability* (`supersedesEdgeId`, edge invalidation, validity intervals) but
nothing detects conflicts and invokes it. An agent must notice the contradiction
itself and choose to supersede, which in practice it will not. Until extraction
resolves entities against existing nodes and flags temporally-overlapping claims,
bitemporality is a mechanism nobody drives — the single most differentiated part
of the design is inert.

**Action** — on write: candidate-match against existing nodes (slug, FTS,
embedding), flag temporally-overlapping claims on the same entity, and enqueue
LLM-judged contradiction resolution as a `graph_job`. The event log already makes
this replayable.

### 17. Provenance quality measurement ✅

Nothing scores whether an answer traces to a genuinely supporting span. The core
thesis is currently an unverified claim, and there is no guard against citations
that are present but wrong.

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

### 23. `repro-eval` reports `18/17 PASS` ✅

`R9` calls `report()` twice under one id, incrementing `passCount` twice against
a hardcoded denominator. A harness that reports more passes than it has tests
undermines confidence in its own output.

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

## Suggested order

1. **#16 write-time reconciliation** — without it, the differentiator is inert
2. **#1 + #2 owner-scoped, batched embedding backfill** — blocks scale
3. **#3 temporal terms** — a measured loss to a naive baseline
4. **#4 extraction loss** — the write path discards answers
5. **#8 + #10 ranking** — retrieval finds the evidence and fails to surface it

Then #5 (typed job results) and #6 (driver parity), which are cheap and prevent
recurrence of bugs already seen once.

**Verify before acting** on every ⚠️ item — #9, #18, and the `deployment.md` /
`README.md` claims in #22.
