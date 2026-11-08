# stack-sim — stacking the "components of agent memory" on Trove

Source: Anthropic, [*The components of agent memory*](https://www.anthropic.com/research/components-of-agent-memory) (2026-11-06).
Question: what can Trove adopt, which dimensions are new, and how do the layers
**stack**? This directory holds a simulator, its raw output
(`results-today.md`, `results-fixed.md`), and this write-up.

> **Read the caveats first.** The store is real (Trove's `InMemoryGraphStore`,
> `agentOps.remember`, real `recall` ranking and SUPERSEDED marking). The agent is
> **not**: it is a seeded stochastic policy whose error rates are assumptions shaped
> after the article. Recall is lexical-only (no embedding provider). The corpus is
> small: **60 facts, 40 sessions, 130–930 notes**, per the backlog's standing rule.
> Treat every number as *directional, about the design*, never as a claim about
> real models. An LLM-backed rerun (the `task-eval` harness) is what would make it
> field evidence.

---

## Status (what has since landed in this branch)

| Proposal | Status |
|---|---|
| 4.1 stale SUPERSEDED mark | **Fixed**, read-side: `supersededBy` ignores an edge recorded before the target's current revision (both drivers); lint `revised_after_superseded` reports the edge. Rerunning S1c on the fixed store gives strong · full stack **89.3%** (82.1% before, 91.6% with the sim's write-side variant; the gap is the both-read-as-current window until dreaming re-points the edge). |
| 4.2 citations a revision contradicts | **Fixed**: `remember` returns `evidenceStale`; the write is incomplete unless the call cites new support. |
| 4.3 session-start index | **Added**: `trove://index`, `GET /v1/index?format=text`, `trove index`; SessionStart hook recipe in `docs/agent-usage.md`. |
| 4.4 dream job | **Added** (`src/dream.ts`, job kind `dream`): re-point turned-around supersessions, report newer conflicting sources and uncited sources, opt-in retirement. Not yet: merging judged duplicates, LLM verification. Scheduled only with `TROVE_DREAM=1`. |
| 4.5 entity pages | **Added** as a dream output: one `community` page per hub, quoting current notes, listed in the index. |
| 4.6 new dimensions | Not started. |

The result tables below are from before these changes and are kept as the record
the decisions were made on.

## 1 · The intuition in one picture

Think of a new team member who keeps a notebook.

- **Transcripts** are the meeting recordings: complete, cheap to keep, slow to search.
- **Notes** are what they jot down during the meeting: fast, but sometimes wrong
  ("the PokéCenter is on the east side").
- **Dreaming** is their Sunday evening review: replay the recordings, fix the
  wrong notes, merge duplicates, fill gaps, throw out junk.
- **Representations** (wikis, entity pages) are the clean binder they build from
  that review: one page per customer or service, quoted verbatim.
- **Injected context** is the sticky note on the monitor: "you have a notebook,
  and here is its index". Small, always in view.

Trove today is an excellent **notebook with recordings**: atoms that cite spans,
and supersession that keeps history. What it lacks is the **Sunday review** and
the **sticky note**. The simulations say those two are where most of the remaining
gain is, and that they **multiply** each other rather than add.

## 2 · Article → Trove mapping

| Article layer | Trove today | Gap |
|---|---|---|
| Transcripts (searchable log) | `ingest` → text units; `grep` over sources | ✅ present |
| Memory notes (in-session, salient) | `remember` atoms with quote evidence | ✅ present — plus a bug (§4.1) |
| Representations (wikis, one page per entity) | `project` / `create_view` render on demand; no maintained pages | ⚠️ render-only, not maintained |
| Injected context (always loaded, small) | MCP `instructions` + `trove://doctrine`: **static doctrine, no per-user index** | ❌ missing |
| **Dreaming** (offline: verify notes vs transcripts, promote, fill gaps) | Worker runs `reconcile_node` (note ⇄ note, at write time), `lint` (`weak_evidence` = note ⇄ cited span), embeddings | ⚠️ the building blocks exist; there is no consolidation job |
| Shared log for concurrent agents | `events` feed (operator); atoms + revisions | ✅ atoms are immune to the overwrite failure (§3 S6) |
| Salience / "what memory is for" | Doctrine is long and procedural | ⚠️ the article warns that long rule files reduce adherence |

