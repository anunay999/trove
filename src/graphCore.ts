import { createHash, randomUUID } from "node:crypto";
import { recallInputSchema } from "./contracts.js";
import { contentTerms } from "./queryNormalize.js";
import type {
  AnnotateInput,
  CaptureInput,
  CreateViewInput,
  DeleteViewInput,
  EnqueueJobInput,
  EventFeedInput,
  GrepInput,
  GraphAnnotation,
  GraphEdge,
  GraphJobKind,
  GraphJobStatus,
  GraphNode,
  GraphSource,
  GraphView,
  IngestInput,
  InvalidateEdgeInput,
  LinkInput,
  ListJobsInput,
  ListViewsInput,
  NeighborhoodInput,
  ProjectInput,
  ReadViewInput,
  ReadInput,
  RecallInput,
  RunJobInput,
  SearchInput,
  TextUnit,
  UpdateInput,
} from "./contracts.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Thrown by both store drivers when an annotation references a source, text
 * unit, or node that does not exist (Postgres surfaces it as FK violation
 * 23503; the in-memory driver checks explicitly). Callers — remember above
 * all — must be able to tell "this citation is bogus" apart from real
 * failures, so the distinction is a named error, never a swallowed catch.
 */
export class UnknownEvidenceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownEvidenceReferenceError";
  }
}

/**
 * Provenance quality (backlog #17): does the cited span actually support the
 * atom? Scored as containment — the share of the node's content terms that
 * appear in its best-matching cited unit. An atom is a distillation of its
 * evidence, so most of its terms should come from the source text; a best
 * score below WEAK_EVIDENCE_FLOOR means the citation is present but probably
 * wrong. Heuristic, not entailment: paraphrases can score low honestly, which
 * is why the lint finding is a warning for review, never an error.
 */
export const WEAK_EVIDENCE_FLOOR = 0.15;

export function evidenceSupportScore(nodeText: string, unitTexts: string[]): number {
  const nodeTerms = new Set(contentTerms(nodeText));
  if (nodeTerms.size === 0) return 1; // nothing to support — don't flag
  let best = 0;
  for (const text of unitTexts) {
    const unitTerms = new Set(contentTerms(text));
    let shared = 0;
    for (const term of nodeTerms) if (unitTerms.has(term)) shared += 1;
    best = Math.max(best, shared / nodeTerms.size);
  }
  return best;
}

export type GraphEvent = {
  id: string;
  action: string;
  entityTable: string;
  entityId: string;
  actorId: string | null;
  actorHandle: string | null;
  interfaceId: string | null;
  requestId: string | null;
  createdAt: string;
};

