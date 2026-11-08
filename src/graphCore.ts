import { createHash } from "node:crypto";
import type {
  AnnotateInput,
  CaptureInput,
  CreateViewInput,
  DeleteViewInput,
  EnqueueJobInput,
  EventFeedInput,
  GraphAnnotation,
  GraphEdge,
  GraphJobKind,
  GraphJobStatus,
  GraphNode,
  GraphSource,
  GraphView,
  GrepInput,
  IngestInput,
  InvalidateEdgeInput,
  LinkInput,
  ListJobsInput,
  ListViewsInput,
  NeighborhoodInput,
  ProjectInput,
  ReadInput,
  ReadViewInput,
  RecallInput,
  RunJobInput,
  SearchInput,
  ShareableInput,
  ShareInput,
  TextUnit,
  UpdateInput,
} from "./contracts.js";
import type { TemporalScope } from "./temporalScope.js";

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
 * Thrown by both store drivers when a write would give one (from, to,
 * predicate) triple two versions that are true at the same world-time
 * instant, or would end a version before it began. Postgres enforces this
 * with the edge_valid_range_excl exclusion constraint and the
 * edge_valid_range_check check; the drivers check first so the refusal can
 * name the edge that owns the overlapping interval. Callers get a refusal,
 * never a silently clamped validFrom.
 */
export class EdgeValidityConflictError extends Error {
  /** Null only when a concurrent writer won the race and its row is not yet visible. */
  readonly conflictingEdgeId: string | null;

  constructor(message: string, conflictingEdgeId: string | null) {
    super(message);
    this.name = "EdgeValidityConflictError";
    this.conflictingEdgeId = conflictingEdgeId;
  }
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
 * Whole-log rollups for the dashboard. Computed by aggregation, never by
 * paging the feed: the log outgrows any page budget, and a walk that stops
 * early silently reports zero for the days it never reached.
 */
export type GraphEventStats = {
  /** Every non-smoke event for this owner — not a page of them. */
  total: number;
  /** UTC day buckets, ascending. Days with no events are absent, not zero. */
  perDay: Array<{ date: string; total: number; writes: number }>;
  actions: Array<{ key: string; count: number }>;
};

/**
 * Memories per day, by the day each one was first written.
 *
 * The dashboard's timeline plotted sources, which is the rarest thing a person
 * does here: it read 0 or 1 on almost every day while the graph itself held
 * fifteen hundred atoms. Atoms are what `remember` writes and what recall
 * finds, so they are what a memory timeline is about.
 *
 * Dated by first write, never by `updated_at`: revising a March note today
 * must not move it to today, or the chart quietly rewrites its own history
 * every time anything is edited. Live nodes only, so the series always sums to
 * the node count the rest of the dashboard reports.
 */
export type MemoryDay = { date: string; memories: number };

/**
 * Row counts for the two owner types the embedding backfill touches.
 *
 * `GraphJob.result` is an untyped `Record<string, unknown>`, so producer and
 * consumer were never checked against each other — that is how `Number(object)`
 * -> NaN compiled silently and stalled the drain loop. Anything reading a
 * refresh_embeddings result should narrow through these types rather than
 * re-deriving the shape.
 */
/**
 * What a refresh_embeddings run counts. `textChunks`, not text units, since
 * migration 020: the vector index is built on chunks (buildTextChunks) and the
 * per-line vectors are being retired.
 */
export type EmbeddingCounts = { nodeRevisions: number; textChunks: number };

export type RefreshEmbeddingsResult =
  | {
      status: "refreshed";
      ownerId: string | null;
      missingBefore: EmbeddingCounts;
      embedded: EmbeddingCounts;
      /** Sources converted from units-only to chunked by this run. */
      chunkedSources: number;
      /** Per-line vectors deleted because their source's chunks are indexed. */
      retiredTextUnitVectors: number;
      provider: string;
      model: string;
    }
  | {
      status: "skipped_no_embedding_provider";
      ownerId: string | null;
      missing: EmbeddingCounts;
      chunkedSources: number;
      provider: string;
      model: string;
    };

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
  /**
   * app_user.id the job belongs to: stamped from the enqueuing context the way
   * every other write stamps its rows. NULL is global/operator work (an
   * unscoped context, or the background worker) and is listed only to
   * unscoped readers, never to a scoped user.
   */
  ownerId: string | null;
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
  /** space.id this operation reads/writes as. Absent → see-all (superuser). */
  ownerId?: string | undefined;
  /** Shared spaces (workspaces) this caller may also read. Never written to through this context. */
  sharedOwnerIds?: string[] | undefined;
  /** Bypass owner scoping entirely (auth-disabled local/CI, maintenance jobs). */
  superuser?: boolean | undefined;
};