## 3 · Simulations

Every arm sees the **same world and the same queries** (separate RNG streams).
Columns: `correct` / `stale` (gave an older true value) / `wrong` (never true) /
`unknown (unread)`. Mean ± sd over 10 seeds. Tables are excerpts; the full output
is in `results-*.md`.

### S1 · The layer ladder (mid agent; proposed fix §4.1 applied)

| stack | correct | stale | unknown (unread) | tok/query |
|---|---|---|---|---|
| notes (Trove today) | 49.0% | 11.2% | 33.9% (29.0%) | 276 |
| + transcripts (cited) | 49.0% | 11.2% | 33.9% | 267 |
| + dreaming | 59.4% | 5.0% | 31.5% | 249 |
| + injected index | **76.3%** | 6.1% | 11.0% (8.5%) | 371 |
| + entity pages (+search) | **80.2%** | 4.4% | 12.4% | 440 |
| *index only, no dreaming* | 61.5% | **14.1%** | 16.6% | 394 |

**Transcripts alone buy nothing** at answer time. They are the substrate that
dreaming reads, which matches the article. **The index alone raises staleness**
(11% → 14%): an agent that reads more also reads more dirty notes. **Dreaming
cleans what the index exposes.** Separately they add about +12.5 and +10 points;
together they add about **+27**.

### S1c · A real bug, and what fixing it is worth

| agent · stack | Trove today | with fix |
|---|---|---|
| strong · notes | 77.8% | 80.8% |
| strong · full stack | 81.6% | **91.3%** |
| mid · full stack | 70.5% | **76.4%** |
| weak · full stack | 52.8% | 54.1% |

The richer the stack, the more the bug costs, because dreaming creates both
supersede edges and revisions. See §4.1.

### S2 · Who benefits from which layer (fix applied)

| agent | notes | + index | + dream | full | biggest single lever |
|---|---|---|---|---|---|
| weak (reads 40%) | 19.7% | 37.8% | 29.8% | **53.7%** | index (+18) |
| mid (reads 70%) | 49.0% | 61.5% | 58.8% | **76.9%** | index (+12.5) |
| strong (reads 90%) | 80.8% | 87.0% | 84.7% | **91.3%** | index (+6); dream cuts stale 5.4% → 2.2% |

This is the same shape as the article's CL-Bench progression. Weaker models
mostly fail by **not reading**, so the always-loaded sticky note matters most.
Stronger models mostly fail on **stale or unverified notes**, so the review step
matters most.

### S1b · Which part of dreaming does the work (mid agent, fix applied)

| dream does | correct | Δ |
|---|---|---|
| nothing | 49.0% | — |
| verify notes vs transcripts | 55.1% | +6.1 |
| + merge duplicate titles (supersedes) | 56.9% | +1.8 |
| + gap fill (transcript facts with no note) | 59.4% | +2.5 |
| + retire never-read noise | 59.0% | ±0 accuracy, **−17% notes** (−58% at heavy clutter, S5) |

Without the fix, *merging made things worse* (54.0 → 52.0, unknowns up about 6 points):
merge writes supersedes edges, later revisions hit the bug, and the fresh note is
hidden. **Ship the fix before shipping any automated supersession.**

### S3 / S4 · Dream budget, priority, cadence (fix applied)

| | correct | checks/run |
|---|---|---|
| verify 5 notes/dream (best priority: recent-reads) | 51.5% | 40 |
| verify 20 notes/dream (best: recent-reads) | 55.5% | 160 |
| verify everything | 60.4% | 698 |
| dream every 1 / 5 / 20 sessions | 63.1 / 58.9 / 53.6% | 2204 / 477 / 143 |

