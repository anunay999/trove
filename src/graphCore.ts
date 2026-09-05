import { createHash, randomUUID } from "node:crypto";
import { recallInputSchema } from "./contracts.js";
import { contentTerms } from "./queryNormalize.js";
import { parseTemporalScope, temporalAffinity, type TemporalScope } from "./temporalScope.js";
import {
  createRecallRerankerFromEnv,
  mmrOrder,
  rerankCandidates,
  toRerankCandidate,
  RERANK_MAX_CANDIDATES,
  type Reranker,
} from "./rerank.js";
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

/**
 * Minimum containment for a fuzzy quote match to be returned by the drivers
 * at all (backlog #9a). Below this the "closest" span shares less than half
 * the quote's terms — reporting it as a candidate would invite a wrong
 * citation. The higher ACCEPT floor/margin lives in agentOps.remember, which
 * decides whether a candidate may be cited automatically.
 */
export const FUZZY_QUOTE_CANDIDATE_FLOOR = 0.5;

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

/** Actions the dashboard counts as a write on the cadence chart. */
export const WRITE_ACTIONS = ["capture", "update", "link", "ingest", "annotate", "invalidate_edge"];

/**
 * Test suites tag their writes with a "-smoke" actor or interface. The audit
 * log keeps them forever, but the dashboard should reflect real memory
 * activity, so every rollup drops them.
 */
export function isSmokeEvent(event: Pick<GraphEvent, "actorHandle" | "actorId" | "interfaceId">): boolean {
  return (event.actorHandle ?? "").endsWith("-smoke") ||
    (event.actorId ?? "").endsWith("-smoke") ||
    (event.interfaceId ?? "").endsWith("-smoke");
}

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

/**
 * Attempts a job gets across all causes -- failures and lease reclaims alike.
 * One constant for both drivers and every query: the claim filter, the
 * dead-letter threshold and the lease-exhaustion retirement must agree, or a
 * job can sit in a state none of them matches.
 */
export const JOB_MAX_ATTEMPTS = 5;

/**
 * How long a finished job (succeeded/failed/dead/cancelled) stays in the
 * table. Rows are the audit trail of maintenance, not the graph; production
 * had ~5,000 succeeded rows and nothing ever removed one. The lint job prunes
 * past this age.
 */
export const TERMINAL_JOB_RETENTION_DAYS = 30;

/**
 * Minimum seconds between two maintenance lints of one scope. A write inside
 * this window after a successful lint enqueues no new lint; the next write
 * past it does. Time-based rather than write-counted because the cost being
 * bounded is lint runs per unit time, and a per-owner counter would need its
 * own table. 0 disables the throttle (tests).
 */