/**
 * Resolve the owner scope for a store operation.
 * - `scoped: false` — no owner filter (superuser, or no context supplied, e.g.
 *   maintenance jobs and internal callers). Writes stamp owner_id = NULL.
 * - `scoped: true` — writes stamp and mutate only `ownerId`; a scoped-but-null
 *   owner matches nothing, so an authed request that failed to resolve an owner
 *   fails closed.
 * - `readOwnerIds` — `ownerId` plus its shared spaces. Only the agent-facing
 *   read paths (search, recall, read, grep, neighborhood, evidence) use it;
 *   listings, lint, export, jobs and every write use `ownerId` alone.
 */
export type OwnerScope = { scoped: boolean; ownerId: string | null; readOwnerIds: string[] };

export function ownerScope(context?: GraphOperationContext): OwnerScope {
  // Scoping requires an explicit owner. No context, superuser, or a context
  // without an ownerId (internal/maintenance callers) all see the whole graph.
  // Every authenticated user credential carries an ownerId, so real requests
  // are always scoped; only trusted operator/internal paths reach see-all.
  if (!context || context.superuser || !context.ownerId) return { scoped: false, ownerId: null, readOwnerIds: [] };
  const shared = (context.sharedOwnerIds ?? []).filter((id) => id !== context.ownerId);
  return { scoped: true, ownerId: context.ownerId, readOwnerIds: [context.ownerId, ...shared] };
}

/** A text unit matching a quoted span (backlog #9a — cite by quote). */
export type TextQuoteMatch = {
  unit: TextUnit;
  /** exact: the quote appears verbatim (case-insensitive); fuzzy: term containment only. */
  match: "exact" | "fuzzy";
  /** 1 for exact; for fuzzy, the share of the quote's content terms the unit contains (0..1). */
  score: number;
};

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

export type ReadResult = GraphNode & {
  evidence: Array<TextUnit | GraphSource>;
  annotations: GraphAnnotation[];
};

/**
 * A node hit from search. `distance` is the cosine distance the semantic arm
 * computed for this hit (query ↔ node-revision embedding, min over the
 * dual-embed vectors) — present only when the semantic arm produced or
 * co-produced the hit. Lexical-only hits carry no distance: ts_rank is a
 * different metric that does not compare with cosine distance, so consumers
 * must treat `undefined` as "unknown", not as "far". Reconciliation (#27) is
 * the primary consumer: it gates judge calls on this number.
 */
export type SearchResultNode = GraphNode & { distance?: number };

export type SearchResult = {
  nodes: SearchResultNode[];
  textUnits: TextUnit[];
};

/**
 * Which retrieval arm produced a hit.
 *
 * "grep" is declared and never emitted by hybrid search: recall's seed pool is
 * the lexical + semantic fusion and nothing else. It has a name here so the
 * day a literal-substring arm joins that pool the wire protocol in
 * src/graphChat.ts does not need a version bump to carry it.
 */
export type SearchArm = "lexical" | "semantic" | "grep";

/**
 * Watch hybrid search's arms resolve individually.
 *
 * `search` returns one fused list, which is the right answer for every caller
 * that wants results and the wrong one for a caller that wants to SHOW the
 * retrieval happening: RRF hides which arm found what, and when. The observer
 * is called once per arm that actually ran, at the moment that arm's own
 * promise settles — never replayed, never reordered, and never synthesized for
 * an arm that did not run. Fire-and-forget: an observer that throws must not
 * fail the search that was carrying it.
 */
export type SearchObserver = { onArm?: (arm: SearchArm, nodes: SearchResultNode[]) => void };

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

/**
 * The reconciliation verdicts worth keeping past the job row that produced
 * them: a judged duplicate and a judged contradiction. `supersedes` is not
 * here because it is already resolved — it becomes an edge, and recall reads
 * it. These two are the ones that need a person, so they need somewhere to wait.
 */
export type ReconcileFlagCode = "possible_duplicate" | "contradiction_candidate";

