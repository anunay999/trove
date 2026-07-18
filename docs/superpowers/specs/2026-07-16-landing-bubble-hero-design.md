# Landing hero: the bubble field is the graph

**Date:** 2026-07-16
**Status:** built
**Scope:** landing hero, read-routing section, dashboard section, landing theme

## Goal

Convey, without reading, that **a user's agents share one memory across sessions
via the Trove MCP**. A visitor should understand within one interaction:

1. Agent sessions are ephemeral; what they learn is not.
2. Several different agents write to the same graph.
3. When a fact changes, the old belief is superseded, not erased.

## Base block

shadcnblocks `hero218` ("staggered headline and particle veil"), pulled with the
pro key from `~/dev/space/.env.local`. Kept: the word-by-word staggered headline
(`rotateX`, 80ms stagger) and its serif-italic accent word, applied to "forgets".
Replaced: the `<Particles>` canvas became the bubble field. Dropped: the
`green-shape.svg` blob, the blur beds, the CTA, and its `framer-motion`
dependency — the repo already has `motion` v12.

The registry index is public; block source is gated. Free heroes are `hero1`,
`hero3`, `hero7`, `hero12`, `hero47`, `hero67`, `hero78`.

## The signature: the field is the graph

There is no panel. A bubble is session context; popping it leaves a **node in the
same position**, and edges thread out to what it relates to. Cause and effect are
the same pixels — an earlier draft put the captured facts in a rail below the
fold, so the one moment that explains the product happened off-screen.

Sequence on capture:

1. Bubble scales to 1.15 (~110ms); the rim washes white.
2. It bursts — 8 droplets out, opacity to 0.
3. The full fact and its source float **at the burst point** for 2s, then fall
   toward the graph and fade.
4. Only then does the node's short label fade in. Both at once read as one
   cluttered block rather than two beats.

**Edges are drawn from the start**, faint, while the facts are still bubbles: the
shape of the graph is there before anything is kept, which is what makes the field
read as a graph instead of loose decoration. An edge firms up and turns gold once
both ends are captured. A superseding edge is dashed — the old belief still sits
at the other end of it.

**Auto-demo.** After 2.2s a bubble rings, and at 3s it pops itself. Nothing on the
page explains "these are clickable, and clicking keeps them" as fast as watching it
happen once. It aborts the moment the visitor touches anything.

### Sessions

Session one's five facts, then **Start session 2** for three more that revise it.
`capturedIds` never resets across the transition — that persistence is the argument.
Nodes from session one stay on the field while session two's bubbles drift in.

### Content

Real decisions from this repo, written by four different agents — the multi-agent
point is carried by the data, not by copy.

**Session 1:** Vitest for tests (codex) · Fly.io deploys (claude-code) · Postgres
16 + pgvector (claude-code) · Keys in .env (cursor) · Clerk owns auth (gemini)

**Session 2:** node:test now (claude-code, supersedes Vitest) · Railway, not Fly
(codex, supersedes Fly) · HNSW still off (cursor)

The Vitest → node:test migration is real (commit `c7ca686`), as is Railway
(`railway.json`) and the commented-out HNSW index (`db/schema.sql:255`).

## Design tokens

### Colour

Dark is the brand. `.landing-shell` and `.landing-chrome` re-declare the dark set
in their own scope, so the landing renders dark regardless of `html.dark`; the
dashboard still honours the toggle. The tokens go on the **app shell**, not just
the header — the header is 90% opaque, so a light body showed through as a grey bar.
The theme toggle is hidden on the landing, where it would do nothing.

| Token | Hex | Role |
|---|---|---|
| `--background` | `#0b0d10` | field, cool-cast near-black |
| `--card` | `#12151a` | raised surfaces |
| `--foreground` | `#edebe4` | text |
| `--signal` | `#f2c46b` | nodes, live edges, accents |

An earlier direction gave the bubbles thin-film iridescence (a conic ramp through
cyan/violet/magenta/gold). **Cut** — the client asked for clear glass. The film is
colourless now; the light it catches is the whole effect. Gold is the only accent,
and it means *durable*: glass = ephemeral, solid gold = kept.

### Type

No new fonts. Display is the existing SF Pro stack; the accent word "forgets" is
set in the existing Iowan serif italic — the fleeting word gets the delicate face.
Inter for body, Geist Mono for tags and sources.

The masking box needs `pb-[0.16em] -mb-[0.16em]`: `overflow-hidden` hides each word
before it rises, but at `leading-[0.98]` the box edge sheared the descender off every
"g".

## Layout

- **lg and up:** field is `absolute inset-0` behind centred copy; bubbles live in
  the gutters, plus one above the headline and one below the copy. Positions and
  sizes are jittered — an even ring reads as a diagram, an uneven spread as a web.
- **Below lg:** field becomes an `h-72` band above the copy. The breakpoint is `lg`,
  not `md`: at 768px the copy column leaves ~48px of gutter, which would put bubbles
  under the headline.
- Bubble size comes from `--bubble-size` and scales to 0.6 below lg; fixed rem sizes
  overflowed a phone once the slot percentages resolved against 390px. The agent tag
  is hidden there — the bubble is too small to hold it.

**The content wrapper must be `pointer-events-none` all the way down.** It spans the
field, so anything solid in it eats every click meant for the bubbles and leaves the
visitor selecting headline text instead. Only the controls opt back in.

**Edges use percentage coordinates, not a `viewBox`.** A 100x100 box stretched to the
field scales x and y differently, which shears dashes and the dash-based `pathLength`
draw into fragments.

## Other sections

- **Read routing** (`GrepSection`) replaced "Watch one memory change" and "Recall that
  fits the moment". grep vs recall, by query shape.
- **Dashboard** (`DashboardProof`) now renders the product's own `ForceGraph2D` with
  the shared `typeColor` scale on seeded data continuing the hero's story — not a
  drawing of it. Lazy, mounted via IntersectionObserver.
- `GraphView` is lazy too, which splits `react-force-graph-2d` into its own 177 kB
  chunk and drops the main bundle from 371 kB to 311 kB gzipped.

### Copy constraint: no fabricated performance

The repo has **no trigram index, no `pg_trgm`, no benchmark, and no timing code**.
The GIN indexes are tsvector and serve `recall`'s lexical leg; a `~*` regex cannot
use them, so grep's scan is not index-accelerated. Any millisecond figure or
"index-backed regex" claim would be invented.

What is true and load-bearing: `grep` never calls the embedding provider — it is one
Postgres query, no model in the loop — while `recall` fetches embeddings from OpenAI
(`src/pgStore.ts:383`). That is the honest version of "fast".

## Accessibility

- Bubbles are `<button>`s with `aria-label="Capture memory: …"` and a visible focus
  ring; nodes are buttons whose label carries the fact, source, and superseded state.
- The counter is `aria-live="polite"`.
- Reduced motion: no drift, no burst, no droplets; the reveal cross-fades and the
  label appears immediately. The narrative stays intact. **Verified by code
  inspection only** — the local Playwright browser binary was unavailable.

## Non-goals

- No live API. Hero content is static.
- No new fonts, no new runtime dependencies.