export function lintMinIntervalSeconds(): number {
  const parsed = Number(process.env.TROVE_LINT_MIN_INTERVAL_SECONDS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 600;
}

/**
 * Minimum seconds between two recall self-tests of one scope. A day by default,
 * two orders of magnitude slacker than lint, because a self-test is twenty
 * recalls rather than one pass over a snapshot — and because what it measures
 * moves on the scale of weeks, not writes. 0 disables the throttle (tests).
 */
export function selfTestMinIntervalSeconds(): number {
  const parsed = Number(process.env.TROVE_SELF_TEST_MIN_INTERVAL_SECONDS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 86_400;
}

/**
 * How long an audit event stays in `graph_event`, in days.
 *
 * The log is append-only and nothing ever removed a row: production carried
 * 30,479 rows / 16 MB across four indexes, growing on every write, forever.
 * Six months answers "who changed this, and when" for anything anybody
 * actually asks, and the dashboard's rollups only ever draw the recent past.
 *
 * 0 disables pruning entirely -- for an operator who wants the whole history
 * kept, and for tests that assert nothing is removed.
 */
export function eventRetentionDays(): number {
  const parsed = Number(process.env.TROVE_EVENT_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 180;
}

/**
 * Ceiling on how many event rows one prune run removes. The prune rides on the
 * lint job, which runs on a request thread; a first prune over a log that has
 * never been trimmed must not turn one lint into a table-wide delete holding
 * locks and bloating WAL. Steady state is far below this (production writes
 * ~500 events a day), so the cap only bites on catch-up runs, and lint runs
 * often enough to drain the backlog over a few of them.
 */
export function eventPruneMaxRows(): number {
  const parsed = Number(process.env.TROVE_EVENT_PRUNE_MAX_ROWS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20_000;
}

/** Rows per delete statement inside one prune run; the cap above bounds the run. */
export const EVENT_PRUNE_BATCH_ROWS = 2_000;

/**
 * Ceiling on the serialized size of one `before`/`after` audit payload.
 *
 * Every event stores both, and no reader reads either: `GraphEvent` does not
 * expose them, so they are pure storage. The payloads recordEvent builds are
 * small metadata objects, but two of them quote unbounded input -- `update`
 * carries the node summary, `tombstone` the id of every edge it expired -- so
 * one write can put a megabyte into columns nothing ever selects.
 *
 * Over the cap the payload keeps its shape: every top-level key survives, and
 * only the oversized values become a `{ truncated, bytes }` marker. The audit
 * still says which node changed and what kind of change it was; it stops
 * promising to reproduce the value verbatim.
 */
export const EVENT_PAYLOAD_MAX_BYTES = 8_192;

/** Longest single value retained verbatim once a payload is over the cap. */
const EVENT_PAYLOAD_MAX_VALUE_BYTES = 512;

function payloadBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/**
 * Bound one audit payload to EVENT_PAYLOAD_MAX_BYTES, keeping its top-level
 * keys. Under the cap the value is returned untouched, which is every event
 * the graph writes in normal use.
 */
export function capEventPayload(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const bytes = payloadBytes(value);
  if (bytes <= EVENT_PAYLOAD_MAX_BYTES) return value;
  if (typeof value !== "object" || Array.isArray(value)) return { truncated: true, bytes };
  const capped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryBytes = payloadBytes(entry);
    capped[key] = entryBytes <= EVENT_PAYLOAD_MAX_VALUE_BYTES ? entry : { truncated: true, bytes: entryBytes };
  }
  return capped;
}

export function ownerScope(context?: GraphOperationContext): OwnerScope {
  // Scoping requires an explicit owner. No context, superuser, or a context
  // without an ownerId (internal/maintenance callers) all see the whole graph.
  // Every authenticated user credential carries an ownerId, so real requests
  // are always scoped; only trusted operator/internal paths reach see-all.
  if (!context || context.superuser || !context.ownerId) return { scoped: false, ownerId: null };
  return { scoped: true, ownerId: context.ownerId };
}

/**
 * Session-served provenance log (backlog #9b). Records which text units a
 * session was actually shown — ingest/search/recall/grep/read/project
 * responses — so `remember` can flag a cited unit the caller never received:
 * a ref the agent was never given is a hallucination by definition.
 *
 * In-process and per-owner BY DESIGN: it backs a warning, not a security
 * boundary, one tenant's serves must never validate another's refs, and the
 * cap + TTL keep it session-sized. Both drivers hold one instance each, so
 * the check behaves identically on either driver.
 */
export class ServedUnitLog {
  private buckets = new Map<string, Map<string, number>>();

  constructor(
    private readonly cap = 2000,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    /**
     * Owner buckets need their own cap. Only the entries *inside* a bucket were
     * bounded before, so every distinct owner that ever ran a recall left a
     * bucket behind for the life of the process — bounded per owner, unbounded
     * across them. Evicted LRU, exactly like the entries.
     */
    private readonly ownerCap = 1000,
  ) {}

  private keyFor(context?: GraphOperationContext): string {
    const scope = ownerScope(context);
    return scope.scoped ? `owner:${scope.ownerId}` : "global";
  }

  mark(unitIds: Iterable<string>, context?: GraphOperationContext): void {
    const now = Date.now();
    const key = this.keyFor(context);
    const bucket = this.buckets.get(key) ?? new Map<string, number>();
    // delete+set moves this owner to the young end too, so the LRU sweep below
    // evicts whoever has been idle longest rather than whoever arrived first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    for (const [id, at] of bucket) {
      if (now - at > this.ttlMs) bucket.delete(id);
    }
    for (const id of unitIds) {
      // delete+set refreshes recency AND moves the entry to the young end.
      bucket.delete(id);
      bucket.set(id, now);
    }
    while (bucket.size > this.cap) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
    }
    // An owner whose entries have all aged out is dead weight: drop the bucket
    // with them rather than keeping an empty Map keyed by that owner forever.
    if (bucket.size === 0) this.buckets.delete(key);
    while (this.buckets.size > this.ownerCap) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  wasServed(textUnitId: string, context?: GraphOperationContext): boolean {
    const bucket = this.buckets.get(this.keyFor(context));
    const at = bucket?.get(textUnitId);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      bucket?.delete(textUnitId);
      return false;
    }
    return true;
  }
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

/** Report one arm to an observer without ever letting it break the search. */
export function reportSearchArm(
  observer: SearchObserver | undefined,
  arm: SearchArm,
  nodes: SearchResultNode[],
): void {
  if (!observer?.onArm) return;
  try {
    observer.onArm(arm, nodes);
  } catch {
    // Instrumentation is not allowed to fail a read.
  }
}

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

/** Lint code per reconcile flag — what the dashboard and the curate prompt see. */
export const RECONCILE_LINT_CODE: Record<ReconcileFlagCode, string> = {
  possible_duplicate: "reconcile_duplicate",
  contradiction_candidate: "reconcile_contradiction",
};

/** At most this many reconcile findings per lint run, matching its sibling passes. */
export const RECONCILE_FINDING_LIMIT = 50;

/**
 * Render one reconcile flag as a lint finding. Shared by both drivers so they
 * produce identical messages, and so the ids an agent needs in order to act on
 * it (`read` both, `connect` the pair, `forget` one) survive inside the
 * existing finding shape: `entityId` is the flagged node, and the other node's
 * slug and id ride in the message.
 *
 * Both severities are `warning`, not `error`: lint reserves `error` for a
 * structurally broken graph (an edge pointing at nothing). A judged
 * contradiction is a fact-level conflict for a person to resolve — the same
 * class as `duplicate_title`, however much it deserves attention.
 */
export function reconcileLintFinding(flag: {
  code: ReconcileFlagCode;
  node: { id: string; title: string; slug: string };
  other: { id: string; title: string; slug: string };
  detail: string;
}): GraphLintFinding {
  const duplicate = flag.code === "possible_duplicate";
  const detail = flag.detail.trim().slice(0, 200);
  return {
    severity: "warning",
    code: RECONCILE_LINT_CODE[flag.code],
    entityTable: "node",
    entityId: flag.node.id,
    message:
      `Reconciliation judged "${flag.node.title}" (${flag.node.slug}, ${flag.node.id}) ` +
      `${duplicate ? "a duplicate of" : "in contradiction with"} ` +
      `"${flag.other.title}" (${flag.other.slug}, ${flag.other.id})` +
      (detail ? `: ${detail}` : "."),
  };
}

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

export type GraphStore = {
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
  const raw = process.env.TROVE_TEMPORAL_SCOPE?.trim().toLowerCase();
  return raw === undefined || raw === "" || !["0", "false", "off", "no"].includes(raw);
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
  options: { primaryMatch?: boolean; maxContentChars?: number; supersededByTitle?: string; agentInference?: boolean } = {},
): { block: string; body: string; contentTruncated: boolean } {
  const origin = hops === 0 ? "match" : "linked";
  const supersedeMark = options.supersededByTitle ? ` — SUPERSEDED by ${options.supersededByTitle}` : "";
  const inferenceMark = options.agentInference ? " — AGENT INFERENCE" : "";
  const headerLines = [
    // The updated date anchors each atom in time: temporal questions ("what did
    // I buy 10 days ago?") are unanswerable from a dateless pack (bench finding —
    // the compare run's atoms carried no dates and temporal-reasoning scored 0%).
    `## ${node.title} [${node.type}/${origin}] (${node.slug}) — updated ${node.updatedAt.slice(0, 10)}${supersedeMark}${inferenceMark}`,
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
  const input = recallInputSchema.parse(rawInput);
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

/**
 * Target size of a text chunk, in characters of unit text. The context prefix
 * rides on top and is not counted.
 *
 * Text units are LINES (splitTextUnits above splits on newlines), averaging 187
 * bytes in production, and one vector per line is what filled the disk on
 * 3 September: 70,479 of the 71,929 vectors were per-line, 98% of the vector
 * bytes. A line is also the wrong grain to embed — "…and that is why we moved
 * off Railway." carries almost no retrievable meaning on its own.
 *
 * 1200 characters is ~300 tokens, the size range Anthropic's contextual-
 * retrieval work uses, and at the production average it gathers ~6 lines into
 * one vector. Changing it changes nothing about citations: the chunk is only
 * what gets EMBEDDED. See buildTextChunks.
 */
export const CHUNK_TARGET_CHARS = 1200;

/**
 * A contiguous run of text units within one source, and the grain the vector
 * index is built on. `firstOrdinal`..`lastOrdinal` is the run it covers, which
 * is how a semantic hit resolves back to the text units it must cite.
 */
export type TextChunk = {
  id: string;
  sourceId: string;
  /** Dense index of the chunk within its source. */
  ordinal: number;
  /** First and last text_unit.ordinal covered, inclusive. */
  firstOrdinal: number;
  lastOrdinal: number;
  /** Section the whole run belongs to; a chunk never straddles two. */
  sectionPath: string[];
  /** The written context the chunk is embedded WITH (never cited). */
  contextPrefix: string;
  /** The units' own text, joined by newlines. */
  text: string;
  /** sha256 of the exact embedding input, so a changed prefix re-embeds. */
  contentSha256: string;
};

/**
 * The context prefix Anthropic's contextual retrieval calls for, built from
 * what we already know for free and can state truthfully: the source's title
 * and the section the run sits in. No LLM call, so it costs nothing per chunk
 * and cannot hallucinate — the reported win there came from situating the
 * chunk in its document, which a title and a section path already do.
 */
export function chunkContextPrefix(sourceTitle: string, sectionPath: string[]): string {
  const section = sectionPath.filter(Boolean).join(" › ");
  return section ? `Source: ${sourceTitle} — Section: ${section}` : `Source: ${sourceTitle}`;
}

/** The exact text handed to the embedding provider for a chunk. */
export function chunkEmbeddingInput(chunk: { contextPrefix: string; text: string }): string {
  return `${chunk.contextPrefix}\n\n${chunk.text}`;
}

/**
 * Whether a text unit is worth counting toward a chunk's substance.
 *
 * Must stay in step with EMBEDDABLE_TEXT_UNIT in pgStore, which is the same
 * predicate in SQL: horizontal rules, markdown table separators and
 * sub-12-character fragments carry no meaning. They still ride INSIDE a chunk
 * (dropping them would break the contiguous ordinal range a chunk resolves
 * through); what this decides is whether a chunk made of nothing else is worth
 * a vector at all.
 */
export function isEmbeddableUnitText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return false;
  if (/^\|?(\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) return false;
  return true;
}

/**
 * Group a source's text units into the chunks the vector index is built on.
 *
 * Two boundaries, in this order: a chunk never straddles a `section_path`
 * change (a heading is a real topic break, and splitTextUnits already opens
 * the new section with its heading line, so a chunk starts with its own
 * heading), and a chunk closes before it would pass CHUNK_TARGET_CHARS. A
 * single unit longer than the target becomes its own chunk rather than being
 * split — the unit is the citation grain and must stay whole.
 *
 * Both drivers call this so the memory driver chunks exactly as Postgres does,
 * and the refresh job calls it to chunk sources ingested before chunking
 * existed — one implementation, so a backfilled chunk is byte-identical to a
 * freshly ingested one.
 */
export function buildTextChunks(sourceId: string, sourceTitle: string, units: TextUnit[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  const ordered = [...units].sort((left, right) => left.ordinal - right.ordinal);
  const sectionKey = (path: string[]): string => path.join(" ");
  let run: TextUnit[] = [];
  let runChars = 0;

  // Nothing embeddable in the whole run (a stretch of rules or separators) is
  // not worth a vector; skipping it leaves those units unembedded, as before.
  const emit = (grouped: TextUnit[]): void => {
    const first = grouped[0];
    const last = grouped[grouped.length - 1];
    if (!first || !last) return;
    if (!grouped.some((unit) => isEmbeddableUnitText(unit.text))) return;
    const text = grouped.map((unit) => unit.text).join("\n");
    const contextPrefix = chunkContextPrefix(sourceTitle, first.sectionPath);
    chunks.push({
      id: randomUUID(),
      sourceId,
      ordinal: chunks.length,
      firstOrdinal: first.ordinal,
      lastOrdinal: last.ordinal,
      sectionPath: first.sectionPath,
      contextPrefix,
      text,
      contentSha256: sha256(chunkEmbeddingInput({ contextPrefix, text })),
    });
  };

  for (const unit of ordered) {
    const head = run[0];
    const sectionChanged = head !== undefined && sectionKey(head.sectionPath) !== sectionKey(unit.sectionPath);
    const wouldOverflow = run.length > 0 && runChars + 1 + unit.text.length > CHUNK_TARGET_CHARS;
    if (sectionChanged || wouldOverflow) {
      emit(run);
      run = [];
      runChars = 0;
    }
    runChars += (run.length === 0 ? 0 : 1) + unit.text.length;
    run.push(unit);
  }
  emit(run);

  return chunks;
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
