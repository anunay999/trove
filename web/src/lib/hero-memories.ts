/**
 * Content for the landing hero, where the bubble field doubles as the graph.
 *
 * These are the decisions a working repo accumulates — the ones you re-explain to
 * an agent every single session. Four different agents wrote them, which is the
 * point: one graph, whoever is at the keyboard.
 *
 * Session two is the payoff. Two of session one's decisions have since changed,
 * and the new facts supersede them without erasing what the repo used to believe.
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
    id: "vitest",
    session: 1,
    fact: "Tests run on Vitest",
    short: "Vitest for tests",
    source: "vitest.config.ts",
    agent: "codex",
    age: "2d ago",
    links: ["postgres"],
    slot: { x: 11, y: 22, size: 7, drift: 13, delay: 0.15 },
  },
  {
    id: "fly",
    session: 1,
    fact: "Deploys go to Fly.io",
    short: "Fly.io deploys",
    source: "fly.toml",
    agent: "claude-code",
    age: "2d ago",
    links: ["postgres"],
    slot: { x: 44, y: 9, size: 4.5, drift: 18, delay: 0.55 },
  },
  {
    id: "postgres",
    session: 1,
    fact: "Postgres 16 with pgvector — the bitemporal queries need real SQL",
    short: "Postgres + pgvector",
    source: "docker-compose.yml",
    agent: "claude-code",
    age: "2d ago",
    links: [],
    slot: { x: 89, y: 20, size: 6.5, drift: 15, delay: 0.25 },
  },
  {
    id: "keys-in-env",
    session: 1,
    fact: "API keys live in .env, never in the repo",
    short: "Keys in .env",
    source: ".env.example",
    agent: "cursor",
    age: "1d ago",
    links: ["postgres"],
    slot: { x: 16, y: 72, size: 6, drift: 16, delay: 0.35 },
  },
  {
    id: "clerk",
    session: 1,
    fact: "Clerk owns auth — don't roll your own sessions",
    short: "Clerk owns auth",
    source: "adr-003.md",
    agent: "gemini",
    age: "1d ago",
    links: ["keys-in-env"],
    slot: { x: 94, y: 47, size: 5, drift: 19, delay: 0.45 },
  },
  {
    id: "node-test",
    session: 2,
    fact: "Moved to node:test — one less dependency to carry",
    short: "node:test now",
    source: "pr-12.md",
    agent: "claude-code",
    age: "just now",
    supersedes: "vitest",
    links: ["vitest", "postgres"],
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
    links: ["fly", "postgres"],
    slot: { x: 84, y: 70, size: 7, drift: 14, delay: 0.3 },
  },
  {
    id: "hnsw-off",
    session: 2,
    fact: "The pgvector HNSW index is still commented out — recall falls back to lexical",
    short: "HNSW still off",
    source: "db/schema.sql",
    agent: "cursor",
    age: "just now",
    links: ["postgres"],
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
