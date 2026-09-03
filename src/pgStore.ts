import { randomUUID } from "node:crypto";
import pg from "pg";
import { contentTerms, normalizeRetrievalQuery } from "./queryNormalize.js";
import type {
  AnnotateInput,
  CaptureInput,
  CreateViewInput,
  DeleteViewInput,
  EnqueueJobInput,
  EventFeedInput,
  GraphAnnotation,
  GraphEdge,
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
  ReadViewInput,
  ReadInput,
  RecallInput,
  RunJobInput,
  SearchInput,
  TextUnit,
  UpdateInput,
} from "./contracts.js";
import {
  compileGrepPattern,
  grepExcerpt,
  isTextUnit,
  ownerScope,
  type OwnerScope,
  JOB_MAX_ATTEMPTS,
  TERMINAL_JOB_RETENTION_DAYS,
  lintMinIntervalSeconds,
  capEventPayload,
  eventPruneMaxRows,
  eventRetentionDays,
  EVENT_PRUNE_BATCH_ROWS,
  decodeEventCursor,
  encodeEventCursor,
  evidenceSupportScore,
  performRecall,
  reportSearchArm,
  type SearchObserver,
  renderAgentContext,
  renderMarkdownProjection,
  sha256,
  splitTextUnits,
  buildTextChunks,
  chunkEmbeddingInput,
  ServedUnitLog,
  FUZZY_QUOTE_CANDIDATE_FLOOR,
  EdgeValidityConflictError,
  UnknownEvidenceReferenceError,
  WEAK_EVIDENCE_FLOOR,
  RECONCILE_FINDING_LIMIT,
  reconcileLintFinding,
  type ReconcileFlag,
  type ReconcileFlagCode,
  type GraphEvent,
  type GraphEventFeed,
  type EmbeddingCounts,
  type GraphEventStats,
  WRITE_ACTIONS,
  type GraphJob,
  type GraphOperationContext,
  type GraphLintFinding,
  type GraphLintReport,
  type GraphSnapshot,
  type GraphStore,
  type GraphViewSnapshot,
  type GrepMatch,
  type GrepResult,
  type NeighborhoodResult,
  type ProjectResult,
  type ReadResult,
  type RecallResult,
  type SearchResult,
  type TextQuoteMatch,
} from "./graphCore.js";
import { ActivationBuffer, type ActivationBump } from "./activation.js";
import { createEmbeddingProviderFromEnv, vectorLiteral, type EmbeddingProvider } from "./embeddings.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import {
  createReconcileJudgeFromEnv,
  performReconcileNode,
  type ReconcileJudge,
} from "./reconcile.js";
import type { GraphJobResult, GraphJobResultMap } from "./jobResults.js";
import { slugify } from "./slug.js";

const { Pool } = pg;

/**
 * How long a claimed job may stay 'running' before another worker may reclaim
 * it. Generous by default: a full refresh_embeddings drain is many OpenAI round
 * trips, and reclaiming a job that is merely slow throws away real work.
 */
/**
 * Default node cap for a neighborhood walk. Shared with exportMarkdown, which
 * assembles the same depth-1 neighbourhoods in memory — if these two drift, the
 * vault projection silently stops matching what neighborhood() would return.
 */
const NEIGHBORHOOD_DEFAULT_MAX_NODES = 100;

/** Every column mapJob reads; one list so a new column cannot be missed by one query. */
const JOB_COLUMNS = `id, kind, status, priority, payload, result, error, dedupe_key, attempts, owner_id,
              created_at, updated_at, started_at, finished_at`;

function jobLeaseSeconds(): number {
  const parsed = Number(process.env.TROVE_JOB_LEASE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 900;
}

/**
 * How often a running job renews its lease. A third of the lease keeps two
 * missed beats inside the window; the clamp keeps a test-sized lease from
 * hammering the pool and a huge one from waiting an hour between beats.
 */
function leaseHeartbeatMs(): number {
  return Math.max(250, Math.min(60_000, Math.floor((jobLeaseSeconds() * 1000) / 3)));
}

// Junk text units (short fragments, horizontal rules, markdown table
// separators) carry no meaning. Since 020 they are no longer embedded one by
// one — they ride inside a chunk — so this predicate now does two jobs: it
// trims them from a semantic hit's expansion (SEMANTIC_UNIT_SEARCH_SQL), and it
// mirrors isEmbeddableUnitText in graphCore, which decides whether a chunk made
// of nothing else is worth a vector. The two must stay in step.
const EMBEDDABLE_TEXT_UNIT = `
  length(trim(tu.text)) >= 12
  and trim(tu.text) !~ '^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$'
  and trim(tu.text) !~ '^\\|?(\\s*:?-+:?\\s*\\|)+\\s*$'`;

/**
 * How many unchunked sources one refresh_embeddings run converts to chunks.
 * The chunking itself is TypeScript (buildTextChunks), so each source is a
 * round trip; 50 keeps a run short while draining production's backlog in a
 * handful of the worker's 30-second ticks.
 */
const CHUNK_BUILD_SOURCES_PER_RUN = 50;

/**
 * How many retired per-line vectors one refresh_embeddings run deletes. Bounded
 * because each delete is HNSW index maintenance; the drain is resumable, so the
 * only cost of a small batch is more of them.
 */
const TEXT_UNIT_VECTOR_RETIRE_PER_RUN = 500;

/**
 * The SQL text of the lexical and grep arms lives at module level so
 * tests/query-plans.test.ts can EXPLAIN the exact statements production runs
 * rather than a hand-copied approximation that drifts.
 */
type GrepOperator = "~" | "~*" | "like" | "ilike";

/**
 * The longest run of characters every match of `pattern` must contain, or
 * null when no such run of three or more exists. Deliberately conservative: a
 * character followed by `?`, `*` or `{…}` is optional and is dropped from its
 * run; alternation, groups, classes and escapes make the required text
 * ambiguous, so the whole pattern is given up on. Three is the trigram floor —
 * pg_trgm cannot serve a shorter ilike from the index.
 */
export function grepIndexLiteral(pattern: string): string | null {
  if (/[|()[\]\\]/.test(pattern)) return null;
  let best = "";
  let run = "";
  const close = (): void => {
    if (run.length > best.length) best = run;
    run = "";
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "?" || char === "*") {
      run = run.slice(0, -1);
      close();
    } else if (char === "{") {
      run = run.slice(0, -1);
      close();
      const end = pattern.indexOf("}", index);
      index = end === -1 ? pattern.length : end;
    } else if (char === "+" || char === "." || char === "^" || char === "$") {
      close();
    } else {
      run += char;
    }
  }
  close();
  return best.length >= 3 ? best : null;
}

/** Escape a literal for use inside a `%…%` like/ilike pattern. */
export function likePattern(literal: string): string {
  return `%${literal.replace(/[%_\\]/g, "\\$&")}%`;
}

const likeOperatorFor = (operator: GrepOperator): "like" | "ilike" => (operator === "~" ? "like" : "ilike");

/**
 * $1 pattern, $2 limit, $3/$4 owner scope, $5 the `%literal%` prefilter (bound
 * only when `prefilter` is true). The prefilter is a necessary condition for
 * the regex, so ANDing it in changes nothing about which rows match; it gives
 * the planner a trigram path even when pg_trgm cannot extract trigrams from
 * the regex itself.
 */
export function grepNodeSql(operator: GrepOperator, prefilter: boolean): string {
  const like = likeOperatorFor(operator);
  const nodeGuard = prefilter ? ` and (n.title ${like} $5 or n.summary ${like} $5)` : "";
  const revisionGuard = prefilter ? ` and nr.content ${like} $5` : "";
  // `hits` is a superset prefilter: one branch per table so each is a BitmapOr
  // over that table's trigram indexes. The revision branch matches ANY revision;
  // the outer predicate re-checks the current one, so the result set is exactly
  // what the plain OR-chain returned — only now it is evaluated on hits alone.
  return `
        with hits as (
          select n.id
          from node n
          where n.deleted_at is null and (n.title ${operator} $1 or n.summary ${operator} $1)${nodeGuard}
          union
          select nr.node_id as id
          from node_revision nr
          where nr.content ${operator} $1${revisionGuard}
        )
        select n.id, n.slug, n.title, n.summary, nr.content
        from hits
        join node n on n.id = hits.id
        left join node_revision nr on nr.id = n.current_revision_id
        where n.deleted_at is null and ($3 or n.owner_id = $4)
          and (n.title ${operator} $1 or coalesce(n.summary, '') ${operator} $1 or coalesce(nr.content, '') ${operator} $1)
        order by n.updated_at desc
        limit $2`;
}

export function grepUnitSql(operator: GrepOperator, prefilter: boolean): string {
  const guard = prefilter ? ` and tu.text ${likeOperatorFor(operator)} $5` : "";
  return `
        select tu.id, tu.source_id, tu.ordinal, tu.text, s.title
        from text_unit tu
        join source s on s.id = tu.source_id
        where ($3 or tu.owner_id = $4) and tu.text ${operator} $1${guard}
        order by tu.created_at desc, tu.ordinal
        limit $2`;
}

// The match predicate is an OR across node and node_revision, and no index can
// serve a disjunction that spans a join: before `hits`, every hybrid search
// hashed all current revisions and recomputed to_tsvector over each. `hits`
// is a superset prefilter with one branch per table, so each branch is a
// BitmapOr over that table's GIN indexes (full-text + trigram; slug and title
// on node). The revision branch matches any revision, current or not — the
// outer WHERE repeats the original predicate against the current revision, so
// the rows returned are exactly the ones the OR-chain returned, evaluated on
// the handful of hits instead of the whole corpus.
export const LEXICAL_NODE_SEARCH_SQL = `with q as (select $7::tsquery as query),
       hits as (
         select n.id
         from node n
         cross join q
         where n.deleted_at is null
           and (
             to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')) @@ q.query
             or n.slug = lower(replace($1, ' ', '-'))
             or n.title ilike $4
             or n.summary ilike $4
           )
         union
         select nr.node_id as id
         from node_revision nr
         cross join q
         where to_tsvector('english', coalesce(nr.content, '')) @@ q.query
            or nr.content ilike $4
       )
       select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at,
              greatest(
                ts_rank_cd(to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')), q.query),
                ts_rank_cd(to_tsvector('english', coalesce(nr.content, '')), q.query),
                case when n.slug = lower(replace($1, ' ', '-')) then 1.0 else 0 end,
                case when n.title ilike $4 then 0.2 else 0 end,
                case when coalesce(n.summary, '') ilike $4 then 0.1 else 0 end,
                case when coalesce(nr.content, '') ilike $4 then 0.05 else 0 end
              ) as rank
       from hits
       join node n on n.id = hits.id
       left join node_revision nr on nr.id = n.current_revision_id
       cross join q
       where n.deleted_at is null
         and ($5 or n.owner_id = $6)
         and ($2::node_type[] is null or n.type = any($2::node_type[]))
         and (
           -- Giant catalog/log pages starve recall packs; only a title or slug
           -- match lets them surface in search. Grep/read/neighborhood keep them.
           coalesce(length(nr.content), 0) <= 12000
           or n.title ilike $4
           or n.slug = lower(replace($1, ' ', '-'))
         )
         and (
           to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')) @@ q.query
           or to_tsvector('english', coalesce(nr.content, '')) @@ q.query
           or n.slug = lower(replace($1, ' ', '-'))
           or n.title ilike $4
           or coalesce(n.summary, '') ilike $4
           or coalesce(nr.content, '') ilike $4
         )
       order by rank desc, n.updated_at desc
       limit $3`;

export const LEXICAL_UNIT_SEARCH_SQL = `with q as (select $5::tsquery as query)
       select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256,
              greatest(
                ts_rank_cd(to_tsvector('english', text), q.query),
                case when text ilike $2 then 0.05 else 0 end
              ) as rank
       from text_unit
       cross join q
       where ($3 or owner_id = $4) and (
         to_tsvector('english', text) @@ q.query
          or text ilike $2
       )
       order by rank desc, created_at desc, ordinal
       limit $1`;

/**
 * The physical shape of the embedding table, which differs before and after the
 * maintenance conversion in scripts/convertEmbeddingStorage.ts. Resolved from
 * the catalog at startup (PgGraphStore.embeddingLayout) rather than assumed, so
 * a deploy never depends on the script having been run — the same build serves
 * a converted database and an unconverted one.
 *
 * `tenantColumn` is whether embedding.tenant_id EXISTS (migration 021 adds it,
 * instantly, at boot), so writes must stamp it. `tenantReady` is whether every
 * row is stamped, so reads may FILTER on it — those are different questions
 * while the backfill is running, and filtering early would silently hide the
 * unstamped rows from their own tenant.
 */
export type EmbeddingLayout = {
  /** What the embedding column holds; query vectors are cast to it. */
  vectorType: "vector" | "halfvec";
  /** embedding.tenant_id exists: every insert must stamp it. */
  tenantColumn: boolean;
  /** Every row is stamped: the probe may filter on tenant_id directly. */
  tenantReady: boolean;
};

/** What production looks like before the conversion script has run. */
export const LEGACY_EMBEDDING_LAYOUT: EmbeddingLayout = {
  vectorType: "vector",
  tenantColumn: false,
  tenantReady: false,
};

/**
 * Rows whose owning row is unowned (pre-isolation, or written by a superuser
 * context) stamp this sentinel rather than NULL, so `tenant_id is null` means
 * exactly one thing: not backfilled yet. Same sentinel migration 006 uses in
 * source_owner_content_key, for the same reason.
 */
export const UNOWNED_TENANT = "00000000-0000-0000-0000-000000000000";

/**
 * The semantic node arm. Vectors occupy $1..$N; everything else is numbered
 * after them: model, type filter, limit, unscoped, owner, max distance,
 * %query%, query, candidate limit.
 *
 * Probe the HNSW index FIRST, then join and filter — never filter-then-sort.
 * Each per-vector branch is `order by embedding <=> $n limit K`, the only shape
 * pgvector can serve from embedding_hnsw_idx (migration 009); the union is
 * deduped by min() rather than `distinct on`, since a revision can hold
 * several embedding rows (the unique key includes content_sha256).
 *
 * The owner filter lives INSIDE the limited branch either way. Before the
 * conversion it is reached through the owning row (embedding carried no tenant;
 * migration 016 explains why it was not added then): ordered index scan →
 * nested-loop pkey lookups → filter → limit keeps the distance order, and with
 * hnsw.iterative_scan on (semanticSearch sets it) the scan keeps walking until
 * K rows of THIS tenant pass. After the conversion the filter is a column on
 * the embedding row itself and the joins leave the probe entirely. Filtering
 * after the limit — the shape before both — handed a small tenant whatever
 * survived of a candidate window the large tenant had already filled, which was
 * usually nothing.
 */
export function semanticNodeSearchSql(vectorCount: number, layout: EmbeddingLayout = LEGACY_EMBEDDING_LAYOUT): string {
  const p = (offset: number): string => `$${vectorCount + offset}`;
  const vt = layout.vectorType;
  const scoped = layout.tenantReady
    ? {
        joins: "",
        filter: `and (${p(4)} or e.tenant_id = coalesce(${p(5)}, '${UNOWNED_TENANT}'::uuid))`,
      }
    : {
        joins: `
           join node_revision nr on nr.id = e.owner_id
           join node n on n.id = nr.node_id`,
        filter: `and (${p(4)} or n.owner_id = ${p(5)})`,
      };
  const branches = Array.from({ length: vectorCount }, (_, index) => `(
           select e.owner_id, e.embedding <=> $${index + 1}::${vt} as distance
           from embedding e${scoped.joins}
           where e.owner_table = 'node_revision' and e.model = ${p(1)}
             ${scoped.filter}
           order by e.embedding <=> $${index + 1}::${vt}
           limit ${p(9)}
         )`).join(" union all ");
  return `with candidates as (${branches}),
            best as (select owner_id, min(distance) as distance from candidates group by owner_id)
       select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id,
              n.updated_at, n.access_count, n.last_accessed_at, best.distance
       from best
       join node_revision nr on nr.id = best.owner_id
       join node n on n.id = nr.node_id and n.deleted_at is null and nr.id = n.current_revision_id
       where best.distance < ${p(6)}
         and (${p(4)} or n.owner_id = ${p(5)})
         and (${p(2)}::node_type[] is null or n.type = any(${p(2)}::node_type[]))
         and (
           coalesce(length(nr.content), 0) <= 12000
           or n.title ilike ${p(7)}
           or n.slug = lower(replace(${p(8)}, ' ', '-'))
         )
       order by best.distance
       limit ${p(3)}`;
}

/**
 * The semantic text-unit arm, one probe per query vector. $1 vector, $2 model,
 * $3 unscoped, $4 owner, $5 limit, $6 max distance.
 *
 * The probe runs over CHUNKS (migration 020) and the result is expanded back to
 * TEXT UNITS, which is the whole design: the chunk is what carries enough
 * meaning to be worth a vector, the text unit is what evidence quotes,
 * annotations and the served-unit log point at. The expansion is a range scan
 * over text_unit_source_idx (source_id, ordinal) across the chunk's contiguous
 * first_ordinal..last_ordinal, so a hit resolves to exactly the units that were
 * embedded — no second implementation of the split in SQL.
 *
 * The distance floor is applied OUTSIDE the probe: as a filter inside it, an
 * unrelated query (every row over the floor) would make the iterative scan walk
 * hnsw.max_scan_tuples looking for one that passes. Outside, the probe stops at
 * $5 rows and the floor trims them — the same rows, since anything past the top
 * $5 is farther. The outer limit is $5 as well: $5 chunks expand to at least $5
 * units, so the caller still gets as many units as it asked for.
 *
 * EMBEDDABLE_TEXT_UNIT repeats on the expansion because a chunk carries its
 * junk lines along (dropping them would break the contiguous ordinal range),
 * and a horizontal rule was never served as evidence before this change either.
 */
