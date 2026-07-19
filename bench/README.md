# Benchmarking Trove

Trove is measured on **[LongMemEval](https://arxiv.org/abs/2410.10813)** (ICLR 2025) through
**[MemoryBench](https://github.com/supermemoryai/memorybench)**, an open-source harness that already
ships Mem0, Zep and Supermemory as providers.

The point of using someone else's harness is comparability. Every system in the table runs the same
dataset, the same answering model, the same judge, and the same scoring code. The only Trove-specific
code is `bench/providers/trove/` (~405 lines) implementing MemoryBench's `Provider` interface.

**We do not lift published numbers.** Vendor-reported LongMemEval scores are not comparable to each
other: Zep is variously cited at 71.2% (its own blog, overall), 63.8% (its temporal sub-task, widely
requoted as if it were the overall figure) and ~82% (a third party's table); Mem0 appears at 94.4%,
49.0% and ~85% depending on the source. Much of the ecosystem compares one vendor's *overall* score
against a rival's *sub-task* score. A number on our site is either measured on this harness or it is
absent.

> **Results so far:** see [FINDINGS.md](FINDINGS.md). The 2026-07-19 pilot found a correctness bug in
> `recall` (empty context packs for natural-language questions). No number from this harness should be
> published until that is fixed and the run repeated.

## Setup

Requires **bun** — MemoryBench uses `bun:sqlite` for checkpointing and `Bun.serve` for its UI, so
node cannot run it. `curl -fsSL https://bun.sh/install | bash`.

```bash
./bench/setup.sh                 # clones MemoryBench @118209a, links + registers the provider

# scratch database, never a real one
docker exec trove-postgres-1 psql -U trove -d postgres -c "CREATE DATABASE trove_bench;"
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:schema
DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench npm run db:migrate

cd bench/.memorybench && bun install
```

Then, from the MemoryBench checkout, with `TROVE_BENCH_DATABASE_URL` set:

```bash
bun run src/index.ts run     -p trove          -b longmemeval -j gpt-4o -l 3 -r smoke
bun run src/index.ts compare -p trove,rag      -b longmemeval -j gpt-4o -l 25 -r pilot
```

`-l/--limit N` and `-s/--sample N` work but are undocumented in `--help`. **Always pass one** — an
unbounded run is all 500 questions, which is roughly 24 hours of ingest alone (FINDINGS.md, finding
2). The first `longmemeval` invocation downloads a 264 MB dataset.

Useful afterwards: `show-failures -r <runId>` dumps each failure with its retrieved context, and
`npx tsx bench/diagnose-recall.ts` reproduces the retrieval bug directly against the scratch database.

## Methodology

| Choice | Value | Why |
|---|---|---|
| Dataset | `longmemeval_s_cleaned` (500 questions) | Auto-downloaded by MemoryBench from HuggingFace; the variant vendors report |
| Judge | `gpt-4o` | LongMemEval's official judge, and MemoryBench's default |
| Answering model | Same for every provider | Pinned in the run config; a provider that swaps readers isn't being compared |
| Metric | MemScore = `accuracy% / latencyMs / contextTokens` | A triple, not a scalar — see below |
| Isolation | One synthetic `app_user` per question | Maps MemoryBench's `containerTag` onto Trove's `owner_id` scoping (migration 006); per-owner slugs (007) keep concurrent containers from colliding |
| Concurrency | 1 (MemoryBench default) | The provider declares no `concurrency` config — it *relies* on the default. It must stay 1 because `refresh_embeddings` converges globally, not per-owner (FINDINGS.md, finding 3); this is currently unenforced and should be made explicit |
| Trove config | `tokenBudget=8000`, `depth=1`, evidence on | Trove's own defaults; overridable via env for the budget sweep |

### Why MemScore is the right metric

MemoryBench reports accuracy, latency and **average context tokens** as three numbers and refuses to
collapse them. That matters here: Trove's `recall` takes a `tokenBudget`, so cost is a dial rather
than a byproduct. A system scoring 95% on 25k tokens per query is not beating one scoring 90% on 7k —
they are different operating points on the same curve. The budget sweep below is the artifact that
curve comes from.

### Two fairness issues we found in the harness

Auditing MemoryBench before trusting it turned up two things, both handled explicitly:

1. **Zep overrides the judge prompt.** Of the built-in providers, only `zep`
   (`src/providers/zep/prompts.ts`) supplies a `judgePrompt`, so its answers are graded against a
   rubric it wrote while every other provider is graded against the built-in one. The Trove provider
   deliberately overrides `answerPrompt` only. When Zep is in the comparison we run it both ways —
   with and without its judge override — and report both. If the two differ materially, the
   with-override number is not comparable and gets marked as such.

2. **It is a competitor's harness.** MemoryBench is maintained by Supermemory, who also ship a
   provider in it. It is open source and the dataset and judge are standard, so this is auditable
   rather than disqualifying — but the scoring path (`src/orchestrator/phases/evaluate.ts`,
   `report.ts`) should be re-read on every upstream bump, and the pinned commit recorded in results.

### Write-time extraction

Trove's doctrine is `ingest` (raw, citable spans) then `remember` (short distilled atoms citing those
spans), and `recall` ranks atoms. Trove does **not** do write-time extraction itself — the design doc
lists "reconciliation in the write path" as open — so the provider performs the distillation an agent
would normally perform, using `gpt-4o-mini`. Mem0 and Zep both run LLM extraction on ingest, so this
is the like-for-like comparison rather than a thumb on the scale.

`TROVE_BENCH_EXTRACT=0` ablates it, measuring recall over raw ingested sessions alone. Report both:
the gap between them is the value of the atom layer, and it is a number nobody has published.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TROVE_BENCH_DATABASE_URL` | `DATABASE_URL` | Scratch Postgres. Refuses non-localhost unless `TROVE_BENCH_ALLOW_REMOTE=1` |
| `TROVE_BENCH_TOKEN_BUDGET` | `8000` | `recall` budget; sweep this for the accuracy-vs-cost curve (max 32000) |
| `TROVE_BENCH_DEPTH` | `1` | Graph expansion hops |
| `TROVE_BENCH_EXTRACT` | `1` | `0` disables write-time distillation |
| `TROVE_BENCH_EXTRACT_MODEL` | `gpt-4o-mini` | Model used for distillation |

## Cost

Measured on the 3-question pilot rather than estimated:

| Phase | Per question | Extrapolated to 500 |
|---|---|---|
| Ingest (~50 `gpt-4o-mini` extraction calls) | **169s** mean (158–181s) | ~24 h, ~25k LLM calls |
| Indexing (embeddings) | ~3,900 embeddable rows | ~1.9M embeddings, ≤100 per job run |
| Search | 548 ms mean | local, query-embedding cost only |
| Answer + evaluate | ~3.5 s | 500 × (context + one `gpt-4o` judge call) |

Ingest dominates and it is sequential. Always start with `-l 3` to validate the pipeline, then a
sample. MemoryBench checkpoints per phase, so an interrupted run resumes with the same `-r` run ID
instead of restarting — the pilot's indexing failure was fixed and resumed without re-ingesting.

## Results

**None yet, and none publishable.** The only run so far is the 3-question pilot recorded in
[FINDINGS.md](FINDINGS.md), which found bugs rather than produced a score.

*Planned* (not yet built — `bench/results/` does not exist and `web/` has no benchmark rendering
code): committed dated JSON per run, each stamped with dataset version, judge model, MemoryBench
commit and Trove git SHA, with the landing page rendering from those files rather than recomputing at
request time.

Before any number goes on the site, the threats to validity in FINDINGS.md need closing — in
particular the dropped `questionDate`, unmeasured extraction quality, and the fact that the provider's
write policy is not Trove's documented `remember` semantics.
