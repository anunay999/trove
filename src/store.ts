/**
 * In-memory graph store — the TEST DOUBLE driver (backlog #6, decision
 * recorded 2026-07-19).
 *
 * Postgres is the product; this driver exists so the test suite runs without
 * a database. The GraphStore interface is the contract and behavioral tests
 * run against both drivers, but retrieval semantics are only APPROXIMATED:
 *
 * - Lexical matching uses tokenized, lightly singularized vocabularies
 *   (queryNormalize's tokenizeForMatch), not pg's english-dictionary
 *   `to_tsvector` stemming. "weddings" finds "wedding" and "all" no longer
 *   finds "call" — the two divergences that bit — but deeper morphology
 *   ("ran"/"run") and ts_rank_cd scoring are intentionally not reproduced.
 * - Semantic search dual-embeds raw + normalized and takes the min distance,
 *   like the pg driver; vectors come from the deterministic fake provider
 *   unless a real one is configured.
 * - Owner enforcement is limited to security-sensitive parity seams such as
 *   raw evidence lookup; no real embedding backfill, heuristic-only
 *   reconciliation judge by default (tests must not make network calls).
 *
 * When a behavior matters, assert it against Postgres too — a green run on
 * this driver alone says the logic works, not that the SQL does.
 */

import { randomUUID } from "node:crypto";
import { contentTerms, normalizeMatchToken, normalizeRetrievalQuery, retrievalQueryTerms, tokenizeForMatch } from "./queryNormalize.js";
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
  performRecall,
  reportSearchArm,
  type SearchObserver,
  renderAgentContext,
  renderMarkdownProjection,
  decodeEventCursor,
  encodeEventCursor,
  evidenceSupportScore,
  sha256,
  splitTextUnits,
  buildTextChunks,
  chunkEmbeddingInput,
  isEmbeddableUnitText,
  type TextChunk,
  ServedUnitLog,
  FUZZY_QUOTE_CANDIDATE_FLOOR,
  WEAK_EVIDENCE_FLOOR,
  type GraphEvent,
  type GraphEventFeed,
  type GraphEventStats,
  type MemoryDay,
  isSmokeEvent,
  RECONCILE_FINDING_LIMIT,
  reconcileLintFinding,
  type ReconcileFlag,
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
  type NeighborhoodNode,
  type NeighborhoodResult,
  type ProjectResult,
  type ReadResult,
  type RecallResult,
  type SearchResult,
  type TextQuoteMatch,
} from "./graphCore.js";
import { cosineSimilarity, createEmbeddingProviderFromEnv, type EmbeddingProvider } from "./embeddings.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import {
  EdgeValidityConflictError,
  JOB_MAX_ATTEMPTS,
  TERMINAL_JOB_RETENTION_DAYS,
  lintMinIntervalSeconds,
  eventPruneMaxRows,
  eventRetentionDays,
  ownerScope,
  UnknownEvidenceReferenceError,
} from "./graphCore.js";
import { performReconcileNode, type ReconcileJudge } from "./reconcile.js";
import type { GraphJobResult, GraphJobResultMap } from "./jobResults.js";
import { slugify } from "./slug.js";

type Revision = {
  id: string;
  nodeId: string;
  revisionNumber: number;
  title: string | null;
  summary: string | null;
  content: string | null;
  createdAt: string;
};

/** Catalog/log-style pages are useful as pointers but starve search/recall. */
const GIANT_CONTENT_CHARS = 12_000;

export class InMemoryGraphStore implements GraphStore {
  private sourceRows = new Map<string, GraphSource & { contentText: string; metadata: Record<string, unknown> }>();
  /** Owner scope is internal metadata, mirroring source.owner_id in Postgres. */
  private sourceOwnerIds = new Map<string, string | null>();
  private textUnits = new Map<string, TextUnit>();
  /**
   * The chunk grain the pg driver keeps in `text_chunk` (migration 020) and
   * builds its vector index on. Held here so semantic text-unit search scores
   * the same texts on both drivers and expands a hit the same way.
   */
  private textChunks = new Map<string, TextChunk>();
  private nodes = new Map<string, GraphNode>();
  private slugIndex = new Map<string, string>();
  private revisions = new Map<string, Revision>();
  private edges = new Map<string, GraphEdge>();
  private annotations = new Map<string, GraphAnnotation>();
  private eventLog: GraphEvent[] = [];
  private graphJobs = new Map<string, GraphJob>();
  private graphViews = new Map<string, GraphView>();
  private viewSlugIndex = new Map<string, string>();
  /** Tombstoned nodes stay in `nodes` (slugs stay taken) but every read path excludes them. */
  private deletedNodeIds = new Set<string>();
  /** Fake-provider vectors by content hash so semantic search stays cheap. */
  private embeddingCache = new Map<string, number[]>();
  /**
   * Judged reconcile verdicts by flagged node, mirroring the `reconcile_flag`
   * table. Keyed by node because a pass REPLACES that node's whole set.
   */
  private reconcileFlags = new Map<string, ReconcileFlag[]>();
  /** Session-served provenance log (backlog #9b) — same shape as the pg driver's. */
  private servedUnits = new ServedUnitLog();
  /**
   * Reconciliation judge. The in-memory driver defaults to the heuristic
   * (null) rather than the env OpenAI judge: it backs the test suite, and an
   * ambient OPENAI_API_KEY must never turn a unit test into an LLM call.
   * Inject one explicitly to test the judged path.
   */
  private reconcileJudge: ReconcileJudge | null;

  constructor(options: { reconcileJudge?: ReconcileJudge | null } = {}) {
    this.reconcileJudge = options.reconcileJudge ?? null;
    this.seed();
  }

  ingest(input: IngestInput, context?: GraphOperationContext): { source: GraphSource; textUnits: TextUnit[] } {
    const now = new Date().toISOString();
    const contentSha256 = sha256(input.contentText);

    // Mirror Postgres upsert semantics: identical content is one source row.
    const existing = [...this.sourceRows.values()].find(
      (row) => row.kind === input.kind && row.contentSha256 === contentSha256,
    );
    if (existing) {
      existing.title = input.title;
      existing.metadata = input.metadata ?? existing.metadata;
      const { contentText: _contentText, metadata: _metadata, ...publicSource } = existing;
      const units = [...this.textUnits.values()]
        .filter((unit) => unit.sourceId === existing.id)
        .sort((left, right) => left.ordinal - right.ordinal);
      this.servedUnits.mark(units.map((unit) => unit.id), context);
      return { source: publicSource, textUnits: units };
    }

    const id = randomUUID();
    const source: GraphSource & { contentText: string; metadata: Record<string, unknown> } = {
      id,
      kind: input.kind,
      title: input.title,
      uri: input.uri ?? null,
      contentSha256,
      contentText: input.contentText,
      metadata: input.metadata ?? {},
      createdAt: now,
    };
    const units = splitTextUnits(source.id, input.contentText);

    this.sourceRows.set(source.id, source);
    this.sourceOwnerIds.set(source.id, ownerScope(context).ownerId);
    for (const unit of units) {
      this.textUnits.set(unit.id, unit);
    }
    for (const chunk of buildTextChunks(source.id, source.title, units)) {
      this.textChunks.set(chunk.id, chunk);
    }
    this.recordEvent("ingest", source.id, context, now);
    this.enqueueMaintenanceJobs(context, ["lint_graph", "refresh_embeddings"]);

    const { contentText: _contentText, metadata: _metadata, ...publicSource } = source;
    this.servedUnits.mark(units.map((unit) => unit.id), context);
    return { source: publicSource, textUnits: units };
  }

  sources(input: { limit?: number } = {}): Array<GraphSource & { metadata: Record<string, unknown> }> {
    return [...this.sourceRows.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 1000)
      .map(({ contentText: _contentText, ...row }) => row);
  }

  readSource(input: { sourceId: string }): (GraphSource & { metadata: Record<string, unknown>; contentText: string }) | null {
    return this.sourceRows.get(input.sourceId) ?? null;
  }

  readDocument(input: { uri: string }): { uri: string; title: string; contentText: string; segmentCount: number } | null {
    const episodes = [...this.sourceRows.values()]
      .filter((row) => row.metadata.episodeOf === input.uri)
      .sort((left, right) => Number(left.metadata.episodeOrdinal ?? 0) - Number(right.metadata.episodeOrdinal ?? 0));
    if (episodes.length > 0) {
      return {
        uri: input.uri,
        title: input.uri.split("/").at(-1) ?? input.uri,
        contentText: episodes.map((row) => row.contentText).join("\n\n"),
        segmentCount: episodes.length,
      };
    }
    const whole = [...this.sourceRows.values()]
      .filter((row) => row.uri === input.uri)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return whole
      ? { uri: input.uri, title: whole.title, contentText: whole.contentText, segmentCount: 1 }
      : null;
  }

