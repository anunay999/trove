# Task-shaped eval (backlog #29) — first results

Harness measures the four real jobs of agent working-memory (three are NOT
accuracy metrics): context pickup, no re-derivation, no stale-belief actions,
auditability. Arms: **trove** (local store, ranked recall + SUPERSEDED marking),
**scratchpad** (a flat `notes.md`, the "files are all you need" competitor),
**nomem** (control). Agent = gpt-4o-mini, temp 0, ≤6 tool calls/session. Local
Trove only (fresh owner per run), never the hosted MCP. See `DESIGN.md`.

## Instrument validation (do not skip — this is why the numbers are trustworthy)
- **Discriminates:** `nomem` clearly loses (context_pickup 0%, rederivation 100%,
  citation 50%). Controls tie at 100% across all arms → not rigged.
- **A scoring flaw was caught before it misled us:** the first `stale_belief`
  metric flagged the *better* answer ("now ISO 8601 **instead of epoch**") as
  stale because it mentioned the old value contrastively — which Trove's
  SUPERSEDED context makes *more* likely. It would have reported Trove as WORSE
  at supersession. Fixed: `stale_belief = usesOld && !usesNew` (fires only when
  the answer gives the OLD value *instead of* the new).

## v2 clutter degradation sweep (4 scenarios × 2 seeds, gpt-4o-mini)
As accumulated memory grows, does ranked recall beat grep-over-a-growing-file?

| clutter | trove pickup | scratch pickup | trove tok | scratch tok | stale (both) |
|---|---|---|---|---|---|
| 0  | 100% | 88% | 1042 | **565** | 0% |
| 20 | 100% | 88% | 1054 | 781 | 0% |
| 40 | 100% | 75% | 1083 | **996** | 0% |

## Findings (ranked by confidence)
1. **Cost scaling — solid.** Trove's tokens stay flat (~1050, bounded recall);
   the scratchpad climbs 565 → 781 → 996 (re-reads the whole growing file) and is
   on a clear path to overtake Trove just past clutter=40. The "cheap flat file"
   is cheapest only at zero clutter.
2. **Retrieval under clutter — directional, small-n.** Trove holds pickup at
   100%; scratchpad slips 88% → 75%. But it's 1→2 misses of 8, concentrated in
   one scenario type (the "which port?" task, where the agent answers from
   world-knowledge instead of reading its notes, worsened by a bigger file).
   Suggestive, not proven.
3. **Supersession / stale-belief — NOT separated (both 0%).** The hypothesized
   crux did not fire even at clutter=40: once retrieved, gpt-4o-mini uses the
   current value regardless of arm. The edge is in *retrieval*, not
   *belief-resolution*, at this scale.

**Bottom line:** at modest scale, structured memory's measured edge over a
well-kept flat file is **cost (bounded retrieval) + a directional
retrieval-reliability bump — not supersession accuracy.** Provenance/audit and
bitemporal (things a file structurally cannot do) are established separately by
#17/#18 and are not tested here.

## Caveats
n=8 per cell; one model (gpt-4o-mini); synthetic authored scenarios; the 51-fact
distractor pool caps the file at ~2.5KB, so the curve is **early**. Directional
signal, not field truth.

## v3 (to make it defensible / stress-test later)
- Distractor pool 200–300; clutter levels 0/50/150/300 (where even a careful
  reader misses a buried update — where stale-belief should finally break).
- More seeds (tighten n); optionally a second, weaker + a stronger model to see
  if the retrieval gap widens/narrows with model capability.
- Real-session replay (the deferred authenticity upgrade).

## Volume used (for budgeting v3)
Whole build+run effort (v1 matrix + 3-arm check + v2 smokes + the sweep):
~**1.1–1.2k gpt-4o-mini agent sessions**, ~**1.0M input tokens** (465k measured
in the retained result JSONs alone; the rest in the v1 matrix + filler sessions
not persisted). Cost on gpt-4o-mini: **well under ~$2**. The Trove arm also made
a few hundred local `text-embedding-3-small` calls. A v3 at ~5× scale is still a
few dollars. All runs hit local docker Postgres (fresh test owners) — no prod.

## Reproduce
```
node --import tsx bench/task-eval/run.ts --scenarios=1,2,3,4 --arms=trove,scratchpad,nomem --seeds=3
for C in 0 20 40; do node --import tsx bench/task-eval/run.ts --scenarios=1,2,3,4 --arms=trove,scratchpad --seeds=2 --clutter=$C; done
node --import tsx bench/task-eval/sweep-summary.ts
```
Requires local pg (`docker compose up -d --wait postgres`) + `OPENAI_API_KEY` in `.env`.