export function semanticUnitSearchSql(layout: EmbeddingLayout = LEGACY_EMBEDDING_LAYOUT): string {
  const vt = layout.vectorType;
  // After the conversion the tenant is a column on the embedding row, so the
  // chunk join becomes a pure pkey lookup on rows the limit has already chosen
  // rather than a filter the probe has to walk past.
  const filter = layout.tenantReady
    ? `and ($3 or e.tenant_id = coalesce($4, '${UNOWNED_TENANT}'::uuid))`
    : "and ($3 or tc.owner_id = $4)";
  return `select tu.id, tu.source_id, tu.ordinal, tu.section_path, tu.char_start, tu.char_end, tu.text, tu.content_sha256, chunk.distance
       from (
         select tc.source_id, tc.first_ordinal, tc.last_ordinal,
                (e.embedding <=> $1::${vt}) as distance
         from embedding e
         join text_chunk tc on tc.id = e.owner_id and e.owner_table = 'text_chunk'
         where e.model = $2
           ${filter}
         order by e.embedding <=> $1::${vt}
         limit $5
       ) chunk
       join text_unit tu
         on tu.source_id = chunk.source_id
        and tu.ordinal between chunk.first_ordinal and chunk.last_ordinal
       where chunk.distance < $6
         and ${EMBEDDABLE_TEXT_UNIT}
       order by chunk.distance, tu.ordinal
       limit $5`;
}

/** The pre-conversion form, kept as a named export for the query-plan tests. */
export const SEMANTIC_UNIT_SEARCH_SQL = semanticUnitSearchSql();

type PgStoreOptions = {
  connectionString: string;
  /**
   * Override the reconciliation judge (tests inject a fake; production defaults
   * to the OpenAI judge from env, falling back to the heuristic when
   * unconfigured). Pass `null` explicitly to force the heuristic.
   */
  reconcileJudge?: ReconcileJudge | null;
};

export class PgGraphStore implements GraphStore {
  private pool: pg.Pool;
  private reconcileJudge: ReconcileJudge | null;
  /**
   * Session-served provenance log (backlog #9b). In-process by design — the
   * server is one process, and this backs a warning, not a security boundary.
   */
  private servedUnits = new ServedUnitLog();
  /** Resolved once per store: whether pgvector is 0.8+ (hnsw.iterative_scan). */
  private iterativeScanSupport: Promise<boolean> | null = null;
  /**
   * Read strengthening, batched. One `update` per tracked read was one round
   * trip, one transaction and one dead tuple on the hottest table in the graph;
   * bumps now accumulate here and drain in a single statement. See
   * src/activation.ts for the window and why it is a timed buffer rather than a
   * per-call flush.
   */
  private activation = new ActivationBuffer((bumps) => this.writeActivation(bumps));
  /** Resolved from the catalog: see EmbeddingLayout and embeddingLayout(). */
  private layout: Promise<EmbeddingLayout> | null = null;
  /** When the last unconverted layout was resolved, for the re-check below. */
  private layoutResolvedAt = 0;

