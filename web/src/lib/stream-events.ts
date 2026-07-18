/**
 * The scripted ledger behind the hero's memory stream.
 *
 * The facts are the same ones the old bubble hero carried, kept because they
 * pass the repo test: none of them can be derived from reading the code. They
 * are decisions with reasons, rejected alternatives, and tombstones — the only
 * kinds of memory worth demonstrating.
 *
 * The sequence is the argument: session one ends, session two begins, and two
 * of its first writes retire beliefs from session one — struck through, not
 * deleted. `at` is ledger time inside one loop, not wall time.
 */

export type AgentId = "claude" | "codex" | "gemini" | "cursor";

export type StreamOp = "remember" | "recall" | "supersede";

export type StreamEvent = {
  id: string;
  at: string;
  agent: AgentId;
  op: StreamOp;
  /** The fact written, or the question asked. */
  text: string;
  /** Evidence the memory points back to. */
  source?: string;
  /** The belief this event retires, shown struck through. */
  retires?: string;
};

/** A session boundary is a divider row, not an event with an agent. */
export type StreamDivider = {
  id: string;
  divider: true;
  label: string;
};

export type StreamRow = StreamEvent | StreamDivider;

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
};

export const STREAM: StreamRow[] = [
  {
    id: "raw-sql",
    at: "00:02",
    agent: "claude",
    op: "remember",
    text: "Tried Prisma and dropped it — the bitemporal queries need raw SQL",
    source: "adr-003.md",
  },
  {
    id: "fly",
    at: "00:19",
    agent: "claude",
    op: "remember",
    text: "Deploys go to Fly — the only host with a Postgres volume in our region",
    source: "adr-002.md",
  },
  {
    id: "hard-cascade",
    at: "00:41",
    agent: "codex",
    op: "remember",
    text: "Garbage collection hard-cascades deletes — it's the right layer for it",
    source: "adr-006.md",
  },
  {
    id: "redis-out",
    at: "01:03",
    agent: "gemini",
    op: "remember",
    text: "Redis came out in March — the invalidation bugs weren't worth the cache",
    source: "adr-004.md",
  },
  { id: "end-1", divider: true, label: "session 014 ended · 4 memories retained" },
  {
    id: "dockerfile-db",
    at: "01:37",
    agent: "cursor",
    op: "remember",
    text: "The Dockerfile never copies db/, so the container dies on boot. CI can't catch it",
    source: "Dockerfile",
  },
  {
    id: "redis-recall",
    at: "02:04",
    agent: "codex",
    op: "recall",
    text: "why did we drop Redis?",
    source: "adr-004.md · answered from session 014",
  },
  {
    id: "railway",
    at: "02:28",
    agent: "codex",
    op: "supersede",
    text: "Moved to Railway — Fly kept recycling the Postgres volume",
    source: "railway.json",
    retires: "Deploys go to Fly",
  },
  {
    id: "soft-delete",
    at: "02:51",
    agent: "claude",
    op: "supersede",
    text: "GC routes through the canonical soft-delete now — the hard cascade orphaned rows",
    source: "pr-12.md",
    retires: "GC hard-cascades",
  },
  {
    id: "percent-recall",
    at: "03:12",
    agent: "cursor",
    op: "recall",
    text: "what breaks exact match?",
    source: "queryBuilder.ts:142 · a literal % runs as a LIKE wildcard",
  },
  { id: "end-2", divider: true, label: "session 015 ended · graph kept all of it" },
];
