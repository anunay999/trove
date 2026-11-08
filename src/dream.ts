import { contentTerms } from "./queryNormalize.js";
import type { GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphStore } from "./graphCore.js";
import { remember } from "./agentOps.js";

/**
 * Dreaming: the offline consolidation pass over one owner's memory.
 *
 * Writing notes during a session captures what seemed important at the time;
 * some of it is wrong from the start, some goes stale, some never gets
 * written. The article "The components of agent memory" calls the background
 * pass that fixes this dreaming: replay the record, correct notes, fill gaps,
 * and keep representations (one page per entity) up to date. bench/stack-sim
 * measured which parts pay for themselves; this job ships those, ordered by
 * what they risk:
 *
 *   1. resolve supersessions a later revision turned around (edge writes only)
 *   2. verify notes against newer source spans (report only)
 *   3. report sources nothing cites yet (report only)
 *   4. rebuild entity pages from current notes (writes its own page nodes)
 *   5. retire never-used, unlinked, uncited notes (opt-in, tombstone only)
 *
 * No LLM: every check is deterministic, so a run is cheap enough to cover the
 * whole graph (the simulations found that how much a pass checks matters far
 * more than which notes it checks first). Nothing is hard-deleted: edges are
 * expired with a successor, notes are tombstoned and stay in history.
 */

export const DREAM_PAGE_MARKER = "Page kept by Trove dreaming";
const HUB_TYPES = new Set(["entity", "project", "domain", "person", "infrastructure"]);
const FACT_TYPES = new Set(["claim", "decision", "pattern", "task", "question"]);
const PAGE_MIN_NOTES = 3;
const PAGE_MAX_NOTES = 40;
const REPORT_LIMIT = 50;

export type DreamOptions = {
  /** Notes checked against newer sources per run (default 200). */
  budget?: number;
  /** Rebuild entity pages (default true). */
  pages?: boolean;
  /** Tombstone unused, unlinked, uncited claims older than this many days. Null/absent = never. */
  retireAfterDays?: number | null;
  now?: Date;
};

export type DreamResult = {
  ownerId: string | null;
  notes: number;
  checked: number;
  supersessionsResolved: Array<{ expiredEdgeId: string; currentNodeId: string; supersededNodeId: string }>;
  supersessionsAmbiguous: Array<{ edgeId: string; reason: string }>;
  newerSourceConflicts: Array<{ nodeId: string; slug: string; title: string; textUnitId: string; sourceId: string; excerpt: string }>;
  uncitedSources: { count: number; sample: Array<{ sourceId: string; title: string; createdAt: string }> };
  pages: { written: string[]; unchanged: number };
  retired: Array<{ nodeId: string; slug: string; title: string }>;
};

export function isDreamPage(node: Pick<GraphNode, "type" | "content">): boolean {
  return node.type === "community" && (node.content ?? "").startsWith(DREAM_PAGE_MARKER);
}