  constructor(options: PgStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, keepAlive: true });
    this.reconcileJudge = options.reconcileJudge === undefined ? createReconcileJudgeFromEnv() : options.reconcileJudge;
    // Idle clients dropped by the pooler (e.g. Supabase) emit 'error'; without
    // a listener that unhandled event kills the whole process.
    this.pool.on("error", (error) => {
      console.error("[pg-pool] idle client error:", error.message);
    });
  }

  /**
   * hnsw.iterative_scan arrived in pgvector 0.8.0 (production runs 0.8.2). An
   * older extension would reject the SET and abort the transaction, so the
   * version is checked once and remembered; a failed check is not remembered,
   * so a transient error does not pin the store to the pre-0.8 behaviour.
   */
  private supportsIterativeScan(): Promise<boolean> {
    this.iterativeScanSupport ??= this.pool
      .query(`select extversion from pg_extension where extname = 'vector'`)
      .then((result) => {
        const [major = 0, minor = 0] = String(result.rows[0]?.extversion ?? "0.0").split(".").map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => {
        this.iterativeScanSupport = null;
        return false;
      });
    return this.iterativeScanSupport;
  }

  /**
   * What the embedding table physically looks like right now.
   *
   * The halfvec conversion and the tenant backfill are a maintenance-window
   * script, not a migration, so a running deploy sees either shape and must
   * work with both. Read from the catalog, not assumed, and cached: a converted
   * layout never changes back, so it is remembered for the life of the process;
   * an unconverted one is re-checked at most every LAYOUT_RECHECK_MS so a
   * server that was up while the script ran picks the conversion up on its own
   * rather than needing a restart.
   *
   * A failed probe is never cached and falls back to the legacy shape, which is
   * always correct (the tenant filter goes through the owning row, and vector →
   * halfvec is an implicit cast in pgvector, so the cast is only about keeping
   * the index path unambiguous).
   */
  private embeddingLayout(): Promise<EmbeddingLayout> {
    const LAYOUT_RECHECK_MS = 60_000;
    if (this.layout && Date.now() - this.layoutResolvedAt > LAYOUT_RECHECK_MS) this.layout = null;
    if (this.layout) return this.layout;
    this.layoutResolvedAt = Date.now();
    this.layout = this.pool
      .query(
        `select
           (select format_type(a.atttypid, null)
              from pg_attribute a
             where a.attrelid = 'embedding'::regclass and a.attname = 'embedding') as vector_type,
           (select true
              from pg_attribute a
             where a.attrelid = 'embedding'::regclass and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant`,
      )
      .then(async (result) => {
        const row = result.rows[0] ?? {};
        const vectorType = String(row.vector_type ?? "").startsWith("halfvec") ? "halfvec" : "vector";
        const tenantColumn = row.has_tenant === true;
        // Heap-only predicate: the vectors live in TOAST and are never read to
        // answer it, so this is a few megabytes even on the production table.
        const tenantReady = tenantColumn
          && !(await this.pool.query("select 1 from embedding where tenant_id is null limit 1")).rowCount;
        // A converted table never converts back, so stop re-checking it.
        if (tenantReady && vectorType === "halfvec") this.layoutResolvedAt = Number.POSITIVE_INFINITY;
        return { vectorType, tenantColumn, tenantReady } satisfies EmbeddingLayout;
      })
      .catch(() => {
        this.layout = null;
        return LEGACY_EMBEDDING_LAYOUT;
      });
    return this.layout;
  }

  async ingest(input: IngestInput, context?: GraphOperationContext): Promise<{ source: GraphSource; textUnits: TextUnit[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const ownerId = ownerScope(context).ownerId;
      const sourceId = randomUUID();
      const contentSha256 = sha256(input.contentText);
      const sourceResult = await client.query(
        `insert into source (id, kind, uri, title, content_sha256, content_text, metadata, created_by, owner_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         on conflict (kind, content_sha256, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid))
         do update set title = excluded.title, metadata = excluded.metadata
         returning id, kind, title, uri, content_sha256, created_at`,
        [
          sourceId,
          input.kind,
          input.uri ?? null,
          input.title,
          contentSha256,
          input.contentText,
          JSON.stringify(input.metadata),
          actorUuid,
          ownerId,
        ],
      );
      const source = mapSource(sourceResult.rows[0]);
      const units = splitTextUnits(source.id, input.contentText);

      for (const unit of units) {
        await client.query(
          `insert into text_unit (
             id, source_id, ordinal, section_path, char_start, char_end, text, token_count, content_sha256, metadata, owner_id
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10)
           on conflict (source_id, ordinal) do nothing`,
          [
            unit.id,
            unit.sourceId,
            unit.ordinal,
            unit.sectionPath,
            unit.charStart,
            unit.charEnd,
            unit.text,
            estimateTokenCount(unit.text),
            unit.contentSha256,
            ownerId,
          ],
        );
      }

      // The chunks the vector index is built on, written in the same
      // transaction as the units they cover so a source is never half-chunked.
      // Same builder the refresh job uses to chunk older sources, so a
      // backfilled chunk is byte-identical to a freshly ingested one.
      for (const chunk of buildTextChunks(source.id, source.title, units)) {
        await client.query(
          `insert into text_chunk (
             id, source_id, owner_id, ordinal, first_ordinal, last_ordinal,
             section_path, context_prefix, text, token_count, content_sha256
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (source_id, ordinal) do nothing`,
          [
            chunk.id,
            chunk.sourceId,
            ownerId,
            chunk.ordinal,
            chunk.firstOrdinal,
            chunk.lastOrdinal,
            chunk.sectionPath,
            chunk.contextPrefix,
            chunk.text,
            estimateTokenCount(chunkEmbeddingInput(chunk)),
            chunk.contentSha256,
          ],
        );
      }

      await this.recordEvent(
        client,
        "ingest",
        "source",
        source.id,
        { title: source.title, kind: source.kind },
        null,
        context,
        actorUuid,
      );
      await this.enqueueMaintenanceJobs(client, context, actorUuid, [
        "lint_graph",
        "refresh_embeddings",
      ]);
      await client.query("commit");

      const textUnits = await this.textUnitsForSource(source.id);
      this.servedUnits.mark(textUnits.map((unit) => unit.id), context);
      return { source, textUnits };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async sources(input: { limit?: number } = {}, context?: GraphOperationContext): Promise<Array<GraphSource & { metadata: Record<string, unknown> }>> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, metadata, created_at
       from source
       where ($2 or owner_id = $3)
       order by created_at desc
       limit $1`,
      [input.limit ?? 1000, !scope.scoped, scope.ownerId],
    );
    return result.rows.map((row) => ({ ...mapSource(row), metadata: asRecord(row.metadata) }));
  }

  async readSource(input: { sourceId: string }, context?: GraphOperationContext): Promise<(GraphSource & { metadata: Record<string, unknown>; contentText: string }) | null> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, metadata, content_text, created_at
       from source
       where id = $1 and ($2 or owner_id = $3)`,
      [input.sourceId, !scope.scoped, scope.ownerId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      ...mapSource(row),
      metadata: asRecord(row.metadata),
      contentText: row.content_text === null ? "" : String(row.content_text),
    };
  }

  async readDocument(input: { uri: string }, context?: GraphOperationContext): Promise<{ uri: string; title: string; contentText: string; segmentCount: number } | null> {
    const scope = ownerScope(context);
    const episodes = await this.pool.query(
      `select title, content_text
       from source
       where metadata->>'episodeOf' = $1 and ($2 or owner_id = $3)
       order by (metadata->>'episodeOrdinal')::int asc nulls last, created_at asc`,
      [input.uri, !scope.scoped, scope.ownerId],
    );
    if (episodes.rowCount && episodes.rowCount > 0) {
      return {
        uri: input.uri,
        title: input.uri.split("/").at(-1) ?? input.uri,
        contentText: episodes.rows.map((row) => String(row.content_text ?? "")).join("\n\n"),
        segmentCount: episodes.rowCount,
      };
    }
    const whole = await this.pool.query(
      `select title, content_text
       from source
       where uri = $1 and ($2 or owner_id = $3)
       order by created_at desc
       limit 1`,
      [input.uri, !scope.scoped, scope.ownerId],
    );
    if (whole.rowCount === 0) return null;
    return {
      uri: input.uri,
      title: String(whole.rows[0].title),
      contentText: String(whole.rows[0].content_text ?? ""),
      segmentCount: 1,
    };
  }

  async grep(input: GrepInput, context?: GraphOperationContext): Promise<GrepResult> {
    const scope = input.scope ?? "all";
    const owner = ownerScope(context);
    const ownerParams = [!owner.scoped, owner.ownerId];
    const limit = input.limit ?? 20;
    const caseSensitive = input.caseSensitive ?? false;
    const operator = caseSensitive ? "~" : "~*";
    const regex = compileGrepPattern(input.pattern, caseSensitive);
    const literalRegex = compileGrepPattern(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive);
    const likeLiteral = likePattern(input.pattern);
    // A literal run every match must contain lets the trigram index prefilter
    // the regex scan; patterns without one fall back to the plain regex.
    const indexLiteral = grepIndexLiteral(input.pattern);
    const regexParams = [input.pattern, limit + 1, ...ownerParams, ...(indexLiteral === null ? [] : [likePattern(indexLiteral)])];
    const matches: GrepMatch[] = [];
    const excerptFor = (text: string): string | null => grepExcerpt(text, regex) ?? grepExcerpt(text, literalRegex);

    if (scope === "nodes" || scope === "all") {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await this.pool.query(grepNodeSql(operator, indexLiteral !== null), regexParams)).rows;
      } catch {
        // JS accepted the pattern but Postgres POSIX regex rejected it — fall back to a literal scan.
        rows = (await this.pool.query(grepNodeSql("ilike", false), [likeLiteral, limit + 1, ...ownerParams])).rows;
      }
      for (const row of rows) {
        const fields: Array<["title" | "summary" | "content", string | null]> = [
          ["title", row.title == null ? null : String(row.title)],
          ["summary", row.summary == null ? null : String(row.summary)],
          ["content", row.content == null ? null : String(row.content)],
        ];
        for (const [field, value] of fields) {
          if (!value) continue;
          const excerpt = excerptFor(value);
          if (excerpt !== null) {
            matches.push({ kind: "node", nodeId: String(row.id), slug: String(row.slug), title: String(row.title), field, excerpt });
            break;
          }
        }
      }
    }

    if (scope === "sources" || scope === "all") {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await this.pool.query(grepUnitSql(operator, indexLiteral !== null), regexParams)).rows;
      } catch {
        rows = (await this.pool.query(grepUnitSql("ilike", false), [likeLiteral, limit + 1, ...ownerParams])).rows;
      }
      for (const row of rows) {
        const text = String(row.text ?? "");
        matches.push({
          kind: "source",
          sourceId: String(row.source_id),
          textUnitId: String(row.id),
          ordinal: Number(row.ordinal),
          title: String(row.title),
          field: "text",
          excerpt: excerptFor(text) ?? text.slice(0, 240),
        });
      }
    }

    const served = matches.slice(0, limit);
    this.servedUnits.mark(
      served.flatMap((match) => (match.textUnitId ? [match.textUnitId] : [])),
      context,
    );
    return { matches: served, truncated: matches.length > limit };
  }

  async search(
    input: SearchInput,
    context?: GraphOperationContext,
    observer?: SearchObserver,
  ): Promise<SearchResult> {
    const scope = ownerScope(context);
    const provider = input.mode === "lexical" ? null : createEmbeddingProviderFromEnv();

    let result: SearchResult;
    // Semantic-only searches used to run a full lexical search first and throw
    // the result away; they now do no lexical work at all.
    if (input.mode === "semantic") {
      result = provider ? await this.semanticSearch(input, provider, scope) : { nodes: [], textUnits: [] };
      if (provider) reportSearchArm(observer, "semantic", result.nodes);
    } else if (input.mode === "lexical" || !provider) {
      // Lexical-only, or hybrid with no embedding provider configured.
      result = await this.lexicalSearch(input, scope);
      reportSearchArm(observer, "lexical", result.nodes);
    } else {
      // The two arms are independent, and the semantic one blocks on an embedding
      // API round trip. Running them concurrently hides the lexical SQL entirely
      // behind that call rather than adding to it — recall (the hot path) and
      // view creation both call this with limit 50.
      //
      // The observer fires off each arm's OWN promise, so a watcher sees the
      // fast SQL arm land while the embedding round trip is still in flight —
      // the real shape of the race, not a pair of events synthesized after
      // Promise.all resolved them both.
      const [lexical, semantic] = await Promise.all([
        this.lexicalSearch(input, scope).then((arm) => {
          reportSearchArm(observer, "lexical", arm.nodes);
          return arm;
        }),
        this.semanticSearch(input, provider, scope).then((arm) => {
          reportSearchArm(observer, "semantic", arm.nodes);
          return arm;
        }),
      ]);
      result = {
        nodes: reciprocalRankFusion(lexical.nodes, semantic.nodes),
        textUnits: reciprocalRankFusion(lexical.textUnits, semantic.textUnits),
      };
    }
    this.servedUnits.mark(result.textUnits.map((unit) => unit.id), context);
    return result;
  }

  private async lexicalSearch(input: SearchInput, scope: OwnerScope): Promise<SearchResult> {
    // Question-shaped queries arrive at the tsquery as their content terms
    // ("How many weddings…" -> "weddings attended year"); slug/ilike matching
    // keeps the original query text.
    const retrievalQuery = normalizeRetrievalQuery(input.query);
    // Compute the tsquery first: for stop-word-only or near-empty queries
    // websearch_to_tsquery is empty, and the ilike fallbacks would otherwise
    // match noise ("the" boosted 8/10 fixtures). Substring needs are served by
    // grep, so lexical returns nothing here. The OR form is the fallback for
    // multi-term queries whose terms never co-occur in one node (e.g.
    // natural-language questions).
    const tsquery = await this.pool.query(
      `select websearch_to_tsquery('english', $1)::text as query,
              (select string_agg(lexeme, ' | ') from unnest(tsvector_to_array(to_tsvector('english', $1))) as terms(lexeme)) as or_query,
              (select count(*)::int from unnest(tsvector_to_array(to_tsvector('english', $1)))) as lexeme_count`,
      [retrievalQuery],
    );
    const tsqueryText = String(tsquery.rows[0]?.query ?? "");
    const orQueryText = String(tsquery.rows[0]?.or_query ?? "");
    // Gate the fallback on lexeme COUNT, not on the two strings differing:
    // websearch_to_tsquery quotes lexemes ('wed') while string_agg does not
    // (wed), so `orQueryText !== tsqueryText` is true even for a single-term
    // query and every miss fired a second, byte-identical query. With one
    // lexeme the OR form is identical in meaning, so there is nothing to retry.
    const hasOrFallback = Number(tsquery.rows[0]?.lexeme_count ?? 0) > 1 && orQueryText.length > 0;
    if (retrievalQuery.length < 3 || tsqueryText.length === 0) {
      return { nodes: [], textUnits: [] };
    }

    const typeFilter = input.types && input.types.length > 0 ? input.types : null;
    const runNodeSearch = (effectiveTsquery: string) =>
      this.pool.query(LEXICAL_NODE_SEARCH_SQL, [
        input.query, typeFilter, input.limit, `%${input.query}%`, !scope.scoped, scope.ownerId, effectiveTsquery,
      ]);
    // Strict AND first so precision is preserved whenever every term co-occurs;
    // the looser OR form only runs when AND found nothing at all.
    const withOrFallback = async (run: (tsquery: string) => Promise<pg.QueryResult>) => {
      const strict = await run(tsqueryText);
      return strict.rows.length > 0 || !hasOrFallback ? strict : run(orQueryText);
    };
    const nodeResult = await withOrFallback(runNodeSearch);

    const runUnitSearch = (effectiveTsquery: string) =>
      this.pool.query(LEXICAL_UNIT_SEARCH_SQL, [
        input.limit, `%${input.query}%`, !scope.scoped, scope.ownerId, effectiveTsquery,
      ]);
    const textUnitResult = input.includeTextUnits
      ? await withOrFallback(runUnitSearch)
      : { rows: [] as Record<string, unknown>[] };

    return {
      nodes: nodeResult.rows.map(mapNode),
      textUnits: textUnitResult.rows.map(mapTextUnit),
    };
  }

  private async semanticSearch(input: SearchInput, provider: EmbeddingProvider, scope: OwnerScope): Promise<SearchResult> {
    // Dual-embed: the raw query preserves question intent, the normalized query
    // sharpens keyword overlap — real providers score them inconsistently
    // (measured: normalization helped one node 0.72→0.64, hurt another
    // 0.56→0.59), so we embed both in one batched call and take the min
    // distance. One API call either way.
    const normalized = normalizeRetrievalQuery(input.query);
    const queries = normalized === input.query.trim() ? [input.query] : [input.query, normalized];
    const vectors = (await provider.embed(queries))
      .filter((vector): vector is number[] => Array.isArray(vector))
      .map(vectorLiteral);
    if (vectors.length === 0) return { nodes: [], textUnits: [] };
    const typeFilter = input.types && input.types.length > 0 ? input.types : null;
    const maxDistance = maxSemanticDistanceFor(input);

    // The probe (see semanticNodeSearchSql) fetches a few times the limit
    // because the type filter and the giant-page rule still run after it.
    // Owner scoping is no longer among them — it is inside the probe — so this
    // is no longer a guess about how many foreign rows a tenant must wade
    // through, only about how selective the type filter is.
    const candidateLimit = Math.max(100, input.limit * 4);
    // Resolved from the catalog: which SQL type to cast the query vector to,
    // and whether the tenant filter can sit on the embedding row itself.
    const layout = await this.embeddingLayout();
    const nodeParams = [
      ...vectors,
      provider.model,
      typeFilter,
      input.limit,
      !scope.scoped,
      scope.ownerId,
      maxDistance,
      `%${input.query}%`,
      input.query,
      candidateLimit,
    ];

    // One indexable probe PER vector, merged in JS — never `least(...)` here.
    // `order by e.embedding <=> $1::vector limit N` is the only shape pgvector
    // can serve from embedding_hnsw_idx (migration 009); wrapping it in least()
    // makes the sort key a non-indexable expression and silently degrades this
    // to a sequential scan over every embedding row. Verified with
    // enable_seqscan=off: the single-vector form plans an
    // "Index Scan using embedding_hnsw_idx", the least() form has no index path
    // at all. That mattered precisely on natural-language queries, since those
    // are the ones where normalized !== raw and a second vector exists.
    // Two indexed probes beat one unindexed scan; the union is exact because
    // min-over-vectors of a per-row distance is the same set either way.
    //
    // Both arms run on one connection inside a transaction so that the
    // `set local`s cover them and nothing else:
    //
    //  - hnsw.iterative_scan: without it an HNSW scan hands back at most
    //    hnsw.ef_search (40) candidates and stops, and an owner filter that
    //    rejects most of them leaves the query short. With it the scan keeps
    //    walking (up to hnsw.max_scan_tuples) until the limit is met.
    //  - enable_hashjoin / enable_mergejoin off: the owner filter is reached
    //    through pkey joins inside the limited probe. Only a nested loop
    //    streams, so only a nested loop lets the Limit stop the scan once K
    //    rows have passed; a hash join was observed (small owner, seqscan
    //    off) to drain the index scan into its probe side first, which either
    //    starves the window or, iterating, walks max_scan_tuples every time.
    //    Every join in these statements is a primary-key lookup, where nested
    //    loop is the plan the planner picks anyway at production sizes.
    const client = await this.pool.connect();
    let nodeResult: pg.QueryResult;
    const unitRowsByVector: pg.QueryResult[] = [];
    try {
      await client.query("begin");
      await client.query("set local enable_hashjoin = off");
      await client.query("set local enable_mergejoin = off");
      if (await this.supportsIterativeScan()) {
        await client.query("set local hnsw.iterative_scan = relaxed_order");
      }
      nodeResult = await client.query(semanticNodeSearchSql(vectors.length, layout), nodeParams);
      if (input.includeTextUnits) {
        for (const vector of vectors) {
          unitRowsByVector.push(
            await client.query(semanticUnitSearchSql(layout), [vector, provider.model, !scope.scoped, scope.ownerId, input.limit, maxDistance]),
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    // Keep each unit once at its best (smallest) distance across the probes.
    const bestUnits = new Map<string, Record<string, unknown>>();
    for (const result of unitRowsByVector) {
      for (const row of result.rows) {
        const existing = bestUnits.get(String(row.id));
        if (!existing || Number(row.distance) < Number(existing.distance)) bestUnits.set(String(row.id), row);
      }
    }
    const textUnitResult = {
      rows: [...bestUnits.values()]
        .sort((left, right) => Number(left.distance) - Number(right.distance))
        .slice(0, input.limit),
    };

    return {
      // The semantic arm's per-node cosine distance (best over the dual-embed
      // vectors) rides along on the hit — reconciliation gates judge calls on
      // it (#27). mapNode alone would discard what the SQL already computed.
      nodes: nodeResult.rows.map((row) => ({ ...mapNode(row), distance: Number(row.distance) })),
      textUnits: textUnitResult.rows.map(mapTextUnit),
    };
  }

  async read(input: ReadInput, context?: GraphOperationContext, opts?: { trackAccess?: boolean }): Promise<ReadResult | null> {
    const scope = ownerScope(context);
    const predicate = input.nodeId ? "n.id = $1" : "n.slug = $1";
    const revisionJoin = input.asOf
      ? `join lateral (
           select id, title, summary, content, created_at
           from node_revision
           where node_id = n.id and created_at <= $4::timestamptz
           order by created_at desc, revision_number desc
           limit 1
         ) nr on true`
      : "left join node_revision nr on nr.id = n.current_revision_id";
    const nodeResult = await this.pool.query(
      `select n.id, n.type, n.slug,
              coalesce(nr.title, n.title) as title,
              case when nr.title is null then n.summary else nr.summary end as summary,
              nr.content, nr.id as current_revision_id,
              case when $4::timestamptz is null then n.updated_at else nr.created_at end as updated_at,
              n.access_count, n.last_accessed_at
       from node n
       ${revisionJoin}
       where n.deleted_at is null and ${predicate} and ($2 or n.owner_id = $3)
       limit 1`,
      [input.nodeId ?? input.slug, !scope.scoped, scope.ownerId, input.asOf ?? null],
    );
    if (nodeResult.rowCount === 0) return null;

    const node = mapNode(nodeResult.rows[0]);
    // The bump is buffered, not written here. The row above is the flushed
    // baseline, so folding this store's un-flushed delta back on top keeps the
    // count exact for every caller in the process — including the untracked
    // reads (dedupe, read-backs, project) that must observe activation without
    // adding to it.
    const activation = (opts?.trackAccess ?? true)
      ? this.activation.bump(node.id)
      : this.activation.pendingFor(node.id);
    if (activation.count > 0 && activation.lastAccessedAt) {
      node.accessCount += activation.count;
      node.lastAccessedAt = activation.lastAccessedAt;
    }

    // Evidence and annotations intentionally remain current for historical fact
    // reads; only title/summary/content are revision-scoped in backlog #18.
    // Fetch stays constant-query: annotations, batched text units, then sources.
    const annotations = await this.annotationsForNode(node.id, scope);
    const unitsById = new Map(
      (await this.getEvidenceForNodes([node.id], context)).get(node.id)?.map((unit) => [unit.id, unit] as const) ?? [],
    );
    const sourceOnlyIds = [...new Set(
      annotations
        .filter((annotation) => !annotation.textUnitId && annotation.sourceId)
        .map((annotation) => annotation.sourceId as string),
    )];
    const sourcesById = await this.sourcesByIds(sourceOnlyIds, scope);

    const evidence: Array<TextUnit | GraphSource> = [];
    for (const annotation of annotations) {
      if (annotation.textUnitId) {
        const textUnit = unitsById.get(annotation.textUnitId);
        if (textUnit) evidence.push(textUnit);
        continue;
      }
      if (annotation.sourceId) {
        const source = sourcesById.get(annotation.sourceId);
        if (source) evidence.push(source);
      }
    }

    // A tracked read is an agent-facing one — its evidence was actually shown,
    // so it counts as served. Internal reads (trackAccess: false) show nothing.
    if (opts?.trackAccess ?? true) {
      this.servedUnits.mark(evidence.filter(isTextUnit).map((unit) => unit.id), context);
    }
    return { ...node, evidence, annotations };
  }

  async getEvidenceForNodes(
    nodeIds: string[],
    context?: GraphOperationContext,
    opts?: { query?: string; perNodeLimit?: number },
  ): Promise<Map<string, TextUnit[]>> {
    const evidence = new Map<string, TextUnit[]>(nodeIds.map((nodeId) => [nodeId, []]));
    if (nodeIds.length === 0) return evidence;
    const scope = ownerScope(context);

    if (opts?.query) {
      // Ranked mode: cap each node at its best-matching units (default 5).
      // Ranking uses the OR tsquery over the normalized query — a unit holding
      // any content term outranks one holding none (AND would rank most 0).
      const perNodeLimit = Math.max(1, Math.trunc(opts.perNodeLimit ?? 5));
      const ranked = await this.pool.query(
        `with q as (
           select coalesce(
             (select (string_agg(lexeme, ' | '))::tsquery
              from unnest(tsvector_to_array(to_tsvector('english', $2))) as terms(lexeme)),
             ''::tsquery
           ) as query
         ), ranked as (
           select a.node_id, tu.id, tu.source_id, tu.ordinal, tu.section_path, tu.char_start, tu.char_end, tu.text, tu.content_sha256,
                  row_number() over (
                    partition by a.node_id
                    order by ts_rank_cd(to_tsvector('english', tu.text), q.query) desc,
                             tu.source_id, tu.ordinal
                  ) as per_node_rank
           from annotation a
           join text_unit tu on tu.id = a.text_unit_id
           cross join q
           where a.node_id = any($1::uuid[]) and ($3 or a.owner_id = $4)
         )
         select node_id, id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256
         from ranked
         where per_node_rank <= $5
         order by node_id, per_node_rank`,
        [nodeIds, normalizeRetrievalQuery(opts.query), !scope.scoped, scope.ownerId, perNodeLimit],
      );
      for (const row of ranked.rows) {
        evidence.get(String(row.node_id))?.push(mapTextUnit(row));
      }
      return evidence;
    }

    const result = await this.pool.query(
      `select a.node_id, tu.id, tu.source_id, tu.ordinal, tu.section_path, tu.char_start, tu.char_end, tu.text, tu.content_sha256
       from annotation a
       join text_unit tu on tu.id = a.text_unit_id
       where a.node_id = any($1::uuid[]) and ($2 or a.owner_id = $3)
       order by a.node_id, a.created_at, tu.ordinal`,
      [nodeIds, !scope.scoped, scope.ownerId],
    );
    for (const row of result.rows) {
      evidence.get(String(row.node_id))?.push(mapTextUnit(row));
    }
    return evidence;
  }

  async evidenceNodeIds(nodeIds: string[], context?: GraphOperationContext): Promise<Set<string>> {
    if (nodeIds.length === 0) return new Set();
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select distinct a.node_id
       from annotation a
       join node n on n.id = a.node_id
       where a.node_id = any($1::uuid[])
         and n.deleted_at is null
         and ($2 or n.owner_id = $3)`,
      [nodeIds, !scope.scoped, scope.ownerId],
    );
    return new Set(result.rows.map((row) => String(row.node_id)));
  }

  async resolveTextQuote(
    input: { quote: string; sourceId?: string; textUnitId?: string; limit?: number },
    context?: GraphOperationContext,
  ): Promise<TextQuoteMatch[]> {
    const scope = ownerScope(context);
    const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 8)));
    // Exact: verbatim containment, case-insensitive. position() sidesteps
    // ILIKE's %/_ escaping entirely.
    const exact = await this.pool.query(
      `select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256
       from text_unit
       where ($2 or owner_id = $3)
         and ($4::uuid is null or source_id = $4)
         and ($5::uuid is null or id = $5)
         and position(lower($1) in lower(text)) > 0
       order by created_at desc, ordinal
       limit $6`,
      [input.quote, !scope.scoped, scope.ownerId, input.sourceId ?? null, input.textUnitId ?? null, limit],
    );
    if (exact.rows.length > 0) {
      return exact.rows.map((row): TextQuoteMatch => ({ unit: mapTextUnit(row), match: "exact", score: 1 }));
    }

    // Fuzzy: units holding any of the quote's content terms (the same OR form
    // as lexical search's fallback), then containment-scored in JS with the
    // helper the weak-evidence lint uses — one scoring rule, two call sites.
    if (contentTerms(input.quote).length === 0) return [];
    const fuzzy = await this.pool.query(
      `with q as (
         select coalesce(
           (select (string_agg(lexeme, ' | '))::tsquery
            from unnest(tsvector_to_array(to_tsvector('english', $1))) as terms(lexeme)),
           ''::tsquery
         ) as query
       )
       select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256,
              ts_rank_cd(to_tsvector('english', text), q.query) as rank
       from text_unit
       cross join q
       where ($2 or owner_id = $3)
         and ($4::uuid is null or source_id = $4)
         and ($5::uuid is null or id = $5)
         and to_tsvector('english', text) @@ q.query
       order by rank desc
       limit 25`,
      [input.quote, !scope.scoped, scope.ownerId, input.sourceId ?? null, input.textUnitId ?? null],
    );
    return fuzzy.rows
      .map((row): TextQuoteMatch => ({
        unit: mapTextUnit(row),
        match: "fuzzy",
        score: evidenceSupportScore(input.quote, [String(row.text ?? "")]),
      }))
      .filter((match) => match.score >= FUZZY_QUOTE_CANDIDATE_FLOOR)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async textUnitText(
    input: { textUnitId: string },
    context?: GraphOperationContext,
  ): Promise<string | null> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select text from text_unit where id = $1 and ($2 or owner_id = $3)`,
      [input.textUnitId, !scope.scoped, scope.ownerId],
    );
    return result.rowCount === 1 ? String(result.rows[0].text) : null;
  }

  markTextUnitsServed(textUnitIds: string[], context?: GraphOperationContext): void {
    this.servedUnits.mark(textUnitIds, context);
  }

  textUnitWasServed(input: { textUnitId: string }, context?: GraphOperationContext): boolean {
    return this.servedUnits.wasServed(input.textUnitId, context);
  }

  async supersededBy(nodeIds: string[], context?: GraphOperationContext): Promise<Map<string, { byNodeId: string; byTitle: string }>> {
    const map = new Map<string, { byNodeId: string; byTitle: string }>();
    if (nodeIds.length === 0) return map;
    const scope = ownerScope(context);
    // Only ACTIVE supersedes edges count: an expired/invalidated one is history,
    // not a reason to distrust the atom today.
    const result = await this.pool.query(
      `select e.to_node_id, e.from_node_id, n.title
       from edge e
       join node n on n.id = e.from_node_id and n.deleted_at is null
       where e.predicate = 'supersedes'
         and e.to_node_id = any($1::uuid[])
         and e.deleted_at is null and e.expired_at is null
         and ($2 or e.owner_id = $3)`,
      [nodeIds, !scope.scoped, scope.ownerId],
    );
    for (const row of result.rows) {
      map.set(String(row.to_node_id), { byNodeId: String(row.from_node_id), byTitle: String(row.title) });
    }
    return map;
  }

  async neighborhood(input: NeighborhoodInput, context?: GraphOperationContext): Promise<NeighborhoodResult> {
    const scope = ownerScope(context);
    const maxNodes = Math.max(1, Math.min(500, Math.trunc(input.maxNodes ?? NEIGHBORHOOD_DEFAULT_MAX_NODES)));
    const validAt = input.validAt ?? null;
    const nodeResult = await this.pool.query(
      `with recursive walk as (
         select n.id as node_id, 0 as depth, array[n.id] as path
         from node n
         where n.id = $1 and n.deleted_at is null and ($6 or n.owner_id = $7)
         union all
         select next_node.id as node_id, walk.depth + 1 as depth, walk.path || next_node.id as path
         from walk
         join edge e
           on e.deleted_at is null
          and ($6 or e.owner_id = $7)
          and (e.from_node_id = walk.node_id or e.to_node_id = walk.node_id)
          and ($8::timestamptz is null
            or (e.valid_from <= $8::timestamptz
              and (e.valid_until is null or e.valid_until > $8::timestamptz)))
         join node next_node
           on next_node.deleted_at is null
          and ($6 or next_node.owner_id = $7)
          and next_node.id = case
            when e.from_node_id = walk.node_id then e.to_node_id
            else e.from_node_id
          end
         where walk.depth < $2
           and ($3::text[] is null or e.predicate = any($3::text[]))
           and ($5::boolean
             or ($4::timestamptz is null and e.expired_at is null)
             or ($4::timestamptz is not null
               and e.created_at <= $4::timestamptz
               and (e.expired_at is null or e.expired_at > $4::timestamptz)))
           and not next_node.id = any(walk.path)
       )
       select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at,
              min(walk.depth) as level
       from walk
       join node n on n.id = walk.node_id
       left join node_revision nr on nr.id = n.current_revision_id
       group by n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       order by level, n.id
       limit $9`,
      [input.nodeId, input.depth ?? 1, input.predicates ?? null, input.asOf ?? null, input.includeExpired ?? false, !scope.scoped, scope.ownerId, validAt, maxNodes],
    );
    const nodes = nodeResult.rows.map((row) => ({ ...mapNode(row), level: Number(row.level) }));
    const nodeIds = nodes.map((node) => node.id);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // Edges are owner-filtered like the nodes: with both endpoints in scope a
    // stray edge could still have been written by another tenant (or planted),
    // and it must not surface here any more than in exportGraph.
    const edgeResult = await this.pool.query(
      `select id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by, invalidation_reason
       from edge
       where deleted_at is null
         and ($5 or owner_id = $6)
         and from_node_id = any($1::uuid[])
         and to_node_id = any($1::uuid[])
         and ($4::timestamptz is null
           or (valid_from <= $4::timestamptz
             and (valid_until is null or valid_until > $4::timestamptz)))
         and ($3::boolean
           or ($2::timestamptz is null and expired_at is null)
           or ($2::timestamptz is not null
             and created_at <= $2::timestamptz
             and (expired_at is null or expired_at > $2::timestamptz)))`,
      [nodeIds, input.asOf ?? null, input.includeExpired ?? false, validAt, !scope.scoped, scope.ownerId],
    );

    return { nodes, edges: edgeResult.rows.map(mapEdge) };
  }

  async link(input: LinkInput, context?: GraphOperationContext): Promise<GraphEdge | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const scope = ownerScope(context);
      const fromNodeId = input.fromNodeId ?? await this.nodeIdForSlug(input.fromSlug, client, scope);
      const toNodeId = input.toNodeId ?? await this.nodeIdForSlug(input.toSlug, client, scope);
      // A node id arrives from the client as-is, where a slug was resolved
      // inside the owner's namespace. Both must end the same way: a foreign or
      // tombstoned endpoint is an unknown one, so the link returns null rather
      // than confirming the row exists.
      const endpoints = fromNodeId && toNodeId
        ? await this.visibleIds(client, "node", [fromNodeId, toNodeId], scope)
        : new Set<string>();
      if (!fromNodeId || !toNodeId || !endpoints.has(fromNodeId) || !endpoints.has(toNodeId)) {
        await client.query("rollback");
        return null;
      }

      // World-time integrity. A triple may have one version per instant, and
      // edge_valid_range_excl enforces it across expired versions too; this
      // pre-check exists so the refusal can name the version that owns the
      // interval instead of surfacing a bare constraint error. The active
      // version, if any, is not a conflict: the upsert below turns the call
      // into a weight update on it, and no new row is written.
      const validFrom = input.validFrom ?? null;
      const overlapping = await client.query(overlappingVersionSql, [fromNodeId, toNodeId, input.predicate, validFrom]);
      if (overlapping.rowCount) {
        throw overlapError(String(overlapping.rows[0].id), input.predicate, validFrom);
      }

      let result;
      try {
        result = await client.query(
          `insert into edge (id, from_node_id, to_node_id, predicate, weight, valid_from, created_by, owner_id)
           values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8)
           on conflict (from_node_id, to_node_id, predicate) where deleted_at is null and expired_at is null
           do update set weight = excluded.weight
           returning id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by, invalidation_reason`,
          [randomUUID(), fromNodeId, toNodeId, input.predicate, input.weight, validFrom, actorUuid, scope.ownerId],
        );
      } catch (error) {
        // The pre-check lost a race to a concurrent writer of the same triple;
        // the constraint is the arbiter. Name the committed winner if it is
        // visible from a fresh connection (this one's transaction is aborted).
        if (isExclusionViolation(error, "edge_valid_range_excl")) {
          const winner = await this.pool.query(overlappingVersionSql, [fromNodeId, toNodeId, input.predicate, validFrom]);
          throw overlapError(winner.rowCount ? String(winner.rows[0].id) : null, input.predicate, validFrom);
        }
        throw error;
      }
      const edge = mapEdge(result.rows[0]);
      await this.recordEvent(
        client,
        "link",
        "edge",
        edge.id,
        { predicate: edge.predicate, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId },
        null,
        context,
        actorUuid,
      );

      if (input.supersedesEdgeId && input.supersedesEdgeId !== edge.id) {
        // The successor's validFrom becomes the old edge's validUntil, so it
        // must not precede the old edge's validFrom or edge_valid_range_check
        // would refuse the close. Compared in SQL against the same
        // coalesce(validFrom, now()) the insert used, so the two agree to the
        // microsecond. Owner-scoped like every other write by id.
        const previous = await client.query(
          `select id, valid_from <= coalesce($4::timestamptz, now()) as closes_after_start
           from edge
           where id = $1 and deleted_at is null and expired_at is null and ($2 or owner_id = $3)
           for update`,
          [input.supersedesEdgeId, !scope.scoped, scope.ownerId, validFrom],
        );
        if (previous.rowCount && previous.rows[0].closes_after_start !== true) {
          throw new EdgeValidityConflictError(
            `Cannot supersede edge ${input.supersedesEdgeId}: the new edge's validFrom (${edge.validFrom}) precedes the superseded edge's validFrom.`,
            input.supersedesEdgeId,
          );
        }
        const expired = await client.query(
          `update edge
           set expired_at = now(),
               valid_until = coalesce($2::timestamptz, now()),
               invalidated_by = $3,
               invalidation_reason = 'superseded'
           where id = $1 and deleted_at is null and expired_at is null and ($4 or owner_id = $5)
           returning id`,
          [input.supersedesEdgeId, validFrom, edge.id, !scope.scoped, scope.ownerId],
        );
        if (expired.rowCount && expired.rowCount > 0) {
          await this.recordEvent(
            client,
            "invalidate_edge",
            "edge",
            input.supersedesEdgeId,
            { invalidatedBy: edge.id, validUntil: edge.validFrom },
            null,
            context,
            actorUuid,
          );
        }
      }

      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["lint_graph"]);
      await client.query("commit");
      return edge;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async invalidateEdge(input: InvalidateEdgeInput, context?: GraphOperationContext): Promise<GraphEdge | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const eScope = ownerScope(context);
      const existing = await client.query(
        `select id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by, invalidation_reason
         from edge
         where id = $1 and deleted_at is null and ($2 or owner_id = $3)
         for update`,
        [input.edgeId, !eScope.scoped, eScope.ownerId],
      );
      if (existing.rowCount === 0) {
        await client.query("rollback");
        return null;
      }
      const current = mapEdge(existing.rows[0]);
      if (current.expiredAt !== null) {
        await client.query("rollback");
        return current;
      }

      // Validity cannot end before it began (edge_valid_range_check). A caller
      // who says otherwise is refused, never clamped. With no validUntil the
      // edge closes now -- or, for a future-dated validFrom, at validFrom,
      // which records a belief that never held as an empty interval.
      const updated = await client.query(
        `update edge
         set expired_at = now(),
             valid_until = coalesce($2::timestamptz, greatest(now(), valid_from)),
             invalidation_reason = 'invalidated'
         where id = $1 and ($2::timestamptz is null or $2::timestamptz >= valid_from)
         returning id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by, invalidation_reason`,
        [input.edgeId, input.validUntil ?? null],
      );
      if (updated.rowCount === 0) {
        throw new EdgeValidityConflictError(
          `Cannot invalidate edge ${input.edgeId}: validUntil (${input.validUntil}) precedes its validFrom (${current.validFrom}).`,
          input.edgeId,
        );
      }
      const edge = mapEdge(updated.rows[0]);
      await this.recordEvent(
        client,
        "invalidate_edge",
        "edge",
        edge.id,
        { validUntil: edge.validUntil },
        null,
        context,
        actorUuid,
      );
      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["lint_graph"]);
      await client.query("commit");
      return edge;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async tombstoneNodes(ids: string[], context?: GraphOperationContext): Promise<{ tombstoned: string[] }> {
    const tombstoned: string[] = [];
    for (const id of ids) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const actorUuid = await this.actorUuidForContext(client, context);
        const scope = ownerScope(context);
        // Owner-scoped like update; already-deleted or invisible ids are skipped
        // so repeat calls are no-ops.
        const node = await client.query(
          `update node
           set deleted_at = now(), updated_at = now()
           where id = $1 and deleted_at is null and ($2 or owner_id = $3)
           returning id, title`,
          [id, !scope.scoped, scope.ownerId],
        );
        if (node.rowCount === 0) {
          await client.query("rollback");
          continue;
        }

        // Expire every incident active edge the caller owns, closing validity
        // as well as belief so edge_valid_range_excl frees the triple. A
        // future-dated validFrom closes at validFrom: an empty interval, the
        // record of a belief that never held.
        const edges = await client.query(
          `update edge
           set expired_at = now(),
               valid_until = greatest(now(), valid_from),
               invalidation_reason = 'tombstoned'
           where deleted_at is null and expired_at is null
             and (from_node_id = $1 or to_node_id = $1)
             and ($2 or owner_id = $3)
           returning id`,
          [id, !scope.scoped, scope.ownerId],
        );

        // A tombstoned node's revisions must never surface through semantic
        // search again.
        await client.query(
          `delete from embedding
           where owner_table = 'node_revision'
             and owner_id in (select id from node_revision where node_id = $1)`,
          [id],
        );

        await this.recordEvent(
          client,
          "tombstone",
          "node",
          id,
          { title: String(node.rows[0].title), expiredEdgeIds: edges.rows.map((row) => String(row.id)) },
          null,
          context,
          actorUuid,
        );
        await this.enqueueMaintenanceJobs(client, context, actorUuid, ["lint_graph", "refresh_embeddings"]);
        await client.query("commit");
        tombstoned.push(id);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return { tombstoned };
  }

  async findSimilarTitles(title: string, limit: number, context?: GraphOperationContext): Promise<Array<{ node: GraphNode; score: number }>> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at,
              greatest(
                similarity(n.title, $1),
                case when lower(trim(n.title)) = lower(trim($1)) then 1.0 else 0 end
              ) as score
       from node n
       left join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null
         and ($3 or n.owner_id = $4)
         and (similarity(n.title, $1) > 0.25 or lower(trim(n.title)) = lower(trim($1)))
       order by score desc, n.updated_at desc
       limit $2`,
      [title, limit, !scope.scoped, scope.ownerId],
    );
    return result.rows.map((row) => ({ node: mapNode(row), score: Number(row.score) }));
  }

  async recall(input: RecallInput, context?: GraphOperationContext): Promise<RecallResult> {
    return performRecall(this, input, context);
  }

  async capture(input: CaptureInput, context?: GraphOperationContext): Promise<GraphNode> {
    // Cross-actor race: two concurrent captures can compute the same free slug
    // and one loses to the per-owner slug unique index (23505). Retry the
    // check-then-insert slug loop a bounded number of times before giving up.
    const maxAttempts = 5;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.captureOnce(input, context);
      } catch (error) {
        if (!isSlugUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new Error(`Capture could not allocate a unique slug after ${maxAttempts} attempts.`, { cause: lastError });
  }

  private async captureOnce(input: CaptureInput, context?: GraphOperationContext): Promise<GraphNode> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const scope = ownerScope(context);
      const ownerId = scope.ownerId;
      const id = randomUUID();
      const revisionId = randomUUID();
      const slug = await this.uniqueSlug(slugify(input.title), client, scope);
      const content = input.content ?? null;

      await client.query(
        `insert into node (id, type, slug, title, summary, metadata, owner_id)
         values ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
        [id, input.type, slug, input.title, input.summary, ownerId],
      );
      await client.query(
        `insert into node_revision (
           id, node_id, revision_number, title, summary, content, frontmatter, content_sha256, created_by
         )
         values ($1, $2, 1, $3, $4, $5, '{}'::jsonb, $6, $7)`,
        [revisionId, id, input.title, input.summary, content, sha256(content ?? ""), actorUuid],
      );
      await client.query("update node set current_revision_id = $1 where id = $2", [revisionId, id]);

      await this.attachEvidenceAndLinks(client, id, input.evidence, input.links, context, actorUuid, scope);

      await this.recordEvent(
        client,
        "capture",
        "node",
        id,
        { title: input.title, type: input.type },
        null,
        context,
        actorUuid,
      );
      await this.enqueueMaintenanceJobs(client, context, actorUuid, [
        "lint_graph",
        "refresh_embeddings",
      ]);
      await this.enqueueReconcileJob(client, context, actorUuid, id);
      await client.query("commit");

      const node = await this.read({ nodeId: id }, undefined, { trackAccess: false });
      if (!node) throw new Error("Captured node could not be read back.");
      return stripReadResult(node);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async annotate(input: AnnotateInput, context?: GraphOperationContext): Promise<GraphAnnotation> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const annotation = await this.insertAnnotation(client, input, context, actorUuid);
      await client.query("commit");
      return annotation;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    input: UpdateInput,
    context?: GraphOperationContext,
  ): Promise<GraphNode | { conflict: true; currentRevisionId: string } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const uScope = ownerScope(context);
      const current = await client.query(
        `select n.id, n.title, n.summary, n.current_revision_id, nr.content
         from node n
         left join node_revision nr on nr.id = n.current_revision_id
         where n.id = $1 and n.deleted_at is null and ($2 or n.owner_id = $3)
         for update of n`,
        [input.nodeId, !uScope.scoped, uScope.ownerId],
      );
      if (current.rowCount === 0) {
        await client.query("rollback");
        return null;
      }
      const currentRevisionId = String(current.rows[0].current_revision_id);
      if (currentRevisionId !== input.baseRevisionId) {
        await client.query("rollback");
        return { conflict: true, currentRevisionId };
      }

      const currentTitle = String(current.rows[0].title);
      const currentSummary = current.rows[0].summary == null ? null : String(current.rows[0].summary);
      const currentContent = current.rows[0].content ?? null;
      const nextTitle = input.title ?? currentTitle;
      const nextSummary = input.summary ?? currentSummary;
      const nextContent = input.content ?? currentContent;
      const titleChanged = input.title !== undefined && input.title !== currentTitle;
      const summaryChanged = input.summary !== undefined && input.summary !== currentSummary;
      const contentChanged = input.content !== undefined && input.content !== currentContent;
      const factChanged = titleChanged || summaryChanged || contentChanged;
      let revisionId = currentRevisionId;
      if (factChanged) {
        const revisionNumberResult = await client.query(
          "select coalesce(max(revision_number), 0) + 1 as next_revision from node_revision where node_id = $1",
          [input.nodeId],
        );
        revisionId = randomUUID();
        await client.query(
          `insert into node_revision (
             id, node_id, revision_number, title, summary, content, frontmatter, content_sha256, created_by
           )
           values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8)`,
          [
            revisionId,
            input.nodeId,
            revisionNumberResult.rows[0].next_revision,
            nextTitle,
            nextSummary,
            nextContent,
            sha256(nextContent ?? ""),
            actorUuid,
          ],
        );
      }

      let nextSlug: string | null = null;
      if (input.slug) {
        const base = slugify(input.slug);
        const collision = await client.query(
          "select id from node where slug = $1 and ($2 or owner_id = $3)",
          [base, !uScope.scoped, uScope.ownerId],
        );
        nextSlug = collision.rowCount === 0 || collision.rows[0].id === input.nodeId
          ? base
          : await this.uniqueSlug(base, client, uScope);
      }

      await client.query(
        `update node
         set title = coalesce($1, title),
             summary = coalesce($2, summary),
             slug = coalesce($3, slug),
             current_revision_id = $4,
             updated_at = now()
         where id = $5`,
        [input.title ?? null, input.summary ?? null, nextSlug, revisionId, input.nodeId],
      );
      if (revisionId !== currentRevisionId) {
        // Superseded revisions lose their embeddings so semantic search can
        // never resurrect replaced content under the current revisionId.
        await client.query(
          `delete from embedding
           where owner_table = 'node_revision'
             and owner_id in (select id from node_revision where node_id = $1 and id <> $2)`,
          [input.nodeId, revisionId],
        );
      }
      await this.attachEvidenceAndLinks(client, input.nodeId, input.evidence ?? [], input.links ?? [], context, actorUuid, uScope);
      await this.recordEvent(
        client,
        "update",
        "node",
        input.nodeId,
        { revisionId, title: input.title, summary: input.summary, slug: nextSlug ?? undefined },
        { revisionId: currentRevisionId },
        context,
        actorUuid,
      );
      await this.enqueueMaintenanceJobs(client, context, actorUuid, [
        "lint_graph",
        "refresh_embeddings",
      ]);
      // Preserve reconcile cadence: title/summary revisions refresh search,
      // but only body changes introduce claims for the reconcile judge.
      if (contentChanged) {
        await this.enqueueReconcileJob(client, context, actorUuid, input.nodeId);
      }
      await client.query("commit");

      const updated = await this.read({ nodeId: input.nodeId }, undefined, { trackAccess: false });
      return updated ? stripReadResult(updated) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async project(input: ProjectInput, context?: GraphOperationContext): Promise<ProjectResult | null> {
    // Projection is a system read (exportMarkdown walks every node); it must
    // not inflate activation counts.
    const read = await this.read({ nodeId: input.nodeId }, context, { trackAccess: false });
    if (!read) return null;
    const node = stripReadResult(read);
    const neighborhood = await this.neighborhood({ nodeId: node.id, depth: input.depth }, context);
    const evidence = read.evidence.filter(isTextUnit);

    if (input.format === "mind_map") {
      return { format: "mind_map", ...neighborhood };
    }

    // markdown and agent_context both carry the evidence text — that is a serve.
    this.servedUnits.mark(evidence.map((unit) => unit.id), context);

    if (input.format === "agent_context") {
      return {
        format: "agent_context",
        context: renderAgentContext(node, evidence, neighborhood),
        evidence,
      };
    }

    return {
      format: "markdown",
      content: renderMarkdownProjection(node, evidence, neighborhood),
    };
  }

  async timeline(context?: GraphOperationContext): Promise<GraphEvent[]> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select ge.id, ge.action, ge.entity_table, ge.entity_id, ge.actor_id, a.handle as actor_handle,
              ge.interface_id, ge.request_id, ge.created_at
       from graph_event ge
       left join actor a on a.id = ge.actor_id
       where ($1 or ge.owner_id = $2)
       order by ge.created_at desc
       limit 100`,
      [!scope.scoped, scope.ownerId],
    );
    return result.rows.map(mapEvent);
  }

  async events(input: EventFeedInput = { limit: 100 }, context?: GraphOperationContext): Promise<GraphEventFeed> {
    const after = input.afterCursor ? decodeEventCursor(input.afterCursor) : null;
    const descending = input.order === "desc";
    const scope = ownerScope(context);
    // The cursor carries `cursor_at`, not the event's `createdAt`. Postgres
    // keeps created_at to the microsecond while a JS ISO string stops at the
    // millisecond, so a cursor built from the mapped event pointed at a moment
    // just BEFORE the row it was meant to resume after — and the keyset
    // predicate handed that row back on the next page. Every page boundary
    // re-served its last row to anything syncing through the feed.
    const result = await this.pool.query(
      `select ge.id, ge.action, ge.entity_table, ge.entity_id, ge.actor_id, a.handle as actor_handle,
              ge.interface_id, ge.request_id, ge.created_at,
              to_char(ge.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
       from graph_event ge
       left join actor a on a.id = ge.actor_id
       where ($4 or ge.owner_id = $5) and ($1::timestamptz is null or ${descending
         ? "(ge.created_at, ge.id) < ($1::timestamptz, $2::uuid)"
         : "(ge.created_at, ge.id) > ($1::timestamptz, $2::uuid)"})
       order by ge.created_at ${descending ? "desc" : "asc"}, ge.id ${descending ? "desc" : "asc"}
       limit $3`,
      [after?.createdAt ?? null, after?.id ?? null, input.limit + 1, !scope.scoped, scope.ownerId],
    );
    const rows = result.rows.slice(0, input.limit);
    const events = rows.map(mapEvent);
    const last = rows.at(-1);
    return {
      events,
      nextCursor: last
        ? encodeEventCursor({ createdAt: String(last.cursor_at), id: String(last.id) })
        : input.afterCursor ?? null,
      hasMore: result.rows.length > rows.length,
    };
  }

  /**
   * Day and action rollups, aggregated in the database.
   *
   * The dashboard used to build these by paging the feed oldest-first, capped
   * at 20 pages of 500. Once the log passed 10,000 events the walk ran out
   * before it reached the newest days, so the cadence chart read zero for
   * everything after the cutoff while the graph itself was plainly growing —
   * and the truncation flag compared the post-smoke-filter count against the
   * raw cap, so it never fired. Aggregate; never paginate a whole-log rollup.
   */
  async eventStats(context?: GraphOperationContext): Promise<GraphEventStats> {
    const scope = ownerScope(context);
    // Bucket in UTC to match the ISO dates the rest of the API reports.
    // actor_id is a uuid here, so the "-smoke" check that the feed applies to
    // it can never match; handle and interface are the ones that carry the tag.
    const result = await this.pool.query(
      `select to_char(ge.created_at at time zone 'UTC', 'YYYY-MM-DD') as date,
              ge.action as action,
              count(*)::int as count
       from graph_event ge
       left join actor a on a.id = ge.actor_id
       where ($1 or ge.owner_id = $2)
         and coalesce(a.handle, '') not like '%-smoke'
         and coalesce(ge.interface_id, '') not like '%-smoke'
       group by 1, 2
       order by 1`,
      [!scope.scoped, scope.ownerId],
    );

    const writeActions = new Set(WRITE_ACTIONS);
    const perDay = new Map<string, { date: string; total: number; writes: number }>();
    const actions = new Map<string, number>();
    let total = 0;
    for (const row of result.rows) {
      const date = String(row.date);
      const action = String(row.action);
      const count = Number(row.count);
      const entry = perDay.get(date) ?? { date, total: 0, writes: 0 };
      entry.total += count;
      if (writeActions.has(action)) entry.writes += count;
      perDay.set(date, entry);
      actions.set(action, (actions.get(action) ?? 0) + count);
      total += count;
    }

    return {
      total,
      perDay: [...perDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
      actions: [...actions.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
    };
  }

  async lint(context?: GraphOperationContext): Promise<GraphLintReport> {
    const scope = ownerScope(context);
    const p: [boolean, string | null] = [!scope.scoped, scope.ownerId];
    const [nodeCount, edgeCount, orphanNodes, missingEvidence, duplicateTitles, danglingEdges, evidenceRows, reconcileFlags] = await Promise.all([
      this.pool.query("select count(*)::int as count from node where deleted_at is null and ($1 or owner_id = $2)", p),
      this.pool.query("select count(*)::int as count from edge where deleted_at is null and expired_at is null and ($1 or owner_id = $2)", p),
      this.pool.query(
        `select n.id, n.title
         from node n
         left join edge e on e.deleted_at is null and e.expired_at is null and (e.from_node_id = n.id or e.to_node_id = n.id)
         where n.deleted_at is null and ($1 or n.owner_id = $2)
         group by n.id, n.title
         having count(e.id) = 0
         order by n.updated_at desc
         limit 50`,
        p,
      ),
      this.pool.query(
        `select n.id, n.title
         from node n
         left join annotation a on a.node_id = n.id and ($1 or a.owner_id = $2)
         where n.deleted_at is null and ($1 or n.owner_id = $2)
         group by n.id, n.title
         having count(a.id) = 0
         order by n.updated_at desc
         limit 50`,
        p,
      ),
      this.pool.query(
        `select lower(title) as title_key, count(*)::int as count
         from node
         where deleted_at is null and ($1 or owner_id = $2)
         group by lower(title)
         having count(*) > 1
         order by count(*) desc, lower(title)
         limit 50`,
        p,
      ),
      this.pool.query(
        `select e.id
         from edge e
         left join node from_node on from_node.id = e.from_node_id and from_node.deleted_at is null
         left join node to_node on to_node.id = e.to_node_id and to_node.deleted_at is null
         where e.deleted_at is null and e.expired_at is null and ($1 or e.owner_id = $2)
           and (from_node.id is null or to_node.id is null)
         limit 50`,
        p,
      ),
      // weak_evidence: nodes WITH citations, scored for whether the cited span
      // actually supports the atom. Content is capped per node — the score
      // uses the same leading slice reconcile judges on.
      this.pool.query(
        `select n.id, n.title, coalesce(n.summary, '') as summary, left(coalesce(nr.content, ''), 2000) as content,
                tu.text as unit_text
         from node n
         join annotation a on a.node_id = n.id and a.text_unit_id is not null and ($1 or a.owner_id = $2)
         join text_unit tu on tu.id = a.text_unit_id
         left join node_revision nr on nr.id = n.current_revision_id
         where n.deleted_at is null and ($1 or n.owner_id = $2)`,
        p,
      ),
      // reconcile_duplicate / reconcile_contradiction: what the write-time
      // reconciliation judge already decided (022_reconcile_flag.sql). Joining
      // through `node` twice both resolves the pair's slugs for the message and
      // drops any flag whose endpoint has since been tombstoned.
      this.pool.query(
        `select f.code, f.detail,
                n.id as node_id, n.title as node_title, n.slug as node_slug,
                o.id as other_id, o.title as other_title, o.slug as other_slug
         from reconcile_flag f
         join node n on n.id = f.node_id and n.deleted_at is null
         join node o on o.id = f.other_node_id and o.deleted_at is null
         where ($1 or f.owner_id = $2)
         order by f.created_at desc, f.node_id, f.code
         limit $3`,
        [...p, RECONCILE_FINDING_LIMIT],
      ),
    ]);

    const findings: GraphLintFinding[] = [];

    for (const row of orphanNodes.rows) {
      findings.push({
        severity: "warning",
        code: "orphan_node",
        entityTable: "node",
        entityId: String(row.id),
        message: `Node has no graph edges: ${row.title}`,
      });
    }

    for (const row of missingEvidence.rows) {
      findings.push({
        severity: "warning",
        code: "missing_evidence",
        entityTable: "node",
        entityId: String(row.id),
        message: `Node has no evidence annotation: ${row.title}`,
      });
    }

    for (const row of duplicateTitles.rows) {
      findings.push({
        severity: "warning",
        code: "duplicate_title",
        count: Number(row.count),
        message: `Multiple nodes share title: ${row.title_key}`,
      });
    }

    for (const row of danglingEdges.rows) {
      findings.push({
        severity: "error",
        code: "dangling_edge",
        entityTable: "edge",
        entityId: String(row.id),
        message: "Edge points at a missing or deleted node.",
      });
    }

    // weak_evidence: a citation that is present but probably wrong. Group the
    // joined rows per node, score against the best cited unit, flag under the
    // floor — capped so a bulk mis-ingest cannot flood the report.
    const evidenceByNode = new Map<string, { title: string; nodeText: string; units: string[] }>();
    for (const row of evidenceRows.rows) {
      const id = String(row.id);
      const entry = evidenceByNode.get(id) ?? {
        title: String(row.title),
        nodeText: `${row.title}\n${row.summary}\n${row.content}`,
        units: [] as string[],
      };
      entry.units.push(String(row.unit_text));
      evidenceByNode.set(id, entry);
    }
    let weakEvidenceCount = 0;
    for (const [id, entry] of evidenceByNode) {
      if (weakEvidenceCount >= 50) break;
      const score = evidenceSupportScore(entry.nodeText, entry.units);
      if (score < WEAK_EVIDENCE_FLOOR) {
        findings.push({
          severity: "warning",
          code: "weak_evidence",
          entityTable: "node",
          entityId: id,
          message: `Cited evidence supports ${(score * 100).toFixed(0)}% of the node's content terms (floor ${WEAK_EVIDENCE_FLOOR * 100}%): ${entry.title}`,
        });
        weakEvidenceCount += 1;
      }
    }

    for (const row of reconcileFlags.rows) {
      findings.push(reconcileLintFinding({
        code: row.code as ReconcileFlagCode,
        node: { id: String(row.node_id), title: String(row.node_title), slug: String(row.node_slug) },
        other: { id: String(row.other_id), title: String(row.other_title), slug: String(row.other_slug) },
        detail: String(row.detail ?? ""),
      }));
    }

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        nodes: Number(nodeCount.rows[0]?.count ?? 0),
        edges: Number(edgeCount.rows[0]?.count ?? 0),
        findings: findings.length,
        errors,
        warnings,
      },
      findings,
    };
  }

  async recordReconcileFlags(
    input: { nodeId: string; flags: ReconcileFlag[] },
    context?: GraphOperationContext,
  ): Promise<void> {
    const scope = ownerScope(context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Replace, in one transaction: the pass that just ran is the whole truth
      // about this node, so a stale flag never outlives the verdict behind it.
      await client.query(
        "delete from reconcile_flag where node_id = $1 and ($2 or owner_id = $3)",
        [input.nodeId, !scope.scoped, scope.ownerId],
      );
      // At most MAX_CANDIDATES flags per pass, so the loop is bounded by
      // construction; the upsert guards a concurrent pass on the same pair.
      for (const flag of input.flags) {
        await client.query(
          `insert into reconcile_flag (owner_id, node_id, other_node_id, code, detail)
           values ($1, $2, $3, $4, $5)
           on conflict (node_id, other_node_id, code)
           do update set detail = excluded.detail, created_at = now()`,
          [scope.ownerId, input.nodeId, flag.otherNodeId, flag.code, flag.detail.slice(0, 500)],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async exportMarkdown(context?: GraphOperationContext): Promise<Record<string, string>> {
    // One project() per node meant a read() plus a recursive neighborhood()
    // each -- around six round trips per node, ~9k across 1,432 nodes, every one
    // of them crossing a region boundary in production. That is what made
    // refresh_obsidian_projection take 10-20 minutes, and slow enough that three
    // consecutive deploys killed it mid-flight: it sat 'running' from
    // 2026-07-04 until the job lease finally reclaimed it, blocking its dedupe
    // key the entire time. The whole vault is derivable from three bulk reads,
    // so take those and assemble the depth-1 neighbourhoods in memory.
    const snapshot = await this.exportGraph(context);
    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const evidenceByNode = await this.getEvidenceForNodes([...nodesById.keys()], context);

    const neighbourIds = new Map<string, Set<string>>(snapshot.nodes.map((node) => [node.id, new Set()]));
    for (const edge of snapshot.edges) {
      neighbourIds.get(edge.fromNodeId)?.add(edge.toNodeId);
      neighbourIds.get(edge.toNodeId)?.add(edge.fromNodeId);
    }

    const files: Record<string, string> = {};
    for (const node of snapshot.nodes) {
      const evidence = evidenceByNode.get(node.id) ?? [];
      // Mirrors neighborhood({depth: 1}): the root sits at level 0 and
      // everything one live edge away at level 1, ordered by (level, id) and
      // capped by the same maxNodes -- which counts the root, so the slice
      // stays on the combined list rather than on the neighbours alone.
      const related = [...(neighbourIds.get(node.id) ?? [])]
        .filter((id) => id !== node.id)
        .map((id) => nodesById.get(id))
        .filter((neighbour): neighbour is GraphNode => neighbour !== undefined)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const neighbourhood = {
        nodes: [node, ...related].slice(0, NEIGHBORHOOD_DEFAULT_MAX_NODES),
        edges: [] as GraphEdge[],
      };
      // project() counts a markdown render as a serve; preserve that here.
      this.servedUnits.mark(evidence.map((unit) => unit.id), context);
      files[`${node.slug}.md`] = renderMarkdownProjection(node, evidence, neighbourhood);
    }
    return files;
  }

  async exportGraph(context?: GraphOperationContext): Promise<GraphSnapshot> {
    const scope = ownerScope(context);
    const p: [boolean, string | null] = [!scope.scoped, scope.ownerId];
    const nodeResult = await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from node n
       left join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null and ($1 or n.owner_id = $2)
       order by n.slug`,
      p,
    );
    const edgeResult = await this.pool.query(
      `select e.id, e.from_node_id, e.to_node_id, e.predicate, e.weight, e.created_at, e.valid_from, e.valid_until, e.expired_at, e.invalidated_by, e.invalidation_reason
       from edge e
       join node from_node on from_node.id = e.from_node_id and from_node.deleted_at is null
       join node to_node on to_node.id = e.to_node_id and to_node.deleted_at is null
       where e.deleted_at is null and e.expired_at is null and ($1 or e.owner_id = $2)
       order by e.predicate, e.id`,
      p,
    );

    return {
      nodes: nodeResult.rows.map(mapNode),
      edges: edgeResult.rows.map(mapEdge),
      views: await this.views({ limit: 100 }, context),
    };
  }

  async createView(input: CreateViewInput, context?: GraphOperationContext): Promise<GraphViewSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const scope = ownerScope(context);
      const id = randomUUID();
      const slug = await this.uniqueViewSlug(slugify(input.slug ?? input.title), client, scope);
      const resolved = await this.resolveViewMembers(client, input, context);

      const result = await client.query(
        `insert into graph_view (
           id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids, summary, created_by, owner_id
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid[], $8::uuid[], $9, $10, $11)
         returning id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
                   summary, created_at, updated_at`,
        [
          id,
          slug,
          input.title,
          resolved.rootNodeId,
          input.query ?? null,
          JSON.stringify(input.layout),
          resolved.nodeIds,
          resolved.edgeIds,
          input.summary ?? null,
          actorUuid,
          ownerScope(context).ownerId,
        ],
      );
      const view = mapView(result.rows[0]);
      await this.recordEvent(
        client,
        "create_view",
        "graph_view",
        view.id,
        { title: view.title, slug: view.slug, nodes: view.includedNodeIds.length, edges: view.includedEdgeIds.length },
        null,
        context,
        actorUuid,
      );
      await client.query("commit");
      return await this.snapshotForView(view);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async views(input: ListViewsInput = { limit: 25 }, context?: GraphOperationContext): Promise<GraphView[]> {
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
              summary, created_at, updated_at
       from graph_view
       where ($3 or owner_id = $4)
         and ($1::text is null or title ilike $1 or coalesce(summary, '') ilike $1 or coalesce(query, '') ilike $1)
       order by updated_at desc
       limit $2`,
      [input.query ? `%${input.query}%` : null, input.limit ?? 25, !scope.scoped, scope.ownerId],
    );
    return result.rows.map(mapView);
  }

  async readView(input: ReadViewInput, context?: GraphOperationContext): Promise<GraphViewSnapshot | null> {
    const scope = ownerScope(context);
    const params = [input.viewId ?? input.slug, !scope.scoped, scope.ownerId];
    const predicate = input.viewId ? "id = $1" : "slug = $1";
    const result = await this.pool.query(
      `select id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
              summary, created_at, updated_at
       from graph_view
       where ${predicate} and ($2 or owner_id = $3)
       limit 1`,
      params,
    );
    if (result.rowCount === 0) return null;
    return await this.snapshotForView(mapView(result.rows[0]));
  }

  async deleteView(input: DeleteViewInput, context?: GraphOperationContext): Promise<{ deleted: boolean; view: GraphView | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const dScope = ownerScope(context);
      const params = [input.viewId ?? input.slug, !dScope.scoped, dScope.ownerId];
      const predicate = input.viewId ? "id = $1" : "slug = $1";
      const result = await client.query(
        `delete from graph_view
         where ${predicate} and ($2 or owner_id = $3)
         returning id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
                   summary, created_at, updated_at`,
        params,
      );
      if (result.rowCount === 0) {
        await client.query("commit");
        return { deleted: false, view: null };
      }
      const view = mapView(result.rows[0]);
      await this.recordEvent(
        client,
        "delete_view",
        "graph_view",
        view.id,
        { title: view.title, slug: view.slug },
        null,
        context,
        actorUuid,
      );
      await client.query("commit");
      return { deleted: true, view };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueJob(input: EnqueueJobInput, context?: GraphOperationContext): Promise<GraphJob> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const job = await this.enqueueJobWithClient(client, input, context, actorUuid);
      await client.query("commit");
      return job;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async jobs(input: ListJobsInput = { limit: 25 }, context?: GraphOperationContext): Promise<GraphJob[]> {
    // Same scoping as every other read: a scoped caller sees only rows stamped
    // with their owner. Global (NULL-owner) rows are operator work and are
    // listed only to unscoped callers, so a lint over the whole graph never
    // shows one tenant another tenant's node titles.
    const scope = ownerScope(context);
    const result = await this.pool.query(
      `select ${JOB_COLUMNS}
       from graph_job
       where ($1::text is null or status = $1)
         and ($2::text is null or kind = $2)
         and ($4 or owner_id = $5)
       order by created_at desc
       limit $3`,
      [input.status ?? null, input.kind ?? null, input.limit ?? 25, !scope.scoped, scope.ownerId],
    );
    return result.rows.map(mapJob);
  }

  async runJob(input: RunJobInput = {}, context?: GraphOperationContext): Promise<GraphJob | null> {
    const claimed = await this.claimJob(input.jobId);
    if (!claimed) return null;
    if (claimed.job.status !== "running" || !claimed.claimant) return claimed.job;

    // The lease is only as good as its renewal. Nothing used to touch
    // updated_at while a job ran, so a slow-but-healthy embedding drain (many
    // provider round trips) looked exactly like a dead worker once it passed
    // JOB_LEASE_SECONDS, got reclaimed, and ran twice. The heartbeat renews
    // under this claim only; once another worker holds the row it stops.
    const heartbeat = this.startLeaseHeartbeat(claimed.job.id, claimed.claimant);
    let outcome: { status: "succeeded"; result: GraphJobResult } | { status: "failed"; error: string };
    try {
      outcome = { status: "succeeded", result: await this.performJob(claimed.job) };
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : "Unknown job error" };
    } finally {
      // Stop before finishing, or a beat can land after the row is closed and
      // report a lease we gave up on purpose.
      heartbeat.stop();
    }
    return outcome.status === "succeeded"
      ? await this.finishJob(claimed.job, claimed.claimant, "succeeded", outcome.result, null, context)
      : await this.finishJob(claimed.job, claimed.claimant, "failed", null, outcome.error, context);
  }

  private startLeaseHeartbeat(jobId: string, claimant: string): { stop(): void } {
    let inFlight = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      this.pool.query(
        `update graph_job
            set updated_at = now()
          where id = $1 and status = 'running' and claimed_by = $2`,
        [jobId, claimant],
      ).then((updated) => {
        if (stopped) return;
        if ((updated.rowCount ?? 0) === 0) {
          // Reclaimed or retired under us. The work in flight cannot be
          // cancelled, but finishJob's guard will drop its result; no point
          // renewing a lease we no longer hold.
          console.warn(`[jobs] lease for ${jobId} is no longer held by ${claimant}; the in-flight result will be dropped`);
          clearInterval(timer);
        }
      }).catch((error: unknown) => {
        console.warn(`[jobs] lease heartbeat for ${jobId} failed:`, error instanceof Error ? error.message : error);
      }).finally(() => {
        inFlight = false;
      });
    }, leaseHeartbeatMs());
    timer.unref?.();
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Drain a window's worth of read strengthening in one statement. `unnest`
   * keeps the parameter count at three however many nodes ride along (the same
   * shape the embedding backfill uses), and `greatest` means a bump can only
   * move `last_accessed_at` forward — an out-of-order flush cannot rewind it.
   */
  private async writeActivation(bumps: ActivationBump[]): Promise<void> {
    const CHUNK = 1_000;
    for (let start = 0; start < bumps.length; start += CHUNK) {
      const slice = bumps.slice(start, start + CHUNK);
      await this.pool.query(
        `update node
            set access_count = node.access_count + b.n,
                last_accessed_at = greatest(node.last_accessed_at, b.read_at)
           from unnest($1::uuid[], $2::bigint[], $3::timestamptz[]) as b(id, n, read_at)
          where node.id = b.id and node.deleted_at is null`,
        [
          slice.map((bump) => bump.nodeId),
          slice.map((bump) => bump.count),
          slice.map((bump) => bump.lastAccessedAt.toISOString()),
        ],
      );
    }
  }

  /** Write buffered activation immediately. Used by shutdown paths and tests. */
  async flushActivation(): Promise<void> {
    await this.activation.flush();
  }

  async close(): Promise<void> {
    // Before the pool goes away: buffered bumps have nowhere else to land.
    await this.activation.close();
    await this.pool.end();
  }

  async health(): Promise<{ ok: true }> {
    await this.pool.query("select 1");
    return { ok: true };
  }

  /**
   * Maintenance work a mutation leaves behind. Dedupe collapses a burst of
   * writes into one pending row per key.
   *
   * Lint is per owner: the key is `maintenance:lint_graph:<ownerId>` and the
   * payload carries the owner, so the job runs `lint()` under that owner's
   * scope and its findings (node ids and titles) belong to the tenant whose
   * write caused them. An unscoped writer (superuser, worker) gets the global
   * key with no owner, which is also what an operator-triggered lint uses —
   * the only way a lint runs over everyone's graph.
   *
   * Embedding refresh stays under the global key: its result is counts, not
   * data, and one drain over every owner's missing rows is cheaper than one
   * per tenant. The importer's owner-scoped drain keys itself.
   *
   * Lint is also throttled here, at the one place every mutation funnels
   * through: dedupe collapses a burst into one row, but steady state was
   * still a full lint after every single write. A scope whose lint succeeded
   * within TROVE_LINT_MIN_INTERVAL_SECONDS (default 600) gets no new lint;
   * the first write past the window does. The check is keyed on the same
   * dedupe key the job would take, so operator-triggered lints with their own
   * keys never count.
   */
  private async enqueueMaintenanceJobs(
    client: pg.PoolClient,
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
    kinds: Array<GraphJob["kind"]>,
  ): Promise<void> {
    const scope = ownerScope(context);
    for (const kind of kinds) {
      const scoped = kind === "lint_graph" && scope.scoped && scope.ownerId !== null;
      const dedupeKey = scoped ? `maintenance:${kind}:${scope.ownerId}` : `maintenance:${kind}`;
      if (kind === "lint_graph" && await this.lintSucceededRecently(client, dedupeKey)) continue;
      await this.enqueueJobWithClient(client, {
        kind,
        payload: scoped ? { reason: "graph_mutation", ownerId: scope.ownerId } : { reason: "graph_mutation" },
        priority: kind === "refresh_embeddings" ? 40 : 60,
        dedupeKey,
      }, context, actorUuid);
    }
  }

  private async lintSucceededRecently(client: pg.PoolClient, dedupeKey: string): Promise<boolean> {
    const interval = lintMinIntervalSeconds();
    if (interval <= 0) return false;
    const recent = await client.query(
      `select 1
       from graph_job
       where kind = 'lint_graph'
         and dedupe_key = $1
         and status = 'succeeded'
         and finished_at > now() - make_interval(secs => $2::numeric)
       limit 1`,
      [dedupeKey, interval],
    );
    return (recent.rowCount ?? 0) > 0;
  }

  /**
   * Housekeeping that rides on the lint job, which already runs at most once
   * per interval per scope: drop terminal rows past the retention window. An
   * open row is never touched, whatever its age -- the lease handles those.
   */
  private async pruneTerminalJobs(): Promise<number> {
    const pruned = await this.pool.query(
      `delete from graph_job
       where status in ('succeeded', 'failed', 'dead', 'cancelled')
         and coalesce(finished_at, updated_at) < now() - make_interval(days => $1::int)`,
      [TERMINAL_JOB_RETENTION_DAYS],
    );
    return pruned.rowCount ?? 0;
  }

  /**
   * The same housekeeping for the audit log: drop events past
   * TROVE_EVENT_RETENTION_DAYS. graph_event is append-only and nothing ever
   * removed a row, so it grew on every single write forever.
   *
   * Deliberately batched rather than one predicate-wide delete. A log that has
   * never been trimmed can hold years of rows, and this runs on a request
   * thread inside the lint job: an unbounded delete would hold locks and write
   * one enormous WAL record. Each statement takes the oldest EVENT_PRUNE_BATCH_ROWS
   * past the horizon, the run stops at eventPruneMaxRows(), and the next lint
   * picks up whatever is left. Ordering by created_at makes the batch an index
   * scan on graph_event_created_at_idx (migration 019) rather than a seq scan.
   *
   * Global, not owner-scoped, exactly like the job prune: the horizon is a
   * property of the table, and one tenant's lint has no business leaving
   * another tenant's expired rows behind.
   */
  private async pruneEvents(): Promise<number> {
    const days = eventRetentionDays();
    if (days <= 0) return 0;
    const maxRows = eventPruneMaxRows();
    let pruned = 0;
    while (pruned < maxRows) {
      const batch = Math.min(EVENT_PRUNE_BATCH_ROWS, maxRows - pruned);
      const deleted = await this.pool.query(
        `delete from graph_event
         where id in (
           select id from graph_event
           where created_at < now() - make_interval(days => $1::int)
           order by created_at
           limit $2
         )`,
        [days, batch],
      );
      const count = deleted.rowCount ?? 0;
      pruned += count;
      if (count < batch) break;
    }
    return pruned;
  }

  /**
   * Reconciliation runs per node, below the other maintenance jobs in priority
   * (it is the expensive, LLM-judged pass). Dedupe is per node: a burst of
   * revisions to the same node collapses into one run, which reads the current
   * revision at claim time.
   *
   * Note the contrast with the `maintenance:*` keys above: those cover a whole
   * scope (one owner's lint, or the global embedding drain), so concurrent
   * writers in that scope sharing one pending row is CORRECT — the job covers
   * all of their data — while reconciliation is per-node work and must never
   * absorb across nodes. The `dedupeJoined` return marker lets a caller
   * observe either absorption.
   */
  private async enqueueReconcileJob(
    client: pg.PoolClient,
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
    nodeId: string,
  ): Promise<void> {
    await this.enqueueJobWithClient(client, {
      kind: "reconcile_node",
      payload: { reason: "graph_mutation", nodeId, ownerId: ownerScope(context).ownerId },
      priority: 30,
      dedupeKey: `reconcile:${nodeId}`,
    }, context, actorUuid);
  }

  private async enqueueJobWithClient(
    client: pg.PoolClient,
    input: EnqueueJobInput,
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
  ): Promise<GraphJob> {
    if (input.dedupeKey) {
      const existing = await client.query(
        `select ${JOB_COLUMNS}
         from graph_job
         where kind = $1
           and dedupe_key = $2
           and status in ('pending', 'running')
         order by created_at
         limit 1`,
        [input.kind, input.dedupeKey],
      );
      if ((existing.rowCount ?? 0) > 0) return { ...mapJob(existing.rows[0]), dedupeJoined: true };
    }

    // Insert, or join the open row that beat us to the dedupe key. Two rounds:
    // the open row we lose to can finish between our conflicting insert and
    // the reselect, which frees the key again -- reading rows[0] off the
    // conflicted insert in that gap was a TypeError with no job to show for
    // it. If the key is still contended after a retry something is wrong with
    // the queue, and that deserves a named error rather than a crash.
    let inserted: pg.QueryResult | null = null;
    for (let round = 0; round < 2 && inserted === null; round += 1) {
      const attempt = await client.query(
        `insert into graph_job (id, kind, priority, payload, dedupe_key, created_by, owner_id)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7)
         on conflict do nothing
         returning ${JOB_COLUMNS}`,
        [
          randomUUID(),
          input.kind,
          input.priority,
          JSON.stringify(input.payload),
          input.dedupeKey ?? null,
          actorUuid,
          // Stamped like every other write: the row belongs to the context that
          // enqueued it, and NULL (unscoped) marks operator/worker work.
          ownerScope(context).ownerId,
        ],
      );
      if ((attempt.rowCount ?? 0) > 0) {
        inserted = attempt;
        break;
      }
      if (!input.dedupeKey) throw new Error(`enqueueJob: insert of ${input.kind} returned no row`);
      const existing = await client.query(
        `select ${JOB_COLUMNS}
         from graph_job
         where kind = $1
           and dedupe_key = $2
           and status in ('pending', 'running')
         order by created_at
         limit 1`,
        [input.kind, input.dedupeKey],
      );
      if ((existing.rowCount ?? 0) > 0) return { ...mapJob(existing.rows[0]), dedupeJoined: true };
    }
    if (inserted === null) {
      throw new Error(
        `enqueueJob: ${input.kind} with dedupe key ${input.dedupeKey} conflicted twice but no pending/running row holds that key`,
      );
    }
    const job = mapJob(inserted.rows[0]);
    await this.recordEvent(
      client,
      "enqueue_job",
      "graph_job",
      job.id,
      { kind: job.kind, dedupeKey: job.dedupeKey },
      null,
      context,
      actorUuid,
    );
    return job;
  }

  /**
   * Claim the next runnable job (or one job by id). `claimant` is set only when
   * this call moved the row to 'running': it is the value written to
   * claimed_by, unique per claim, and the only token that may finish the row.
   * A job returned without a claimant was merely looked up (not runnable now).
   */
  private async claimJob(jobId?: string): Promise<{ job: GraphJob; claimant: string | null } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Retire lease-expired rows that have spent their attempts. Without this
      // the lease below leaves a hole exactly the shape of the bug it fixes: a
      // job that hangs often enough to exhaust `attempts` stops matching
      // `attempts < JOB_MAX_ATTEMPTS`, so it sits 'running' forever and
      // graph_job_open_dedupe_idx keeps blocking every new job of its kind.
      // Retiring it to 'failed' frees the dedupe key (the index only covers
      // pending/running) while still refusing to run it again.
      await client.query(
        `update graph_job
            set status = 'failed',
                finished_at = now(),
                updated_at = now(),
                error = coalesce(nullif(error, ''), 'Lease expired with attempts exhausted; retired so its dedupe key stops blocking new jobs of this kind.')
          where status = 'running'
            and attempts >= $1
            and updated_at < now() - make_interval(secs => $2::numeric)`,
        [JOB_MAX_ATTEMPTS, jobLeaseSeconds()],
      );
      // Retire failed rows that a live row of the same kind and dedupe key
      // already covers. The retry branch below would otherwise flip such a row
      // to 'running', and graph_job_open_dedupe_idx covers pending AND running,
      // so the claim raises a unique violation, the transaction rolls back, and
      // the error escapes the worker tick BEFORE anything is drained. That is
      // not hypothetical: production wedged exactly this way from 2026-09-02,
      // logging "duplicate key value violates unique constraint
      // graph_job_open_dedupe_idx" every 30 seconds with 55 jobs pending and
      // none running, after two jobs failed on a statement timeout during the
      // disk-full outage. The retry is redundant anyway — the pending row does
      // the same work — so retiring it loses nothing.
      await client.query(
        `update graph_job f
            set status = 'dead',
                finished_at = now(),
                updated_at = now(),
                error = coalesce(nullif(f.error, ''), 'Superseded before retry.')
                        || ' | Retired: a live job of the same kind and dedupe key already covers this work.'
          where f.status = 'failed'
            and f.dedupe_key is not null
            and exists (
              select 1 from graph_job live
               where live.kind = f.kind
                 and live.dedupe_key = f.dedupe_key
                 and live.status in ('pending', 'running')
            )`,
      );
      const result = await client.query(
        `select id
         from graph_job
         where (
             status = 'pending'
             or (
               -- Retry with quadratic backoff: attempts^2 x 10s since last update.
               status = 'failed'
               and attempts < $3
               and updated_at < now() - make_interval(secs => power(attempts, 2) * 10)
               -- Belt and braces against the wedge the retirement above clears:
               -- never promote a failed row into a dedupe key a live row holds.
               and (
                 graph_job.dedupe_key is null
                 or not exists (
                   select 1 from graph_job live
                    where live.kind = graph_job.kind
                      and live.dedupe_key = graph_job.dedupe_key
                      and live.status in ('pending', 'running')
                 )
               )
             )
             or (
               -- Lease expiry. A worker that dies mid-job -- or hangs on a call
               -- with no timeout -- leaves the row 'running' forever, and since
               -- graph_job_open_dedupe_idx covers 'running', nothing of that kind
               -- can ever be enqueued again: one wedged row silently freezes a
               -- whole maintenance stream. (A refresh_embeddings job did exactly
               -- that in production, and embeddings stopped refreshing for days
               -- with no failure surfaced anywhere.) Job bodies are
               -- conflict-idempotent, so re-running one is safe; a frozen queue
               -- is not.
               status = 'running'
               and attempts < $3
               and updated_at < now() - make_interval(secs => $2::numeric)
             )
           )
           and ($1::uuid is null or id = $1)
         order by priority desc, created_at
         for update skip locked
         limit 1`,
        [jobId ?? null, jobLeaseSeconds(), JOB_MAX_ATTEMPTS],
      );

      if (result.rowCount === 0) {
        const existing = jobId ? await client.query(
          `select ${JOB_COLUMNS}
           from graph_job
           where id = $1`,
          [jobId],
        ) : { rows: [], rowCount: 0 };
        await client.query("commit");
        return (existing.rowCount ?? 0) > 0 ? { job: mapJob(existing.rows[0]), claimant: null } : null;
      }

      // Unique per claim, not per worker: a worker that reclaims its own
      // lease-expired row must not let the earlier attempt's finish through.
      const claimant = `${process.env.TROVE_WORKER_ID ?? "inline-worker"}:${randomUUID()}`;
      const claimed = await client.query(
        `update graph_job
         set status = 'running',
             attempts = attempts + 1,
             claimed_by = $2,
             error = null,
             updated_at = now(),
             started_at = now()
         where id = $1
         returning ${JOB_COLUMNS}`,
        [result.rows[0].id, claimant],
      );
      await client.query("commit");
      return { job: mapJob(claimed.rows[0]), claimant };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async performJob(job: GraphJob): Promise<GraphJobResult> {
    if (job.kind === "lint_graph") {
      // payload.ownerId scopes the lint to one tenant, the same contract as
      // refresh_embeddings below. Absent means the whole graph, which only an
      // operator-triggered enqueue produces; a mutation always carries its owner.
      const payloadOwner = asRecord(job.payload).ownerId;
      const ownerId = typeof payloadOwner === "string" ? payloadOwner : null;
      const report = await this.lint(ownerId ? { ownerId } : undefined);
      const prunedJobs = await this.pruneTerminalJobs();
      const prunedEvents = await this.pruneEvents();
      // Carry the findings themselves (capped) — counts alone are not actionable.
      const result: GraphJobResultMap["lint_graph"] = {
        ownerId,
        lint: { ...report.summary, findings: report.findings.slice(0, 200) },
        prunedJobs,
        prunedEvents,
      };
      return result;
    }

    if (job.kind === "reconcile_node") {
      const payload = asRecord(job.payload);
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : null;
      if (!nodeId) throw new Error("reconcile_node: payload.nodeId is required");
      const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : null;
      const result: GraphJobResultMap["reconcile_node"] = await performReconcileNode(this, { nodeId, ownerId }, this.reconcileJudge);
      return result;
    }

    if (job.kind === "refresh_obsidian_projection") {
      const projection = buildObsidianVaultExport(
        await this.exportMarkdown(),
        await this.timeline(),
        await this.exportGraph(),
      );
      const result: GraphJobResultMap["refresh_obsidian_projection"] = {
        manifest: projection.manifest,
        fileCount: Object.keys(projection.files).length,
      };
      return result;
    }

    const provider = createEmbeddingProviderFromEnv();
    const model = provider?.model ?? process.env.TROVE_EMBEDDING_MODEL ?? "unconfigured";
    // payload.ownerId scopes the whole job to one tenant: a bulk importer can
    // ask "is MY data indexed yet?" and drain just its own slice instead of
    // waiting for the entire corpus. Absent means global (the background
    // worker's mode). The count and the backfill must take the same filter or
    // the drain math lies.
    const payloadOwner = asRecord(job.payload).ownerId;
    const ownerId = typeof payloadOwner === "string" ? payloadOwner : null;

    // Chunk whatever is still unchunked BEFORE counting, so the count sees the
    // rows this run is about to be asked to embed. Sources ingested before
    // migration 020 have text units and no chunks; this is what converts them,
    // batched, and it is what makes the per-line backfill retirement below safe
    // to run — a source is never left with neither grain indexed.
    const chunkedSources = await this.buildMissingTextChunks(ownerId);

    // Only the owner types the backfill actually embeds (and search actually
    // reads) are counted; whole-source vectors are a future feature, and
    // counting them here made every job report look permanently unfinished.
    const [nodeRevisions, textChunks] = await Promise.all([
      this.pool.query(
        `select count(*)::int as count
         from node n
         join node_revision nr on nr.id = n.current_revision_id
         where n.deleted_at is null
           and ($2::uuid is null or n.owner_id = $2)
           and not exists (
             select 1 from embedding e
             where e.owner_table = 'node_revision'
               and e.owner_id = nr.id
               and e.model = $1
               and e.content_sha256 = nr.content_sha256
           )`,
        [model, ownerId],
      ),
      this.pool.query(
        `select count(*)::int as count
         from text_chunk tc
         where ($2::uuid is null or tc.owner_id = $2)
           and not exists (
             select 1 from embedding e
             where e.owner_table = 'text_chunk'
               and e.owner_id = tc.id
               and e.model = $1
               and e.content_sha256 = tc.content_sha256
           )`,
        [model, ownerId],
      ),
    ]);

    const missing = {
      nodeRevisions: Number(nodeRevisions.rows[0]?.count ?? 0),
      textChunks: Number(textChunks.rows[0]?.count ?? 0),
    };

    if (!provider) {
      const result: GraphJobResultMap["refresh_embeddings"] = {
        provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "none",
        model,
        status: "skipped_no_embedding_provider",
        ownerId,
        chunkedSources,
        missing,
      };
      return result;
    }

    const limit = Number(asRecord(job.payload).limit ?? process.env.TROVE_EMBEDDING_JOB_LIMIT ?? 256);
    const embedded = await this.refreshMissingEmbeddings(provider, Number.isFinite(limit) ? limit : 256, ownerId);
    // Only once a source's chunks are all embedded do its per-line vectors go.
    const retiredTextUnitVectors = await this.retireTextUnitVectors(model, ownerId);
    const result: GraphJobResultMap["refresh_embeddings"] = {
      provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "openai",
      model,
      status: "refreshed",
      ownerId,
      chunkedSources,
      retiredTextUnitVectors,
      missingBefore: missing,
      embedded,
    };
    return result;
  }

  /**
   * Chunk the sources that have text units but no chunks yet — everything
   * ingested before migration 020 — a bounded batch at a time.
   *
   * The chunking runs in TypeScript (buildTextChunks) rather than SQL on
   * purpose: it is the same function ingest calls, so a chunk backfilled here
   * is byte-identical to one written at ingest, and there is no second
   * implementation of the section/size rules to drift. The price is a round
   * trip per source, which is why the batch is bounded.
   */
  private async buildMissingTextChunks(ownerId: string | null): Promise<number> {
    const sources = await this.pool.query(
      `select s.id, s.title, s.owner_id
       from source s
       where ($1::uuid is null or s.owner_id = $1)
         and exists (select 1 from text_unit tu where tu.source_id = s.id)
         and not exists (select 1 from text_chunk tc where tc.source_id = s.id)
       order by s.created_at desc
       limit $2`,
      [ownerId, CHUNK_BUILD_SOURCES_PER_RUN],
    );
    if (sources.rows.length === 0) return 0;

    let chunked = 0;
    for (const row of sources.rows) {
      const sourceId = String(row.id);
      const units = await this.textUnitsForSource(sourceId);
      const chunks = buildTextChunks(sourceId, String(row.title), units);
      if (chunks.length === 0) continue;
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        for (const chunk of chunks) {
          await client.query(
            `insert into text_chunk (
               id, source_id, owner_id, ordinal, first_ordinal, last_ordinal,
               section_path, context_prefix, text, token_count, content_sha256
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             on conflict (source_id, ordinal) do nothing`,
            [
              chunk.id,
              chunk.sourceId,
              row.owner_id ?? null,
              chunk.ordinal,
              chunk.firstOrdinal,
              chunk.lastOrdinal,
              chunk.sectionPath,
              chunk.contextPrefix,
              chunk.text,
              estimateTokenCount(chunkEmbeddingInput(chunk)),
              chunk.contentSha256,
            ],
          );
        }
        await client.query("commit");
        chunked += 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return chunked;
  }

  /**
   * Delete the per-line vectors a source's chunk vectors have replaced.
   *
   * The guard is deliberately strict: a text unit's vector goes only once its
   * source has chunks AND every one of them is embedded for this model, so
   * semantic search over that source is never served by neither grain. Bounded
   * and re-runnable — this is the whole production backfill path for the 70,479
   * per-line vectors, drained by the background worker rather than a migration.
   *
   * Deleting does not shrink the table on its own; the space returns with the
   * rewrite in scripts/convertEmbeddingStorage.ts (or any VACUUM FULL).
   */
  private async retireTextUnitVectors(model: string, ownerId: string | null): Promise<number> {
    const result = await this.pool.query(
      `with doomed as (
         select e.id
         from embedding e
         join text_unit tu on tu.id = e.owner_id
         where e.owner_table = 'text_unit'
           and ($1::uuid is null or tu.owner_id = $1)
           and exists (select 1 from text_chunk tc where tc.source_id = tu.source_id)
           and not exists (
             select 1 from text_chunk tc
             where tc.source_id = tu.source_id
               and not exists (
                 select 1 from embedding ce
                 where ce.owner_table = 'text_chunk'
                   and ce.owner_id = tc.id
                   and ce.model = $2
                   and ce.content_sha256 = tc.content_sha256
               )
           )
         limit $3
       )
       delete from embedding where id in (select id from doomed)`,
      [ownerId, model, TEXT_UNIT_VECTOR_RETIRE_PER_RUN],
    );
    return result.rowCount ?? 0;
  }

  private async refreshMissingEmbeddings(
    provider: EmbeddingProvider,
    limit: number,
    ownerId: string | null,
  ): Promise<EmbeddingCounts> {
    // Provider-sized batches, not job-sized ones: the old 100-row clamp predates
    // batched embed calls and made a 20k-row import take ~800 queue round trips.
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const nodeRevisionRows = await this.pool.query(
      `select nr.id, nr.content_sha256, n.owner_id as tenant_id, concat_ws(E'\n', nr.title, nr.summary, nr.content) as text
       from node n
       join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null
         and ($3::uuid is null or n.owner_id = $3)
         and length(trim(concat_ws(E'\n', nr.title, nr.summary, nr.content))) > 0
         and not exists (
           select 1 from embedding e
           where e.owner_table = 'node_revision'
             and e.owner_id = nr.id
             and e.model = $1
             and e.content_sha256 = nr.content_sha256
         )
       order by n.updated_at desc
       limit $2`,
      [provider.model, boundedLimit, ownerId],
    );
    const remaining = Math.max(0, boundedLimit - nodeRevisionRows.rows.length);
    // The context prefix is part of what gets embedded, and content_sha256 was
    // computed over exactly this concatenation — so a retitled source or a
    // moved section re-embeds through the same not-exists check.
    const textChunkRows = remaining === 0 ? { rows: [] } : await this.pool.query(
      `select tc.id, tc.content_sha256, tc.owner_id as tenant_id, concat_ws(E'\n\n', nullif(tc.context_prefix, ''), tc.text) as text
       from text_chunk tc
       where ($3::uuid is null or tc.owner_id = $3)
         and not exists (
           select 1 from embedding e
           where e.owner_table = 'text_chunk'
             and e.owner_id = tc.id
             and e.model = $1
             and e.content_sha256 = tc.content_sha256
         )
       order by tc.created_at desc
       limit $2`,
      [provider.model, remaining, ownerId],
    );

    await this.embedRows(provider, "node_revision", nodeRevisionRows.rows);
    await this.embedRows(provider, "text_chunk", textChunkRows.rows);

    return {
      nodeRevisions: nodeRevisionRows.rows.length,
      textChunks: textChunkRows.rows.length,
    };
  }

  private async embedRows(
    provider: EmbeddingProvider,
    ownerTable: "node_revision" | "text_chunk",
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    // Provider-sized batches: OpenAI accepts far more than the old job clamp
    // ever sent, but a whole 1000-row drain in one request risks payload and
    // timeout limits; 128 texts keeps each call small and lets a job embed up
    // to 1000 rows in a handful of round trips. Inserts stay one transaction —
    // the job is the unit of retry and its inserts are conflict-idempotent.
    const EMBED_BATCH = 128;
    const embeddings: number[][] = [];
    for (let start = 0; start < rows.length; start += EMBED_BATCH) {
      const batch = rows.slice(start, start + EMBED_BATCH);
      embeddings.push(...await provider.embed(batch.map((row) => String(row.text))));
    }
    // Bulk-insert through unnest rather than one statement per row. The
    // row-at-a-time loop sent a separate INSERT per embedding, each paying its
    // own cross-region round trip *and* its own HNSW index maintenance:
    // measured at ~0.58s/row against Supabase in production, which put the
    // 62k-row backfill at ~10 hours and is the shape that produced "canceling
    // statement due to statement timeout". unnest holds the parameter count at
    // six no matter how many rows ride along, so the statement can never
    // approach Postgres's 65535-parameter ceiling; the chunk below bounds the
    // size of any single statement instead.
    const ownerIds: string[] = [];
    const vectors: string[] = [];
    const shas: string[] = [];
    const tenants: string[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const embedding = embeddings[index];
      if (!row || !embedding) continue;
      ownerIds.push(String(row.id));
      vectors.push(vectorLiteral(embedding));
      shas.push(String(row.content_sha256));
      // An unowned row (pre-isolation, or superuser-written) stamps the
      // sentinel, never NULL: NULL is reserved to mean "not backfilled yet".
      tenants.push(row.tenant_id === null || row.tenant_id === undefined ? UNOWNED_TENANT : String(row.tenant_id));
    }
    if (ownerIds.length === 0) return;

    // Stamp the tenant from the moment migration 021 adds the column, so the
    // conversion script only ever has to backfill history — never a moving
    // target. Gated on the column EXISTING, not on the backfill being done.
    const layout = await this.embeddingLayout();
    const columns = layout.tenantColumn
      ? "(owner_table, owner_id, model, dimensions, embedding, content_sha256, tenant_id)"
      : "(owner_table, owner_id, model, dimensions, embedding, content_sha256)";
    const selected = layout.tenantColumn
      ? `$1, t.owner_id, $2, $3, t.embedding::${layout.vectorType}, t.content_sha256, t.tenant_id`
      : `$1, t.owner_id, $2, $3, t.embedding::${layout.vectorType}, t.content_sha256`;
    const unnested = layout.tenantColumn
      ? "unnest($4::uuid[], $5::text[], $6::text[], $7::uuid[]) as t(owner_id, embedding, content_sha256, tenant_id)"
      : "unnest($4::uuid[], $5::text[], $6::text[]) as t(owner_id, embedding, content_sha256)";

    const INSERT_CHUNK = 256;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (let start = 0; start < ownerIds.length; start += INSERT_CHUNK) {
        await client.query(
          `insert into embedding ${columns}
           select ${selected}
             from ${unnested}
           on conflict (owner_table, owner_id, model, content_sha256) do nothing`,
          [
            ownerTable,
            provider.model,
            provider.dimensions,
            ownerIds.slice(start, start + INSERT_CHUNK),
            vectors.slice(start, start + INSERT_CHUNK),
            shas.slice(start, start + INSERT_CHUNK),
            ...(layout.tenantColumn ? [tenants.slice(start, start + INSERT_CHUNK)] : []),
          ],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async finishJob(
    claimed: GraphJob,
    claimant: string,
    status: "succeeded" | "failed",
    result: Record<string, unknown> | null,
    error: string | null,
    context?: GraphOperationContext,
  ): Promise<GraphJob> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      // Only the claim that started this attempt may end it. Matching on id
      // alone let a worker that had lost its lease overwrite the row another
      // worker was running -- marking it finished under the wrong attempt,
      // or failed with a stale error. Attempts is in the guard as well so an
      // identical claimant string on a later attempt could never match.
      const updated = await client.query(
        `update graph_job
         set status = case
               when $2 = 'failed' and attempts >= $5 then 'dead'
               else $2
             end,
             result = $3::jsonb,
             error = $4,
             updated_at = now(),
             finished_at = now()
         where id = $1
           and status = 'running'
           and claimed_by = $6
           and attempts = $7
         returning ${JOB_COLUMNS}`,
        [
          claimed.id,
          status,
          result === null ? null : JSON.stringify(result),
          error,
          JOB_MAX_ATTEMPTS,
          claimant,
          claimed.attempts,
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query("rollback");
        console.warn(
          `[jobs] dropped ${status} result for ${claimed.kind} ${claimed.id}: claim ${claimant} (attempt ${claimed.attempts}) is no longer current`,
        );
        const current = await client.query(`select ${JOB_COLUMNS} from graph_job where id = $1`, [claimed.id]);
        return (current.rowCount ?? 0) > 0 ? mapJob(current.rows[0]) : claimed;
      }
      const job = mapJob(updated.rows[0]);
      await this.recordEvent(
        client,
        status === "succeeded" ? "run_job" : "fail_job",
        "graph_job",
        job.id,
        { status: job.status, kind: job.kind },
        null,
        context,
        actorUuid,
      );
      await client.query("commit");
      return job;
    } catch (finishError) {
      await client.query("rollback");
      throw finishError;
    } finally {
      client.release();
    }
  }

  /**
   * The evidence and link half of a node write, on the caller's transaction:
   * capture and update both run it between their row writes and their event,
   * so a citation or edge that cannot be written rolls the node back with it
   * (docs/architecture.md: remember is one transaction). A link whose slug
   * does not resolve is skipped -- capture's callers hold slugs they just
   * minted, and remember reports unresolved targets before it gets here.
   */
  private async attachEvidenceAndLinks(
    client: pg.PoolClient,
    nodeId: string,
    evidence: CaptureInput["evidence"],
    links: CaptureInput["links"],
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
    scope: OwnerScope,
  ): Promise<void> {
    for (const ref of evidence) {
      await this.insertAnnotation(client, {
        motivation: "supports",
        sourceId: ref.sourceId,
        textUnitId: ref.textUnitId,
        nodeId,
        body: {},
        selector: ref.selector,
      }, context, actorUuid);
    }

    for (const link of links) {
      const toNodeId = await this.nodeIdForSlug(link.toSlug, client, scope);
      if (!toNodeId) continue;
      // Same world-time rule as link(): a previous version of this triple
      // closed with a future validUntil still owns "now", and the exclusion
      // constraint would abort the whole capture with a bare 23P01. Name the
      // conflict instead; the transaction rolls back either way.
      const overlapping = await client.query(overlappingVersionSql, [nodeId, toNodeId, link.predicate, null]);
      if (overlapping.rowCount) {
        throw overlapError(String(overlapping.rows[0].id), link.predicate, null);
      }
      const inserted = await client.query(
        `insert into edge (id, from_node_id, to_node_id, predicate, valid_from, created_by, owner_id)
         values ($1, $2, $3, $4, now(), $5, $6)
         on conflict (from_node_id, to_node_id, predicate) where deleted_at is null and expired_at is null
         do nothing
         returning id`,
        [randomUUID(), nodeId, toNodeId, link.predicate, actorUuid, scope.ownerId],
      );
      if (inserted.rowCount === 0) continue;
      await this.recordEvent(
        client,
        "link",
        "edge",
        String(inserted.rows[0].id),
        { predicate: link.predicate, fromNodeId: nodeId, toNodeId },
        null,
        context,
        actorUuid,
      );
    }
  }

  private async insertAnnotation(
    client: pg.PoolClient,
    input: AnnotateInput,
    context?: GraphOperationContext,
    actorUuid?: string | null,
  ): Promise<GraphAnnotation> {
    const resolvedActorUuid = actorUuid === undefined ? await this.actorUuidForContext(client, context) : actorUuid;
    const scope = ownerScope(context);
    const unknownReference = () => new UnknownEvidenceReferenceError(
      `annotation references an unknown source/text-unit/node: sourceId=${input.sourceId ?? "null"} textUnitId=${input.textUnitId ?? "null"} nodeId=${input.nodeId ?? "null"}`,
    );
    // The FK below only proves the rows exist. Each referenced row must also
    // belong to the caller, and a foreign one raises the very same error as a
    // missing one, so the failure never confirms another tenant's row.
    const refs = [
      ["node", input.nodeId],
      ["source", input.sourceId],
      ["text_unit", input.textUnitId],
    ] as const;
    for (const [table, id] of refs) {
      if (id && !(await this.visibleIds(client, table, [id], scope)).has(id)) throw unknownReference();
    }
    let result: pg.QueryResult;
    try {
      result = await client.query(
        `insert into annotation (
           id, motivation, source_id, text_unit_id, node_id, body, selector, created_by, owner_id
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         returning id, motivation, source_id, text_unit_id, node_id, body, selector, created_at`,
        [
          randomUUID(),
          input.motivation,
          input.sourceId ?? null,
          input.textUnitId ?? null,
          input.nodeId ?? null,
          JSON.stringify(input.body),
          JSON.stringify(input.selector),
          resolvedActorUuid,
          scope.ownerId,
        ],
      );
    } catch (error) {
      // FK violation (23503): a source/text-unit/node ref does not resolve.
      // Surface it as the named error so callers can distinguish a bogus
      // citation from a real failure without parsing pg error codes.
      if ((error as { code?: string }).code === "23503") throw unknownReference();
      throw error;
    }
    const annotation = mapAnnotation(result.rows[0]);
    await this.recordEvent(
      client,
      "annotate",
      "annotation",
      annotation.id,
      { motivation: annotation.motivation, nodeId: annotation.nodeId },
      null,
      context,
      resolvedActorUuid,
    );
    return annotation;
  }

  private async actorUuidForContext(
    client: pg.PoolClient,
    context: GraphOperationContext | undefined,
  ): Promise<string | null> {
    const actorHandle = context?.actorId?.trim();
    if (!actorHandle) return null;

    const result = await client.query(
      `insert into actor (handle, display_name, kind)
       values ($1, $2, 'agent')
       on conflict (handle) do update set display_name = excluded.display_name
       returning id`,
      [actorHandle, actorHandle],
    );
    return String(result.rows[0].id);
  }

  private async recordEvent(
    client: pg.PoolClient,
    action: string,
    entityTable: string,
    entityId: string,
    after: unknown,
    before: unknown,
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
  ): Promise<void> {
    await client.query(
      `insert into graph_event (id, actor_id, interface_id, action, entity_table, entity_id, before, after, request_id, owner_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        randomUUID(),
        actorUuid,
        context?.interfaceId ?? null,
        action,
        entityTable,
        entityId,
        // Both columns are write-only (GraphEvent exposes neither), and a
        // couple of payloads quote unbounded input — cap them, keeping the
        // top-level keys. See capEventPayload.
        before === null ? null : JSON.stringify(capEventPayload(before)),
        after === null ? null : JSON.stringify(capEventPayload(after)),
        context?.requestId ?? null,
        ownerScope(context).ownerId,
      ],
    );
  }

  // Slugs are unique per owner, so two owners can each hold `project-x`. A
  // superuser (unscoped) write dedupes globally, which still satisfies the
  // per-owner unique index.
  private async uniqueSlug(baseSlug: string, client: pg.PoolClient, scope: OwnerScope): Promise<string> {
    let slug = baseSlug || "untitled";
    let counter = 2;
    while (true) {
      const result = await client.query(
        "select 1 from node where slug = $1 and ($2 or owner_id = $3)",
        [slug, !scope.scoped, scope.ownerId],
      );
      if (result.rowCount === 0) return slug;
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
  }

  private async uniqueViewSlug(baseSlug: string, client: pg.PoolClient, scope: OwnerScope): Promise<string> {
    let slug = baseSlug || "view";
    let counter = 2;
    while (true) {
      const result = await client.query(
        "select 1 from graph_view where slug = $1 and ($2 or owner_id = $3)",
        [slug, !scope.scoped, scope.ownerId],
      );
      if (result.rowCount === 0) return slug;
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
  }

  private async resolveViewMembers(
    client: pg.PoolClient,
    input: CreateViewInput,
    context?: GraphOperationContext,
  ): Promise<{ rootNodeId: string | null; nodeIds: string[]; edgeIds: string[] }> {
    const scope = ownerScope(context);
    const ownerParams: [boolean, string | null] = [!scope.scoped, scope.ownerId];
    const rootNodeId = input.rootNodeId ?? await this.nodeIdForSlug(input.rootSlug, client, scope);
    if (input.rootNodeId || input.rootSlug) {
      if (!rootNodeId) throw new Error("View root node could not be resolved.");
      const root = await client.query(
        "select 1 from node where id = $1 and deleted_at is null and ($2 or owner_id = $3)",
        [rootNodeId, ...ownerParams],
      );
      if (root.rowCount === 0) throw new Error("View root node could not be resolved.");
    }

    if (input.includedNodeIds?.length) {
      const nodes = await client.query(
        `select id
         from node
         where deleted_at is null and id = any($1::uuid[]) and ($2 or owner_id = $3)
         order by array_position($1::uuid[], id)`,
        [input.includedNodeIds, ...ownerParams],
      );
      const nodeIds = nodes.rows.map((row) => String(row.id));
      const nodeIdSet = new Set(nodeIds);
      const candidateEdgeIds = input.includedEdgeIds?.length ? input.includedEdgeIds : null;
      const edges = await client.query(
        `select id
         from edge
         where deleted_at is null
           and from_node_id = any($1::uuid[])
           and to_node_id = any($1::uuid[])
           and ($2::uuid[] is null or id = any($2::uuid[]))
         order by predicate, id`,
        [nodeIds, candidateEdgeIds],
      );
      return {
        rootNodeId: rootNodeId && nodeIdSet.has(rootNodeId) ? rootNodeId : rootNodeId ?? null,
        nodeIds,
        edgeIds: edges.rows.map((row) => String(row.id)),
      };
    }

    if (rootNodeId) {
      const neighborhood = await this.neighborhood({
        nodeId: rootNodeId,
        depth: input.depth,
        predicates: input.predicates,
      }, context);
      if (neighborhood.nodes.length === 0) {
        throw new Error("View root node could not be resolved.");
      }
      return {
        rootNodeId,
        nodeIds: neighborhood.nodes.map((node) => node.id),
        edgeIds: neighborhood.edges.map((edge) => edge.id),
      };
    }

    if (input.query) {
      const search = await this.search({ query: input.query, includeTextUnits: false, mode: "hybrid", limit: 50 }, context);
      const nodeIds = search.nodes.map((node) => node.id);
      const edges = nodeIds.length === 0 ? { rows: [] } : await client.query(
        `select id
         from edge
         where deleted_at is null and expired_at is null
           and from_node_id = any($1::uuid[])
           and to_node_id = any($1::uuid[])
         order by predicate, id`,
        [nodeIds],
      );
      return {
        rootNodeId: null,
        nodeIds,
        edgeIds: edges.rows.map((row) => String(row.id)),
      };
    }

    return { rootNodeId: null, nodeIds: [], edgeIds: [] };
  }

  private async snapshotForView(view: GraphView): Promise<GraphViewSnapshot> {
    const nodeResult = view.includedNodeIds.length === 0 ? { rows: [] } : await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from node n
       left join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null and n.id = any($1::uuid[])
       order by array_position($1::uuid[], n.id)`,
      [view.includedNodeIds],
    );
    const nodeIds = new Set(nodeResult.rows.map((row) => String(row.id)));
    const edgeResult = view.includedEdgeIds.length === 0 ? { rows: [] } : await this.pool.query(
      `select e.id, e.from_node_id, e.to_node_id, e.predicate, e.weight, e.created_at, e.valid_from, e.valid_until, e.expired_at, e.invalidated_by, e.invalidation_reason
       from edge e
       where e.deleted_at is null and e.expired_at is null
         and e.id = any($1::uuid[])
         and e.from_node_id = any($2::uuid[])
         and e.to_node_id = any($2::uuid[])
       order by array_position($1::uuid[], e.id)`,
      [view.includedEdgeIds, [...nodeIds]],
    );

    return {
      ...view,
      nodes: nodeResult.rows.map(mapNode),
      edges: edgeResult.rows.map(mapEdge),
    };
  }

  /**
   * Which of `ids` the caller may touch. Every id a client hands us by value
   * (link endpoints, supersedesEdgeId, annotate's node/source/text-unit) goes
   * through here before it is written, so a foreign row and a missing row look
   * identical: neither is in the returned set, and the caller then does what
   * the slug path already does for an unknown slug. Unscoped (superuser and
   * internal) callers see every live row, so their semantics are unchanged.
   */
  private async visibleIds(
    client: pg.PoolClient,
    table: "node" | "edge" | "source" | "text_unit",
    ids: string[],
    scope: OwnerScope,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const live = table === "node" || table === "edge" ? " and deleted_at is null" : "";
    const result = await client.query(
      `select id from ${table} where id = any($1::uuid[]) and ($2 or owner_id = $3)${live}`,
      [ids, !scope.scoped, scope.ownerId],
    );
    return new Set(result.rows.map((row) => String(row.id)));
  }

  private async nodeIdForSlug(slug: string | undefined, client: pg.PoolClient | undefined, scope: OwnerScope): Promise<string | null> {
    if (!slug) return null;
    const queryable = client ?? this.pool;
    const result = await queryable.query(
      "select id from node where slug = $1 and deleted_at is null and ($2 or owner_id = $3)",
      [slug, !scope.scoped, scope.ownerId],
    );
    return result.rowCount === 0 ? null : String(result.rows[0].id);
  }

  private async textUnitsForSource(sourceId: string): Promise<TextUnit[]> {
    const result = await this.pool.query(
      `select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256
       from text_unit
       where source_id = $1
       order by ordinal`,
      [sourceId],
    );
    return result.rows.map(mapTextUnit);
  }

  // Both read helpers carry the owner predicate even though read() already
  // resolved the node inside the owner's scope: an annotation or source row
  // reached by id is evidence the caller's agent will be shown verbatim, and a
  // row another tenant attached (or planted) must never become that evidence.
  private async annotationsForNode(nodeId: string, scope: OwnerScope): Promise<GraphAnnotation[]> {
    const result = await this.pool.query(
      `select id, motivation, source_id, text_unit_id, node_id, body, selector, created_at
       from annotation
       where node_id = $1 and ($2 or owner_id = $3)
       order by created_at`,
      [nodeId, !scope.scoped, scope.ownerId],
    );
    return result.rows.map(mapAnnotation);
  }

  private async sourcesByIds(ids: string[], scope: OwnerScope): Promise<Map<string, GraphSource>> {
    if (ids.length === 0) return new Map();
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, created_at
       from source
       where id = any($1::uuid[]) and ($2 or owner_id = $3)`,
      [ids, !scope.scoped, scope.ownerId],
    );
    return new Map(result.rows.map((row) => [String(row.id), mapSource(row)]));
  }
}

function mapSource(row: Record<string, unknown>): GraphSource {
  return {
    id: String(row.id),
    kind: row.kind as GraphSource["kind"],
    title: String(row.title),
    uri: row.uri === null ? null : String(row.uri),
    contentSha256: String(row.content_sha256),
    createdAt: toIso(row.created_at),
  };
}

function mapTextUnit(row: Record<string, unknown>): TextUnit {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    ordinal: Number(row.ordinal),
    sectionPath: Array.isArray(row.section_path) ? row.section_path.map(String) : [],
    charStart: Number(row.char_start ?? 0),
    charEnd: Number(row.char_end ?? 0),
    text: String(row.text),
    contentSha256: String(row.content_sha256),
  };
}

function mapNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row.id),
    type: row.type as GraphNode["type"],
    slug: String(row.slug),
    title: String(row.title),
    summary: row.summary === null ? null : String(row.summary),
    content: row.content === null || row.content === undefined ? null : String(row.content),
    revisionId: String(row.current_revision_id),
    updatedAt: toIso(row.updated_at),
    accessCount: Number(row.access_count ?? 0),
    lastAccessedAt: row.last_accessed_at === null || row.last_accessed_at === undefined
      ? null
      : toIso(row.last_accessed_at),
  };
}

function mapEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    predicate: String(row.predicate),
    weight: Number(row.weight),
    recordedAt: toIso(row.created_at ?? new Date()),
    validFrom: row.valid_from === null || row.valid_from === undefined ? null : toIso(row.valid_from),
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : toIso(row.valid_until),
    expiredAt: row.expired_at === null || row.expired_at === undefined ? null : toIso(row.expired_at),
    invalidatedBy: row.invalidated_by === null || row.invalidated_by === undefined
      ? null
      : String(row.invalidated_by),
    invalidationReason: row.invalidation_reason === null || row.invalidation_reason === undefined
      ? null
      : (row.invalidation_reason as GraphEdge["invalidationReason"]),
  };
}

function mapAnnotation(row: Record<string, unknown>): GraphAnnotation {
  return {
    id: String(row.id),
    motivation: row.motivation as GraphAnnotation["motivation"],
    sourceId: row.source_id === null ? null : String(row.source_id),
    textUnitId: row.text_unit_id === null ? null : String(row.text_unit_id),
    nodeId: row.node_id === null ? null : String(row.node_id),
    body: asRecord(row.body),
    selector: asRecord(row.selector),
    createdAt: toIso(row.created_at),
  };
}

function mapJob(row: Record<string, unknown>): GraphJob {
  return {
    id: String(row.id),
    kind: row.kind as GraphJob["kind"],
    status: row.status as GraphJob["status"],
    priority: Number(row.priority),
    payload: asRecord(row.payload),
    result: row.result === null ? null : asRecord(row.result),
    error: row.error === null ? null : String(row.error),
    dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    attempts: Number(row.attempts),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
  };
}

function mapEvent(row: Record<string, unknown>): GraphEvent {
  return {
    id: String(row.id),
    action: String(row.action),
    entityTable: String(row.entity_table),
    entityId: String(row.entity_id),
    actorId: row.actor_id === null ? null : String(row.actor_id),
    actorHandle: row.actor_handle === null ? null : String(row.actor_handle),
    interfaceId: row.interface_id === null ? null : String(row.interface_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    createdAt: toIso(row.created_at),
  };
}

function mapView(row: Record<string, unknown>): GraphView {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    rootNodeId: row.root_node_id === null ? null : String(row.root_node_id),
    query: row.query === null ? null : String(row.query),
    summary: row.summary === null ? null : String(row.summary),
    layout: asRecord(row.layout),
    includedNodeIds: Array.isArray(row.included_node_ids) ? row.included_node_ids.map(String) : [],
    includedEdgeIds: Array.isArray(row.included_edge_ids) ? row.included_edge_ids.map(String) : [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function stripReadResult(read: ReadResult): GraphNode {
  const { evidence: _evidence, annotations: _annotations, ...node } = read;
  return node;
}

/**
 * Reciprocal Rank Fusion over the per-mode ranked lists: each item scores
 * 1/(60 + rank) per list it appears in (1-based rank), ordered by fused score.
 * Ties break to the best single-list rank, then id for determinism.
 */
function reciprocalRankFusion<T extends { id: string }>(...lists: T[][]): T[] {
  const fused = new Map<string, { item: T; score: number; bestRank: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const existing = fused.get(item.id);
      if (existing) {
        existing.score += 1 / (60 + rank);
        existing.bestRank = Math.min(existing.bestRank, rank);
        const incoming = (item as { distance?: number }).distance;
        if (incoming !== undefined) {
          const current = (existing.item as { distance?: number }).distance;
          if (current === undefined || incoming < current) {
            existing.item = { ...existing.item, distance: incoming };
          }
        }
      } else {
        fused.set(item.id, { item, score: 1 / (60 + rank), bestRank: rank });
      }
    });
  }
  return [...fused.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.bestRank - right.bestRank ||
      left.item.id.localeCompare(right.item.id))
    .map((entry) => entry.item);
}

// Semantic hits farther than this cosine distance are noise. Input wins, then
// the env override, then the default.
function maxSemanticDistanceFor(input: SearchInput): number {
  if (typeof input.maxSemanticDistance === "number" && Number.isFinite(input.maxSemanticDistance)) {
    return input.maxSemanticDistance;
  }
  const fromEnv = Number(process.env.TROVE_SEMANTIC_MAX_DISTANCE);
  if (process.env.TROVE_SEMANTIC_MAX_DISTANCE && Number.isFinite(fromEnv)) return fromEnv;
  return 0.55;
}

/**
 * Closed versions of a triple whose world-time interval still covers
 * [validFrom, infinity). The active version is deliberately excluded: link()
 * upserts onto it. Parameters: from, to, predicate, validFrom (null = now()).
 */
const overlappingVersionSql = `
  select id from edge
  where from_node_id = $1 and to_node_id = $2 and predicate = $3
    and deleted_at is null and expired_at is not null
    and tstzrange(valid_from, valid_until, '[)') && tstzrange(coalesce($4::timestamptz, now()), null, '[)')
  order by valid_until desc nulls first
  limit 1`;

function overlapError(conflictingEdgeId: string | null, predicate: string, validFrom: string | null): EdgeValidityConflictError {
  const start = validFrom ?? "now";
  return new EdgeValidityConflictError(
    conflictingEdgeId
      ? `Cannot link "${predicate}" from ${start}: edge ${conflictingEdgeId} is already valid over that interval. Start the new version at or after its validUntil.`
      : `Cannot link "${predicate}" from ${start}: another version of this link is valid over that interval.`,
    conflictingEdgeId,
  );
}

function isExclusionViolation(error: unknown, constraint: string): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: string }).code === "23P01"
    && (error as { constraint?: string }).constraint === constraint;
}

function isSlugUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: string }).code === "23505"
    && (error as { constraint?: string }).constraint === "node_owner_slug_key";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
