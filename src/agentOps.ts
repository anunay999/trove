import type { ForgetInput, GraphEdge, GraphNode, QuoteEvidenceRef, ReadAnyInput, RememberInput } from "./contracts.js";
import type { GraphOperationContext, GraphSourceDocument, GraphStore, ReadResult, TextQuoteMatch } from "./graphCore.js";
import { UnknownEvidenceReferenceError } from "./graphCore.js";
import { slugify } from "./slug.js";

export type RememberResult = {
  /** True only when every requested evidence ref and link completed without a surfaced failure. */
  complete: boolean;
  action: "created" | "updated";
  node: GraphNode;
  /** Near-matches that were NOT merged into — surfaced so the agent can retarget with `slug` if the dedupe missed. */
  similar: Array<{ nodeId: string; slug: string; title: string; score: number }>;
  /**
   * Evidence refs that did not resolve (unknown source/text unit, or a quote
   * that matched nothing/too much), with the reason. They are reported here
   * instead of silently dropped — nothing is a free-floating fact unless the
   * caller can SEE that its citation failed. Reasons are repairable: they say
   * what would have worked, not just that it failed. Present only when at
   * least one ref failed.
   */
  evidenceRejected?: Array<{ sourceId: string | null; textUnitId: string | null; quote?: string | null; reason: string }>;
  /**
   * Refs that ATTACHED but cite a unit this session was never served
   * (backlog #9b): a ref the agent never received is a hallucination by
   * definition. Additive and non-breaking — the citation lands, the warning
   * tells the agent to re-cite as { quote } or fetch the span first.
   * Quote-resolved citations are exempt: resolution grounds them by
   * construction. Present only when at least one ref was unserved.
   */
  evidenceUnserved?: Array<{ sourceId: string | null; textUnitId: string | null; reason: string }>;
  /** Requested links that could not be attached after the node mutation landed. */
  linkRejected?: Array<{ toSlug: string; predicate: string; reason: string }>;
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
 * Cite-by-quote acceptance (backlog #9a): a fuzzy match may be cited
 * automatically only when it holds at least this share of the quote's content
 * terms AND leads the runner-up by the margin — a near-tie is a guess, and a
 * wrong auto-citation is worse than a repairable rejection. Exact (verbatim)
 * matches need no margin: they either contain the words or they don't.
 */
const FUZZY_QUOTE_ACCEPT_FLOOR = 0.7;
const FUZZY_QUOTE_ACCEPT_MARGIN = 0.15;

type QuoteResolution =
  | { ok: true; textUnitId: string; sourceId: string; match: "exact" | "fuzzy"; score: number }
  | { ok: false; reason: string };

function describeQuoteMatch(match: TextQuoteMatch): string {
  const preview = match.unit.text.replace(/\s+/g, " ").trim().slice(0, 60);
  return `unit ${match.unit.id} in source ${match.unit.sourceId} ("${preview}…")`;
}

/**
 * Resolve a { quote } evidence ref to a concrete text unit. The quote form
 * exists because echoing UUIDs is the one thing LLMs are structurally worst
 * at, while quoting text they were served is what they do naturally
 * (backlog #9). Resolution order: verbatim containment, then term-containment
 * fuzzy. Every rejection names the repair — add sourceId, quote more text,
 * ingest the source — because an error the agent cannot act on is noise.
 */
async function resolveQuoteRef(
  store: GraphStore,
  evidence: QuoteEvidenceRef,
  context?: GraphOperationContext,
): Promise<QuoteResolution> {
  const quote = evidence.quote;
  if (!quote) return { ok: false, reason: "empty quote" };

  // quote + textUnitId is VERIFICATION mode: the cited unit must itself hold
  // the quote. This is containment at write time — the composition with #17's
  // weak-evidence lint, which can only measure the same thing after the fact.
  if (evidence.textUnitId) {
    const within = await store.resolveTextQuote({ quote, textUnitId: evidence.textUnitId, limit: 1 }, context);
    const hit = within.find((match) => match.match === "exact")
      ?? (within[0] && within[0].score >= FUZZY_QUOTE_ACCEPT_FLOOR ? within[0] : undefined);
    if (hit) {
      return { ok: true, textUnitId: hit.unit.id, sourceId: hit.unit.sourceId, match: hit.match, score: hit.score };
    }
    // Repair costs one extra lookup, on the failure path only: say where the
    // quote DOES appear so the agent can retarget in one call.
    const elsewhere = await store.resolveTextQuote({ quote, limit: 3 }, context);
    const elsewhereNote = elsewhere.length > 0
      ? ` It ${elsewhere[0]?.match === "exact" ? "appears verbatim" : "most closely matches"} in ${describeQuoteMatch(elsewhere[0] as TextQuoteMatch)} — cite that unit, or drop textUnitId and let the quote resolve.`
      : "";
    return { ok: false, reason: `The quote does not appear in cited text unit ${evidence.textUnitId}.${elsewhereNote}` };
  }

  const matches = await store.resolveTextQuote({
    quote,
    ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
    limit: 8,
  }, context);
  const exact = matches.filter((match) => match.match === "exact");
  if (exact.length === 1) {
    const hit = exact[0] as TextQuoteMatch;
    return { ok: true, textUnitId: hit.unit.id, sourceId: hit.unit.sourceId, match: "exact", score: 1 };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      reason: `The quote is ambiguous — it appears verbatim in ${exact.length} spans: ${exact.slice(0, 3).map(describeQuoteMatch).join("; ")}. Add sourceId, or quote a longer passage.`,
    };
  }

  const best = matches[0];
  if (!best) {
    return {
      ok: false,
      reason: `The quote does not appear in any ingested span${evidence.sourceId ? ` of source ${evidence.sourceId}` : ""}. Ingest the source first, or quote a span you were served.`,
    };
  }
  const marginOk = matches.length === 1 || best.score - (matches[1]?.score ?? 0) >= FUZZY_QUOTE_ACCEPT_MARGIN;
  if (best.score >= FUZZY_QUOTE_ACCEPT_FLOOR && marginOk) {
    return { ok: true, textUnitId: best.unit.id, sourceId: best.unit.sourceId, match: "fuzzy", score: best.score };
  }
  return {
    ok: false,
    reason: `No span contains the quote verbatim; closest: ${matches.slice(0, 3).map((match) => `${describeQuoteMatch(match)} (${Math.round(match.score * 100)}% of quote terms)`).join("; ")}. Quote the span verbatim, or add sourceId.`,
  };
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
  // { quote } refs are resolved to units BEFORE attaching (cite-by-quote);
  // UUID refs that attach but were never served this session come back in
  // `evidenceUnserved` — attached (non-breaking), but visibly suspect.
  const evidenceRejected: NonNullable<RememberResult["evidenceRejected"]> = [];
  const evidenceUnserved: NonNullable<RememberResult["evidenceUnserved"]> = [];
  const linkRejected: NonNullable<RememberResult["linkRejected"]> = [];
  const attachEvidence = async (nodeId: string): Promise<void> => {
    for (const evidence of input.evidence ?? []) {
      if (evidence.quote) {
        const resolved = await resolveQuoteRef(store, evidence, context);
        if (!resolved.ok) {
          evidenceRejected.push({
            sourceId: evidence.sourceId ?? null,
            textUnitId: evidence.textUnitId ?? null,
            quote: evidence.quote,
            reason: resolved.reason,
          });
          continue;
        }
        try {
          await store.annotate({
            motivation: "supports",
            sourceId: resolved.sourceId,
            textUnitId: resolved.textUnitId,
            nodeId,
            body: {},
            selector: {
              ...evidence.selector,
              // W3C TextQuoteSelector shape — the field was always meant for this.
              type: "TextQuoteSelector",
              exact: evidence.quote,
              match: resolved.match,
              ...(resolved.match === "fuzzy" ? { score: resolved.score } : {}),
            },
          }, context);
        } catch (error) {
          if (error instanceof UnknownEvidenceReferenceError) {
            evidenceRejected.push({
              sourceId: resolved.sourceId,
              textUnitId: resolved.textUnitId,
              quote: evidence.quote,
              reason: error.message,
            });
            continue;
          }
          throw error;
        }
        continue;
      }

      // A source identifies a document, not the exact span supporting this
      // claim. Refuse to turn a bare source id into a citation: the caller can
      // repair it with a served text-unit id or with the span's own words.
      if (evidence.sourceId && !evidence.textUnitId) {
        evidenceRejected.push({
          sourceId: evidence.sourceId,
          textUnitId: null,
          reason:
            `source ${evidence.sourceId} does not identify an exact supporting span. ` +
            "Add a textUnitId from served output, or cite { quote } (optionally narrowed with sourceId).",
        });
        continue;
      }

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

      // (b) A UUID ref that attached but was never served to this session is a
      // hallucination by definition — flag it (warning, not rejection).
      if (evidence.textUnitId) {
        const served = await store.textUnitWasServed({ textUnitId: evidence.textUnitId }, context);
        if (!served) {
          evidenceUnserved.push({
            sourceId: evidence.sourceId ?? null,
            textUnitId: evidence.textUnitId,
            reason:
              `text unit ${evidence.textUnitId} was never served to this session (ingest/recall/grep/read). ` +
              "If you have the span's words, re-cite as { quote } so it resolves against the corpus; " +
              "otherwise fetch the span first (grep/read the source) and cite again.",
          });
        }
      }
    }
  };
  const attachLinks = async (nodeId: string): Promise<void> => {
    for (const link of input.links ?? []) {
      const predicate = link.predicate ?? "relates_to";
      try {
        const attached = await store.link({
          fromNodeId: nodeId,
          toSlug: link.toSlug,
          predicate,
          weight: 1,
        }, context);
        if (!attached) {
          linkRejected.push({
            toSlug: link.toSlug,
            predicate,
            reason: `Link target not found: ${link.toSlug}. Remember the target first, then retry this link.`,
          });
        }
      } catch (error) {
        linkRejected.push({
          toSlug: link.toSlug,
          predicate,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const finish = (
    result: Omit<RememberResult, "complete" | "evidenceRejected" | "evidenceUnserved" | "linkRejected">,
  ): RememberResult => ({
    ...result,
    complete: evidenceRejected.length === 0 && evidenceUnserved.length === 0 && linkRejected.length === 0,
    ...(evidenceRejected.length > 0 ? { evidenceRejected } : {}),
    ...(evidenceUnserved.length > 0 ? { evidenceUnserved } : {}),
    ...(linkRejected.length > 0 ? { linkRejected } : {}),
  });

  if (!target) {
    const node = await store.capture({
      title: input.title,
      type: input.type ?? "claim",
      summary: input.summary,
      content: input.content,
      evidence: [],
      links: [],
    }, context);
    await attachLinks(node.id);
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

  await attachLinks(target.id);
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
