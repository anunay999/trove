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
  decodeEventCursor,
  encodeEventCursor,
  evidenceSupportScore,
  performRecall,
  renderAgentContext,
  renderMarkdownProjection,
  sha256,
  splitTextUnits,
  ServedUnitLog,
  FUZZY_QUOTE_CANDIDATE_FLOOR,
  EdgeValidityConflictError,
  UnknownEvidenceReferenceError,
  WEAK_EVIDENCE_FLOOR,
  type GraphEvent,
  type GraphEventFeed,
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

/** Attempts a job gets across all causes — failures and lease reclaims alike. */
const JOB_MAX_ATTEMPTS = 5;

function jobLeaseSeconds(): number {
  const parsed = Number(process.env.TROVE_JOB_LEASE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 900;
}

// Junk text units (short fragments, horizontal rules, markdown table
// separators) are not worth an embedding. The missing-count and the select in
// the refresh job must agree on this filter or the drain loop never finishes.
const EMBEDDABLE_TEXT_UNIT = `
  length(trim(tu.text)) >= 12
  and trim(tu.text) !~ '^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$'
  and trim(tu.text) !~ '^\\|?(\\s*:?-+:?\\s*\\|)+\\s*$'`;

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

  constructor(options: PgStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, keepAlive: true });
    this.reconcileJudge = options.reconcileJudge === undefined ? createReconcileJudgeFromEnv() : options.reconcileJudge;
    // Idle clients dropped by the pooler (e.g. Supabase) emit 'error'; without
    // a listener that unhandled event kills the whole process.
    this.pool.on("error", (error) => {
      console.error("[pg-pool] idle client error:", error.message);
    });
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
    const likeLiteral = `%${input.pattern.replace(/[%_\\]/g, "\\$&")}%`;
    const matches: GrepMatch[] = [];
    const excerptFor = (text: string): string | null => grepExcerpt(text, regex) ?? grepExcerpt(text, literalRegex);

    if (scope === "nodes" || scope === "all") {
      const nodeSql = (predicate: string) => `
        select n.id, n.slug, n.title, n.summary, nr.content
        from node n
        left join node_revision nr on nr.id = n.current_revision_id
        where n.deleted_at is null and ($3 or n.owner_id = $4) and (${predicate})
        order by n.updated_at desc
        limit $2`;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await this.pool.query(
          nodeSql(`n.title ${operator} $1 or coalesce(n.summary, '') ${operator} $1 or coalesce(nr.content, '') ${operator} $1`),
          [input.pattern, limit + 1, ...ownerParams],
        )).rows;
      } catch {
        // JS accepted the pattern but Postgres POSIX regex rejected it — fall back to a literal scan.
        rows = (await this.pool.query(
          nodeSql("n.title ilike $1 or coalesce(n.summary, '') ilike $1 or coalesce(nr.content, '') ilike $1"),
          [likeLiteral, limit + 1, ...ownerParams],
        )).rows;
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
      const unitSql = (predicate: string) => `
        select tu.id, tu.source_id, tu.ordinal, tu.text, s.title
        from text_unit tu
        join source s on s.id = tu.source_id
        where ($3 or tu.owner_id = $4) and (${predicate})
        order by tu.created_at desc, tu.ordinal
        limit $2`;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await this.pool.query(unitSql(`tu.text ${operator} $1`), [input.pattern, limit + 1, ...ownerParams])).rows;
      } catch {
        rows = (await this.pool.query(unitSql("tu.text ilike $1"), [likeLiteral, limit + 1, ...ownerParams])).rows;
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

  async search(input: SearchInput, context?: GraphOperationContext): Promise<SearchResult> {
    const scope = ownerScope(context);
    const provider = input.mode === "lexical" ? null : createEmbeddingProviderFromEnv();

    let result: SearchResult;
    // Semantic-only searches used to run a full lexical search first and throw
    // the result away; they now do no lexical work at all.
    if (input.mode === "semantic") {
      result = provider ? await this.semanticSearch(input, provider, scope) : { nodes: [], textUnits: [] };
    } else if (input.mode === "lexical" || !provider) {
      // Lexical-only, or hybrid with no embedding provider configured.
      result = await this.lexicalSearch(input, scope);
    } else {
      // The two arms are independent, and the semantic one blocks on an embedding
      // API round trip. Running them concurrently hides the lexical SQL entirely
      // behind that call rather than adding to it — recall (the hot path) calls
      // this with limit 50.
      const [lexical, semantic] = await Promise.all([
        this.lexicalSearch(input, scope),
        this.semanticSearch(input, provider, scope),
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
    const nodeSql = `with q as (select $7::tsquery as query)
       select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at,
              greatest(
                ts_rank_cd(to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')), q.query),
                ts_rank_cd(to_tsvector('english', coalesce(nr.content, '') || ' ' || coalesce(nr.projection_markdown, '')), q.query),
                case when n.slug = lower(replace($1, ' ', '-')) then 1.0 else 0 end,
                case when n.title ilike $4 then 0.2 else 0 end,
                case when coalesce(n.summary, '') ilike $4 then 0.1 else 0 end,
                case when coalesce(nr.content, '') ilike $4 then 0.05 else 0 end
              ) as rank
       from node n
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
           or to_tsvector('english', coalesce(nr.content, '') || ' ' || coalesce(nr.projection_markdown, '')) @@ q.query
           or n.slug = lower(replace($1, ' ', '-'))
           or n.title ilike $4
           or coalesce(n.summary, '') ilike $4
           or coalesce(nr.content, '') ilike $4
         )
       order by rank desc, n.updated_at desc
       limit $3`;
    const runNodeSearch = (effectiveTsquery: string) =>
      this.pool.query(nodeSql, [
        input.query, typeFilter, input.limit, `%${input.query}%`, !scope.scoped, scope.ownerId, effectiveTsquery,
      ]);
    // Strict AND first so precision is preserved whenever every term co-occurs;
    // the looser OR form only runs when AND found nothing at all.
    const withOrFallback = async (run: (tsquery: string) => Promise<pg.QueryResult>) => {
      const strict = await run(tsqueryText);
      return strict.rows.length > 0 || !hasOrFallback ? strict : run(orQueryText);
    };
    const nodeResult = await withOrFallback(runNodeSearch);

    const unitSql = `with q as (select $5::tsquery as query)
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
    const runUnitSearch = (effectiveTsquery: string) =>
      this.pool.query(unitSql, [
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
    // Vectors occupy $1..$N; everything else is numbered after them.
    const p = (offset: number): string => `$${vectors.length + offset}`;
    const typeFilter = input.types && input.types.length > 0 ? input.types : null;
    const maxDistance = maxSemanticDistanceFor(input);

    // Probe the HNSW index FIRST, then join and filter — never filter-then-sort.
    //
    // The previous shape selected from embedding JOIN node_revision JOIN node
    // with `distinct on (n.id) ... order by n.id, <distance>`. Ordering by n.id
    // is something the vector index cannot provide, so Postgres read and sorted
    // EVERY embedding row on every semantic search: measured at 50k rows, three
    // sequential scans and 60.8ms. Probing the index for a bounded candidate set
    // and joining afterwards plans as index scans throughout: 0.99ms, ~61x.
    //
    // Each per-vector branch is `order by embedding <=> $n limit K`, the only
    // shape pgvector can serve from embedding_hnsw_idx (migration 009). Their
    // union is deduped by min() rather than `distinct on`, which also removes
    // the need for the n.id ordering that caused the problem — a revision can
    // hold several embedding rows (the unique key includes content_sha256), and
    // min() collapses them correctly.
    //
    // OVERFETCH exists because the index probe happens BEFORE owner scoping,
    // type filters and the giant-content rule, so a heavily filtered query can
    // otherwise come back short. It trades a larger candidate set for recall;
    // pgvector 0.8's hnsw.iterative_scan would remove the guess entirely.
    const OVERFETCH = 10;
    const candidateLimit = Math.max(200, input.limit * OVERFETCH);
    const candidateBranches = vectors
      .map((_, index) => `(
           select e.owner_id, e.embedding <=> $${index + 1}::vector as distance
           from embedding e
           where e.owner_table = 'node_revision' and e.model = ${p(1)}
           order by e.embedding <=> $${index + 1}::vector
           limit ${p(9)}
         )`)
      .join(" union all ");

    const nodeResult = await this.pool.query(
      `with candidates as (${candidateBranches}),
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
       limit ${p(3)}`,
      [
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
      ],
    );

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
    const unitSql = `select tu.id, tu.source_id, tu.ordinal, tu.section_path, tu.char_start, tu.char_end, tu.text, tu.content_sha256,
              (e.embedding <=> $1::vector) as distance
       from embedding e
       join text_unit tu on tu.id = e.owner_id and e.owner_table = 'text_unit'
       where e.model = $2
         and (e.embedding <=> $1::vector) < $6
         and ($3 or tu.owner_id = $4)
       order by e.embedding <=> $1::vector
       limit $5`;
    const unitRowsByVector = input.includeTextUnits
      ? await Promise.all(
        vectors.map((vector) =>
          this.pool.query(unitSql, [vector, provider.model, !scope.scoped, scope.ownerId, input.limit, maxDistance]),
        ),
      )
      : [];
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
    if (opts?.trackAccess ?? true) {
      const bump = await this.pool.query(
        `update node set access_count = access_count + 1, last_accessed_at = now()
         where id = $1 and deleted_at is null
         returning access_count, last_accessed_at`,
        [node.id],
      );
      if (bump.rowCount && bump.rowCount > 0) {
        node.accessCount = Number(bump.rows[0].access_count ?? node.accessCount);
        node.lastAccessedAt = bump.rows[0].last_accessed_at === null
          ? node.lastAccessedAt
          : toIso(bump.rows[0].last_accessed_at);
      }
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
    const [nodeCount, edgeCount, orphanNodes, missingEvidence, duplicateTitles, danglingEdges, evidenceRows] = await Promise.all([
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

  async jobs(input: ListJobsInput = { limit: 25 }): Promise<GraphJob[]> {
    const result = await this.pool.query(
      `select id, kind, status, priority, payload, result, error, dedupe_key, attempts,
              created_at, updated_at, started_at, finished_at
       from graph_job
       where ($1::text is null or status = $1)
         and ($2::text is null or kind = $2)
       order by created_at desc
       limit $3`,
      [input.status ?? null, input.kind ?? null, input.limit ?? 25],
    );
    return result.rows.map(mapJob);
  }

  async runJob(input: RunJobInput = {}, context?: GraphOperationContext): Promise<GraphJob | null> {
    const claimed = await this.claimJob(input.jobId);
    if (!claimed || claimed.status !== "running") return claimed;

    try {
      const result = await this.performJob(claimed);
      return await this.finishJob(claimed.id, "succeeded", result, null, context);
    } catch (error) {
      return await this.finishJob(
        claimed.id,
        "failed",
        null,
        error instanceof Error ? error.message : "Unknown job error",
        context,
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<{ ok: true }> {
    await this.pool.query("select 1");
    return { ok: true };
  }

  private async enqueueMaintenanceJobs(
    client: pg.PoolClient,
    context: GraphOperationContext | undefined,
    actorUuid: string | null,
    kinds: Array<GraphJob["kind"]>,
  ): Promise<void> {
    for (const kind of kinds) {
      await this.enqueueJobWithClient(client, {
        kind,
        payload: { reason: "graph_mutation" },
        priority: kind === "refresh_embeddings" ? 40 : 60,
        dedupeKey: `maintenance:${kind}`,
      }, context, actorUuid);
    }
  }

  /**
   * Reconciliation runs per node, below the other maintenance jobs in priority
   * (it is the expensive, LLM-judged pass). Dedupe is per node: a burst of
   * revisions to the same node collapses into one run, which reads the current
   * revision at claim time.
   *
   * Note the contrast with `maintenance:<kind>` keys above: lint and global
   * embedding refresh are genuinely global work, so concurrent writers sharing
   * one pending row is CORRECT there (the job covers everyone's data), while
   * reconciliation is per-node work and must never absorb across nodes. The
   * `dedupeJoined` return marker lets a caller observe either absorption.
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
        `select id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                created_at, updated_at, started_at, finished_at
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

    const jobId = randomUUID();
    const result = await client.query(
      `insert into graph_job (id, kind, priority, payload, dedupe_key, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict do nothing
       returning id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                 created_at, updated_at, started_at, finished_at`,
      [jobId, input.kind, input.priority, JSON.stringify(input.payload), input.dedupeKey ?? null, actorUuid],
    );
    if (result.rowCount === 0 && input.dedupeKey) {
      const existing = await client.query(
        `select id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                created_at, updated_at, started_at, finished_at
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
    const job = mapJob(result.rows[0]);
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

  private async claimJob(jobId?: string): Promise<GraphJob | null> {
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
          `select id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                  created_at, updated_at, started_at, finished_at
           from graph_job
           where id = $1`,
          [jobId],
        ) : { rows: [], rowCount: 0 };
        await client.query("commit");
        return (existing.rowCount ?? 0) > 0 ? mapJob(existing.rows[0]) : null;
      }

      const claimed = await client.query(
        `update graph_job
         set status = 'running',
             attempts = attempts + 1,
             claimed_by = $2,
             error = null,
             updated_at = now(),
             started_at = now()
         where id = $1
         returning id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                   created_at, updated_at, started_at, finished_at`,
        [result.rows[0].id, process.env.TROVE_WORKER_ID ?? "inline-worker"],
      );
      await client.query("commit");
      return mapJob(claimed.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async performJob(job: GraphJob): Promise<GraphJobResult> {
    if (job.kind === "lint_graph") {
      const report = await this.lint();
      // Carry the findings themselves (capped) — counts alone are not actionable.
      const result: GraphJobResultMap["lint_graph"] = { lint: { ...report.summary, findings: report.findings.slice(0, 200) } };
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
    // Only the owner types the backfill actually embeds (and search actually
    // reads) are counted; whole-source vectors are a future feature, and
    // counting them here made every job report look permanently unfinished.
    const [nodeRevisions, textUnits] = await Promise.all([
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
         from text_unit tu
         where ${EMBEDDABLE_TEXT_UNIT}
           and ($2::uuid is null or tu.owner_id = $2)
           and not exists (
             select 1 from embedding e
             where e.owner_table = 'text_unit'
               and e.owner_id = tu.id
               and e.model = $1
               and e.content_sha256 = tu.content_sha256
           )`,
        [model, ownerId],
      ),
    ]);

    const missing = {
      nodeRevisions: Number(nodeRevisions.rows[0]?.count ?? 0),
      textUnits: Number(textUnits.rows[0]?.count ?? 0),
    };

    if (!provider) {
      const result: GraphJobResultMap["refresh_embeddings"] = {
        provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "none",
        model,
        status: "skipped_no_embedding_provider",
        ownerId,
        missing,
      };
      return result;
    }

    const limit = Number(asRecord(job.payload).limit ?? process.env.TROVE_EMBEDDING_JOB_LIMIT ?? 256);
    const embedded = await this.refreshMissingEmbeddings(provider, Number.isFinite(limit) ? limit : 256, ownerId);
    const result: GraphJobResultMap["refresh_embeddings"] = {
      provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "openai",
      model,
      status: "refreshed",
      ownerId,
      missingBefore: missing,
      embedded,
    };
    return result;
  }

  private async refreshMissingEmbeddings(
    provider: EmbeddingProvider,
    limit: number,
    ownerId: string | null,
  ): Promise<{ nodeRevisions: number; textUnits: number }> {
    // Provider-sized batches, not job-sized ones: the old 100-row clamp predates
    // batched embed calls and made a 20k-row import take ~800 queue round trips.
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const nodeRevisionRows = await this.pool.query(
      `select nr.id, nr.content_sha256, concat_ws(E'\n', nr.title, nr.summary, nr.content) as text
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
    const textUnitRows = remaining === 0 ? { rows: [] } : await this.pool.query(
      `select tu.id, tu.content_sha256, tu.text
       from text_unit tu
       where ${EMBEDDABLE_TEXT_UNIT}
         and ($3::uuid is null or tu.owner_id = $3)
         and not exists (
           select 1 from embedding e
           where e.owner_table = 'text_unit'
             and e.owner_id = tu.id
             and e.model = $1
             and e.content_sha256 = tu.content_sha256
         )
       order by tu.created_at desc
       limit $2`,
      [provider.model, remaining, ownerId],
    );

    await this.embedRows(provider, "node_revision", nodeRevisionRows.rows);
    await this.embedRows(provider, "text_unit", textUnitRows.rows);

    return {
      nodeRevisions: nodeRevisionRows.rows.length,
      textUnits: textUnitRows.rows.length,
    };
  }

  private async embedRows(
    provider: EmbeddingProvider,
    ownerTable: "node_revision" | "text_unit",
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
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const embedding = embeddings[index];
      if (!row || !embedding) continue;
      ownerIds.push(String(row.id));
      vectors.push(vectorLiteral(embedding));
      shas.push(String(row.content_sha256));
    }
    if (ownerIds.length === 0) return;

    const INSERT_CHUNK = 256;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (let start = 0; start < ownerIds.length; start += INSERT_CHUNK) {
        await client.query(
          `insert into embedding (owner_table, owner_id, model, dimensions, embedding, content_sha256)
           select $1, t.owner_id, $2, $3, t.embedding::vector, t.content_sha256
             from unnest($4::uuid[], $5::text[], $6::text[]) as t(owner_id, embedding, content_sha256)
           on conflict (owner_table, owner_id, model, content_sha256) do nothing`,
          [
            ownerTable,
            provider.model,
            provider.dimensions,
            ownerIds.slice(start, start + INSERT_CHUNK),
            vectors.slice(start, start + INSERT_CHUNK),
            shas.slice(start, start + INSERT_CHUNK),
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
    jobId: string,
    status: "succeeded" | "failed",
    result: Record<string, unknown> | null,
    error: string | null,
    context?: GraphOperationContext,
  ): Promise<GraphJob> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const updated = await client.query(
        `update graph_job
         set status = case
               when $2 = 'failed' and attempts >= 5 then 'dead'
               else $2
             end,
             result = $3::jsonb,
             error = $4,
             updated_at = now(),
             finished_at = now()
         where id = $1
         returning id, kind, status, priority, payload, result, error, dedupe_key, attempts,
                   created_at, updated_at, started_at, finished_at`,
        [jobId, status, result === null ? null : JSON.stringify(result), error],
      );
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
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
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
