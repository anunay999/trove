import type { NodeType } from "@/lib/api";

/**
 * The seed graph — the same slice of real Trove data the dashboard explorer
 * draws, shared by the hero's 3D emblem and the inspectable 2D MiniGraph so
 * the page never tells two different stories about the graph.
 */

export type Seed = {
  id: string;
  title: string;
  type: NodeType;
  /** What the evidence card shows when the node is inspected. */
  detail: string;
  /** The source the memory cites. Sources themselves have none — they are it. */
  source?: string;
  /** Set when a newer belief retired this one. It stays on the graph. */
  retiredBy?: string;
};

export const SEEDS: Seed[] = [
  { id: "trove", title: "trove", type: "project", detail: "One graph. Every agent, every session, everything they decided to keep." },
  { id: "postgres", title: "Postgres 16 + pgvector", type: "infrastructure", detail: "The canonical evidence ledger. Vectors are an index over knowledge, not the knowledge.", source: "db/schema.sql" },
  { id: "railway", title: "Moved to Railway", type: "decision", detail: "Fly kept recycling the Postgres volume, so deploys moved. The old call stays on the record.", source: "railway.json" },
  { id: "fly", title: "Deploys go to Fly.io", type: "decision", detail: "The only host with a Postgres volume in our region — true when written, retired when it wasn't.", source: "adr-002.md", retiredBy: "Moved to Railway" },
  { id: "node-test", title: "Moved to node:test", type: "decision", detail: "One less dev dependency to pin, and the suite stopped noticing.", source: "pr-12.md" },
  { id: "vitest", title: "Tests run on Vitest", type: "decision", detail: "Believed for five months. Superseded, still inspectable.", source: "package.json", retiredBy: "Moved to node:test" },
  { id: "clerk", title: "Clerk owns auth", type: "decision", detail: "Sessions and OAuth stay out of the graph entirely — auth is a boundary, not a memory.", source: "adr-003.md" },
  { id: "keys", title: "Keys in .env, never in git", type: "pattern", detail: "The repo can't tell an agent this; the graph has to. That's what it's for.", source: "runbook" },
  { id: "hnsw", title: "HNSW index still off", type: "claim", detail: "Personal scale doesn't feel it yet. Revisit when the graph does.", source: "db/schema.sql" },
  { id: "recall", title: "recall falls back to lexical", type: "claim", detail: "While HNSW is off, semantic search quietly degrades to lexical — documented so no agent re-debugs it.", source: "queryBuilder.ts" },
  { id: "railway-json", title: "railway.json", type: "entity", detail: "Raw source. Cited by: Moved to Railway." },
  { id: "schema-sql", title: "db/schema.sql", type: "entity", detail: "Raw source. Cited by: HNSW index still off." },
  { id: "adr-003", title: "adr-003.md", type: "entity", detail: "Raw source. Cited by: Clerk owns auth." },
  { id: "pr-12", title: "pr-12.md", type: "entity", detail: "Raw source. Cited by: Moved to node:test." },
  { id: "anunay", title: "Anunay", type: "person", detail: "Owns the graph. Approves the waitlist." },
];

export const LINKS: { source: string; target: string; predicate: string }[] = [
  { source: "postgres", target: "trove", predicate: "runs on" },
  { source: "railway", target: "trove", predicate: "decides" },
  { source: "railway", target: "fly", predicate: "supersedes" },
  { source: "railway", target: "postgres", predicate: "because of" },
  { source: "railway-json", target: "railway", predicate: "evidence for" },
  { source: "node-test", target: "vitest", predicate: "supersedes" },
  { source: "node-test", target: "trove", predicate: "decides" },
  { source: "pr-12", target: "node-test", predicate: "evidence for" },
  { source: "clerk", target: "trove", predicate: "decides" },
  { source: "adr-003", target: "clerk", predicate: "evidence for" },
  { source: "keys", target: "clerk", predicate: "relates to" },
  { source: "hnsw", target: "postgres", predicate: "about" },
  { source: "schema-sql", target: "hnsw", predicate: "evidence for" },
  { source: "recall", target: "hnsw", predicate: "caused by" },
  { source: "anunay", target: "trove", predicate: "owns" },
  { source: "anunay", target: "railway", predicate: "decided" },
];

export const degreeOf = (id: string) => LINKS.filter((l) => l.source === id || l.target === id).length;

export const seedById = new Map(SEEDS.map((s) => [s.id, s]));
