import type { ForgetInput, GraphEdge, GraphNode, ReadAnyInput, RememberInput } from "./contracts.js";
import type { GraphOperationContext, GraphSourceDocument, GraphStore, ReadResult } from "./graphCore.js";
import { UnknownEvidenceReferenceError } from "./graphCore.js";
import { slugify } from "./slug.js";

export type RememberResult = {
  action: "created" | "updated";
  node: GraphNode;
  /** Near-matches that were NOT merged into — surfaced so the agent can retarget with `slug` if the dedupe missed. */
  similar: Array<{ nodeId: string; slug: string; title: string; score: number }>;
  /**
   * Evidence refs that did not resolve (unknown source/text unit), with the
   * reason. They are reported here instead of silently dropped — nothing is a
   * free-floating fact unless the caller can SEE that its citation failed.
   * Present only when at least one ref failed.
   */
  evidenceRejected?: Array<{ sourceId: string | null; textUnitId: string | null; reason: string }>;
};

export type ForgetResult = {
  dryRun: boolean;
  retired: number;
  tombstoned: number;
  edges: Array<{
    edgeId: string;
    predicate: string | null;
    fromNodeId: string | null;
    toNodeId: string | null;
    fromTitle: string | null;
    toTitle: string | null;
  }>;
  /** Nodes the forget targets (previews on dryRun, tombstoned on apply). */
  nodes: Array<{ nodeId: string; slug: string; title: string }>;
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
 * never silently merged. Title candidates come from trigram similarity so
 * near-twins ("Airflow DAG ownership rules" vs "Airflow DAG ownership")
 * surface in `similar` with scores. Internal reads never bump access
 * activation ({ trackAccess: false }).
 */
export async function remember(
  store: GraphStore,
  input: RememberInput,
  context?: GraphOperationContext,
): Promise<RememberResult> {
  let target: ReadResult | null = null;
  if (input.nodeId) {
    target = await store.read({ nodeId: input.nodeId }, context, { trackAccess: false });
    if (!target) throw new Error(`remember: no node with id ${input.nodeId}.`);
  } else if (input.slug) {
    target = await store.read({ slug: input.slug }, context, { trackAccess: false });
    if (!target) throw new Error(`remember: no node with slug ${input.slug}.`);
  }

  let similar: RememberResult["similar"] = [];
  if (!target) {
    const matches = await store.findSimilarTitles(input.title, 5, context);
    const wantedSlug = slugify(input.title);
    const wantedTitle = normalizeTitle(input.title);
    const exact = matches.find((match) => match.node.slug === wantedSlug || normalizeTitle(match.node.title) === wantedTitle);
    if (exact) target = await store.read({ nodeId: exact.node.id }, context, { trackAccess: false });
    similar = matches
      .filter((match) => match.node.id !== exact?.node.id)
      .slice(0, 3)
      .map((match) => ({ nodeId: match.node.id, slug: match.node.slug, title: match.node.title, score: match.score }));
  }

  // Evidence attaches the same way on create and revise: each ref is attempted
  // individually, refs that don't resolve come back in `evidenceRejected`
  // (loud, actionable), and any other failure still throws — the old catch-all
  // made a bogus citation indistinguishable from a database on fire.
  const evidenceRejected: NonNullable<RememberResult["evidenceRejected"]> = [];
  const attachEvidence = async (nodeId: string): Promise<void> => {
    for (const evidence of input.evidence ?? []) {
      try {
        await store.annotate({
          motivation: "supports",
          sourceId: evidence.sourceId,
          textUnitId: evidence.textUnitId,
          nodeId,
          body: {},
          selector: evidence.selector ?? {},
        }, context);
      } catch (error) {
        if (error instanceof UnknownEvidenceReferenceError) {
          evidenceRejected.push({
            sourceId: evidence.sourceId ?? null,
            textUnitId: evidence.textUnitId ?? null,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  };
  const finish = (result: RememberResult): RememberResult =>
    evidenceRejected.length > 0 ? { ...result, evidenceRejected } : result;

  if (!target) {
    const node = await store.capture({
      title: input.title,
      type: input.type ?? "claim",
      summary: input.summary,
      content: input.content,
      evidence: [],
      links: (input.links ?? []).map((link) => ({ toSlug: link.toSlug, predicate: link.predicate ?? "relates_to" })),
    }, context);
    await attachEvidence(node.id);
    return finish({ action: "created", node, similar });
  }

  const updateFields = {
    nodeId: target.id,
    title: input.title,
    summary: input.summary,
    ...(input.content !== undefined ? { content: input.content } : {}),
  };
  let updated = await store.update({ ...updateFields, baseRevisionId: target.revisionId }, context);
  if (updated && "conflict" in updated) {
    const fresh = await store.read({ nodeId: target.id }, context, { trackAccess: false });
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
  await attachEvidence(target.id);

  return finish({ action: "updated", node: updated, similar });
}

/**
 * Retire beliefs on the record: edges (expire, bitemporal) and/or whole nodes
 * (tombstone). Explicit edgeIds/nodeIds/slugs apply immediately; query mode
 * defaults to a dry-run preview of the active edges around matching nodes.
 * Slugs resolve exactly like remember — an unknown slug is a hard error.
 * Nothing is hard-deleted: supersession history stays queryable via
 * neighborhood includeExpired/asOf.
 */
export async function forget(
  store: GraphStore,
  input: ForgetInput,
  context?: GraphOperationContext,
): Promise<ForgetResult> {
  const explicitEdges = (input.edgeIds?.length ?? 0) > 0;
  const explicitNodes = (input.nodeIds?.length ?? 0) > 0 || (input.slugs?.length ?? 0) > 0;
  const dryRun = input.dryRun ?? Boolean(input.query && !explicitEdges && !explicitNodes);
  const nodeTitles = new Map<string, string>();
  const candidates = new Map<string, GraphEdge | null>();

  for (const edgeId of input.edgeIds ?? []) candidates.set(edgeId, null);

  // Resolve targeted nodes up front so unknown identifiers fail before any
  // edge is touched. Reads are internal: no access-activation bumps.
  const targeted = new Map<string, GraphNode>();
  for (const slug of input.slugs ?? []) {
    const node = await store.read({ slug }, context, { trackAccess: false });
    if (!node) throw new Error(`forget: no node with slug ${slug}.`);
    targeted.set(node.id, node);
  }
  for (const nodeId of input.nodeIds ?? []) {
    if (targeted.has(nodeId)) continue;
    const node = await store.read({ nodeId }, context, { trackAccess: false });
    if (!node) throw new Error(`forget: no node with id ${nodeId}.`);
    targeted.set(nodeId, node);
  }
  for (const node of targeted.values()) nodeTitles.set(node.id, node.title);

  if (input.query) {
    const found = await store.search({ query: input.query, includeTextUnits: false, mode: "lexical", limit: 5 }, context);
    for (const node of found.nodes) {
      const { nodes, edges } = await store.neighborhood({ nodeId: node.id, depth: 1, includeExpired: false }, context);
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

  const nodes = [...targeted.values()].map((node) => ({ nodeId: node.id, slug: node.slug, title: node.title }));
  let tombstoned = 0;
  if (!dryRun && targeted.size > 0) {
    const result = await store.tombstoneNodes([...targeted.keys()], context);
    tombstoned = result.tombstoned.length;
  }

  return { dryRun, retired, tombstoned, edges, nodes };
}

/** Read anything by id or slug: nodes first, then raw sources. */
export async function readAny(store: GraphStore, input: ReadAnyInput, context?: GraphOperationContext): Promise<ReadAnyResult | null> {
  if (input.slug) {
    const node = await store.read({ slug: input.slug }, context);
    return node ? { kind: "node", node } : null;
  }
  if (!input.id) return null;
  const node = await store.read({ nodeId: input.id }, context);
  if (node) return { kind: "node", node };
  const source = await store.readSource({ sourceId: input.id }, context);
  if (source) return { kind: "source", source };
  return null;
}