**Budget dominates; priority barely matters** (about 1.5 points between the best
and random at a small budget, inside one sd). The practical consequence: make the
check **cheap** so you can check everything, rather than being clever about what
to check. Trove already has a near-free first-pass verifier, the `weak_evidence`
containment score (note ⇄ cited span). Send only its disagreements to the
LLM judge.

### S6 · Concurrent writers (the article's shared `provisions.md` case)

| writers | one page per entity (rewritten whole) | one atom per fact (Trove) |
|---|---|---|
| 1 | 56.0% (lost facts 8.9) | 49.7% (7.5) |
| 2 | 46.2% (18.9) | 49.7% (7.5) |
| 4 | **37.1% (27.0)** | **49.7% (7.5)** |

Trove's atom design is already immune: this is the article's 41/57 → 57/57
result, and Trove gets it by construction. The residual risk is an agent packing
several facts into one team-space note, because a team write revises the *same*
note for everyone.

### S7 · Entity pages vs search (the article's wiki experiment)

| dream every | search only | pages only | pages + search |
|---|---|---|---|
| 5 sessions | 58.8% · 248 tok | 61.0% · **58 tok** | **63.1%** · 310 tok |
| 15 sessions | 55.1% | 54.3% (stale 11.7%) | **58.7%** |

This matches the article's direction (wiki + search 61% > search 53% > wiki
only 48%). Pages are **about 4× cheaper per read**, but they go stale between
dreams; search covers the gap.

---

## 4 · What to adopt, ranked

### 4.1 Fix: revising a superseded note leaves it marked SUPERSEDED (P0, both drivers)

Reproduced against the real store:

```
remember "Falcon port" = v1  →  remember "port for Falcon" = v2  →  link v2 supersedes v1
remember "Falcon port" = v3          (exact title → revision; v3 is now the truth)
recall →  ## Falcon port … SUPERSEDED by port for Falcon     Falcon port is v3
          ## port for Falcon …                              Falcon port is v2   ← agent answers this
```

`supersededBy` (`src/store.ts:678`, `src/pgStore.ts:1293`) never compares the
target's latest revision with the edge's recorded time. Options:

- **read-side (recommended; non-destructive, keeps supersession annotation-first):**
  ignore a `supersedes` edge in recall when the target has a revision newer than
  the edge, and add a lint finding (`inverted_supersession`) so curation or dreaming
  resolves it;
- **write-side:** when `remember` revises a node with active incoming
  `supersedes` edges, expire them and report `supersessionCleared` in the result.
  The simulator's fix uses this variant.

### 4.2 Fix: a revision keeps citations that no longer support it (P1)

Seen in the same probe: after revising "port is 8787" to "port is 9090", recall
shows `9090` with the quote `> billing-service port is 8787` underneath it.
Evidence attaches to the node, not the revision, so a value change inherits a
contradicting citation. That is provenance that looks fine and is wrong, which is
the article's "wrong note trusted later" failure. Fix: on a content-changing
revision, re-score attached evidence with `evidenceSupportScore` and detach or
flag spans that fall below the floor. *(Not simulated: the simulated reader
ignores quote lines.)*

### 4.3 Add a session-start index: the "sticky note" (high leverage, cheap)

A per-user resource (`trove://index` or a `brief` tool) that a client injects at
session start. It is deterministic, needs no LLM, and stays small, capped like
Claude Code's `MEMORY.md` (200 lines / 25 KB). It lists the hot entities and
projects, the most-activated notes, and one line: *memory exists, read it before
answering*. In the simulations this is the single biggest lever for weak and mid
agents. It costs about 100 tokens per session, and it should ship **together
with** dreaming, because on its own it raises staleness.

### 4.4 Add a `dream` job: offline consolidation (the new dimension)

Trove's worker already drains a queue. Add a per-owner job on a cadence (or
after N writes). It reuses existing parts, in the order the simulations rank them:

1. **verify notes against sources** (+6): `weak_evidence` containment as the free
   first pass, then the reconcile judge only on disagreements;