export type GraphEventFeed = {
  events: GraphEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Row counts for the two owner types the embedding backfill touches.
 *
 * `GraphJob.result` is an untyped `Record<string, unknown>`, so producer and
 * consumer were never checked against each other — that is how `Number(object)`
 * -> NaN compiled silently and stalled the drain loop. Anything reading a
 * refresh_embeddings result should narrow through these types rather than
 * re-deriving the shape.
 */
export type EmbeddingCounts = { nodeRevisions: number; textUnits: number };

export type RefreshEmbeddingsResult =
  | { status: "refreshed"; ownerId: string | null; missingBefore: EmbeddingCounts; embedded: EmbeddingCounts; provider: string; model: string }
  | { status: "skipped_no_embedding_provider"; ownerId: string | null; missing: EmbeddingCounts; provider: string; model: string };

export type GraphJob = {
  id: string;
  kind: GraphJobKind;
  status: GraphJobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  dedupeKey: string | null;
  /**
   * Set only on the job returned by an enqueue that JOINED an existing
   * pending/running row with the same dedupe key — never stored, never set on
   * a freshly created row. Callers can therefore tell "my enqueue created
   * work" from "my enqueue was absorbed" (backlog #7: absorption is correct
   * for genuinely global maintenance, but it must be observable).
   */
  dedupeJoined?: boolean;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type GraphOperationContext = {
  actorId?: string;
  interfaceId?: string;
  requestId?: string;
  /** app_user.id this operation reads/writes as. Absent → see-all (superuser). */
  ownerId?: string | undefined;
  /** Bypass owner scoping entirely (auth-disabled local/CI, maintenance jobs). */
  superuser?: boolean | undefined;
};

/**
 * Resolve the owner scope for a store operation.
 * - `scoped: false` — no owner filter (superuser, or no context supplied, e.g.
 *   maintenance jobs and internal callers). Writes stamp owner_id = NULL.
 * - `scoped: true` — reads filter by `ownerId`; a scoped-but-null owner matches
 *   nothing, so an authed request that failed to resolve an owner fails closed.
 */
export type OwnerScope = { scoped: boolean; ownerId: string | null };

export function ownerScope(context?: GraphOperationContext): OwnerScope {
  // Scoping requires an explicit owner. No context, superuser, or a context
  // without an ownerId (internal/maintenance callers) all see the whole graph.
  // Every authenticated user credential carries an ownerId, so real requests
  // are always scoped; only trusted operator/internal paths reach see-all.
  if (!context || context.superuser || !context.ownerId) return { scoped: false, ownerId: null };
  return { scoped: true, ownerId: context.ownerId };
}

export type GraphSourceOverview = GraphSource & {
  metadata: Record<string, unknown>;
};

export type GraphSourceDocument = GraphSource & {
  metadata: Record<string, unknown>;
  contentText: string;
};

export type GraphDocument = {
  uri: string;
  title: string;
  contentText: string;
  segmentCount: number;
};

export type LogicalSegment = {
  ordinal: number;
  heading: string | null;
  date: string | null;
  text: string;
};

export type LogicalSplit = {
  mode: "dated" | "sectional";
  segments: LogicalSegment[];
};

export type ReadResult = GraphNode & {
  evidence: Array<TextUnit | GraphSource>;
  annotations: GraphAnnotation[];
};

export type SearchResult = {
  nodes: GraphNode[];
  textUnits: TextUnit[];
};

/** A neighborhood node carries its true BFS depth from the seed (seed = 0). */
export type NeighborhoodNode = GraphNode & { level: number };

export type NeighborhoodResult = {
  nodes: NeighborhoodNode[];
  edges: GraphEdge[];
};

export type GrepMatch = {
  kind: "node" | "source";
  nodeId?: string;
  slug?: string;
  sourceId?: string;
  textUnitId?: string;
  ordinal?: number;
  title: string;
  field: "title" | "summary" | "content" | "text";
  excerpt: string;
};

export type GrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
};

/** Compile a grep pattern; invalid regex degrades to a literal substring match. */
export function compileGrepPattern(pattern: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "" : "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

export function grepExcerpt(text: string, regex: RegExp, radius = 120): string | null {
  const match = regex.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  views?: GraphView[];
};

export type GraphViewSnapshot = GraphView & {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphLintFinding = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  entityId?: string;
  entityTable?: string;
  count?: number;
};

export type GraphLintReport = {
  generatedAt: string;
  summary: {
    nodes: number;
    edges: number;
    findings: number;
    errors: number;
    warnings: number;
  };
  findings: GraphLintFinding[];
};

export type RecallAtom = {
  node: GraphNode;
  score: number;
  hops: number;
  tokens: number;
  /** True when atom.node.content is a packed slice of the note body, not the full body. */
  contentTruncated: boolean;
};

export type RecallCitation = {
  nodeId: string | null;
  sourceId: string | null;
  textUnitId: string | null;
};

export type RecallResult = {
  context: string;
  atoms: RecallAtom[];
  edges: GraphEdge[];
  evidence: TextUnit[];
  citations: RecallCitation[];
  tokenBudget: number;
  spentTokens: number;
  truncated: boolean;
};

export type ProjectResult =
  | { format: "markdown"; content: string }
  | { format: "mind_map"; nodes: GraphNode[]; edges: GraphEdge[] }
  | { format: "agent_context"; context: string; evidence: TextUnit[] };

export type GraphStore = {
  ingest(input: IngestInput, context?: GraphOperationContext): MaybePromise<{ source: GraphSource; textUnits: TextUnit[] }>;
  sources(input?: { limit?: number }, context?: GraphOperationContext): MaybePromise<GraphSourceOverview[]>;
  readSource(input: { sourceId: string }, context?: GraphOperationContext): MaybePromise<GraphSourceDocument | null>;
  readDocument(input: { uri: string }, context?: GraphOperationContext): MaybePromise<GraphDocument | null>;
  search(input: SearchInput, context?: GraphOperationContext): MaybePromise<SearchResult>;
  grep(input: GrepInput, context?: GraphOperationContext): MaybePromise<GrepResult>;
  /**
   * Read a node with its evidence and annotations. By default bumps access
   * activation (accessCount/lastAccessedAt); pass `{ trackAccess: false }` for
   * internal reads (dedupe, recall packing) that must not perturb activation.
   */
  read(input: ReadInput, context?: GraphOperationContext, opts?: { trackAccess?: boolean }): MaybePromise<ReadResult | null>;
  neighborhood(input: NeighborhoodInput, context?: GraphOperationContext): MaybePromise<NeighborhoodResult>;
  /**
   * Soft-delete nodes (set deleted_at), expire their incident edges, prune
   * revision embeddings, and emit events. Idempotent and owner-scoped.
   */
  tombstoneNodes(ids: string[], context?: GraphOperationContext): MaybePromise<{ tombstoned: string[] }>;
  /**
   * Trigram/Jaccard title similarity over ACTIVE nodes. Scores are > 0.25;
   * an exact normalized-title match scores 1.0.
   */
  findSimilarTitles(title: string, limit: number, context?: GraphOperationContext): MaybePromise<Array<{ node: GraphNode; score: number }>>;
  /**
   * Batched evidence fetch for many nodes in one query. When `query` is given,
   * units are ranked by full-text relevance to it; at most `perNodeLimit`
   * (default 5) units per node.
   */
  getEvidenceForNodes(nodeIds: string[], context?: GraphOperationContext, opts?: { query?: string; perNodeLimit?: number }): MaybePromise<Map<string, TextUnit[]>>;
  /**
   * Active `supersedes` edges pointing AT the given nodes — i.e. which of them
   * a newer node has replaced. Recall uses it to mark superseded atoms so an
   * agent prefers the successor instead of reading two co-equal "truths".
   */
  supersededBy(nodeIds: string[], context?: GraphOperationContext): MaybePromise<Map<string, { byNodeId: string; byTitle: string }>>;
  recall(input: RecallInput, context?: GraphOperationContext): MaybePromise<RecallResult>;
  link(input: LinkInput, context?: GraphOperationContext): MaybePromise<GraphEdge | null>;
  invalidateEdge(input: InvalidateEdgeInput, context?: GraphOperationContext): MaybePromise<GraphEdge | null>;
  capture(input: CaptureInput, context?: GraphOperationContext): MaybePromise<GraphNode>;
  annotate(input: AnnotateInput, context?: GraphOperationContext): MaybePromise<GraphAnnotation>;
  update(input: UpdateInput, context?: GraphOperationContext): MaybePromise<GraphNode | { conflict: true; currentRevisionId: string } | null>;
  project(input: ProjectInput, context?: GraphOperationContext): MaybePromise<ProjectResult | null>;
  timeline(context?: GraphOperationContext): MaybePromise<GraphEvent[]>;
  events(input?: EventFeedInput, context?: GraphOperationContext): MaybePromise<GraphEventFeed>;
  lint(context?: GraphOperationContext): MaybePromise<GraphLintReport>;
  createView(input: CreateViewInput, context?: GraphOperationContext): MaybePromise<GraphViewSnapshot>;
  views(input?: ListViewsInput, context?: GraphOperationContext): MaybePromise<GraphView[]>;
  readView(input: ReadViewInput, context?: GraphOperationContext): MaybePromise<GraphViewSnapshot | null>;
  deleteView(input: DeleteViewInput, context?: GraphOperationContext): MaybePromise<{ deleted: boolean; view: GraphView | null }>;
  exportMarkdown(context?: GraphOperationContext): MaybePromise<Record<string, string>>;
  exportGraph(context?: GraphOperationContext): MaybePromise<GraphSnapshot>;
  enqueueJob(input: EnqueueJobInput, context?: GraphOperationContext): MaybePromise<GraphJob>;
  jobs(input?: ListJobsInput): MaybePromise<GraphJob[]>;
  runJob(input?: RunJobInput, context?: GraphOperationContext): MaybePromise<GraphJob | null>;
  health(): MaybePromise<{ ok: true }>;
};

const DATED_HEADING = /^## \[?(\d{4}-\d{2}-\d{2})/;

// Append-heavy files (event logs) and registries (index.md) should not be
// re-snapshotted wholesale on every import. Split them into logical segments
// so the (kind, content_sha256) upsert dedupes unchanged segments and growth
// becomes O(new entries) instead of O(file size x versions).
export function splitLogicalSegments(contentText: string, relPath: string): LogicalSplit | null {
  const lines = contentText.split("\n");
  const segments: LogicalSegment[] = [];
  let current: string[] = [];
  let currentHeading: string | null = null;

  const push = () => {
    const text = current.join("\n").trim();
    if (text.length > 0) {
      const date = currentHeading ? DATED_HEADING.exec(currentHeading)?.[1] ?? null : null;
      segments.push({ ordinal: segments.length, heading: currentHeading, date, text });
    }
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      push();
      currentHeading = line;
    }
    current.push(line);
  }
  push();

  const datedCount = segments.filter((segment) => segment.date !== null).length;
  if (datedCount >= 3) {
    return { mode: "dated", segments };
  }

  const fileName = relPath.split("/").at(-1) ?? relPath;
  if (fileName.toLowerCase() === "index.md" && segments.length >= 2) {
    return { mode: "sectional", segments };
  }
  return null;
}

export type EpisodicIngestResult = {
  episodic: boolean;
  newSegments: number;
  totalSegments: number;
  results: Array<{ source: GraphSource; textUnits: TextUnit[] }>;
};

export async function ingestEpisodic(
  store: GraphStore,
  input: {
    kind: IngestInput["kind"];
    title: string;
    uri: string;
    relPath: string;
    contentText: string;
    metadata?: Record<string, unknown>;
  },
  context?: GraphOperationContext,
): Promise<EpisodicIngestResult> {
  const split = splitLogicalSegments(input.contentText, input.relPath);
  if (!split) {
    const result = await store.ingest({
      kind: input.kind,
      title: input.title,
      uri: input.uri,
      contentText: input.contentText,
      metadata: { ...input.metadata, relPath: input.relPath },
    }, context);
    return { episodic: false, newSegments: 1, totalSegments: 1, results: [result] };
  }

  const existing = await store.sources({ limit: 10000 }, context);
  const knownHashes = new Set(existing.map((row) => `${row.kind}:${row.contentSha256}`));

  let newSegments = 0;
  const results: EpisodicIngestResult["results"] = [];
  for (const segment of split.segments) {
    if (!knownHashes.has(`${input.kind}:${sha256(segment.text)}`)) {
      newSegments += 1;
    }
    const label = segment.heading?.replace(/^##\s*/, "").slice(0, 120) ?? `intro`;
    const result = await store.ingest({
      kind: input.kind,
      title: `${input.title} · ${label}`,
      uri: `${input.uri}#${segment.ordinal}`,
      contentText: segment.text,
      metadata: {
        ...input.metadata,
        relPath: input.relPath,
        episodeOf: input.uri,
        episodeOrdinal: segment.ordinal,
        entryDate: segment.date,
        mode: split.mode,
      },
    }, context);
    results.push(result);
  }
  return { episodic: true, newSegments, totalSegments: split.segments.length, results };
}

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

/** Vault-import stubs used to point at sources without storing the body. */
function isPlaceholderContent(content: string | null | undefined): boolean {
  if (!content) return true;
  return content.includes("The source document remains the evidence layer.");
}

/** Catalog/log-style pages are useful as pointers but starve the pack if dumped whole. */
const GIANT_CONTENT_CHARS = 12_000;
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
  options: { primaryMatch?: boolean; maxContentChars?: number; supersededByTitle?: string } = {},
): { block: string; body: string; contentTruncated: boolean } {
  const origin = hops === 0 ? "match" : "linked";
  const supersedeMark = options.supersededByTitle ? ` — SUPERSEDED by ${options.supersededByTitle}` : "";
  const headerLines = [
    // The updated date anchors each atom in time: temporal questions ("what did
    // I buy 10 days ago?") are unanswerable from a dateless pack (bench finding —
    // the compare run's atoms carried no dates and temporal-reasoning scored 0%).
    `## ${node.title} [${node.type}/${origin}] (${node.slug}) — updated ${node.updatedAt.slice(0, 10)}${supersedeMark}`,
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
    if (hops > 0) {
      maxChars = Math.min(raw.length, 600, budgetForContent * 4);
    } else if (giant) {
      maxChars = Math.min(raw.length, GIANT_PACK_CHARS, budgetForContent * 4);
    } else if (options.primaryMatch) {
      // Best lexical hit: pack as much as budget allows (Scribe-depth runbook).
      maxChars = Math.min(raw.length, PRIMARY_PACK_CHARS, budgetForContent * 4);
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

export async function performRecall(store: GraphStore, rawInput: RecallInput, context?: GraphOperationContext): Promise<RecallResult> {
  const input = recallInputSchema.parse(rawInput);
  const search = await store.search({
    query: input.query,
    ...(input.types ? { types: input.types } : {}),
    includeTextUnits: input.includeEvidence,
    mode: "hybrid",
    limit: 10,
    ...(input.maxSemanticDistance !== undefined ? { maxSemanticDistance: input.maxSemanticDistance } : {}),
  }, context);

  const nowMs = Date.now();
  type Candidate = { node: GraphNode; matchRank: number | null; hops: number; degree: number };
  const candidates = new Map<string, Candidate>();
  search.nodes.forEach((node, index) => {
    candidates.set(node.id, { node, matchRank: index, hops: 0, degree: 0 });
  });

  const edgePool = new Map<string, GraphEdge>();
  if (input.depth > 0) {
    for (const seed of search.nodes.slice(0, 5)) {
      const expansion = await store.neighborhood({
        nodeId: seed.id,
        depth: input.depth,
        includeExpired: false,
        ...(input.asOf ? { asOf: input.asOf } : {}),
      }, context);
      for (const edge of expansion.edges) edgePool.set(edge.id, edge);
      for (const node of expansion.nodes) {
        if (!candidates.has(node.id)) {
          // True BFS depth from the seed: depth-2 neighbors are hops 2.
          candidates.set(node.id, { node, matchRank: null, hops: Math.max(1, node.level), degree: 0 });
        }
      }
    }
  }

  for (const edge of edgePool.values()) {
    const from = candidates.get(edge.fromNodeId);
    if (from) from.degree += 1;
    const to = candidates.get(edge.toNodeId);
    if (to) to.degree += 1;
  }

  const maxDegree = Math.max(1, ...[...candidates.values()].map((candidate) => candidate.degree));
  // Prefer hop-0 (direct matches) over linked neighbors so budget goes to full pages.
  // Soft-penalize giant catalog/log pages so they don't outrank a specific runbook.
  const scored = [...candidates.values()]
    .map((candidate) => {
      const contentLen = candidate.node.content?.length ?? 0;
      const giantPenalty = contentLen > GIANT_CONTENT_CHARS ? 0.12 : 0;
      return {
        ...candidate,
        score:
          (candidate.matchRank === null ? 0 : 0.5 / (1 + candidate.matchRank)) +
          0.3 * activationScore(candidate.node, nowMs) +
          0.2 * (candidate.degree / maxDegree) +
          (candidate.hops === 0 ? 0.15 : 0) -
          giantPenalty,
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      left.hops - right.hops ||
      // Prefer more specific (shorter) pages when scores tie.
      (left.node.content?.length ?? 0) - (right.node.content?.length ?? 0) ||
      left.node.slug.localeCompare(right.node.slug),
    );

  const header = `Recall: ${input.query}\n`;
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
    const isPrimary = primary?.node.id === candidate.node.id;
    const headerEstimate = estimateTokens(`${candidate.node.title}\n${candidate.node.summary ?? ""}`) + 4;
    const contentRoomTokens = Math.max(0, Math.floor(
      (wireLimit - spentTokens - wireExtras - headerEstimate - ATOM_META_TOKENS) / 2,
    ));
    const edgeTokens = marginalEdgeTokens(candidate.node.id);

    let packed = false;
    // First try the slice the wire room allows; on overflow degrade to
    // header-only before skipping the candidate entirely.
    for (const maxContentChars of [contentRoomTokens * 4, 0]) {
      const supersededByTitle = superseded.get(candidate.node.id)?.byTitle;
      const rendered = renderRecallAtom(candidate.node, candidate.hops, remaining, {
        primaryMatch: isPrimary,
        maxContentChars,
        ...(supersededByTitle ? { supersededByTitle } : {}),
      });
      const atom: RecallAtom = {
        // The wire atom carries the packed slice the budgeter chose, never the
        // untruncated body; contentTruncated says whether more exists via read.
        node: { ...candidate.node, content: rendered.body },
        score: candidate.score,
        hops: candidate.hops,
        tokens: estimateTokens(rendered.block),
        contentTruncated: rendered.contentTruncated,
      };
      const blockCost = estimateTokens(rendered.block);
      const extra = estimateTokens(JSON.stringify(atom)) + edgeTokens;
      if (spentTokens + blockCost <= input.tokenBudget && spentTokens + blockCost + wireExtras + extra <= wireLimit) {
        spentTokens += blockCost;
        wireExtras += extra;
        contextParts.push(rendered.block);
        packedNodeIds.add(candidate.node.id);
        atoms.push(atom);
        packed = true;
        break;
      }
    }
    if (!packed) truncated = true;
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
    const evidenceNodeIds = ordered
      .filter((candidate) =>
        packedNodeIds.has(candidate.node.id) &&
        candidate.hops === 0 &&
        (candidate.node.content?.length ?? 0) <= GIANT_CONTENT_CHARS)
      .map((candidate) => candidate.node.id);
    const evidenceByNode = evidenceNodeIds.length > 0
      ? await store.getEvidenceForNodes(evidenceNodeIds, context, { query: input.query, perNodeLimit: 5 })
      : new Map<string, TextUnit[]>();

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
  };
  enforceRecallWireBudget(result);
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
  for (const atom of result.atoms) {
    if (atom.hops === 0) continue;
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

export function splitTextUnits(sourceId: string, contentText: string): TextUnit[] {
  const units: TextUnit[] = [];
  const sections: string[] = [];
  const blockPattern = /[^\n](?:.*[^\n])?/g;
  let match: RegExpExecArray | null;
  let ordinal = 0;

  while ((match = blockPattern.exec(contentText)) !== null) {
    const text = match[0] ?? "";
    const heading = /^(#{1,6})\s+(.+)$/.exec(text);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      sections.splice(level - 1);
      sections[level - 1] = heading[2] ?? text;
    }

    units.push({
      id: randomUUID(),
      sourceId,
      ordinal,
      sectionPath: sections.filter(Boolean),
      charStart: match.index,
      charEnd: match.index + text.length,
      text,
      contentSha256: sha256(text),
    });
    ordinal += 1;
  }

  return units;
}

export function renderMarkdownProjection(
  node: GraphNode,
  evidence: TextUnit[],
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[] },
): string {
  const related = neighborhood.nodes.filter((neighbor) => neighbor.id !== node.id);
  return [
    "---",
    `trove_id: ${node.id}`,
    `revision_id: ${node.revisionId}`,
    `type: ${node.type}`,
    `updated_at: ${node.updatedAt}`,
    "---",
    "",
    `# ${node.title}`,
    "",
    node.summary ?? "",
    "",
    node.content ?? "",
    "",
    "## Evidence",
    ...evidence.map((unit) => `- ${unit.text}`),
    "",
    "## Related",
    ...related.map((neighbor) => `- [[${neighbor.slug}|${neighbor.title}]]`),
  ].join("\n").trimEnd();
}

export function renderAgentContext(
  node: GraphNode,
  evidence: TextUnit[],
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[] },
): string {
  const edges = neighborhood.edges.map((edge) => `${edge.fromNodeId} -[${edge.predicate}]-> ${edge.toNodeId}`);
  return [
    `Node: ${node.title} (${node.type})`,
    `Updated: ${node.updatedAt}`,
    `Summary: ${node.summary ?? ""}`,
    node.content ? `Content: ${node.content}` : "",
    "Evidence:",
    ...evidence.map((unit) => `- ${unit.text}`),
    "Edges:",
    ...edges,
  ].filter(Boolean).join("\n");
}

export function isTextUnit(value: TextUnit | GraphSource): value is TextUnit {
  return "sourceId" in value && "text" in value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function encodeEventCursor(event: Pick<GraphEvent, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id })).toString("base64url");
}

export function decodeEventCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid event cursor.");
  const value = decoded as Record<string, unknown>;
  if (typeof value.createdAt !== "string" || typeof value.id !== "string") {
    throw new Error("Invalid event cursor.");
  }
  return { createdAt: value.createdAt, id: value.id };
}
