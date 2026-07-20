# Trove benchmarks

## What's here

| | |
|---|---|
| `thesis/` | **The Trove thesis harness** — does the graph earn its complexity? |
| `FINDINGS.md` | Record of the LongMemEval/MemoryBench pilot: what it found, what it fixed, and why no number from it belongs on the website |
| `extraction-recall.ts` | Write-path loss: are ground-truth terms surviving into atoms? |
| `diagnose-recall.ts` | Retrieval-level probe for a single query — grep, three search modes, distance sweep |

## Why the MemoryBench harness was removed

`bench/providers/trove/` and `bench/setup.sh` ran Trove against LongMemEval via
Supermemory's MemoryBench. They were deleted on 2026-07-20 — deliberately, and
the reasoning is worth keeping because it is easy to want them back.

LongMemEval is **question-answering over chat history**. Trove is a memory
substrate for working agents. Optimising against LongMemEval makes Trove a
better LongMemEval system and only incidentally a better agent memory —
extraction recall and Hit@K are that benchmark's shape, not Trove's. The pilot
was still worth running: it found that `recall` returned empty packs for
natural-language questions, which is its documented usage, and that two query
paths had lost their HNSW index (222× and 61×). Those are real and they are
fixed. But `FINDINGS.md` lists six blockers standing between that harness and a
publishable number, and closing them would buy a number describing *a bespoke
benchmark agent*, not Trove as shipped.

The competitive comparison is still worth having eventually — it is just track
three, and it was blocking track one. Rebuilding a MemoryBench provider is
maybe a day's work against `FINDINGS.md`, which documents the harness's
quirks (undocumented `--limit`, a stuck `in_progress` phase blocking resume,
Zep overriding the judge prompt).

## The thesis harness

Trove costs more than a vector store: it distills sources into atoms, links
them, and traverses those links at recall. **That is only worth paying for if it
answers questions flat retrieval structurally cannot.** Nothing previously in
this repository tested that.

The design, in one line: *multi-hop questions whose joining entity never appears
in the question.*

> Session 1: "migrating my notes off Notion — everything lives in Obsidian now"
> Session 7: "the Obsidian vault replicates to the desktop over Syncthing"
> **Q: "How do my notes end up on my desktop machine?"**

The answer composes two facts that share no text unit, and "Obsidian" — the
join — is absent from the question. Name it and embedding similarity retrieves
both spans, making the graph decoration; omit it and flat retrieval must get
lucky twice while traversal follows an edge. `dataset.ts` records those
`bridgeTerms` and `validateDataset()` asserts they are absent **before ingest**,
so the property is enforced mechanically rather than by an author's care.

### The controls are the point

Single-hop controls are answerable from one span, so flat retrieval should tie
or win. The result supporting the thesis is a **split**: ahead on multi-hop,
level on single-hop. Ahead on *everything* means the dataset or the flat
baseline is broken, and the harness says so rather than declaring victory.

### Fairness

Both systems consume the **same ingested text units**. The only variable is what
happens between ingest and retrieval — distillation and traversal for Trove,
embedding and top-k for flat. Same answering model, same prompt, same judge.
Distillation is inside the measurement, not scaffolding around it: if it fails
to build the joining edges there is no graph to traverse, and that is a genuine
negative result about Trove rather than a harness bug.

### Bridge coverage

Every item reports the share of its `requiredFacts` present in the retrieved
context. This separates failure modes that accuracy alone conflates:

- wrong answer, **full** coverage → ranking or answering failure
- wrong answer, **partial** coverage → retrieval failure

Without it a red number tells you nothing about where to work next.

## Running it

```bash
docker exec trove-postgres-1 psql -U trove -d postgres -c "CREATE DATABASE trove_thesis;"
export TROVE_THESIS_DATABASE_URL=postgres://trove:trove@localhost:5433/trove_thesis
npm run db:schema && npm run db:migrate

export OPENAI_API_KEY=...            # distillation, answering, judging
export TROVE_EMBEDDING_PROVIDER=openai
npx tsx bench/thesis/run.ts
```

Writes a corpus, so it refuses non-local databases unless
`TROVE_THESIS_ALLOW_REMOTE=1`. Knobs: `TROVE_THESIS_MODEL`,
`TROVE_THESIS_JUDGE_MODEL`, `TROVE_THESIS_TOP_K`, `TROVE_THESIS_TOKEN_BUDGET`.

## Reporting a number

The multi-hop set (n=33, 51 items total) clears the runner's own verdict gate
(n≥30 multi-hop). Whatever gets reported carries the sample size, both systems'
scores per shape, the models, and the Trove SHA — the absence of exactly that
is what makes the rest of the ecosystem's numbers uncitable (`FINDINGS.md`).
The first verdict-grade run (2026-07-20) and its reading are recorded in
`docs/backlog.md` #25.