2. **gap fill** (+3): ingested spans that no atom cites → propose atoms (as
   `AGENT INFERENCE` drafts, or as review items);
3. **merge duplicates** (+1, *only after 4.1*): link title variants of one
   fact with `supersedes`;
4. **retire noise**: tombstone never-recalled, low-activation notes past a
   window. This is backlog #11 (decay/archive), and the article gives it a
   mechanism;
5. **maintain entity pages and the index** (4.3, 4.5) as its outputs.

Report `checks` / `fixes` / `judgeCalls` like `reconcile_node` already does.
Because budget dominates priority, keep the checks cheap and broad.

### 4.5 Maintain entity pages from dreaming (representations)

Use one `entity`-type node per entity, with content quoted verbatim from current
beliefs and links to the atoms underneath. Recall should serve the page *plus*
any atom newer than the page. That is the S7 "pages + search" rule, which beat
both alternatives and cut read tokens about 4×.

### 4.6 New dimensions Trove does not model yet

- **Tested vs. theorised.** The article's best models wrote "rules, provenance,
  trap warnings" and marked what was *verified by doing*. Trove distinguishes
  `citation` from `AGENT INFERENCE`, but not *inference that was later tested*.
  A `status: hypothesis | tested | verified` on claims (representation.md already
  sketches claim status) would give dreaming something to promote.
- **Salience as purpose, not rules.** "Record only failures" cost Opus 5 0.234
  reward. Trove's doctrine is long and procedural. It is worth an ablation in
  `task-eval`: full doctrine vs. a short *what memory is for* paragraph.
- **What to save.** Save what exists only if it is written down (plans, tested
  rules, decisions), not state the agent can re-read from the environment. This
  could become a remember-time hint or lint check: atoms that duplicate a source
  verbatim with no distillation.
- **Time resolution in recall headers.** Headers show a date only, so two
  same-day revisions cannot be ordered by the reader. The fix is cheap: show the
  time when same-day siblings exist.

## 5 · Suggested order

1. **4.1** (stale-marker fix) and **4.2** (citation re-score): correctness, small,
   and prerequisites for anything automated.
2. **4.3** session-start index: cheapest large win.
3. **4.4** dream job (verify + gap fill first), then merge, then retire.
4. **4.5** entity pages as a dream output.
5. Re-measure with an LLM agent: the `task-eval` arms map one-to-one onto this
   ladder, and the article's CL-Bench setup (a fresh session per question, only
   the memory directory persists) is the same shape.

## Reproduce

```
node --import tsx bench/stack-sim/run.ts --seeds=10            # Trove today
node --import tsx bench/stack-sim/run.ts --seeds=10 --fixed    # with the 4.1 fix
node --import tsx bench/stack-sim/run.ts ladder revive-fix     # pick experiments
```

Needs no database, API key, or network. The full suite runs in about 3 minutes.
Experiments: `ladder`, `dream-parts`, `revive-fix`, `profiles`, `dream-priority`,
`cadence`, `clutter`, `multiagent`, `pages`.

### Caveats, specifically

- Agent error rates are **assumed** (`PROFILES` in `sim.ts`); the *shape* of the
  results comes from them. A different profile mix moves the levels.
- The verifier reads transcripts with a 5% error rate. A real dream would use an
  LLM and could also introduce errors; the article reports hallucinated pages.
- Recall is lexical over a small corpus, where ranking is easy. Per the backlog,
  small fixtures can change which system wins; the ladder needs a rerun at scale
  with embeddings.
- **Not fully deterministic.** Notes written within the same millisecond tie on
  `updatedAt`, so the same configuration can land 1–1.5 points apart between
  experiments (mid full stack: 75.6% in S1c vs 76.9% in S2). Read gaps under
  about 2 points as ties. The tables above quote `results-today.md` (S1c) and
  `results-fixed.md` (everything else).
- The S6 shared-page arm models the worst case (each writer rewrites the whole
  page from its own stale view).
