import type { GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphSnapshot, GraphStore } from "./graphCore.js";
import { isDreamPage } from "./dream.js";

/**
 * The session-start memory index: a small, deterministic page an agent sees
 * before it does anything else ("you have memory, here is what is in it").
 *
 * Why it exists: the dominant failure of agent memory is not bad retrieval but
 * never looking (the agent answers from scratch while the fact sits in memory).
 * Telling the model memory exists, and what it covers, is what the article
 * "The components of agent memory" calls injected context; Claude Code's own
 * MEMORY.md is capped at 200 lines / 25 KB for the same reason. Keep it small:
 * it is paid for on every session, and longer instruction text lowers adherence.
 *
 * No LLM: hubs by link degree, most-used by recorded access, recent by update
 * time. Superseded notes are left out so the index never advertises a stale
 * belief.
 */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25_000;

const HUB_TYPES = new Set(["entity", "project", "domain", "person", "infrastructure", "community"]);

export type MemoryIndexOptions = {
  now?: Date;
  hubs?: number;
  mostUsed?: number;
  recent?: number;
};

export type MemoryIndex = {
  text: string;
  nodes: number;
  edges: number;
  truncated: boolean;
};

export async function buildMemoryIndex(store: GraphStore, context?: GraphOperationContext, options: MemoryIndexOptions = {}): Promise<MemoryIndex> {
  return renderMemoryIndex(await store.exportGraph(context), options);
}

export function renderMemoryIndex(snapshot: GraphSnapshot, options: MemoryIndexOptions = {}): MemoryIndex {
  const now = options.now ?? new Date();
  const nodes = snapshot.nodes.filter((node) => node.type !== "view");
  const activeEdges = snapshot.edges.filter((edge) => edge.expiredAt === null);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const degree = new Map<string, number>();
  for (const edge of activeEdges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) continue;
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
  }

  // A node is treated as superseded when an active supersedes edge reached it
  // at or after its last update (the snapshot carries no revision times; this
  // is the conservative reading of supersessionRevivedBy for an index).
  const superseded = new Set<string>();
  for (const edge of activeEdges) {
    if (edge.predicate !== "supersedes") continue;
    const target = byId.get(edge.toNodeId);
    if (target && Date.parse(edge.recordedAt) >= Date.parse(target.updatedAt)) superseded.add(target.id);
  }
  const pages = nodes.filter(isDreamPage).sort((left, right) => left.title.localeCompare(right.title));
  const current = nodes.filter((node) => !superseded.has(node.id) && !isDreamPage(node));

  const used = new Set<string>();
  const take = (candidates: GraphNode[], limit: number): GraphNode[] => {
    const picked: GraphNode[] = [];
    for (const node of candidates) {
      if (picked.length >= limit) break;
      if (used.has(node.id)) continue;
      used.add(node.id);
      picked.push(node);
    }
    return picked;
  };

  const hubs = take(
    current
      .filter((node) => HUB_TYPES.has(node.type) && (degree.get(node.id) ?? 0) > 0)
      .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.title.localeCompare(right.title)),
    options.hubs ?? 25,
  );
  const mostUsed = take(
    current
      .filter((node) => node.accessCount > 0)
      .sort((left, right) => right.accessCount - left.accessCount || right.updatedAt.localeCompare(left.updatedAt)),
    options.mostUsed ?? 25,
  );
  const recent = take(
    [...current].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    options.recent ?? 15,
  );

  const lines: string[] = [
    "# Trove memory index",
    `${nodes.length} notes, ${activeEdges.length} links · generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    nodes.length === 0
      ? "Memory is empty. Save durable facts with remember as they become true."
      : "You have memory. Before answering anything that may depend on earlier work, look it up (grep for exact strings, read a note by slug, recall for open questions) instead of re-deriving it.",
  ];
  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    lines.push("", `## ${title}`, ...rows);
  };
  const oneLine = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  section("Entity pages (one read covers the hub)", pages.slice(0, 15).map((node) => `- ${node.title} (${node.slug}) · ${oneLine(node.summary)}`));
  section("Hubs", hubs.map((node) => `- ${node.title} (${node.slug}) · ${node.type}, ${degree.get(node.id)} links`));
  section("Most used", mostUsed.map((node) => `- ${node.title} (${node.slug}) · read ${node.accessCount}×${node.summary ? ` — ${oneLine(node.summary)}` : ""}`));
  section("Recently changed", recent.map((node) => `- ${node.title} (${node.slug}) · ${node.updatedAt.slice(0, 10)}${node.summary ? ` — ${oneLine(node.summary)}` : ""}`));

  let truncated = false;
  let out = lines.slice(0, MEMORY_INDEX_MAX_LINES);
  if (out.length < lines.length) truncated = true;
  while (Buffer.byteLength(out.join("\n"), "utf8") > MEMORY_INDEX_MAX_BYTES && out.length > 4) {
    out = out.slice(0, -1);
    truncated = true;
  }
  return { text: `${out.join("\n")}\n`, nodes: nodes.length, edges: activeEdges.length, truncated };
}
