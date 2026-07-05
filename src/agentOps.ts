import type { ForgetInput, GraphEdge, GraphNode, ReadAnyInput, RememberInput } from "./contracts.js";
import type { GraphOperationContext, GraphSourceDocument, GraphStore, ReadResult } from "./graphCore.js";
import { slugify } from "./slug.js";

export type RememberResult = {
  action: "created" | "updated";
  node: GraphNode;
  /** Near-matches that were NOT merged into — surfaced so the agent can retarget with `slug` if the dedupe missed. */
  similar: Array<{ nodeId: string; slug: string; title: string }>;
};

export type ForgetResult = {
  dryRun: boolean;
  retired: number;
  edges: Array<{
    edgeId: string;
    predicate: string | null;
    fromNodeId: string | null;
    toNodeId: string | null;
    fromTitle: string | null;
    toTitle: string | null;
  }>;
};

export type ReadAnyResult =
  | { kind: "node"; node: ReadResult }
  | { kind: "source"; source: GraphSourceDocument };

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * One write door: revise the node when the title (or an explicit nodeId/slug)
 * identifies an existing atom, otherwise capture a new one. Dedupe is
 * exact-identity only (slug or normalized title) — near-matches are reported,
 * never silently merged.
 */
export async function remember(
  store: GraphStore,
  input: RememberInput,
  context?: GraphOperationContext,
): Promise<RememberResult> {
  let target: ReadResult | null = null;
  if (input.nodeId) {
    target = await store.read({ nodeId: input.nodeId });
    if (!target) throw new Error(`remember: no node with id ${input.nodeId}.`);
  } else if (input.slug) {
    target = await store.read({ slug: input.slug });
    if (!target) throw new Error(`remember: no node with slug ${input.slug}.`);
  }

  let similar: RememberResult["similar"] = [];
  if (!target) {
    const found = await store.search({ query: input.title, includeTextUnits: false, mode: "lexical", limit: 5 });
    const wantedSlug = slugify(input.title);
    const wantedTitle = normalizeTitle(input.title);
    const exact = found.nodes.find((node) => node.slug === wantedSlug || normalizeTitle(node.title) === wantedTitle);
    if (exact) target = await store.read({ nodeId: exact.id });
    similar = found.nodes
      .filter((node) => node.id !== exact?.id)
      .slice(0, 3)
      .map((node) => ({ nodeId: node.id, slug: node.slug, title: node.title }));
  }

  if (!target) {
    const node = await store.capture({
      title: input.title,
      type: input.type ?? "claim",
      summary: input.summary,
      content: input.content,
      evidence: (input.evidence ?? []).map((ref) => ({
        sourceId: ref.sourceId,
        textUnitId: ref.textUnitId,
        selector: ref.selector ?? {},
      })),
      links: (input.links ?? []).map((link) => ({ toSlug: link.toSlug, predicate: link.predicate ?? "relates_to" })),
    }, context);
    return { action: "created", node, similar };
  }

  const updateFields = {
    nodeId: target.id,
    title: input.title,
    summary: input.summary,
    ...(input.content !== undefined ? { content: input.content } : {}),
  };
  let updated = await store.update({ ...updateFields, baseRevisionId: target.revisionId }, context);
  if (updated && "conflict" in updated) {
    const fresh = await store.read({ nodeId: target.id });
    if (!fresh) throw new Error(`remember: node ${target.id} disappeared during update.`);
    updated = await store.update({ ...updateFields, baseRevisionId: fresh.revisionId }, context);
  }
  if (!updated || "conflict" in updated) {
    throw new Error(`remember: update of ${target.id} kept conflicting; re-read and retry.`);
  }

  for (const link of input.links ?? []) {
    try {
      await store.link({
        fromNodeId: target.id,
        toSlug: link.toSlug,
        predicate: link.predicate ?? "relates_to",
        weight: 1,
      }, context);
    } catch {
      // Missing link targets are non-fatal; the belief update already landed.
    }
  }
  for (const evidence of input.evidence ?? []) {
    try {
      await store.annotate({
        motivation: "supports",
        sourceId: evidence.sourceId,
        textUnitId: evidence.textUnitId,
        nodeId: target.id,
        body: {},
        selector: evidence.selector ?? {},
      }, context);
    } catch {
      // Evidence refs that fail to resolve are non-fatal.
    }
  }

  return { action: "updated", node: updated, similar };
}

/**
 * Retire beliefs on the record. Explicit edgeIds apply immediately; query mode
 * defaults to a dry-run preview of the active edges around matching nodes.
 * Edges are expired (bitemporal), never deleted.
 */
export async function forget(
  store: GraphStore,
  input: ForgetInput,
  context?: GraphOperationContext,
): Promise<ForgetResult> {
  const dryRun = input.dryRun ?? Boolean(input.query && !input.edgeIds?.length);
  const nodeTitles = new Map<string, string>();
  const candidates = new Map<string, GraphEdge | null>();

  for (const edgeId of input.edgeIds ?? []) candidates.set(edgeId, null);

  if (input.query) {
    const found = await store.search({ query: input.query, includeTextUnits: false, mode: "lexical", limit: 5 });
    for (const node of found.nodes) {
      const { nodes, edges } = await store.neighborhood({ nodeId: node.id, depth: 1, includeExpired: false });
      for (const neighbor of nodes) nodeTitles.set(neighbor.id, neighbor.title);
      for (const edge of edges) {
        if (!edge.expiredAt) candidates.set(edge.id, edge);
      }
    }
  }

  const edges: ForgetResult["edges"] = [];
  let retired = 0;
  for (const [edgeId, known] of candidates) {
    let edge = known;
    if (!dryRun) {
      const result = await store.invalidateEdge({ edgeId, validUntil: input.validUntil }, context);
      if (result) {
        retired += 1;
        edge = result;
      } else if (!known) {
        continue; // Unknown id and nothing to retire: skip silently.
      }
    }
    edges.push({
      edgeId,
      predicate: edge?.predicate ?? null,
      fromNodeId: edge?.fromNodeId ?? null,
      toNodeId: edge?.toNodeId ?? null,
      fromTitle: edge ? nodeTitles.get(edge.fromNodeId) ?? null : null,
      toTitle: edge ? nodeTitles.get(edge.toNodeId) ?? null : null,
    });
  }

  return { dryRun, retired, edges };
}

/** Read anything by id or slug: nodes first, then raw sources. */
export async function readAny(store: GraphStore, input: ReadAnyInput): Promise<ReadAnyResult | null> {
  if (input.slug) {
    const node = await store.read({ slug: input.slug });
    return node ? { kind: "node", node } : null;
  }
  if (!input.id) return null;
  const node = await store.read({ nodeId: input.id });
  if (node) return { kind: "node", node };
  const source = await store.readSource({ sourceId: input.id });
  if (source) return { kind: "source", source };
  return null;
}