export type ReconcileFlag = {
  code: ReconcileFlagCode;
  /** The candidate the flagged node was judged against. */
  otherNodeId: string;
  /** The judge's reason, as written into the job result. */
  detail: string;
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
  /** Whether this atom is backed by a resolvable text-unit citation or is explicitly inference. */
  provenance: "citation" | "agent_inference";
  score: number;
  hops: number;
  tokens: number;
  /** True when atom.node.content is a packed slice of the note body, not the full body. */
  contentTruncated: boolean;
  /** Which space the note lives in, reported only while a team is active. */
  space?: "mine" | "team";
};

export type RecallCitation = {
  nodeId: string | null;
  sourceId: string | null;
  textUnitId: string | null;
};

/**
 * What recall understood the question to be asking about in time, when it
 * understood anything at all. Additive and optional: absent from every pack
 * whose query carried no temporal words, which is every pack today. It exists
 * so an agent can say "as of January" instead of silently answering about a
 * different time.
 */
export type RecallTemporalScope = TemporalScope & {
  /** Always "reweight": a parsed scope moves ranking, it never removes candidates. */
  applied: "reweight";
  /** The text the lexical and semantic arms actually searched for, minus the date phrase. */
  searchQuery: string;
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
  temporalScope?: RecallTemporalScope;
};

/**
 * A recall told as it happens.
 *
 * `performRecall` normally speaks once, at the end, and a pack tells you what
 * retrieval concluded but not what it did. The trace is the same run narrated:
 * every event is emitted from the line that does the work, carrying the rows
 * that line actually produced, at the moment it produced them. Nothing here is
 * derived after the fact and nothing is replayed — the graph-chat view lights
 * up exactly the nodes recall touched, in the order recall touched them, and
 * that honesty is the whole reason the hook exists rather than a timeline
 * reconstructed from the result.
 *
 * Costs nothing when unused: with no `onTrace` the emitter is never called and
 * no arrays are built.
 */
export type RecallTraceEvent =
  /** One arm of hybrid search settled. Emitted per arm that ran, as it ran. */
  | { stage: "seeds"; arm: SearchArm; nodes: SearchResultNode[] }
  /** The fused (RRF) seed pool the rest of recall works from. */
  | { stage: "fused"; nodes: SearchResultNode[] }
  /** One seed's neighborhood came back; `nodes` are the candidates it ADDED. */
  | { stage: "expanded"; seedNodeId: string; nodes: Array<{ node: GraphNode; hops: number }> }
  /** The final candidate order, after reranking/MMR/temporal reweight. */
  | { stage: "ranked"; reranked: boolean; nodes: Array<{ node: GraphNode; score: number; hops: number }> };

export type RecallTrace = (event: RecallTraceEvent) => void;

export type ProjectResult =
  | { format: "markdown"; content: string }
  | { format: "mind_map"; nodes: GraphNode[]; edges: GraphEdge[] }
  | { format: "agent_context"; context: string; evidence: TextUnit[] };

/** Notes moved between a member's private space and the team space. */
export type SpaceMoveResult = {
  moved: Array<{ id: string; slug: string; title: string }>;
  skipped: Array<{ ref: string; reason: string }>;
  keptPrivate?: Array<{ id: string; slug: string; title: string }>;
};

export type SimilarNote = { nodeId: string; slug: string; title: string; score: number; space: "mine" | "team"; match: "title" | "meaning" };

export type ShareableResult = {
  total: number;
  notes: Array<{ id: string; slug: string; title: string; summary: string | null; updatedAt: string; looksLikeCredential: boolean; closestTeamNote?: { slug: string; title: string; distance: number } }>;
};