export async function performDream(
  store: GraphStore,
  input: { ownerId?: string | null } & DreamOptions,
): Promise<DreamResult> {
  const ownerId = input.ownerId ?? null;
  const context: GraphOperationContext = {
    ...(ownerId ? { ownerId } : {}),
    actorId: "trove-dream",
    interfaceId: "dream",
  };
  const now = input.now ?? new Date();
  const snapshot = await store.exportGraph(context);
  const nodes = snapshot.nodes.filter((node) => node.type !== "view");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const activeEdges = snapshot.edges.filter((edge) => edge.expiredAt === null && byId.has(edge.fromNodeId) && byId.has(edge.toNodeId));

  const result: DreamResult = {
    ownerId,
    notes: nodes.length,
    checked: 0,
    supersessionsResolved: [],
    supersessionsAmbiguous: [],
    newerSourceConflicts: [],
    uncitedSources: { count: 0, sample: [] },
    pages: { written: [], unchanged: 0 },
    retired: [],
  };

  // 1. Supersessions a later revision turned around. Lint already knows which
  // edges supersededBy stopped honouring; the dream decides the direction.
  const lint = await store.lint(context);
  const edgeById = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const finding of lint.findings) {
    if (finding.code !== "revised_after_superseded" || !finding.entityId) continue;
    const edge = edgeById.get(finding.entityId);
    if (!edge || edge.expiredAt !== null) continue;
    const successor = byId.get(edge.fromNodeId);
    const revived = byId.get(edge.toNodeId);
    if (!successor || !revived) continue;
    // Both sides changed after the edge: which belief is current is a
    // judgement call, so leave the lint finding for a person or agent.
    if (Date.parse(successor.updatedAt) > Date.parse(edge.recordedAt)) {
      result.supersessionsAmbiguous.push({ edgeId: edge.id, reason: "both notes were revised after the edge was recorded" });
      continue;
    }
    const replacement = await store.link({
      fromNodeId: revived.id,
      toNodeId: successor.id,
      predicate: "supersedes",
      weight: 1,
      supersedesEdgeId: edge.id,
    }, context);
    if (replacement) {
      result.supersessionsResolved.push({ expiredEdgeId: edge.id, currentNodeId: revived.id, supersededNodeId: successor.id });
    }
  }

  // Notes that still read as current after step 1.
  const superseded = new Set((await store.supersededBy(nodes.map((node) => node.id), context)).keys());
  const facts = nodes.filter((node) => FACT_TYPES.has(node.type) && !superseded.has(node.id) && !isDreamPage(node));

  // 2. Verify against newer sources: a span ingested after the note was last
  // written that names the same thing but states different numbers. Reported,
  // never applied: a deterministic check can find the candidate, not decide it.
  const evidence = await store.getEvidenceForNodes(nodes.map((node) => node.id), context);
  const sources = await store.sources({ limit: 5000 }, context);
  const sourceCreated = new Map(sources.map((source) => [source.id, source.createdAt]));
  const budget = Math.max(0, Math.trunc(input.budget ?? DREAM_DEFAULT_BUDGET));
  const toCheck = [...facts]
    .sort((left, right) => right.accessCount - left.accessCount || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, budget);
  for (const node of toCheck) {
    result.checked += 1;
    if (result.newerSourceConflicts.length >= REPORT_LIMIT) break;
    const cited = new Set((evidence.get(node.id) ?? []).map((unit) => unit.id));
    const found = await store.search({ query: node.title, mode: "lexical", includeTextUnits: true, limit: 8 }, context);
    for (const unit of found.textUnits) {
      if (cited.has(unit.id)) continue;
      const created = sourceCreated.get(unit.sourceId);
      if (!created || Date.parse(created) <= Date.parse(node.updatedAt)) continue;
      if (!newerSpanChangesValue(node, unit.text)) continue;
      result.newerSourceConflicts.push({
        nodeId: node.id,
        slug: node.slug,
        title: node.title,
        textUnitId: unit.id,
        sourceId: unit.sourceId,
        excerpt: unit.text.replace(/\s+/g, " ").trim().slice(0, 240),
      });
      break;
    }
  }

  // 3. Sources no note cites: material that was saved but never distilled.
  const citedSources = new Set<string>();
  for (const units of evidence.values()) for (const unit of units) citedSources.add(unit.sourceId);
  const uncited = sources.filter((source) => !citedSources.has(source.id));
  result.uncitedSources = {
    count: uncited.length,
    sample: uncited.slice(0, 10).map((source) => ({ sourceId: source.id, title: source.title, createdAt: source.createdAt })),
  };

  // 4. Entity pages: one page per hub, quoting its current notes verbatim
  // (the article's "one page per entity, quote critical facts"). A page is
  // as-of its newest note, so a reader can tell when a note is newer than it.
  if (input.pages !== false) {
    const neighbours = new Map<string, Set<string>>();
    for (const edge of activeEdges) {
      if (edge.predicate === "supersedes") continue;
      for (const [hub, other] of [[edge.fromNodeId, edge.toNodeId], [edge.toNodeId, edge.fromNodeId]] as const) {
        const set = neighbours.get(hub) ?? new Set<string>();
        set.add(other);
        neighbours.set(hub, set);
      }
    }
    const current = new Map(facts.map((node) => [node.id, node]));
    for (const hub of nodes) {
      if (!HUB_TYPES.has(hub.type) || superseded.has(hub.id)) continue;
      const notes = [...(neighbours.get(hub.id) ?? [])]
        .map((id) => current.get(id))
        .filter((node): node is GraphNode => Boolean(node))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, PAGE_MAX_NOTES);
      if (notes.length < PAGE_MIN_NOTES) continue;
      const content = renderEntityPage(hub, notes);
      const title = `${hub.title} page`;
      const existing = await store.read({ slug: `${hub.slug}-page` }, context, { trackAccess: false });
      if (existing && existing.content === content) {
        result.pages.unchanged += 1;
        continue;
      }
      if (existing && !isDreamPage(existing)) continue; // someone else's note owns the slug
      const written = await remember(store, {
        ...(existing ? { nodeId: existing.id } : {}),
        title,
        type: "community",
        summary: `Current notes about ${hub.title}, as of ${notes[0]!.updatedAt.slice(0, 10)}.`,
        content,
        links: [{ toSlug: hub.slug, predicate: "summarizes" }],
      }, context);
      result.pages.written.push(written.node.slug);
    }
  }

  // 5. Retire noise, only when asked: never read, never linked, never cited,
  // and old. Tombstoned, so history and asOf reads keep it.
  const retireDays = input.retireAfterDays;
  if (retireDays !== null && retireDays !== undefined && retireDays > 0) {
    const cutoff = now.getTime() - retireDays * 86_400_000;
    const linked = new Set<string>();
    for (const edge of activeEdges) {
      linked.add(edge.fromNodeId);
      linked.add(edge.toNodeId);
    }
    const evidenced = await store.evidenceNodeIds(nodes.map((node) => node.id), context);
    const noise = nodes.filter((node) =>
      node.type === "claim" &&
      node.accessCount === 0 &&
      !linked.has(node.id) &&
      !evidenced.has(node.id) &&
      Date.parse(node.updatedAt) < cutoff,
    ).slice(0, REPORT_LIMIT);
    if (noise.length > 0) {
      await store.tombstoneNodes(noise.map((node) => node.id), context);
      result.retired = noise.map((node) => ({ nodeId: node.id, slug: node.slug, title: node.title }));
    }
  }

  return result;
}

