import type { NodeType } from "@/lib/api";

/**
 * The seed graph — a slice of memory any engineer recognizes, shared by the
 * hero's 3D emblem and the inspectable 2D MiniGraph so the page never tells
 * two different stories about the graph.
 *
 * None of these facts live in code a stranger could read: they are team
 * conventions, a host migration, a frozen folder, and the reason a pool cap
 * is 10. Exactly the kind of thing agents keep getting wrong and teams keep
 * re-explaining.
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
  { id: "acme", title: "acme", type: "project", detail: "One graph behind the whole team's agents — every session, everything worth keeping." },
  { id: "postgres", title: "Postgres 15 on Neon", type: "infrastructure", detail: "The database nobody writes down because 'everyone knows'. Now the graph knows.", source: "runbook.md" },
  { id: "vercel", title: "Moved to Vercel", type: "decision", detail: "Merge to main, it deploys. The old hosting call stays on the record, inspectable.", source: "vercel.json" },
  { id: "heroku", title: "Hosted on Heroku", type: "decision", detail: "True for two years. Retired when it wasn't — struck on the record, not deleted.", source: "adr-004.md", retiredBy: "Moved to Vercel" },
  { id: "pnpm", title: "Always pnpm, never npm", type: "decision", detail: "One npm install from an eager agent and the lockfile war begins. Remembered once.", source: "CONTRIBUTING.md" },
  { id: "errors", title: "Errors are { code, message }", type: "pattern", detail: "Agents shape responses correctly in every session, because session one wrote it down.", source: "src/errors.ts" },
  { id: "legacy", title: "Never touch /legacy", type: "pattern", detail: "The folder that eats juniors. Frozen by RFC 7 — agents read the sign this time.", source: "rfc-007.md" },
  { id: "env", title: "Keys in .env, never in git", type: "pattern", detail: "The repo can't tell an agent this; the graph has to. That's what it's for.", source: "runbook.md" },
  { id: "pool", title: "Free tier caps the pool at 10", type: "claim", detail: "Why the pool is 10 and not 100: the free tier. Ask the graph, not Priya.", source: "runbook.md" },
  { id: "contributing", title: "CONTRIBUTING.md", type: "entity", detail: "Raw source. Cited by: Always pnpm, never npm." },
  { id: "vercel-json", title: "vercel.json", type: "entity", detail: "Raw source. Cited by: Moved to Vercel." },
  { id: "adr-004", title: "adr-004.md", type: "entity", detail: "Raw source. Cited by: Hosted on Heroku." },
  { id: "errors-ts", title: "src/errors.ts", type: "entity", detail: "Raw source. Cited by: Errors are { code, message }." },
  { id: "rfc-007", title: "rfc-007.md", type: "entity", detail: "Raw source. Cited by: Never touch /legacy." },
  { id: "runbook", title: "runbook.md", type: "entity", detail: "Raw source. Cited by the operational claims nobody else wrote down." },
  { id: "priya", title: "Priya", type: "person", detail: "Owns billing. Approved the Vercel move. The graph remembers so she doesn't have to." },
];

export const LINKS: { source: string; target: string; predicate: string }[] = [
  { source: "postgres", target: "acme", predicate: "runs on" },
  { source: "vercel", target: "acme", predicate: "decides" },
  { source: "vercel", target: "heroku", predicate: "supersedes" },
  { source: "vercel", target: "postgres", predicate: "because of" },
  { source: "pnpm", target: "acme", predicate: "decides" },
  { source: "contributing", target: "pnpm", predicate: "evidence for" },
  { source: "errors", target: "acme", predicate: "relates to" },
  { source: "errors-ts", target: "errors", predicate: "evidence for" },
  { source: "legacy", target: "acme", predicate: "relates to" },
  { source: "rfc-007", target: "legacy", predicate: "evidence for" },
  { source: "env", target: "acme", predicate: "relates to" },
  { source: "runbook", target: "env", predicate: "evidence for" },
  { source: "pool", target: "postgres", predicate: "about" },
  { source: "runbook", target: "pool", predicate: "evidence for" },
  { source: "vercel-json", target: "vercel", predicate: "evidence for" },
  { source: "adr-004", target: "heroku", predicate: "evidence for" },
  { source: "priya", target: "acme", predicate: "owns" },
  { source: "priya", target: "vercel", predicate: "decided" },
];

export const degreeOf = (id: string) => LINKS.filter((l) => l.source === id || l.target === id).length;

export const seedById = new Map(SEEDS.map((s) => [s.id, s]));
