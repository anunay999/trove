/**
 * Content for the landing hero, where the bubble field doubles as the graph.
 *
 * Every fact here is one the repo cannot tell you, and that is the entire brief.
 * "Tests run on Vitest" is in package.json — an agent that reads it needs no
 * memory graph, and putting it on the page argues the product away. What is left
 * when you remove everything derivable is the good stuff: decisions with the
 * reason attached, the alternatives already tried and rejected, the suspects
 * already ruled out, and the things deliberately deleted.
 *
 * That last category is the sharpest, because the repo doesn't merely omit it —
 * it argues the opposite. Git history reads to an agent as a menu of things to
 * restore, and one stale comment is a spec. Reading the code harder makes it
 * worse. A tombstone with a reason on it is the only fix.
 *
 * Four different agents wrote these, which is the point: one graph, whoever is at
 * the keyboard. Session two is the payoff — two of session one's decisions have
 * since changed, and the new facts supersede them without erasing what the repo
 * used to believe. An append-only log cannot express "this was tried and it
 * failed"; that is what the supersedes edge is for.
 */

export type AgentName = "claude-code" | "codex" | "cursor" | "gemini";

/** Where a bubble sits, and where its node stays once captured. */
export type Slot = {
  /** Percent from the left edge of the field. */
  x: number;
  /** Percent from the top edge of the field. */
  y: number;
  /** Bubble diameter in rem, before the small-screen scale-down. */
  size: number;
  /** Seconds for one drift cycle. Varying these keeps the field from pulsing in unison. */
  drift: number;
  /** Seconds before the bubble rises into view. */
  delay: number;
};

export type MemoryFact = {
  id: string;
  session: 1 | 2;
  /** The full sentence, shown on capture and on hover. */
  fact: string;
  /** The node label. Kept short — it sits in a gutter without crowding the headline. */
  short: string;
  source: string;
  agent: AgentName;
  age: string;
  /** Capturing this retires that belief, without deleting it. */
  supersedes?: string;
  /** Ids this fact draws an edge to. */
  links: string[];
  slot: Slot;
};

/**
 * Placement covers the whole field, not just two stacks: three down each side,
 * one above the headline, one below the copy. Positions and sizes are jittered
 * rather than mirrored — an even ring reads as a diagram, an uneven spread reads
 * as a web. The centre column stays clear for the headline.
 *
 * Sessions interleave across the field so neither one leaves a region empty.
 */
export const MEMORIES: MemoryFact[] = [
  {
    id: "hard-cascade",
    session: 1,
    fact: "Garbage collection hard-cascades deletes — it's the right layer for it",
    short: "GC hard-cascades",
    source: "adr-006.md",
    agent: "codex",
    age: "2d ago",
    links: ["raw-sql"],
    slot: { x: 11, y: 22, size: 7, drift: 13, delay: 0.15 },
  },
  {
    id: "fly",
    session: 1,
    // A decision with its reason attached, which is what makes it worth keeping —
    // and what makes it land when session two proves the reason wrong.
    fact: "Deploys go to Fly — the only host with a Postgres volume in our region",
    short: "Fly.io deploys",
    source: "adr-002.md",
    agent: "claude-code",
    age: "2d ago",
    links: ["raw-sql"],
    slot: { x: 44, y: 9, size: 4.5, drift: 18, delay: 0.55 },
  },
  {
    id: "raw-sql",
    session: 1,
    // The rejected alternative is the memory. Without it, every new agent
    // re-proposes the ORM on day one.
    fact: "Tried Prisma and dropped it — the bitemporal queries need raw SQL",
    short: "No ORM — raw SQL",
    source: "adr-003.md",
    agent: "claude-code",
    age: "2d ago",
    links: [],
    slot: { x: 89, y: 20, size: 6.5, drift: 15, delay: 0.25 },
  },
  {
    id: "dockerfile-db",
    session: 1,
    // The repo actively lies about this one: the Dockerfile looks correct and
    // the test suite is green.
    fact: "The Dockerfile never copies db/, so the container dies on boot. CI can't catch it — it never builds the image",
    short: "Dockerfile skips db/",
    source: "Dockerfile",
    agent: "cursor",
    age: "1d ago",
    links: ["raw-sql"],
    slot: { x: 16, y: 72, size: 6, drift: 16, delay: 0.35 },
  },
  {
    id: "redis-out",
    session: 1,
    // The sharpest kind of memory: the artifact is gone, so the only trace left
    // in the repo is a git history that argues for putting it back.
    fact: "Redis came out in March — the invalidation bugs weren't worth the cache. Git history still argues for it",
    short: "Redis: gone on purpose",
    source: "adr-004.md",
    agent: "gemini",
    age: "1d ago",
    links: ["raw-sql"],
    slot: { x: 94, y: 47, size: 5, drift: 19, delay: 0.45 },
  },
  {
    id: "soft-delete",
    session: 2,
    fact: "GC routes through the canonical soft-delete now. The hard cascade orphaned rows and left no tombstone — this reverses the earlier call",
    short: "GC soft-deletes now",
    source: "pr-12.md",
    agent: "claude-code",
    age: "just now",
    supersedes: "hard-cascade",
    links: ["hard-cascade", "raw-sql"],
    slot: { x: 6, y: 48, size: 5.5, drift: 17, delay: 0.2 },
  },
  {
    id: "railway",
    session: 2,
    fact: "Moved to Railway — Fly kept recycling the Postgres volume",
    short: "Railway, not Fly",
    source: "railway.json",
    agent: "codex",
    age: "just now",
    supersedes: "fly",
    links: ["fly", "raw-sql"],
    slot: { x: 84, y: 70, size: 7, drift: 14, delay: 0.3 },
  },
  {
    id: "percent-wildcard",
    session: 2,
    // The four wrong answers are the payload. A codebase can tell you what it
    // does; it can never tell you what you already ruled out.
    fact: "A literal % in an exact match runs as an unescaped LIKE wildcard. Already ruled out: stale index, trigram, match config",
    short: "% breaks exact match",
    source: "queryBuilder.ts:142",
    agent: "cursor",
    age: "just now",
    links: ["raw-sql"],
    slot: { x: 57, y: 90, size: 5, drift: 16, delay: 0.5 },
  },
];

export type Session = {
  id: 1 | 2;
  /** Shown once every bubble in the session is captured. */
  ending: string;
};

export const SESSIONS: Session[] = [
  { id: 1, ending: "Session ended. Your graph kept everything." },
  { id: 2, ending: "Four agents. Two sessions. One memory." },
];

export const bubblesFor = (session: 1 | 2) => MEMORIES.filter((m) => m.session === session);
export const memoryById = (id: string) => MEMORIES.find((m) => m.id === id);