/**
 * Does a newer span look like it changes this note's value? It has to name the
 * same thing (most of the title's terms) and disagree on a number: it states a
 * number the note does not, and leaves out one the note states. Narrow on
 * purpose: a false conflict sends a person to check a note that was fine.
 */
export function newerSpanChangesValue(node: Pick<GraphNode, "title" | "summary" | "content">, unitText: string): boolean {
  const unitTerms = new Set(contentTerms(unitText));
  const titleTerms = contentTerms(node.title).filter((term) => !/^\d+$/.test(term));
  if (titleTerms.length === 0) return false;
  const named = titleTerms.filter((term) => unitTerms.has(term)).length / titleTerms.length;
  if (named < 0.75) return false;
  const numbers = (terms: Iterable<string>) => new Set([...terms].filter((term) => /^\d+$/.test(term)));
  const noteNumbers = numbers(contentTerms(`${node.summary ?? ""}\n${node.content ?? ""}`));
  const unitNumbers = numbers(unitTerms);
  if (noteNumbers.size === 0 || unitNumbers.size === 0) return false;
  const statesNew = [...unitNumbers].some((value) => !noteNumbers.has(value));
  const dropsOld = [...noteNumbers].some((value) => !unitNumbers.has(value));
  return statesNew && dropsOld;
}

export function renderEntityPage(hub: Pick<GraphNode, "title" | "slug">, notes: Array<Pick<GraphNode, "title" | "slug" | "summary" | "updatedAt">>): string {
  const lines = [
    `${DREAM_PAGE_MARKER} for ${hub.title} (${hub.slug}). It quotes the current notes linked to it; a note updated after the date below is newer than this page.`,
    "",
    ...notes.map((note) => `- ${note.title} (${note.slug}, ${note.updatedAt.slice(0, 10)}): ${(note.summary ?? "").replace(/\s+/g, " ").trim()}`),
  ];
  return lines.join("\n");
}

/** Notes a scheduled dream checks against newer sources. */
export const DREAM_DEFAULT_BUDGET = 200;

/**
 * Options for one run, from the job payload (budget, pages, retireAfterDays).
 * Retiring is never a default: it runs only when a payload asks for it.
 */
export function dreamOptionsFromPayload(payload: Record<string, unknown>): { budget: number; pages: boolean; retireAfterDays: number | null } {
  return {
    budget: typeof payload.budget === "number" && payload.budget >= 0 ? payload.budget : DREAM_DEFAULT_BUDGET,
    pages: typeof payload.pages === "boolean" ? payload.pages : true,
    retireAfterDays: typeof payload.retireAfterDays === "number" && payload.retireAfterDays > 0 ? payload.retireAfterDays : null,
  };
}
