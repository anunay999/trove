import {
  type GraphEdge,
  type GraphNode,
  type RecallInput,
  recallInputSchema,
  type TextUnit,
} from "./contracts.js";
import { featureEnabled } from "./flags.js";
import type {
  GraphOperationContext,
  GraphStore,
  RecallAtom,
  RecallCitation,
  RecallResult,
  RecallTrace,
  RecallTraceEvent,
} from "./graphCore.js";
import { contentTerms } from "./queryNormalize.js";
import {
  createRecallRerankerFromEnv,
  mmrOrder,
  RERANK_MAX_CANDIDATES,
  rerankCandidates,
  type Reranker,
  toRerankCandidate,
} from "./rerank.js";
import { parseTemporalScope, temporalAffinity, type TemporalScope } from "./temporalScope.js";
import { observe, withTraceAttributes } from "./tracing.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function activationScore(node: GraphNode, nowMs: number): number {
  const recency = node.lastAccessedAt
    ? Math.exp(-Math.max(0, nowMs - Date.parse(node.lastAccessedAt)) / (1000 * 60 * 60 * 168))
    : 0;
  const frequency = Math.min(1, Math.log1p(node.accessCount) / Math.log(101));
  return 0.6 * recency + 0.4 * frequency;
}

/**
 * Weight of the parsed temporal scope in the candidate score. Sized to flip a
 * rank or two among otherwise comparable candidates — a note that was true in
 * the asked-about window beats its neighbour — without outweighing the lexical
 * match itself (0.35 at rank 0), because the parse is a heuristic.
 */
const TEMPORAL_SCOPE_WEIGHT = 0.25;
/** Candidates with no dated evidence either way sit between a hit and a miss. */
const TEMPORAL_NEUTRAL_AFFINITY = 0.5;

/** Query-side temporal scoping is on by default; set TROVE_TEMPORAL_SCOPE=0/off/false to fall back to present-day recall. */
export function temporalScopeEnabled(): boolean {
  return featureEnabled(process.env.TROVE_TEMPORAL_SCOPE);
}

/**
 * Reweight — never filter — the ranked candidates by how well each fits the
 * temporal scope parsed out of the query.
 *
 * Filtering was the tempting option and is the wrong one. The parse is
 * heuristic, world time in Trove lives on edges only, and a node carries
 * recorded time that says nothing about when its fact was true; a filter would
 * therefore drop the right note whenever the parse misfired or a fact simply
 * had no dated edge. That is the same class of silent wrongness that got asOf
 * removed from recall: a pack that looks coherent and is not. A boost can only
 * reorder what present-day recall already found, so the worst case is the
 * ranking recall would have produced anyway.
 *
 * The sort is stable and keyed on score alone, so every tie-break the caller's
 * comparator established survives.
 */
function rescoreForTemporalScope<T extends { node: GraphNode; score: number }>(
  scored: T[],
  scope: TemporalScope,
  edges: Iterable<GraphEdge>,
  now: Date,
): T[] {
  const incident = new Map<string, { validFrom: string | null; validUntil: string | null }[]>();
  for (const edge of edges) {
    const validity = { validFrom: edge.validFrom, validUntil: edge.validUntil };
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      const list = incident.get(nodeId);
      if (list) list.push(validity);
      else incident.set(nodeId, [validity]);
    }
  }
  return scored
    .map((candidate) => {
      const affinity = temporalAffinity(scope, {
        updatedAt: candidate.node.updatedAt,
        edges: incident.get(candidate.node.id) ?? [],
      }, now);
      return { ...candidate, score: candidate.score + TEMPORAL_SCOPE_WEIGHT * (affinity ?? TEMPORAL_NEUTRAL_AFFINITY) };
    })
    .sort((left, right) => right.score - left.score);
}