  async search(
    input: SearchInput,
    context?: GraphOperationContext,
    observer?: SearchObserver,
  ): Promise<SearchResult> {
    const provider = input.mode === "lexical" ? null : createEmbeddingProviderFromEnv();

    let result: SearchResult;
    // Mirrors PgGraphStore.search: a semantic-only search must not run (and
    // discard) a lexical pass. No Promise.all here — this driver's lexical arm
    // is synchronous, so there is nothing to overlap.
    if (input.mode === "semantic") {
      result = provider ? await this.semanticSearch(input, provider) : { nodes: [], textUnits: [] };
      if (provider) reportSearchArm(observer, "semantic", result.nodes);
    } else if (input.mode === "lexical" || !provider) {
      result = this.lexicalSearch(input);
      reportSearchArm(observer, "lexical", result.nodes);
    } else {
      // Reported in the order this driver really produces them: the lexical arm
      // is synchronous here, so it always lands before the embedding call.
      const lexical = this.lexicalSearch(input);
      reportSearchArm(observer, "lexical", lexical.nodes);
      const semantic = await this.semanticSearch(input, provider);
      reportSearchArm(observer, "semantic", semantic.nodes);
      result = {
        nodes: reciprocalRankFusion(lexical.nodes, semantic.nodes),
        textUnits: reciprocalRankFusion(lexical.textUnits, semantic.textUnits),
      };
    }
    this.servedUnits.mark(result.textUnits.map((unit) => unit.id), context);
    return result;
  }

  private lexicalSearch(input: SearchInput): SearchResult {
    const query = input.query.toLowerCase().trim();
    // Mirror Postgres: a stop-word-only (or near-empty) query has no tsquery
    // and must not fall back to substring matching — grep serves that need.
    if (query.length < 3 || !hasLexicalSignal(query)) {
      return { nodes: [], textUnits: [] };
    }
    // Content terms of the normalized query drive the fallback below: phrase
    // matching fails for natural-language questions, so require every term
    // first (AND), then any term (OR) — mirroring the pg tsquery fallback.
    // Terms are matched against the tokenized, singularized vocabulary (never
    // raw substrings), the same approximation pg's stemmed tsvector provides.
    const terms = retrievalQueryTerms(input.query);
    const types = new Set(input.types ?? []);
    const slugQuery = query.replace(/\s+/g, "-");
    const scored: Array<{ node: GraphNode; score: number; sequence: number }> = [];
    let sequence = 0;
    for (const node of this.nodes.values()) {
      sequence += 1;
      if (this.deletedNodeIds.has(node.id)) continue;
      if (types.size > 0 && !types.has(node.type)) continue;
      const title = node.title.toLowerCase();
      const summary = (node.summary ?? "").toLowerCase();
      const content = (node.content ?? "").toLowerCase();
      let score = 0;
      if (node.slug === slugQuery) score += 8;
      if (title.includes(query)) score += 4;
      if (summary.includes(query)) score += 2;
      if (content.includes(query)) score += 1;
      if (score === 0 && terms.length > 0) {
        const vocabulary = tokenizeForMatch(`${title} ${summary} ${content}`);
        const hits = terms.filter((term) => vocabulary.has(normalizeMatchToken(term)));
        if (hits.length === terms.length) score = 0.9;
        else if (hits.length > 0) score = 0.5 * (hits.length / terms.length);
      }
      if (score === 0) continue;
      // Giant catalog/log pages only surface on a title or slug match.
      if ((node.content?.length ?? 0) > GIANT_CONTENT_CHARS && !title.includes(query) && node.slug !== slugQuery) {
        continue;
      }
      scored.push({ node, score, sequence });
    }
    scored.sort((left, right) => right.score - left.score || left.sequence - right.sequence);

    const textUnits = input.includeTextUnits
      ? [...this.textUnits.values()]
        .filter((unit) => {
          // Token matching (not substring): "weddings" must find stored
          // "wedding", and "all" must not find "call" — see the node arm.
          const vocabulary = tokenizeForMatch(unit.text);
          return terms.some((term) => vocabulary.has(normalizeMatchToken(term)));
        })
        .slice(0, input.limit)
      : [];

    return { nodes: scored.slice(0, input.limit).map((entry) => entry.node), textUnits };
  }