export type GraphStore = {
  /** Teams live in Postgres only; the memory store leaves these out. */
  shareable?(input: ShareableInput, context?: GraphOperationContext): Promise<ShareableResult>;
  similarAcrossSpaces?(input: { title: string; summary: string }, limit: number, context?: GraphOperationContext): Promise<SimilarNote[]>;
  teamNoteIds?(nodeIds: string[], context?: GraphOperationContext): Promise<Set<string>>;
  share?(input: ShareInput, context?: GraphOperationContext): Promise<SpaceMoveResult>;
  unshare?(input: ShareInput, context?: GraphOperationContext): Promise<SpaceMoveResult>;
  ingest(input: IngestInput, context?: GraphOperationContext): MaybePromise<{ source: GraphSource; textUnits: TextUnit[] }>;
  sources(input?: { limit?: number }, context?: GraphOperationContext): MaybePromise<GraphSourceOverview[]>;
  readSource(input: { sourceId: string }, context?: GraphOperationContext): MaybePromise<GraphSourceDocument | null>;
  readDocument(input: { uri: string }, context?: GraphOperationContext): MaybePromise<GraphDocument | null>;
  /** `observer` is optional instrumentation only; it cannot change the result. */
  search(input: SearchInput, context?: GraphOperationContext, observer?: SearchObserver): MaybePromise<SearchResult>;
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
   * Return node ids with at least one attached evidence annotation, including
   * source-level annotations that have no text unit to pack.
   */
  evidenceNodeIds(nodeIds: string[], context?: GraphOperationContext): MaybePromise<Set<string>>;
  /**
   * Resolve quoted span text to the text unit(s) containing it (backlog #9a —
   * cite by quote). Exact matches contain the quote verbatim
   * (case-insensitive); fuzzy matches come back only when nothing contains it,
   * scored by containment of the quote's content terms. Owner-scoped, so an
   * agent can never resolve a quote against another tenant's text.
   */
  resolveTextQuote(input: { quote: string; sourceId?: string; textUnitId?: string; limit?: number }, context?: GraphOperationContext): MaybePromise<TextQuoteMatch[]>;
  /**
   * Return one text unit's text when it resolves in the caller's owner scope.
   * Raw-UUID evidence uses this fail-closed lookup before attaching so it can
   * apply the same support score as the weak-evidence lint.
   */
  textUnitText(input: { textUnitId: string }, context?: GraphOperationContext): MaybePromise<string | null>;
  /**
   * Record units as served to this session. Internal plumbing — drivers call
   * it from their own read paths (ingest/search/grep/read/project), and
   * performRecall calls it for the evidence that actually made the pack.
   */
  markTextUnitsServed(textUnitIds: string[], context?: GraphOperationContext): MaybePromise<void>;
  /**
   * Was this unit served to the current session (backlog #9b)? `remember`
   * flags cited units that were not — a ref the agent never received is a
   * hallucination by definition. Heuristic (in-process, per-owner, capped):
   * backs a warning, never a rejection.
   */
  textUnitWasServed(input: { textUnitId: string }, context?: GraphOperationContext): MaybePromise<boolean>;
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
  eventStats(context?: GraphOperationContext): MaybePromise<GraphEventStats>;
  /** UTC day buckets of first-written memories, ascending; empty days absent. */
  memoryDays(context?: GraphOperationContext): MaybePromise<MemoryDay[]>;
  lint(context?: GraphOperationContext): MaybePromise<GraphLintReport>;
  /**
   * Settle any buffered activation bumps. Reads strengthen a node's activation
   * through a timed buffer (src/activation.ts), so a count read straight off
   * the row can trail by a window. Production tolerates that -- activation is a
   * weak tie-breaker -- but a caller that must observe a settled count (a
   * ranking assertion, a shutdown) calls this first.
   */
  flushActivation(): MaybePromise<void>;
  /**
   * REPLACE one node's durable reconcile flags with the set a reconcile pass
   * just produced (an empty list clears them). Internal plumbing —
   * performReconcileNode is the only caller, and `lint` is the only reader.
   * Replace, not append: the latest pass is the whole truth about that node,
   * so a re-judged node that is no longer a duplicate loses the flag.
   */
  recordReconcileFlags(
    input: { nodeId: string; flags: ReconcileFlag[] },
    context?: GraphOperationContext,
  ): MaybePromise<void>;
  createView(input: CreateViewInput, context?: GraphOperationContext): MaybePromise<GraphViewSnapshot>;
  views(input?: ListViewsInput, context?: GraphOperationContext): MaybePromise<GraphView[]>;
  readView(input: ReadViewInput, context?: GraphOperationContext): MaybePromise<GraphViewSnapshot | null>;
  deleteView(input: DeleteViewInput, context?: GraphOperationContext): MaybePromise<{ deleted: boolean; view: GraphView | null }>;
  exportMarkdown(context?: GraphOperationContext): MaybePromise<Record<string, string>>;
  exportGraph(context?: GraphOperationContext): MaybePromise<GraphSnapshot>;
  enqueueJob(input: EnqueueJobInput, context?: GraphOperationContext): MaybePromise<GraphJob>;
  jobs(input?: ListJobsInput, context?: GraphOperationContext): MaybePromise<GraphJob[]>;
  runJob(input?: RunJobInput, context?: GraphOperationContext): MaybePromise<GraphJob | null>;
  health(): MaybePromise<{ ok: true }>;
};

export function isTextUnit(value: TextUnit | GraphSource): value is TextUnit {
  return "sourceId" in value && "text" in value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