/** Cosine distance (0..2; lower = closer) → alignment in [0,1] (higher = closer). */
export function semanticAlignment(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

/** Vault-import stubs used to point at sources without storing the body. */
function isPlaceholderContent(content: string | null | undefined): boolean {
  if (!content) return true;
  return content.includes("The source document remains the evidence layer.");
}

/** Catalog/log-style pages are useful as pointers but starve the pack if dumped whole. */
const GIANT_CONTENT_CHARS = 12_000;
/**
 * Soft rank penalty for those pages, applied by BOTH ranking paths — the hand
 * blend and the reranked one. See the note at its second use for why a
 * relevance reranker cannot subsume it.
 */
const GIANT_RANK_PENALTY = 0.12;
function giantContentPenalty(node: GraphNode): number {
  return (node.content?.length ?? 0) > GIANT_CONTENT_CHARS ? GIANT_RANK_PENALTY : 0;
}
/**
 * Weights of the reranked score. Relevance dominates because that is the whole
 * point of paying for a second pass; activation is a prior, not a competitor.
 */
const RERANK_RELEVANCE_WEIGHT = 0.85;
const RERANK_ACTIVATION_WEIGHT = 0.15;
/** Body slice the diversity pass compares. See its use in performRecall. */
const MMR_TEXT_CHARS = 2_000;
/** Hard cap for giant pages in a pack (summary + opening). */
const GIANT_PACK_CHARS = 2_500;
/** Soft cap for a single non-giant hop-0 page so one match doesn't exhaust the budget. */
const PRIMARY_PACK_CHARS = 24_000;
/** The serialized recall response must stay within ~this multiple of the token budget. */
const WIRE_GUARD_RATIO = 1.5;
/** Conservative pre-estimate of an atom's JSON overhead (everything but its content slice). */
const ATOM_META_TOKENS = 140;
/** Reserve for the recall result envelope (keys, budget counters, flags). */
const ENVELOPE_RESERVE_TOKENS = 30;

/**
 * Render a node for the recall pack.
 * - Primary (hop 0) non-giant pages: full body up to remaining budget / soft cap
 *   so runbooks match Scribe depth.
 * - Giant pages (index, event log): summary + short opening only.
 * - Linked neighbors: short teaser.
 *
 * Returns the rendered context block plus the exact body slice the budgeter
 * chose, so the wire atom can carry that slice (never the untruncated body).
 */
function renderRecallAtom(
  node: GraphNode,
  hops: number,
  remainingTokens: number,
  options: { primaryMatch?: boolean; maxContentChars?: number; supersededByTitle?: string; agentInference?: boolean; space?: "mine" | "team" | undefined } = {},
): { block: string; body: string; contentTruncated: boolean } {
  const origin = hops === 0 ? "match" : "linked";
  const supersedeMark = options.supersededByTitle ? ` — SUPERSEDED by ${options.supersededByTitle}` : "";
  const inferenceMark = options.agentInference ? " — AGENT INFERENCE" : "";
  const spaceMark = options.space ? ` — ${options.space.toUpperCase()}` : "";
  const headerLines = [
    // The updated date anchors each atom in time: temporal questions ("what did
    // I buy 10 days ago?") are unanswerable from a dateless pack (bench finding —
    // the compare run's atoms carried no dates and temporal-reasoning scored 0%).
    `## ${node.title} [${node.type}/${origin}] (${node.slug}) — updated ${node.updatedAt.slice(0, 10)}${spaceMark}${supersedeMark}${inferenceMark}`,
    node.summary ?? "",
  ].filter(Boolean);
  const header = headerLines.join("\n") + "\n";
  const headerCost = estimateTokens(header);
  const budgetForContent = Math.max(0, remainingTokens - headerCost);

  let body = "";
  const raw = node.content ?? "";
  if (raw && !isPlaceholderContent(raw) && budgetForContent > 0) {
    const giant = raw.length > GIANT_CONTENT_CHARS;
    let maxChars: number;
    if (giant) {
      maxChars = Math.min(raw.length, GIANT_PACK_CHARS, budgetForContent * 4);
    } else if (options.primaryMatch) {
      // Primary lexical hits and fidelity-floor successors get a full-body
      // allocation. The latter preserves current truth without reranking.
      maxChars = Math.min(raw.length, PRIMARY_PACK_CHARS, budgetForContent * 4);
    } else if (hops > 0) {
      maxChars = Math.min(raw.length, 600, budgetForContent * 4);
    } else {
      // Other hop-0 hits: leave room for the primary page + neighbors.
      maxChars = Math.min(raw.length, 4_000, Math.floor(budgetForContent * 4 * 0.35));
    }
    if (options.maxContentChars !== undefined) {
      maxChars = Math.min(maxChars, Math.max(0, options.maxContentChars));
    }
    body = raw.slice(0, Math.max(0, maxChars));
  }

  const hasRealContent = Boolean(raw) && !isPlaceholderContent(raw);
  const contentTruncated = hasRealContent && body.length < raw.length;

  const displayBody = contentTruncated && body ? `${body}\n…` : body;
  const block = displayBody ? `${header}${displayBody}\n` : header;
  return { block, body, contentTruncated };
}

function renderRecallEvidence(unit: TextUnit, maxChars = 1200): string {
  const text = unit.text.length > maxChars ? `${unit.text.slice(0, maxChars)}\n…` : unit.text;
  return `> ${text} [source:${unit.sourceId}]\n`;
}

export async function performRecall(
  store: GraphStore,
  rawInput: RecallInput,
  context?: GraphOperationContext,
  options: { reranker?: Reranker | null; onTrace?: RecallTrace } = {},
): Promise<RecallResult> {
  const parsed = recallInputSchema.parse(rawInput);
  // A retriever, and the root of its own trace when an agent calls recall over
  // MCP; a child of `graph-chat` when the panel asked. Same subtree either way,
  // because nesting comes from context rather than from a flag passed in — one
  // instrumentation, both surfaces, and the query is comparable across them.
  return withTraceAttributes(
    {
      ...(context?.ownerId ? { userId: context.ownerId } : {}),
      tags: ["recall"],
    },
    () => observe("recall", {
      asType: "retriever",
      input: { query: parsed.query, tokenBudget: parsed.tokenBudget, depth: parsed.depth },
    }, async (retrieval) => {
      const pack = await performRecallInner(store, parsed, context, options);
      retrieval.update({
        output: {
          atoms: pack.atoms.map((atom) => ({ slug: atom.node.slug, score: atom.score, hops: atom.hops })),
        },
        metadata: {
          atoms: pack.atoms.length,
          spentTokens: pack.spentTokens,
          truncated: pack.truncated,
          ...(pack.temporalScope ? { temporalScope: pack.temporalScope.label } : {}),
        },
      });
      return pack;
    }),
  );
}

async function performRecallInner(
  store: GraphStore,
  // The PARSED input: defaults already applied, so the body keeps reading
  // `input.includeEvidence` as the boolean the schema guarantees.
  input: ReturnType<(typeof recallInputSchema)["parse"]>,
  context?: GraphOperationContext,
  options: { reranker?: Reranker | null; onTrace?: RecallTrace } = {},
): Promise<RecallResult> {
  // A watcher never breaks the thing it watches: recall must return the same
  // pack whether or not anyone is listening, so a throwing observer is
  // swallowed here rather than failing an interactive read.
  const emit = (event: RecallTraceEvent): void => {
    if (!options.onTrace) return;
    try {
      options.onTrace(event);
    } catch {
      // A trace consumer's problem is not recall's problem.
    }
  };
  // Temporal intent belongs in the question, not in a parameter: recall lost
  // asOf because it reached only the expansion, but "what did we deploy in
  // January" is still a question the graph can answer better than a present-
  // day pack. parseTemporalScope reads the date out of the query text and
  // returns nothing whenever the reading is ambiguous, so a query with no
  // temporal words takes exactly the path it took before.
  const temporal = temporalScopeEnabled()
    ? parseTemporalScope(input.query)
    : { scope: null, query: input.query };
  // The lexical arm ANDs every term: a month name that appears in no note
  // empties the result set, and it dilutes the query embedding besides. Search
  // sees the question without its date phrase; ranking below sees the date.
  const searchQuery = temporal.scope && contentTerms(temporal.query).length > 0
    ? temporal.query
    : input.query;
  const search = await store.search({
    query: searchQuery,
    ...(input.types ? { types: input.types } : {}),
    includeTextUnits: input.includeEvidence,
    mode: "hybrid",
    // The seed pool, not the pack size: the budgeter below decides how many of
    // these fit. At 10 the pack was silently narrower than search, and a
    // generous budget could never reach the eleventh hit.
    limit: 50,
    ...(input.maxSemanticDistance !== undefined ? { maxSemanticDistance: input.maxSemanticDistance } : {}),
  }, context, { onArm: (arm, nodes) => emit({ stage: "seeds", arm, nodes }) });
  emit({ stage: "fused", nodes: search.nodes });

  const nowMs = Date.now();
  type Candidate = {
    node: GraphNode;
    matchRank: number | null;
    hops: number;
    degree: number;
    distance: number | undefined;
  };
  const candidates = new Map<string, Candidate>();
  search.nodes.forEach((node, index) => {
    candidates.set(node.id, { node, matchRank: index, hops: 0, degree: 0, distance: node.distance });
  });

  const edgePool = new Map<string, GraphEdge>();
  if (input.depth > 0) {
    for (const seed of search.nodes.slice(0, 5)) {
      const expansion = await store.neighborhood({
        nodeId: seed.id,
        depth: input.depth,
        includeExpired: false,
      }, context);
      for (const edge of expansion.edges) edgePool.set(edge.id, edge);
      const reached: Array<{ node: GraphNode; hops: number }> = [];
      for (const node of expansion.nodes) {
        if (!candidates.has(node.id)) {
          // True BFS depth from the seed: depth-2 neighbors are hops 2.
          const hops = Math.max(1, node.level);
          candidates.set(node.id, {
            node,
            matchRank: null,
            hops,
            degree: 0,
            distance: undefined,
          });
          reached.push({ node, hops });
        }
      }
      // Only what this walk ADDED. A neighbor that was already a seed was not
      // reached by traversal, and a trace that claimed otherwise would light a
      // node for work the expansion did not do.
      if (options.onTrace) emit({ stage: "expanded", seedNodeId: seed.id, nodes: reached });
    }
  }

  for (const edge of edgePool.values()) {
    const from = candidates.get(edge.fromNodeId);
    if (from) from.degree += 1;
    const to = candidates.get(edge.toNodeId);
    if (to) to.degree += 1;
  }

  const maxDegree = Math.max(1, ...[...candidates.values()].map((candidate) => candidate.degree));
  const knownAlignments = [...candidates.values()]
    .filter((candidate) => candidate.distance !== undefined)
    .map((candidate) => semanticAlignment(candidate.distance as number));
  const neutralAlignment = knownAlignments.length
    ? knownAlignments.reduce((left, right) => left + right, 0) / knownAlignments.length
    : 0.5;
  // Prefer hop-0 (direct matches) over linked neighbors so budget goes to full pages.
  // Soft-penalize giant catalog/log pages so they don't outrank a specific runbook.
  const byScore = (left: Scored, right: Scored): number =>
    right.score - left.score ||
    left.hops - right.hops ||
    // Prefer more specific (shorter) pages when scores tie.
    (left.node.content?.length ?? 0) - (right.node.content?.length ?? 0) ||
    left.node.slug.localeCompare(right.node.slug);
  type Scored = Candidate & { score: number };
  const blended = [...candidates.values()]
    .map((candidate) => {
      const align = candidate.distance !== undefined
        ? semanticAlignment(candidate.distance)
        : neutralAlignment;
      return {
        ...candidate,
        score:
          (candidate.matchRank === null ? 0 : 0.35 / (1 + candidate.matchRank)) +
          0.30 * align +
          0.20 * activationScore(candidate.node, nowMs) +
          0.15 * (candidate.degree / maxDegree) +
          (candidate.hops === 0 ? 0.15 : 0) -
          giantContentPenalty(candidate.node),
      };
    })
    .sort(byScore);

  // Reranking (finding 08 / R5). The blend above is seven hand-set constants
  // nobody measured, and bench/FINDINGS.md prices them: Hit@K 100% against
  // precision 23.3%. It stays exactly as it is as the CANDIDATE GENERATOR —
  // RRF fusion plus expansion is cheap, recalls everything, and orders badly —
  // and a reranker reorders its head when one is configured.
  //
  // Head only, and the tail keeps its place behind it. Scores either side of
  // that boundary come from different scales and are deliberately not compared;
  // what packing consumes is the order, not the number.
  const reranker = options.reranker === undefined ? createRecallRerankerFromEnv() : options.reranker;
  const rerankHead = blended.slice(0, RERANK_MAX_CANDIDATES);
  const rerankScores = await rerankCandidates(reranker, {
    query: input.query,
    candidates: rerankHead.map((candidate) => toRerankCandidate(candidate.node)),
  });
  let scored: Scored[] = rerankScores
    ? [
      ...rerankHead
        .map((candidate) => ({
          ...candidate,
          // Two terms, not seven. The reranker already weighs everything match
          // rank, alignment, degree and the hop bonus were proxies for — it
          // reads the candidate against the query instead of guessing from its
          // position in a fused list — so those four go. Two survive:
          //
          // - activation, because it is the one thing a cross-encoder cannot
          //   know: which atoms THIS owner actually works from. Small on
          //   purpose. It breaks ties; it does not overturn relevance.
          // - the giant penalty, because it is not a relevance signal at all.
          //   It is a budget-shape signal: a 12k-char catalog page can be the
          //   most relevant hit and still be the wrong thing to spend a pack
          //   on, and renderRecallAtom truncates it to 2.5k anyway. The
          //   reranker is asked about relevance and answers about relevance,
          //   so it cannot subsume this.
          score:
            RERANK_RELEVANCE_WEIGHT * (rerankScores.get(candidate.node.id) ?? 0) +
            RERANK_ACTIVATION_WEIGHT * activationScore(candidate.node, nowMs) -
            giantContentPenalty(candidate.node),
        }))
        .sort(byScore),
      ...blended.slice(RERANK_MAX_CANDIDATES),
    ]
    : blended;
  // Diversity, over the reranked head only. A reranker is a relevance function
  // and nothing more: shown four restatements of the one fact that answers the
  // query, it scores all four at the top and they take the whole pack, so the
  // budget buys one fact instead of four. MMR spends the slots after the first
  // on atoms that add something. Deliberately not applied to the hand blend —
  // with the flag off, recall is what it was.
  if (rerankScores) {
    const head = mmrOrder(scored.slice(0, RERANK_MAX_CANDIDATES), {
      score: (candidate) => candidate.score,
      // Redundancy is judged on the same text the reader would see. The body
      // slice is bounded for the same reason the reranker's is: term extraction
      // should cost the same on a runbook and on an event log.
      text: (candidate) => [
        candidate.node.title,
        candidate.node.summary ?? "",
        (candidate.node.content ?? "").slice(0, MMR_TEXT_CHARS),
      ].filter(Boolean).join("\n"),
    });
    scored.splice(0, head.length, ...head);
  }

  // Temporal reweight last, so it applies to whichever ranking produced the
  // order above: it is a preference about WHEN a fact was true, orthogonal to
  // how relevant the ranker thinks it is.
  if (temporal.scope) scored = rescoreForTemporalScope(scored, temporal.scope, edgePool.values(), new Date(nowMs));

  // The order everything downstream consumes. Emitted before packing, which is
  // itself several round trips (supersession, batched evidence) — a watcher
  // sees ranking land and then waits for the pack, exactly as recall does.
  if (options.onTrace) {
    emit({
      stage: "ranked",
      reranked: Boolean(rerankScores),
      nodes: scored.map((candidate) => ({ node: candidate.node, score: candidate.score, hops: candidate.hops })),
    });
  }

  // The header names the scope so the pack itself says which time it answers
  // about; an agent reading only the context text can then say "as of January".
  const header = `Recall: ${input.query}\n${temporal.scope
    ? `Temporal scope: ${temporal.scope.label} — ranked toward facts true then; use read/neighborhood asOf for exact history.\n`
    : ""}`;
  let spentTokens = estimateTokens(header);
  let truncated = false;
  const contextParts = [header];
  const atoms: RecallAtom[] = [];
  const citations: RecallCitation[] = [];
  const citationKeys = new Set<string>();
  const packedNodeIds = new Set<string>();
  const packedEvidenceIds = new Set<string>();
  const evidence: TextUnit[] = [];

  const addCitation = (citation: RecallCitation): void => {
    const key = `${citation.nodeId}:${citation.sourceId}:${citation.textUnitId}`;
    if (citationKeys.has(key)) return;
    citationKeys.add(key);
    citations.push(citation);
  };

  const pushEvidence = (unit: TextUnit): void => {
    if (evidence.some((existing) => existing.id === unit.id)) return;
    evidence.push(unit);
  };

  // The wire budget (~1.5× tokenBudget) covers the WHOLE serialized response,
  // not just the rendered context. A packed body is carried twice on the wire
  // — rendered inside context and structured inside the atom — so each packed
  // content char costs double. Atoms degrade to header-only when the wire is
  // nearly full; the backstop guard below handles edges/citations slack.
  const wireLimit = Math.ceil(input.tokenBudget * WIRE_GUARD_RATIO);
  // Response tokens beyond context: atom/evidence/edge JSON, plus a small
  // reserve for the result envelope. Atoms are charged exactly (stringified);
  // each packed atom also pays for the edges it newly closes in the result.
  let wireExtras = ENVELOPE_RESERVE_TOKENS;

  const marginalEdgeTokens = (nodeId: string): number => {
    let tokens = 0;
    for (const edge of edgePool.values()) {
      const touches = edge.fromNodeId === nodeId || edge.toNodeId === nodeId;
      const otherEnd = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      if (touches && packedNodeIds.has(otherEnd)) tokens += estimateTokens(JSON.stringify(edge));
    }
    return tokens;
  };

  // Two-pass packing: first the best non-giant hop-0 match (full body), then the rest.
  const primary = scored.find(
    (candidate) =>
      candidate.hops === 0 &&
      candidate.matchRank !== null &&
      (candidate.node.content?.length ?? 0) <= GIANT_CONTENT_CHARS &&
      !isPlaceholderContent(candidate.node.content),
  ) ?? scored.find((candidate) => candidate.hops === 0 && candidate.matchRank === 0);
  const ordered = primary
    ? [primary, ...scored.filter((candidate) => candidate.node.id !== primary.node.id)]
    : scored;

  // A node a newer fact supersedes is marked in its header, so the reader
  // prefers the successor instead of weighing two co-equal "truths".
  const superseded = await store.supersededBy(ordered.map((candidate) => candidate.node.id), context);
  const teamIds = context?.sharedOwnerIds?.length && store.teamNoteIds
    ? await store.teamNoteIds(ordered.map((candidate) => candidate.node.id), context)
    : null;
  const spaceOf = (nodeId: string): "mine" | "team" | undefined => (teamIds ? (teamIds.has(nodeId) ? "team" : "mine") : undefined);
  // Supersession is annotation-first, not a ranking signal. Preserve `ordered`
  // exactly, but transfer body fidelity toward an in-pack successor: a stale
  // atom gets at most a linked-note teaser, while its successor is eligible
  // for the full-body slot even when graph traversal found it at hops > 0.
  const candidateIds = new Set(ordered.map((candidate) => candidate.node.id));
  const fidelityFloorSuccessorIds = new Set(
    [...superseded.values()]
      .map((entry) => entry.byNodeId)
      .filter((nodeId) => candidateIds.has(nodeId)),
  );
  // Provenance is part of every atom even when the caller omits evidence from
  // the wire response. One batched lookup keeps the mark resolvable without
  // introducing a per-node read.
  const evidenceByNode = ordered.length > 0
    ? await store.getEvidenceForNodes(
      ordered.map((candidate) => candidate.node.id),
      context,
      { query: input.query, perNodeLimit: 5 },
    )
    : new Map<string, TextUnit[]>();
  const evidenceNodeIds = ordered.length > 0
    ? await store.evidenceNodeIds(ordered.map((candidate) => candidate.node.id), context)
    : new Set<string>();
  const contextIndexByNodeId = new Map<string, number>();
  const candidateByNodeId = new Map(ordered.map((candidate) => [candidate.node.id, candidate]));

  // Phase 1: pack atom bodies/teasers for every candidate in rank order. No
  // per-node store.read — candidates from search/expansion already carry
  // current content, and internal reads must not bump access activation.
  for (const candidate of ordered) {
    const remaining = input.tokenBudget - spentTokens;
    // Need room for at least a title + summary.
    if (remaining < 40) {
      truncated = true;
      break;
    }
    const hasInPackSuccessor = superseded.has(candidate.node.id);
    const isPrimary =
      (primary?.node.id === candidate.node.id && !hasInPackSuccessor) ||
      fidelityFloorSuccessorIds.has(candidate.node.id);
    const headerEstimate = estimateTokens(`${candidate.node.title}\n${candidate.node.summary ?? ""}`) + 4;
    const contentRoomTokens = Math.max(0, Math.floor(
      (wireLimit - spentTokens - wireExtras - headerEstimate - ATOM_META_TOKENS) / 2,
    ));
    const edgeTokens = marginalEdgeTokens(candidate.node.id);

    let packed = false;
    // First try the slice the wire room allows; on overflow degrade to
    // header-only before skipping the candidate entirely.
    const contentCap = hasInPackSuccessor
      ? Math.min(contentRoomTokens * 4, 600)
      : contentRoomTokens * 4;
    for (const maxContentChars of [contentCap, 0]) {
      const supersededByTitle = superseded.get(candidate.node.id)?.byTitle;
      const provenance: RecallAtom["provenance"] =
        evidenceNodeIds.has(candidate.node.id) ? "citation" : "agent_inference";
      const rendered = renderRecallAtom(candidate.node, candidate.hops, remaining, {
        primaryMatch: isPrimary,
        maxContentChars,
        ...(supersededByTitle ? { supersededByTitle } : {}),
        ...(provenance === "agent_inference" ? { agentInference: true } : {}),
        space: spaceOf(candidate.node.id),
      });
      const atom: RecallAtom = {
        // The wire atom carries the packed slice the budgeter chose, never the
        // untruncated body; contentTruncated says whether more exists via read.
        node: { ...candidate.node, content: rendered.body },
        provenance,
        score: candidate.score,
        hops: candidate.hops,
        tokens: estimateTokens(rendered.block),
        contentTruncated: rendered.contentTruncated,
        ...(spaceOf(candidate.node.id) ? { space: spaceOf(candidate.node.id)! } : {}),
      };
      const blockCost = estimateTokens(rendered.block);
      const extra = estimateTokens(JSON.stringify(atom)) + edgeTokens;
      if (spentTokens + blockCost <= input.tokenBudget && spentTokens + blockCost + wireExtras + extra <= wireLimit) {
        spentTokens += blockCost;
        wireExtras += extra;
        contextIndexByNodeId.set(candidate.node.id, contextParts.length);
        contextParts.push(rendered.block);
        packedNodeIds.add(candidate.node.id);
        atoms.push(atom);
        packed = true;
        break;
      }
    }
    if (!packed) truncated = true;
  }

  // Annotation-first supersession still needs a real fidelity floor. Packing
  // order and rank remain untouched; if both versions made the pack, trim the
  // stale body's achieved fraction to no more than the successor's fraction.
  // This can only return budget, never consume more or promote either atom.
  // Iterate to a fixed point so A→B→C chains are independent of edge/map
  // insertion order. Every change only shortens a stale body, so at most one
  // propagation per packed atom is needed.
  for (let pass = 0; pass < atoms.length; pass += 1) {
    let changed = false;
    for (const [staleNodeId, successor] of superseded) {
      const staleIndex = atoms.findIndex((atom) => atom.node.id === staleNodeId);
      const successorIndex = atoms.findIndex((atom) => atom.node.id === successor.byNodeId);
      if (staleIndex < 0 || successorIndex < 0) continue;

      const staleCandidate = candidateByNodeId.get(staleNodeId);
      const successorCandidate = candidateByNodeId.get(successor.byNodeId);
      if (!staleCandidate || !successorCandidate) continue;
      const staleContent = staleCandidate.node.content ?? "";
      const successorContent = successorCandidate.node.content ?? "";
      const staleFullLength = isPlaceholderContent(staleContent)
        ? 0
        : staleContent.length;
      const successorFullLength = isPlaceholderContent(successorContent)
        ? 0
        : successorContent.length;
      const staleAtom = atoms[staleIndex];
      const successorAtom = atoms[successorIndex];
      if (!staleAtom || !successorAtom) continue;
      const staleFidelity = staleFullLength === 0 ? 1 : (staleAtom.node.content?.length ?? 0) / staleFullLength;
      const successorFidelity =
        successorFullLength === 0 ? 1 : (successorAtom.node.content?.length ?? 0) / successorFullLength;
      if (staleFidelity <= successorFidelity) continue;

      const oldAtom = staleAtom;
      const maxContentChars = Math.floor(staleFullLength * successorFidelity);
      const rendered = renderRecallAtom(staleCandidate.node, staleCandidate.hops, input.tokenBudget, {
        maxContentChars,
        supersededByTitle: successor.byTitle,
        ...(oldAtom.provenance === "agent_inference" ? { agentInference: true } : {}),
        space: oldAtom.space,
      });
      const replacement: RecallAtom = {
        ...oldAtom,
        node: { ...oldAtom.node, content: rendered.body },
        tokens: estimateTokens(rendered.block),
        contentTruncated: rendered.contentTruncated,
      };
      spentTokens += replacement.tokens - oldAtom.tokens;
      wireExtras += estimateTokens(JSON.stringify(replacement)) - estimateTokens(JSON.stringify(oldAtom));
      atoms[staleIndex] = replacement;
      const contextIndex = contextIndexByNodeId.get(staleNodeId);
      if (contextIndex !== undefined) contextParts[contextIndex] = rendered.block;
      truncated = truncated || rendered.contentTruncated;
      changed = true;
    }
    if (!changed) break;
  }

  // Phase 2: evidence, only after every atom had its body/teaser allocation —
  // one node's citations can no longer crowd out other atoms' bodies. A single
  // batched evidence fetch covers all packed hop-0 nodes (query-ranked, ≤5
  // units per node), followed by leftover search-hit units.
  const tryPackEvidence = (unit: TextUnit, citation: RecallCitation, maxChars = 1200): boolean => {
    const block = renderRecallEvidence(unit, maxChars);
    const blockCost = estimateTokens(block);
    const extra = estimateTokens(JSON.stringify(unit)) + estimateTokens(JSON.stringify(citation));
    if (spentTokens + blockCost > input.tokenBudget || spentTokens + blockCost + wireExtras + extra > wireLimit) {
      truncated = true;
      return false;
    }
    spentTokens += blockCost;
    wireExtras += extra;
    contextParts.push(block);
    packedEvidenceIds.add(unit.id);
    pushEvidence(unit);
    addCitation(citation);
    return true;
  };

  if (input.includeEvidence) {
    for (const candidate of ordered) {
      if (!packedNodeIds.has(candidate.node.id)) continue;
      for (const item of evidenceByNode.get(candidate.node.id) ?? []) {
        if (packedEvidenceIds.has(item.id)) continue;
        const text = item.text.trim();
        if (!text || text === "---") continue;
        if (!tryPackEvidence(item, { nodeId: candidate.node.id, sourceId: item.sourceId, textUnitId: item.id }, 2000)) break;
      }
    }

    for (const unit of search.textUnits) {
      if (packedEvidenceIds.has(unit.id)) continue;
      const text = unit.text.trim();
      if (!text || text === "---") continue;
      if (!tryPackEvidence(unit, { nodeId: null, sourceId: unit.sourceId, textUnitId: unit.id })) break;
    }
  }

  const edges = [...edgePool.values()].filter(
    (edge) => packedNodeIds.has(edge.fromNodeId) && packedNodeIds.has(edge.toNodeId),
  );

  const result: RecallResult = {
    context: contextParts.join("\n").trimEnd(),
    atoms,
    edges,
    evidence,
    citations,
    tokenBudget: input.tokenBudget,
    spentTokens,
    truncated,
    ...(temporal.scope
      ? { temporalScope: { ...temporal.scope, applied: "reweight" as const, searchQuery } }
      : {}),
  };
  enforceRecallWireBudget(result);
  // Provenance guard (backlog #9b): only the evidence that survived EVERY cut
  // counts as served — units fetched but dropped by the budget or the wire
  // guard were never shown, and a later citation of them was never "given" to
  // the agent. Marking runs after enforceRecallWireBudget for exactly that.
  if (result.evidence.length > 0) {
    await store.markTextUnitsServed(result.evidence.map((unit) => unit.id), context);
  }
  return result;
}

/**
 * Final wire guard: the token budget covers the whole serialized response,
 * not just the rendered context. Keep the payload within ~1.5× the budget by
 * shrinking neighbor teasers first, then dropping the least-relevant evidence
 * (query-ranked order puts it at the tail). The primary match is never cut.
 */
function enforceRecallWireBudget(result: RecallResult): void {
  const limit = Math.ceil(result.tokenBudget * WIRE_GUARD_RATIO);
  if (estimateTokens(JSON.stringify(result)) <= limit) return;

  result.truncated = true;
  const fidelityFloorSuccessorIds = new Set(
    result.edges
      .filter((edge) => edge.predicate === "supersedes")
      .map((edge) => edge.fromNodeId),
  );
  for (const atom of result.atoms) {
    if (atom.hops === 0 || fidelityFloorSuccessorIds.has(atom.node.id)) continue;
    const content = atom.node.content ?? "";
    if (content.length > 240) {
      atom.node.content = `${content.slice(0, 240)}\n…`;
      atom.contentTruncated = true;
    }
  }
  if (estimateTokens(JSON.stringify(result)) <= limit) return;

  while (result.evidence.length > 0 && estimateTokens(JSON.stringify(result)) > limit) {
    const dropped = result.evidence.pop();
    if (dropped) {
      result.citations = result.citations.filter((citation) => citation.textUnitId !== dropped.id);
    }
  }
}