  private async semanticSearch(input: SearchInput, provider: EmbeddingProvider): Promise<SearchResult> {
    // Dual-embed like the pg driver: the raw query preserves question intent,
    // the normalized query sharpens keyword overlap; distance is the min over
    // both vectors.
    const normalized = normalizeRetrievalQuery(input.query);
    const queryTexts = normalized === input.query.trim() ? [input.query] : [input.query, normalized];
    const queryVectors = await provider.embed(queryTexts);
    if (queryVectors.length === 0) return { nodes: [], textUnits: [] };
    const queryDistance = (vector: number[]): number =>
      Math.min(...queryVectors.map((queryVector) => 1 - cosineSimilarity(queryVector, vector)));
    const maxDistance = maxSemanticDistanceFor(input);
    const query = input.query.toLowerCase().trim();
    const slugQuery = query.replace(/\s+/g, "-");
    const types = new Set(input.types ?? []);

    const scoredNodes: Array<{ node: GraphNode; distance: number }> = [];
    for (const node of this.nodes.values()) {
      if (this.deletedNodeIds.has(node.id)) continue;
      if (types.size > 0 && !types.has(node.type)) continue;
      if (
        (node.content?.length ?? 0) > GIANT_CONTENT_CHARS &&
        !node.title.toLowerCase().includes(query) &&
        node.slug !== slugQuery
      ) {
        continue;
      }
      const vector = await this.embeddingForText(provider, [node.title, node.summary ?? "", node.content ?? ""].filter(Boolean).join("\n"));
      const distance = queryDistance(vector);
      if (distance < maxDistance) scoredNodes.push({ node, distance });
    }
    scoredNodes.sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id));

    // Chunks are scored, text units are returned — the pg driver's shape
    // (SEMANTIC_UNIT_SEARCH_SQL): the chunk is the grain worth embedding, the
    // unit is the grain that gets cited. A chunk's units all inherit its
    // distance and come back in ordinal order, capped at the caller's limit.
    const scoredUnits: Array<{ unit: TextUnit; distance: number }> = [];
    if (input.includeTextUnits) {
      const scoredChunks: Array<{ chunk: TextChunk; distance: number }> = [];
      for (const chunk of this.textChunks.values()) {
        const vector = await this.embeddingForText(provider, chunkEmbeddingInput(chunk));
        const distance = queryDistance(vector);
        if (distance < maxDistance) scoredChunks.push({ chunk, distance });
      }
      scoredChunks.sort((left, right) => left.distance - right.distance || left.chunk.id.localeCompare(right.chunk.id));
      for (const { chunk, distance } of scoredChunks.slice(0, input.limit)) {
        for (const unit of this.unitsForChunk(chunk)) scoredUnits.push({ unit, distance });
      }
    }

    return {
      // Distance attached like the pg driver (same 1 - cosine metric) — the
      // declared test double keeps the shape honest so reconcile's distance
      // gate is exercisable without Postgres.
      nodes: scoredNodes.slice(0, input.limit).map((entry) => ({ ...entry.node, distance: entry.distance })),
      textUnits: scoredUnits.slice(0, input.limit).map((entry) => entry.unit),
    };
  }

  /**
   * The text units a chunk covers, in ordinal order. Mirrors the pg driver's
   * range join on (source_id, ordinal), junk lines trimmed the same way — they
   * ride inside a chunk but were never served as evidence.
   */
  private unitsForChunk(chunk: TextChunk): TextUnit[] {
    return [...this.textUnits.values()]
      .filter((unit) =>
        unit.sourceId === chunk.sourceId
        && unit.ordinal >= chunk.firstOrdinal
        && unit.ordinal <= chunk.lastOrdinal
        && isEmbeddableUnitText(unit.text))
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  private async embeddingForText(provider: EmbeddingProvider, text: string): Promise<number[]> {
    const key = `${provider.model}:${sha256(text)}`;
    const cached = this.embeddingCache.get(key);
    if (cached) return cached;
    const [vector] = await provider.embed([text]);
    if (!vector) throw new Error("Embedding provider returned no vector.");
    this.embeddingCache.set(key, vector);
    return vector;
  }

  grep(input: GrepInput, context?: GraphOperationContext): GrepResult {
    const scope = input.scope ?? "all";
    const limit = input.limit ?? 20;
    const regex = compileGrepPattern(input.pattern, input.caseSensitive ?? false);
    const matches: GrepMatch[] = [];

    if (scope === "nodes" || scope === "all") {
      for (const node of this.nodes.values()) {
        if (this.deletedNodeIds.has(node.id)) continue;
        const fields: Array<["title" | "summary" | "content", string | null]> = [
          ["title", node.title],
          ["summary", node.summary],
          ["content", node.content],
        ];
        for (const [field, value] of fields) {
          if (!value) continue;
          const excerpt = grepExcerpt(value, regex);
          if (excerpt !== null) {
            matches.push({ kind: "node", nodeId: node.id, slug: node.slug, title: node.title, field, excerpt });
            break;
          }
        }
      }
    }

    if (scope === "sources" || scope === "all") {
      for (const unit of this.textUnits.values()) {
        const excerpt = grepExcerpt(unit.text, regex);
        if (excerpt === null) continue;
        const source = this.sourceRows.get(unit.sourceId);
        matches.push({
          kind: "source",
          sourceId: unit.sourceId,
          textUnitId: unit.id,
          ordinal: unit.ordinal,
          title: source?.title ?? unit.sourceId,
          field: "text",
          excerpt,
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

  read(input: ReadInput, context?: GraphOperationContext, opts?: { trackAccess?: boolean }): ReadResult | null {
    const nodeId = input.nodeId ?? this.slugIndex.get(input.slug ?? "");
    if (!nodeId) return null;
    if (this.deletedNodeIds.has(nodeId)) return null;
    const stored = this.nodes.get(nodeId);
    if (!stored) return null;

    const revision = input.asOf
      ? [...this.revisions.values()]
        .filter((candidate) =>
          candidate.nodeId === stored.id &&
          Date.parse(candidate.createdAt) <= Date.parse(input.asOf as string)
        )
        .sort((left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.revisionNumber - left.revisionNumber
        )[0]
      : undefined;
    if (input.asOf && !revision) return null;

    let node: GraphNode = revision
      ? {
        ...stored,
        title: revision.title ?? stored.title,
        summary: revision.summary,
        content: revision.content,
        revisionId: revision.id,
        updatedAt: revision.createdAt,
      }
      : stored;
    if (opts?.trackAccess ?? true) {
      // The pg driver buffers this bump and drains a window's worth in one
      // statement (src/activation.ts). Here the write is a Map assignment: no
      // round trip, no transaction, no dead tuple to amortize, so there is
      // nothing to batch and the count is always current.
      const activated = {
        ...stored,
        accessCount: stored.accessCount + 1,
        lastAccessedAt: new Date().toISOString(),
      };
      this.nodes.set(activated.id, activated);
      node = { ...node, accessCount: activated.accessCount, lastAccessedAt: activated.lastAccessedAt };
    }

    // Evidence and annotations intentionally remain current for historical fact
    // reads; only title/summary/content are revision-scoped in backlog #18.
    const annotations = [...this.annotations.values()].filter((annotation) => annotation.nodeId === node.id);
    const unitsById = new Map(
      (this.getEvidenceForNodes([node.id]).get(node.id) ?? []).map((unit) => [unit.id, unit] as const),
    );
    const evidence: Array<TextUnit | GraphSource> = [];
    for (const annotation of annotations) {
      if (annotation.textUnitId) {
        const textUnit = unitsById.get(annotation.textUnitId);
        if (textUnit) evidence.push(textUnit);
        continue;
      }
      if (annotation.sourceId) {
        const source = this.sourceRows.get(annotation.sourceId);
        if (!source) continue;
        const { contentText: _contentText, ...publicSource } = source;
        evidence.push(publicSource);
      }
    }

    // A tracked read is an agent-facing one — its evidence was actually shown,
    // so it counts as served. Internal reads (trackAccess: false) show nothing.
    if (opts?.trackAccess ?? true) {
      this.servedUnits.mark(evidence.filter(isTextUnit).map((unit) => unit.id), context);
    }
    return { ...node, evidence, annotations };
  }

  /**
   * Driver parity with the pg store's buffered activation: nothing is ever
   * pending here, so a flush is a no-op. Callers (shutdown paths, tests) can
   * therefore ask either driver to settle without knowing which one they hold.
   */
  flushActivation(): Promise<void> {
    return Promise.resolve();
  }

  getEvidenceForNodes(
    nodeIds: string[],
    _context?: GraphOperationContext,
    opts?: { query?: string; perNodeLimit?: number },
  ): Map<string, TextUnit[]> {
    const evidence = new Map<string, TextUnit[]>(nodeIds.map((nodeId) => [nodeId, []]));
    for (const nodeId of nodeIds) {
      const annotations = [...this.annotations.values()]
        .filter((annotation) => annotation.nodeId === nodeId && annotation.textUnitId !== null)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const units = annotations.flatMap((annotation) => {
        const unit = annotation.textUnitId ? this.textUnits.get(annotation.textUnitId) : undefined;
        return unit ? [unit] : [];
      });
      if (opts?.query) {
        // Ranked mode: token-overlap relevance to the normalized query, best
        // units first, capped per node (default 5).
        const queryTokens = new Set(retrievalQueryTerms(opts.query));
        const perNodeLimit = Math.max(1, Math.trunc(opts.perNodeLimit ?? 5));
        const ranked = units
          .map((unit, index) => ({ unit, index, score: tokenOverlap(queryTokens, tokenSet(unit.text)) }))
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .slice(0, perNodeLimit);
        evidence.set(nodeId, ranked.map((entry) => entry.unit));
      } else {
        evidence.set(nodeId, units);
      }
    }
    return evidence;
  }

  evidenceNodeIds(nodeIds: string[]): Set<string> {
    const requested = new Set(nodeIds);
    return new Set(
      [...this.annotations.values()].flatMap((annotation) =>
        annotation.nodeId && requested.has(annotation.nodeId) ? [annotation.nodeId] : [],
      ),
    );
  }

  resolveTextQuote(input: { quote: string; sourceId?: string; textUnitId?: string; limit?: number }): TextQuoteMatch[] {
    const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 8)));
    const needle = input.quote.toLowerCase();
    const inScope = (unit: TextUnit): boolean =>
      (!input.sourceId || unit.sourceId === input.sourceId) && (!input.textUnitId || unit.id === input.textUnitId);
    const exact = [...this.textUnits.values()]
      .filter((unit) => inScope(unit) && unit.text.toLowerCase().includes(needle))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.ordinal - right.ordinal)
      .slice(0, limit)
      .map((unit): TextQuoteMatch => ({ unit, match: "exact", score: 1 }));
    if (exact.length > 0) return exact;

    if (contentTerms(input.quote).length === 0) return [];
    return [...this.textUnits.values()]
      .filter(inScope)
      .map((unit): TextQuoteMatch => ({ unit, match: "fuzzy", score: evidenceSupportScore(input.quote, [unit.text]) }))
      .filter((match) => match.score >= FUZZY_QUOTE_CANDIDATE_FLOOR)
      .sort((left, right) => right.score - left.score || left.unit.id.localeCompare(right.unit.id))
      .slice(0, limit);
  }

  textUnitText(input: { textUnitId: string }, context?: GraphOperationContext): string | null {
    const unit = this.textUnits.get(input.textUnitId);
    if (!unit) return null;
    const scope = ownerScope(context);
    if (scope.scoped && this.sourceOwnerIds.get(unit.sourceId) !== scope.ownerId) return null;
    return unit.text;
  }

  markTextUnitsServed(textUnitIds: string[], context?: GraphOperationContext): void {
    this.servedUnits.mark(textUnitIds, context);
  }

  textUnitWasServed(input: { textUnitId: string }, context?: GraphOperationContext): boolean {
    return this.servedUnits.wasServed(input.textUnitId, context);
  }

  findSimilarTitles(title: string, limit: number): Array<{ node: GraphNode; score: number }> {
    const queryTokens = tokenSet(normalizeTitleForSimilarity(title));
    const normalizedQuery = normalizeTitleForSimilarity(title);
    const scored: Array<{ node: GraphNode; score: number }> = [];
    for (const node of this.nodes.values()) {
      if (this.deletedNodeIds.has(node.id)) continue;
      const exact = normalizeTitleForSimilarity(node.title) === normalizedQuery;
      const score = exact ? 1 : jaccardSimilarity(queryTokens, tokenSet(normalizeTitleForSimilarity(node.title)));
      if (exact || score > 0.25) scored.push({ node, score });
    }
    scored.sort((left, right) => right.score - left.score || right.node.updatedAt.localeCompare(left.node.updatedAt));
    return scored.slice(0, limit);
  }

  tombstoneNodes(ids: string[], context?: GraphOperationContext): { tombstoned: string[] } {
    const tombstoned: string[] = [];
    for (const id of ids) {
      if (!this.nodes.has(id) || this.deletedNodeIds.has(id)) continue;
      const now = new Date().toISOString();
      this.deletedNodeIds.add(id);
      // Close validity as well as belief, so the triple is free for a
      // successor; the reason is its own field, never metadata.
      for (const edge of this.edges.values()) {
        if (edge.expiredAt !== null) continue;
        if (edge.fromNodeId !== id && edge.toNodeId !== id) continue;
        this.edges.set(edge.id, { ...edge, expiredAt: now, validUntil: closeAt(edge, now), invalidationReason: "tombstoned" });
      }
      this.recordEvent("tombstone", id, context, now);
      this.enqueueMaintenanceJobs(context, ["lint_graph", "refresh_embeddings"]);
      tombstoned.push(id);
    }
    return { tombstoned };
  }

  supersededBy(nodeIds: string[], _context?: GraphOperationContext): Map<string, { byNodeId: string; byTitle: string }> {
    const map = new Map<string, { byNodeId: string; byTitle: string }>();
    const wanted = new Set(nodeIds);
    for (const edge of this.edges.values()) {
      if (edge.predicate !== "supersedes" || edge.expiredAt !== null) continue;
      if (!wanted.has(edge.toNodeId)) continue;
      const by = this.nodes.get(edge.fromNodeId);
      if (!by || this.deletedNodeIds.has(by.id)) continue;
      map.set(edge.toNodeId, { byNodeId: by.id, byTitle: by.title });
    }
    return map;
  }

  neighborhood(input: NeighborhoodInput): NeighborhoodResult {
    const allowedPredicates = new Set(input.predicates ?? []);
    const maxNodes = Math.max(1, Math.min(500, Math.trunc(input.maxNodes ?? 100)));
    const validAt = input.validAt;
    if (this.deletedNodeIds.has(input.nodeId) || !this.nodes.has(input.nodeId)) {
      return { nodes: [], edges: [] };
    }
    const levelByNode = new Map<string, number>([[input.nodeId, 0]]);
    const edgeResults = new Map<string, GraphEdge>();
    let frontier = new Set<string>([input.nodeId]);
    const maxDepth = input.depth ?? 1;

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next = new Set<string>();
      const sortedEdges = [...this.edges.values()].sort((left, right) => left.id.localeCompare(right.id));
      for (const edge of sortedEdges) {
        if (!edgeVisible(edge, input.asOf, input.includeExpired ?? false)) continue;
        if (validAt && !edgeValidAt(edge, validAt)) continue;
        if (allowedPredicates.size > 0 && !allowedPredicates.has(edge.predicate)) continue;
        const touchesFrontier = frontier.has(edge.fromNodeId) || frontier.has(edge.toNodeId);
        if (!touchesFrontier) continue;

        edgeResults.set(edge.id, edge);
        for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
          if (!levelByNode.has(nodeId) && !this.deletedNodeIds.has(nodeId) && this.nodes.has(nodeId)) {
            levelByNode.set(nodeId, depth);
            next.add(nodeId);
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    // Deterministic cap: BFS level first, then id — matches the pg ordering.
    const capped = [...levelByNode.entries()]
      .flatMap(([nodeId, level]) => {
        const node = this.nodes.get(nodeId);
        return node ? [{ node, level }] : [];
      })
      .sort((left, right) => left.level - right.level || left.node.id.localeCompare(right.node.id))
      .slice(0, maxNodes);
    const kept = new Set(capped.map((entry) => entry.node.id));

    return {
      nodes: capped.map((entry): NeighborhoodNode => ({ ...entry.node, level: entry.level })),
      edges: [...edgeResults.values()].filter((edge) => kept.has(edge.fromNodeId) && kept.has(edge.toNodeId)),
    };
  }

  /**
   * Mirrors edge_valid_range_excl: one version of a triple per world-time
   * instant, expired versions included. The active version is never a
   * conflict (link() turns the call into a weight update on it).
   */
  private assertNoOverlappingVersion(fromNodeId: string, toNodeId: string, predicate: string, validFrom: string): void {
    const overlapping = [...this.edges.values()]
      .filter((candidate) =>
        candidate.expiredAt !== null
        && candidate.fromNodeId === fromNodeId && candidate.toNodeId === toNodeId && candidate.predicate === predicate
        && intervalCovers(candidate, validFrom))
      .sort((left, right) => (right.validUntil ?? "\uffff").localeCompare(left.validUntil ?? "\uffff"))[0];
    if (overlapping) {
      throw new EdgeValidityConflictError(
        `Cannot link "${predicate}" from ${validFrom}: edge ${overlapping.id} is already valid over that interval. Start the new version at or after its validUntil.`,
        overlapping.id,
      );
    }
  }

  link(input: LinkInput, context?: GraphOperationContext): GraphEdge | null {
    const fromNodeId = input.fromNodeId ?? this.nodeIdForSlug(input.fromSlug);
    const toNodeId = input.toNodeId ?? this.nodeIdForSlug(input.toSlug);
    if (!fromNodeId || !toNodeId) return null;

    const now = new Date().toISOString();
    const sameTriple = (edge: GraphEdge) =>
      edge.fromNodeId === fromNodeId &&
      edge.toNodeId === toNodeId &&
      edge.predicate === input.predicate;
    const existing = [...this.edges.values()].find((edge) => edge.expiredAt === null && sameTriple(edge));

    const edge: GraphEdge = existing ?? {
      id: randomUUID(),
      fromNodeId,
      toNodeId,
      predicate: input.predicate,
      weight: input.weight,
      recordedAt: now,
      validFrom: input.validFrom ? new Date(input.validFrom).toISOString() : now,
      validUntil: null,
      expiredAt: null,
      invalidatedBy: null,
      invalidationReason: null,
    };

    // Mirrors edge_valid_range_excl: one version of a triple per world-time
    // instant, expired versions included. The active version is not a
    // conflict -- the call becomes a weight update on it, as in Postgres.
    if (!existing) this.assertNoOverlappingVersion(fromNodeId, toNodeId, input.predicate, edge.validFrom ?? now);

    // Mirrors edge_valid_range_check on the superseded edge: its validUntil
    // becomes the successor's validFrom, which therefore cannot precede its
    // own validFrom. Checked before anything is written.
    const previous = input.supersedesEdgeId && input.supersedesEdgeId !== edge.id
      ? this.edges.get(input.supersedesEdgeId)
      : undefined;
    if (previous && previous.expiredAt === null && previous.validFrom !== null && edge.validFrom !== null && edge.validFrom < previous.validFrom) {
      throw new EdgeValidityConflictError(
        `Cannot supersede edge ${previous.id}: the new edge's validFrom (${edge.validFrom}) precedes the superseded edge's validFrom.`,
        previous.id,
      );
    }

    if (!existing) {
      this.edges.set(edge.id, edge);
      this.recordEvent("link", edge.id, context, now);
      this.enqueueMaintenanceJobs(context, ["lint_graph"]);
    }

    if (previous) {
      this.expireEdge(previous.id, {
        expiredAt: now,
        validUntil: edge.validFrom,
        invalidatedBy: edge.id,
        invalidationReason: "superseded",
      }, context);
    }
    return edge;
  }

  invalidateEdge(input: InvalidateEdgeInput, context?: GraphOperationContext): GraphEdge | null {
    const edge = this.edges.get(input.edgeId);
    if (!edge) return null;
    if (edge.expiredAt !== null) return edge;
    const now = new Date().toISOString();
    const validUntil = input.validUntil ? new Date(input.validUntil).toISOString() : null;
    if (validUntil !== null && edge.validFrom !== null && validUntil < edge.validFrom) {
      throw new EdgeValidityConflictError(
        `Cannot invalidate edge ${edge.id}: validUntil (${validUntil}) precedes its validFrom (${edge.validFrom}).`,
        edge.id,
      );
    }
    return this.expireEdge(edge.id, {
      expiredAt: now,
      validUntil: validUntil ?? closeAt(edge, now),
      invalidatedBy: null,
      invalidationReason: "invalidated",
    }, context);
  }

  recall(input: RecallInput): Promise<RecallResult> {
    return performRecall(this, input);
  }

  private expireEdge(
    edgeId: string,
    patch: {
      expiredAt: string;
      validUntil: string | null;
      invalidatedBy: string | null;
      invalidationReason: NonNullable<GraphEdge["invalidationReason"]>;
    },
    context?: GraphOperationContext,
  ): GraphEdge | null {
    const edge = this.edges.get(edgeId);
    if (!edge || edge.expiredAt !== null) return edge ?? null;
    const expired: GraphEdge = {
      ...edge,
      expiredAt: patch.expiredAt,
      validUntil: patch.validUntil,
      invalidatedBy: patch.invalidatedBy,
      invalidationReason: patch.invalidationReason,
    };
    this.edges.set(expired.id, expired);
    this.recordEvent("invalidate_edge", expired.id, context, patch.expiredAt);
    this.enqueueMaintenanceJobs(context, ["lint_graph"]);
    return expired;
  }

  capture(input: CaptureInput, context?: GraphOperationContext): GraphNode {
    // Postgres parity: the whole write is one transaction there, so a bogus
    // evidence ref must leave no node behind here either. Check every ref
    // before the first mutation.
    for (const evidence of input.evidence) this.assertEvidenceRefs(evidence, context);

    const now = new Date().toISOString();
    const id = randomUUID();
    const revisionId = randomUUID();
    const baseSlug = slugify(input.title);
    const slug = this.uniqueSlug(baseSlug);
    const node: GraphNode = {
      id,
      type: input.type,
      slug,
      title: input.title,
      summary: input.summary,
      content: input.content ?? null,
      revisionId,
      updatedAt: now,
      accessCount: 0,
      lastAccessedAt: null,
    };

    this.nodes.set(id, node);
    this.slugIndex.set(slug, id);
    this.revisions.set(revisionId, {
      id: revisionId,
      nodeId: id,
      revisionNumber: 1,
      title: node.title,
      summary: node.summary,
      content: node.content,
      createdAt: now,
    });
    this.recordEvent("capture", id, context, now);
    this.enqueueMaintenanceJobs(context, ["lint_graph", "refresh_embeddings"]);
    this.enqueueReconcileJob(context, id);

    for (const evidence of input.evidence) {
      const annotationInput: AnnotateInput = {
        motivation: "supports",
        nodeId: id,
        body: {},
        selector: evidence.selector,
      };
      if (evidence.sourceId) annotationInput.sourceId = evidence.sourceId;
      if (evidence.textUnitId) annotationInput.textUnitId = evidence.textUnitId;
      this.annotate(annotationInput, context);
    }

    for (const link of input.links) {
      this.link({ fromNodeId: id, toSlug: link.toSlug, predicate: link.predicate, weight: 1 }, context);
    }

    return node;
  }

  /**
   * Parity with Postgres's FK constraints: annotations must point at real
   * rows, and a bogus ref is the named error, not a silent store.
   */
  private assertEvidenceRefs(
    input: { sourceId?: string | null | undefined; textUnitId?: string | null | undefined; nodeId?: string | null | undefined },
    context?: GraphOperationContext,
  ): void {
    if (input.sourceId != null && !this.sourceRows.has(input.sourceId)) {
      throw new UnknownEvidenceReferenceError(`annotation references an unknown source: ${input.sourceId}`);
    }
    if (input.textUnitId != null && !this.textUnits.has(input.textUnitId)) {
      throw new UnknownEvidenceReferenceError(`annotation references an unknown text unit: ${input.textUnitId}`);
    }
    if (input.nodeId != null && (!this.nodes.has(input.nodeId) || this.deletedNodeIds.has(input.nodeId))) {
      throw new UnknownEvidenceReferenceError(`annotation references an unknown node: ${input.nodeId}`);
    }
    // Owner parity with Postgres for what this driver tracks (sources, and so
    // their units): a scoped caller citing another owner's row gets the same
    // error as citing a nonexistent one, so existence never leaks.
    const scope = ownerScope(context);
    if (scope.scoped) {
      const cited = [input.sourceId, input.textUnitId != null ? this.textUnits.get(input.textUnitId)?.sourceId : undefined];
      if (cited.some((sourceId) => sourceId != null && this.sourceOwnerIds.get(sourceId) !== scope.ownerId)) {
        throw new UnknownEvidenceReferenceError(
          `annotation references an unknown source/text-unit: sourceId=${input.sourceId ?? "null"} textUnitId=${input.textUnitId ?? "null"}`,
        );
      }
    }
  }

  annotate(input: AnnotateInput, context?: GraphOperationContext): GraphAnnotation {
    this.assertEvidenceRefs(input, context);
    const now = new Date().toISOString();
    const annotation: GraphAnnotation = {
      id: randomUUID(),
      motivation: input.motivation,
      sourceId: input.sourceId ?? null,
      textUnitId: input.textUnitId ?? null,
      nodeId: input.nodeId ?? null,
      body: input.body,
      selector: input.selector,
      createdAt: now,
    };
    this.annotations.set(annotation.id, annotation);
    this.recordEvent("annotate", annotation.id, context, now);
    this.enqueueMaintenanceJobs(context, ["lint_graph"]);
    return annotation;
  }

  update(
    input: UpdateInput,
    context?: GraphOperationContext,
  ): GraphNode | { conflict: true; currentRevisionId: string } | null {
    const existing = this.nodes.get(input.nodeId);
    if (!existing || this.deletedNodeIds.has(input.nodeId)) return null;
    if (existing.revisionId !== input.baseRevisionId) {
      return { conflict: true, currentRevisionId: existing.revisionId };
    }
    // Same rule as capture: nothing mutates until every evidence ref resolves.
    for (const evidence of input.evidence ?? []) this.assertEvidenceRefs(evidence, context);
    // Postgres rolls the revision back when a link's validity conflicts; here
    // the check has to run before the first mutation to give the same result.
    for (const link of input.links ?? []) {
      const toNodeId = this.nodeIdForSlug(link.toSlug);
      if (!toNodeId) continue;
      const active = [...this.edges.values()].some((edge) =>
        edge.expiredAt === null && edge.fromNodeId === existing.id && edge.toNodeId === toNodeId && edge.predicate === link.predicate);
      if (!active) this.assertNoOverlappingVersion(existing.id, toNodeId, link.predicate, new Date().toISOString());
    }

    const now = new Date().toISOString();
    const titleChanged = input.title !== undefined && input.title !== existing.title;
    const summaryChanged = input.summary !== undefined && input.summary !== existing.summary;
    const contentChanged = input.content !== undefined && input.content !== existing.content;
    const factChanged = titleChanged || summaryChanged || contentChanged;
    const revisionId = factChanged ? randomUUID() : existing.revisionId;
    let slug = existing.slug;
    if (input.slug) {
      const base = slugify(input.slug);
      const owner = this.slugIndex.get(base);
      slug = !owner || owner === existing.id ? base : this.uniqueSlug(base);
    }
    const updated: GraphNode = {
      ...existing,
      title: input.title ?? existing.title,
      summary: input.summary ?? existing.summary,
      content: input.content ?? existing.content,
      slug,
      revisionId,
      updatedAt: now,
    };
    this.nodes.set(updated.id, updated);
    if (slug !== existing.slug) {
      this.slugIndex.delete(existing.slug);
      this.slugIndex.set(slug, updated.id);
    }
    if (factChanged) {
      const revisionNumber = 1 + Math.max(
        0,
        ...[...this.revisions.values()]
          .filter((revision) => revision.nodeId === updated.id)
          .map((revision) => revision.revisionNumber),
      );
      this.revisions.set(revisionId, {
        id: revisionId,
        nodeId: updated.id,
        revisionNumber,
        title: updated.title,
        summary: updated.summary,
        content: updated.content,
        createdAt: now,
      });
    }
    for (const evidence of input.evidence ?? []) {
      const annotationInput: AnnotateInput = {
        motivation: "supports",
        nodeId: updated.id,
        body: {},
        selector: evidence.selector,
      };
      if (evidence.sourceId) annotationInput.sourceId = evidence.sourceId;
      if (evidence.textUnitId) annotationInput.textUnitId = evidence.textUnitId;
      this.annotate(annotationInput, context);
    }
    for (const link of input.links ?? []) {
      this.link({ fromNodeId: updated.id, toSlug: link.toSlug, predicate: link.predicate, weight: 1 }, context);
    }
    this.recordEvent("update", updated.id, context, now);
    this.enqueueMaintenanceJobs(context, ["lint_graph", "refresh_embeddings"]);
    // Preserve reconcile cadence: only body changes introduce claims to judge.
    if (contentChanged) this.enqueueReconcileJob(context, updated.id);
    return updated;
  }

  project(input: ProjectInput, context?: GraphOperationContext): ProjectResult | null {
    const node = this.nodes.get(input.nodeId);
    if (!node || this.deletedNodeIds.has(node.id)) return null;
    const neighborhood = this.neighborhood({ nodeId: node.id, depth: input.depth });
    // Projection is a system read; it must not inflate access activation.
    const evidence = this.read({ nodeId: node.id }, undefined, { trackAccess: false })?.evidence.filter(isTextUnit) ?? [];

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

  timeline(): GraphEvent[] {
    return [...this.eventLog].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  events(input: EventFeedInput = { limit: 100 }): GraphEventFeed {
    const after = input.afterCursor ? decodeEventCursor(input.afterCursor) : null;
    const descending = input.order === "desc";
    let sorted = [...this.eventLog].sort(compareEventsAsc);
    if (descending) sorted = sorted.reverse();
    const filtered = after
      ? sorted.filter((event) => (descending
        ? compareEventToCursor(event, after) < 0
        : compareEventToCursor(event, after) > 0))
      : sorted;
    const page = filtered.slice(0, input.limit);
    const last = page.at(-1);
    return {
      events: page,
      nextCursor: last ? encodeEventCursor(last) : input.afterCursor ?? null,
      hasMore: filtered.length > page.length,
    };
  }

  eventStats(): GraphEventStats {
    const writeActions = new Set(WRITE_ACTIONS);
    const perDay = new Map<string, { date: string; total: number; writes: number }>();
    const actions = new Map<string, number>();
    let total = 0;
    for (const event of this.eventLog) {
      if (isSmokeEvent(event)) continue;
      const date = event.createdAt.slice(0, 10);
      const entry = perDay.get(date) ?? { date, total: 0, writes: 0 };
      entry.total += 1;
      if (writeActions.has(event.action)) entry.writes += 1;
      perDay.set(date, entry);
      actions.set(event.action, (actions.get(event.action) ?? 0) + 1);
      total += 1;
    }
    return {
      total,
      perDay: [...perDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
      actions: [...actions.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
    };
  }

  lint(): GraphLintReport {
    const snapshot = this.exportGraph();
    const findings: GraphLintFinding[] = [];
    const degree = new Map(snapshot.nodes.map((node) => [node.id, 0]));

    for (const edge of snapshot.edges) {
      degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
      degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
    }

    for (const node of snapshot.nodes) {
      if ((degree.get(node.id) ?? 0) === 0) {
        findings.push({
          severity: "warning",
          code: "orphan_node",
          entityTable: "node",
          entityId: node.id,
          message: `Node has no graph edges: ${node.title}`,
        });
      }

      const hasEvidence = [...this.annotations.values()].some((annotation) => annotation.nodeId === node.id);
      if (!hasEvidence) {
        findings.push({
          severity: "warning",
          code: "missing_evidence",
          entityTable: "node",
          entityId: node.id,
          message: `Node has no evidence annotation: ${node.title}`,
        });
      }
    }

    // weak_evidence: citations that are present but probably wrong (see pg lint).
    let weakEvidenceCount = 0;
    for (const node of snapshot.nodes) {
      if (weakEvidenceCount >= 50) break;
      const units = [...this.annotations.values()]
        .filter((annotation) => annotation.nodeId === node.id && annotation.textUnitId !== null)
        .map((annotation) => this.textUnits.get(annotation.textUnitId as string)?.text)
        .filter((text): text is string => typeof text === "string");
      if (units.length === 0) continue;
      const nodeText = `${node.title}\n${node.summary ?? ""}\n${(node.content ?? "").slice(0, 2000)}`;
      const score = evidenceSupportScore(nodeText, units);
      if (score < WEAK_EVIDENCE_FLOOR) {
        findings.push({
          severity: "warning",
          code: "weak_evidence",
          entityTable: "node",
          entityId: node.id,
          message: `Cited evidence supports ${(score * 100).toFixed(0)}% of the node's content terms (floor ${WEAK_EVIDENCE_FLOOR * 100}%): ${node.title}`,
        });
        weakEvidenceCount += 1;
      }
    }

    const titleCounts = new Map<string, number>();
    for (const node of snapshot.nodes) {
      const key = node.title.toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    for (const [title, count] of titleCounts) {
      if (count > 1) {
        findings.push({
          severity: "warning",
          code: "duplicate_title",
          count,
          message: `Multiple nodes share title: ${title}`,
        });
      }
    }

    // reconcile_duplicate / reconcile_contradiction: what the write-time
    // reconciliation judge already decided. A flag whose node or counterpart
    // has since been tombstoned is skipped, mirroring the pg driver's join.
    let reconcileCount = 0;
    for (const [nodeId, flags] of this.reconcileFlags) {
      if (reconcileCount >= RECONCILE_FINDING_LIMIT) break;
      const node = this.nodes.get(nodeId);
      if (!node || this.deletedNodeIds.has(nodeId)) continue;
      for (const flag of flags) {
        if (reconcileCount >= RECONCILE_FINDING_LIMIT) break;
        const other = this.nodes.get(flag.otherNodeId);
        if (!other || this.deletedNodeIds.has(other.id)) continue;
        findings.push(reconcileLintFinding({ code: flag.code, node, other, detail: flag.detail }));
        reconcileCount += 1;
      }
    }

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        findings: findings.length,
        errors,
        warnings,
      },
      findings,
    };
  }

  recordReconcileFlags(input: { nodeId: string; flags: ReconcileFlag[] }, _context?: GraphOperationContext): void {
    // Replace, never append: the pass that just ran is the whole truth about
    // this node. The driver is single-user, so there is no owner to key on.
    if (input.flags.length === 0) this.reconcileFlags.delete(input.nodeId);
    else this.reconcileFlags.set(input.nodeId, input.flags.map((flag) => ({ ...flag, detail: flag.detail.slice(0, 500) })));
  }

  exportMarkdown(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const node of this.nodes.values()) {
      if (this.deletedNodeIds.has(node.id)) continue;
      const projected = this.project({ nodeId: node.id, format: "markdown", depth: 1 });
      if (projected?.format === "markdown") {
        files[`${node.slug}.md`] = projected.content;
      }
    }
    return files;
  }

  /**
   * Memories per day, dated by first write.
   *
   * There is no created_at on the in-memory node, so the first revision stands
   * in for it — which is the same instant: a node and its revision 1 are
   * written together. Later revisions are ignored on purpose, so an edit never
   * moves a memory to the day it was edited.
   */
  memoryDays(): MemoryDay[] {
    const firstWrite = new Map<string, string>();
    for (const revision of this.revisions.values()) {
      const current = firstWrite.get(revision.nodeId);
      if (current === undefined || revision.createdAt < current) {
        firstWrite.set(revision.nodeId, revision.createdAt);
      }
    }
    const counts = new Map<string, number>();
    for (const node of this.nodes.values()) {
      if (this.deletedNodeIds.has(node.id)) continue;
      const written = firstWrite.get(node.id) ?? node.updatedAt;
      const date = written.slice(0, 10);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([date, memories]) => ({ date, memories }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  exportGraph(): GraphSnapshot {
    const nodes = [...this.nodes.values()]
      .filter((node) => !this.deletedNodeIds.has(node.id))
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = [...this.edges.values()]
      .filter((edge) => edge.expiredAt === null)
      .filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
      .sort((left, right) => `${left.predicate}:${left.id}`.localeCompare(`${right.predicate}:${right.id}`));
    const views = [...this.graphViews.values()].sort((left, right) => left.slug.localeCompare(right.slug));
    return { nodes, edges, views };
  }

  createView(input: CreateViewInput, context?: GraphOperationContext): GraphViewSnapshot {
    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = this.uniqueViewSlug(slugify(input.slug ?? input.title));
    const resolved = this.resolveViewMembers(input);
    const view: GraphView = {
      id,
      slug,
      title: input.title,
      rootNodeId: resolved.rootNodeId,
      query: input.query ?? null,
      summary: input.summary ?? null,
      layout: input.layout,
      includedNodeIds: resolved.nodeIds,
      includedEdgeIds: resolved.edgeIds,
      createdAt: now,
      updatedAt: now,
    };
    this.graphViews.set(view.id, view);
    this.viewSlugIndex.set(view.slug, view.id);
    this.recordEvent("create_view", view.id, context, now);
    return this.snapshotForView(view);
  }

  views(input: ListViewsInput = { limit: 25 }): GraphView[] {
    const query = input.query?.toLowerCase();
    return [...this.graphViews.values()]
      .filter((view) => {
        if (!query) return true;
        return `${view.title} ${view.summary ?? ""} ${view.query ?? ""}`.toLowerCase().includes(query);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input.limit ?? 25);
  }

  readView(input: ReadViewInput): GraphViewSnapshot | null {
    const viewId = input.viewId ?? this.viewSlugIndex.get(input.slug ?? "");
    if (!viewId) return null;
    const view = this.graphViews.get(viewId);
    return view ? this.snapshotForView(view) : null;
  }

  deleteView(input: DeleteViewInput, context?: GraphOperationContext): { deleted: boolean; view: GraphView | null } {
    const viewId = input.viewId ?? this.viewSlugIndex.get(input.slug ?? "");
    if (!viewId) return { deleted: false, view: null };
    const view = this.graphViews.get(viewId) ?? null;
    if (!view) return { deleted: false, view: null };
    this.graphViews.delete(view.id);
    this.viewSlugIndex.delete(view.slug);
    this.recordEvent("delete_view", view.id, context);
    return { deleted: true, view };
  }

  enqueueJob(input: EnqueueJobInput, context?: GraphOperationContext): GraphJob {
    if (input.dedupeKey) {
      const existing = [...this.graphJobs.values()].find((job) =>
        job.kind === input.kind &&
        job.dedupeKey === input.dedupeKey &&
        (job.status === "pending" || job.status === "running")
      );
      if (existing) return { ...existing, dedupeJoined: true };
    }

    const now = new Date().toISOString();
    const job: GraphJob = {
      id: randomUUID(),
      kind: input.kind,
      status: "pending",
      priority: input.priority,
      payload: input.payload,
      result: null,
      error: null,
      dedupeKey: input.dedupeKey ?? null,
      ownerId: ownerScope(context).ownerId,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.graphJobs.set(job.id, job);
    this.recordEvent("enqueue_job", job.id, context, now);
    return job;
  }

  jobs(input: ListJobsInput = { limit: 25 }, context?: GraphOperationContext): GraphJob[] {
    // Mirrors pgStore: a scoped caller lists only rows stamped with their
    // owner; global (null-owner) rows are operator work for unscoped readers.
    const scope = ownerScope(context);
    return [...this.graphJobs.values()]
      .filter((job) => !scope.scoped || job.ownerId === scope.ownerId)
      .filter((job) => !input.status || job.status === input.status)
      .filter((job) => !input.kind || job.kind === input.kind)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 25);
  }

  async runJob(input: RunJobInput = {}, context?: GraphOperationContext): Promise<GraphJob | null> {
    // Claimable: pending, or failed with retries left whose quadratic backoff
    // (attempts^2 x 10s since last update) has elapsed. Dead jobs never run.
    const claimable = (candidate: GraphJob): boolean => {
      if (candidate.status === "pending") return true;
      if (candidate.status === "failed" && candidate.attempts < JOB_MAX_ATTEMPTS) {
        const backoffMs = Math.pow(candidate.attempts, 2) * 10_000;
        return Date.parse(candidate.updatedAt) + backoffMs <= Date.now();
      }
      return false;
    };
    const job = input.jobId
      ? this.graphJobs.get(input.jobId) ?? null
      : [...this.graphJobs.values()]
        .filter(claimable)
        .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0] ?? null;
    if (!job || !claimable(job)) return job;

    const startedAt = new Date().toISOString();
    const running: GraphJob = {
      ...job,
      status: "running",
      attempts: job.attempts + 1,
      updatedAt: startedAt,
      startedAt,
      error: null,
    };
    this.graphJobs.set(running.id, running);

    try {
      const result = await this.performJob(running);
      const finishedAt = new Date().toISOString();
      const succeeded: GraphJob = {
        ...running,
        status: "succeeded",
        result,
        updatedAt: finishedAt,
        finishedAt,
      };
      this.graphJobs.set(succeeded.id, succeeded);
      this.recordEvent("run_job", succeeded.id, context, finishedAt);
      return succeeded;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const failed: GraphJob = {
        ...running,
        // Out of retries: dead-letter, never reclaimed.
        status: running.attempts >= JOB_MAX_ATTEMPTS ? "dead" : "failed",
        error: error instanceof Error ? error.message : "Unknown job error",
        updatedAt: finishedAt,
        finishedAt,
      };
      this.graphJobs.set(failed.id, failed);
      this.recordEvent("fail_job", failed.id, context, finishedAt);
      return failed;
    }
  }

  health(): { ok: true } {
    return { ok: true };
  }

  private async performJob(job: GraphJob): Promise<GraphJobResult> {
    if (job.kind === "lint_graph") {
      // The memory driver is single-user, so lint always covers the whole
      // store; the owner is still reported so the result shape matches pg.
      const payloadOwner = (job.payload as Record<string, unknown>).ownerId;
      const ownerId = typeof payloadOwner === "string" ? payloadOwner : null;
      const report = this.lint();
      const prunedJobs = this.pruneTerminalJobs();
      const prunedEvents = this.pruneEvents();
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
      const payload = job.payload as Record<string, unknown>;
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : null;
      if (!nodeId) throw new Error("reconcile_node: payload.nodeId is required");
      const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : null;
      const result: GraphJobResultMap["reconcile_node"] = await performReconcileNode(this, { nodeId, ownerId }, this.reconcileJudge);
      return result;
    }

    if (job.kind === "refresh_obsidian_projection") {
      const projection = buildObsidianVaultExport(this.exportMarkdown(), this.timeline(), this.exportGraph());
      const result: GraphJobResultMap["refresh_obsidian_projection"] = {
        manifest: projection.manifest,
        fileCount: Object.keys(projection.files).length,
      };
      return result;
    }

    // The in-memory driver has no embedding backfill; report the skipped shape.
    const result: GraphJobResultMap["refresh_embeddings"] = {
      provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "none",
      model: "unconfigured",
      status: "skipped_no_embedding_provider",
      ownerId: null,
      chunkedSources: 0,
      missing: {
        nodeRevisions: this.nodes.size,
        textChunks: this.textChunks.size,
      },
    };
    return result;
  }

  /**
   * Per-owner lint key and payload, global embedding refresh, and the lint
   * throttle (no new lint within TROVE_LINT_MIN_INTERVAL_SECONDS of a
   * successful one for the same key); see pgStore for the rationale.
   */
  private enqueueMaintenanceJobs(
    context: GraphOperationContext | undefined,
    kinds: Array<GraphJob["kind"]>,
  ): void {
    const scope = ownerScope(context);
    for (const kind of kinds) {
      const scoped = kind === "lint_graph" && scope.scoped && scope.ownerId !== null;
      const dedupeKey = scoped ? `maintenance:${kind}:${scope.ownerId}` : `maintenance:${kind}`;
      if (kind === "lint_graph" && this.lintSucceededRecently(dedupeKey)) continue;
      this.enqueueJob({
        kind,
        payload: scoped ? { reason: "graph_mutation", ownerId: scope.ownerId } : { reason: "graph_mutation" },
        priority: kind === "refresh_embeddings" ? 40 : 60,
        dedupeKey,
      }, context);
    }
  }

  private lintSucceededRecently(dedupeKey: string): boolean {
    const intervalMs = lintMinIntervalSeconds() * 1000;
    if (intervalMs <= 0) return false;
    const floor = Date.now() - intervalMs;
    return [...this.graphJobs.values()].some((job) =>
      job.kind === "lint_graph" &&
      job.dedupeKey === dedupeKey &&
      job.status === "succeeded" &&
      Date.parse(job.finishedAt ?? job.updatedAt) > floor
    );
  }

  /** Drop terminal jobs past the retention window; open rows are never touched. */
  private pruneTerminalJobs(): number {
    const floor = Date.now() - TERMINAL_JOB_RETENTION_DAYS * 86_400_000;
    let pruned = 0;
    for (const [id, job] of this.graphJobs) {
      const terminal = job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || (job.status as string) === "dead";
      if (!terminal || Date.parse(job.finishedAt ?? job.updatedAt) >= floor) continue;
      this.graphJobs.delete(id);
      pruned += 1;
    }
    return pruned;
  }

  /**
   * Drop audit events past the retention horizon, oldest first, at most
   * eventPruneMaxRows() per run; see pgStore.pruneEvents for the rationale.
   * The memory log dies with the process, but the driver has to agree with
   * Postgres on which events a lint removes and what it reports.
   */
  private pruneEvents(): number {
    const days = eventRetentionDays();
    if (days <= 0) return 0;
    const floor = Date.now() - days * 86_400_000;
    const expired = this.eventLog
      .filter((event) => Date.parse(event.createdAt) < floor)
      .sort(compareEventsAsc)
      .slice(0, eventPruneMaxRows());
    if (expired.length === 0) return 0;
    const doomed = new Set(expired.map((event) => event.id));
    // Rewritten in place: the log is the array itself, never a reference the
    // store swaps out, and a spread of the survivors would be argument-count
    // bound on a long log.
    const survivors = this.eventLog.filter((event) => !doomed.has(event.id));
    this.eventLog.length = 0;
    for (const event of survivors) this.eventLog.push(event);
    return expired.length;
  }

  /** Per-node reconciliation enqueue; see pgStore for the rationale. */
  private enqueueReconcileJob(context: GraphOperationContext | undefined, nodeId: string): void {
    this.enqueueJob({
      kind: "reconcile_node",
      payload: { reason: "graph_mutation", nodeId, ownerId: ownerScope(context).ownerId },
      priority: 30,
      dedupeKey: `reconcile:${nodeId}`,
    }, context);
  }

  private uniqueSlug(baseSlug: string): string {
    let slug = baseSlug || "untitled";
    let counter = 2;
    while (this.slugIndex.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
    return slug;
  }

  private uniqueViewSlug(baseSlug: string): string {
    let slug = baseSlug || "view";
    let counter = 2;
    while (this.viewSlugIndex.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
    return slug;
  }

  private nodeIdForSlug(slug: string | undefined): string | undefined {
    const nodeId = slug ? this.slugIndex.get(slug) : undefined;
    return nodeId && !this.deletedNodeIds.has(nodeId) ? nodeId : undefined;
  }

  private resolveViewMembers(input: CreateViewInput): { rootNodeId: string | null; nodeIds: string[]; edgeIds: string[] } {
    const rootNodeId = input.rootNodeId ?? this.nodeIdForSlug(input.rootSlug) ?? null;
    if ((input.rootNodeId || input.rootSlug) && (!rootNodeId || !this.nodes.has(rootNodeId) || this.deletedNodeIds.has(rootNodeId))) {
      throw new Error("View root node could not be resolved.");
    }

    if (input.includedNodeIds?.length) {
      const nodeIds = input.includedNodeIds.filter((nodeId) => this.nodes.has(nodeId) && !this.deletedNodeIds.has(nodeId));
      const nodeSet = new Set(nodeIds);
      const edgeIds = (input.includedEdgeIds?.length ? input.includedEdgeIds : [...this.edges.keys()])
        .filter((edgeId) => {
          const edge = this.edges.get(edgeId);
          return edge && nodeSet.has(edge.fromNodeId) && nodeSet.has(edge.toNodeId);
        });
      return { rootNodeId, nodeIds, edgeIds };
    }

    if (rootNodeId) {
      const neighborhood = this.neighborhood({
        nodeId: rootNodeId,
        depth: input.depth,
        predicates: input.predicates,
      });
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
      const search = this.lexicalSearch({ query: input.query, includeTextUnits: false, mode: "hybrid", limit: 50 });
      const nodeIds = search.nodes.map((node) => node.id);
      const nodeSet = new Set(nodeIds);
      const edgeIds = [...this.edges.values()]
        .filter((edge) => edge.expiredAt === null && nodeSet.has(edge.fromNodeId) && nodeSet.has(edge.toNodeId))
        .map((edge) => edge.id);
      return { rootNodeId: null, nodeIds, edgeIds };
    }

    return { rootNodeId: null, nodeIds: [], edgeIds: [] };
  }

  private snapshotForView(view: GraphView): GraphViewSnapshot {
    const nodeSet = new Set(view.includedNodeIds);
    const edgeSet = new Set(view.includedEdgeIds);
    const nodes = view.includedNodeIds.flatMap((nodeId) => {
      const node = this.nodes.get(nodeId);
      return node && !this.deletedNodeIds.has(nodeId) ? [node] : [];
    });
    const edges = [...this.edges.values()]
      .filter((edge) =>
        edge.expiredAt === null &&
        edgeSet.has(edge.id) &&
        nodeSet.has(edge.fromNodeId) &&
        nodeSet.has(edge.toNodeId)
      )
      .sort((left, right) => `${left.predicate}:${left.id}`.localeCompare(`${right.predicate}:${right.id}`));
    return { ...view, nodes, edges };
  }

  private recordEvent(action: string, entityId: string, context?: GraphOperationContext, createdAt?: string): void {
    this.eventLog.push({
      id: randomUUID(),
      action,
      entityTable: entityTableForAction(action),
      entityId,
      actorId: context?.actorId ?? null,
      actorHandle: context?.actorId ?? null,
      interfaceId: context?.interfaceId ?? null,
      requestId: context?.requestId ?? null,
      createdAt: createdAt ?? new Date().toISOString(),
    });
  }

  private seed(): void {
    const { textUnits } = this.ingest({
      title: "Initial Trove architecture note",
      kind: "agent_note",
      contentText: [
        "# Trove",
        "",
        "Trove is an evidence-backed information graph for agent-maintained memory.",
        "",
        "Markdown, mind maps, dashboards, and agent context packs are projections over the same source-of-truth graph.",
      ].join("\n"),
      metadata: {},
    });

    const firstUnit = textUnits[0];
    const root = this.capture({
      title: "Trove",
      type: "project",
      summary: "Hosted evidence graph for Scribe-style memory.",
      content: "Canonical storage separates raw sources, addressable text units, semantic graph atoms, and projections.",
      evidence: firstUnit ? [{ textUnitId: firstUnit.id, selector: {} }] : [],
      links: [],
    });

    this.recordEvent("seed", root.id, { actorId: "local-dev", interfaceId: "memory-seed" });
  }
}

function compareEventsAsc(left: GraphEvent, right: GraphEvent): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareEventToCursor(event: GraphEvent, cursor: { createdAt: string; id: string }): number {
  return event.createdAt.localeCompare(cursor.createdAt) || event.id.localeCompare(cursor.id);
}

function edgeVisible(edge: GraphEdge, asOf: string | undefined, includeExpired: boolean): boolean {
  if (includeExpired) return true;
  if (asOf) {
    return edge.recordedAt <= asOf && (edge.expiredAt === null || edge.expiredAt > asOf);
  }
  return edge.expiredAt === null;
}

/**
 * Does the edge's non-empty [validFrom, validUntil) still cover [t, infinity)?
 * Mirrors `tstzrange(valid_from, valid_until, '[)') && tstzrange(t, null, '[)')`.
 */
function intervalCovers(edge: GraphEdge, t: string): boolean {
  if (edge.validFrom === null) return false;
  if (edge.validUntil === null) return true;
  return edge.validUntil > edge.validFrom && edge.validUntil > t;
}

/** Where a closing edge's validity ends by default: now, or validFrom when that is later (an empty interval). */
function closeAt(edge: GraphEdge, now: string): string {
  return edge.validFrom !== null && edge.validFrom > now ? edge.validFrom : now;
}

/** Valid-time edge filter, mirroring `valid_from <= t and (valid_until is null or valid_until > t)`. */
function edgeValidAt(edge: GraphEdge, validAt: string): boolean {
  if (edge.validFrom === null || edge.validFrom > validAt) return false;
  if (edge.validUntil !== null && edge.validUntil <= validAt) return false;
  return true;
}

function hasLexicalSignal(query: string): boolean {
  // contentTerms, NOT retrievalQueryTerms: the latter falls back to the original
  // string when every token is a stop word, which would let "the" through the
  // gate and reinstate the substring-noise behavior F6/R7 exist to prevent.
  return contentTerms(query).length > 0;
}

/**
 * Content terms of a DOCUMENT, using the same vocabulary as the query side.
 *
 * Both sides must strip the same words. `tokenOverlap` is |query ∩ text| /
 * |query|, so a term that survives query normalization but is stripped from
 * every document can never match while still inflating the denominator — which
 * is what happened when this used a second, older stop-word list: "not"/"with"
 * survived `retrievalQueryTerms` but were dropped here, capping a perfect
 * negation match at 0.5.
 */
function tokenSet(text: string): Set<string> {
  return new Set(contentTerms(text));
}

/** |query ∩ text| / |query| — coverage of the query terms. */
function tokenOverlap(queryTokens: Set<string>, textTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let shared = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) shared += 1;
  }
  return shared / queryTokens.size;
}

function normalizeTitleForSimilarity(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

/**
 * Reciprocal Rank Fusion over the per-mode ranked lists: each item scores
 * 1/(60 + rank) per list it appears in (1-based rank), ordered by fused score.
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

function entityTableForAction(action: string): string {
  if (action === "ingest") return "source";
  if (action === "link" || action === "invalidate_edge") return "edge";
  if (action === "annotate") return "annotation";
  if (action === "create_view" || action === "delete_view") return "graph_view";
  if (action === "enqueue_job" || action === "run_job" || action === "fail_job") return "graph_job";
  return "node";
}
