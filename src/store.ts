import { randomUUID } from "node:crypto";
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
  renderAgentContext,
  renderMarkdownProjection,
  decodeEventCursor,
  encodeEventCursor,
  sha256,
  splitTextUnits,
  type GraphEvent,
  type GraphEventFeed,
  type GraphJob,
  type GraphOperationContext,
  type GraphLintFinding,
  type GraphLintReport,
  type GraphSnapshot,
  type GraphStore,
  type GraphViewSnapshot,
  type GrepMatch,
  type GrepResult,
  type ProjectResult,
  type ReadResult,
  type RecallResult,
  type SearchResult,
} from "./graphCore.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import { slugify } from "./slug.js";

type Revision = {
  id: string;
  nodeId: string;
  content: string | null;
  createdAt: string;
};

export class InMemoryGraphStore implements GraphStore {
  private sourceRows = new Map<string, GraphSource & { contentText: string; metadata: Record<string, unknown> }>();
  private textUnits = new Map<string, TextUnit>();
  private nodes = new Map<string, GraphNode>();
  private slugIndex = new Map<string, string>();
  private revisions = new Map<string, Revision>();
  private edges = new Map<string, GraphEdge>();
  private annotations = new Map<string, GraphAnnotation>();
  private eventLog: GraphEvent[] = [];
  private graphJobs = new Map<string, GraphJob>();
  private graphViews = new Map<string, GraphView>();
  private viewSlugIndex = new Map<string, string>();

  constructor() {
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
    for (const unit of units) {
      this.textUnits.set(unit.id, unit);
    }
    this.recordEvent("ingest", source.id, context, now);
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"]);

    const { contentText: _contentText, metadata: _metadata, ...publicSource } = source;
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

  search(input: SearchInput): SearchResult {
    const query = input.query.toLowerCase();
    const types = new Set(input.types ?? []);
    const nodes = [...this.nodes.values()]
      .filter((node) => types.size === 0 || types.has(node.type))
      .filter((node) => {
        const text = `${node.title} ${node.summary ?? ""} ${node.content ?? ""}`.toLowerCase();
        return text.includes(query);
      })
      .slice(0, input.limit);

    const textUnits = input.includeTextUnits
      ? [...this.textUnits.values()]
        .filter((unit) => unit.text.toLowerCase().includes(query))
        .slice(0, input.limit)
      : [];

    return { nodes, textUnits };
  }

  grep(input: GrepInput): GrepResult {
    const scope = input.scope ?? "all";
    const limit = input.limit ?? 20;
    const regex = compileGrepPattern(input.pattern, input.caseSensitive ?? false);
    const matches: GrepMatch[] = [];

    if (scope === "nodes" || scope === "all") {
      for (const node of this.nodes.values()) {
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

    return { matches: matches.slice(0, limit), truncated: matches.length > limit };
  }

  read(input: ReadInput): ReadResult | null {
    const nodeId = input.nodeId ?? this.slugIndex.get(input.slug ?? "");
    if (!nodeId) return null;
    const stored = this.nodes.get(nodeId);
    if (!stored) return null;

    const node: GraphNode = {
      ...stored,
      accessCount: stored.accessCount + 1,
      lastAccessedAt: new Date().toISOString(),
    };
    this.nodes.set(node.id, node);

    const annotations = [...this.annotations.values()].filter((annotation) => annotation.nodeId === node.id);
    const evidence: Array<TextUnit | GraphSource> = [];
    for (const annotation of annotations) {
      if (annotation.textUnitId) {
        const textUnit = this.textUnits.get(annotation.textUnitId);
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

    return { ...node, evidence, annotations };
  }

  neighborhood(input: NeighborhoodInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const allowedPredicates = new Set(input.predicates ?? []);
    const visited = new Set<string>([input.nodeId]);
    const edgeResults = new Map<string, GraphEdge>();
    let frontier = new Set<string>([input.nodeId]);
    const maxDepth = input.depth ?? 1;

    for (let currentDepth = 0; currentDepth < maxDepth; currentDepth += 1) {
      const next = new Set<string>();
      for (const edge of this.edges.values()) {
        if (!edgeVisible(edge, input.asOf, input.includeExpired ?? false)) continue;
        if (allowedPredicates.size > 0 && !allowedPredicates.has(edge.predicate)) continue;
        const touchesFrontier = frontier.has(edge.fromNodeId) || frontier.has(edge.toNodeId);
        if (!touchesFrontier) continue;

        edgeResults.set(edge.id, edge);
        for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
          if (!visited.has(nodeId)) {
            visited.add(nodeId);
            next.add(nodeId);
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    return {
      nodes: [...visited].flatMap((nodeId) => {
        const node = this.nodes.get(nodeId);
        return node ? [node] : [];
      }),
      edges: [...edgeResults.values()],
    };
  }

  link(input: LinkInput, context?: GraphOperationContext): GraphEdge | null {
    const fromNodeId = input.fromNodeId ?? this.slugIndex.get(input.fromSlug ?? "");
    const toNodeId = input.toNodeId ?? this.slugIndex.get(input.toSlug ?? "");
    if (!fromNodeId || !toNodeId) return null;

    const now = new Date().toISOString();
    const existing = [...this.edges.values()].find((edge) =>
      edge.expiredAt === null &&
      edge.fromNodeId === fromNodeId &&
      edge.toNodeId === toNodeId &&
      edge.predicate === input.predicate
    );

    const edge: GraphEdge = existing ?? {
      id: randomUUID(),
      fromNodeId,
      toNodeId,
      predicate: input.predicate,
      weight: input.weight,
      recordedAt: now,
      validFrom: input.validFrom ?? now,
      validUntil: null,
      expiredAt: null,
      invalidatedBy: null,
    };
    if (!existing) {
      this.edges.set(edge.id, edge);
      this.recordEvent("link", edge.id, context, now);
      this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph"]);
    }

    if (input.supersedesEdgeId && input.supersedesEdgeId !== edge.id) {
      this.expireEdge(input.supersedesEdgeId, {
        expiredAt: now,
        validUntil: edge.validFrom,
        invalidatedBy: edge.id,
      }, context);
    }
    return edge;
  }

  invalidateEdge(input: InvalidateEdgeInput, context?: GraphOperationContext): GraphEdge | null {
    const edge = this.edges.get(input.edgeId);
    if (!edge) return null;
    if (edge.expiredAt !== null) return edge;
    const now = new Date().toISOString();
    return this.expireEdge(edge.id, {
      expiredAt: now,
      validUntil: input.validUntil ?? now,
      invalidatedBy: null,
    }, context);
  }

  recall(input: RecallInput): Promise<RecallResult> {
    return performRecall(this, input);
  }

  private expireEdge(
    edgeId: string,
    patch: { expiredAt: string; validUntil: string | null; invalidatedBy: string | null },
    context?: GraphOperationContext,
  ): GraphEdge | null {
    const edge = this.edges.get(edgeId);
    if (!edge || edge.expiredAt !== null) return edge ?? null;
    const expired: GraphEdge = {
      ...edge,
      expiredAt: patch.expiredAt,
      validUntil: patch.validUntil,
      invalidatedBy: patch.invalidatedBy,
    };
    this.edges.set(expired.id, expired);
    this.recordEvent("invalidate_edge", expired.id, context, patch.expiredAt);
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph"]);
    return expired;
  }

  capture(input: CaptureInput, context?: GraphOperationContext): GraphNode {
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
    this.revisions.set(revisionId, { id: revisionId, nodeId: id, content: node.content, createdAt: now });
    this.recordEvent("capture", id, context, now);
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"]);

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

  annotate(input: AnnotateInput, context?: GraphOperationContext): GraphAnnotation {
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
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph"]);
    return annotation;
  }

  update(
    input: UpdateInput,
    context?: GraphOperationContext,
  ): GraphNode | { conflict: true; currentRevisionId: string } | null {
    const existing = this.nodes.get(input.nodeId);
    if (!existing) return null;
    if (existing.revisionId !== input.baseRevisionId) {
      return { conflict: true, currentRevisionId: existing.revisionId };
    }

    const now = new Date().toISOString();
    const contentChanged = input.content !== undefined && input.content !== existing.content;
    const revisionId = contentChanged ? randomUUID() : existing.revisionId;
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
    if (contentChanged) {
      this.revisions.set(revisionId, { id: revisionId, nodeId: updated.id, content: updated.content, createdAt: now });
    }
    this.recordEvent("update", updated.id, context, now);
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"]);
    return updated;
  }

  project(input: ProjectInput): ProjectResult | null {
    const node = this.nodes.get(input.nodeId);
    if (!node) return null;
    const neighborhood = this.neighborhood({ nodeId: node.id, depth: input.depth });
    const evidence = this.read({ nodeId: node.id })?.evidence.filter(isTextUnit) ?? [];

    if (input.format === "mind_map") {
      return { format: "mind_map", ...neighborhood };
    }

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

  exportMarkdown(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const node of this.nodes.values()) {
      const projected = this.project({ nodeId: node.id, format: "markdown", depth: 1 });
      if (projected?.format === "markdown") {
        files[`${node.slug}.md`] = projected.content;
      }
    }
    return files;
  }

  exportGraph(): GraphSnapshot {
    const nodes = [...this.nodes.values()].sort((left, right) => left.slug.localeCompare(right.slug));
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
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection"]);
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
    this.enqueueMaintenanceJobs(context, ["refresh_obsidian_projection"]);
    return { deleted: true, view };
  }

  enqueueJob(input: EnqueueJobInput, context?: GraphOperationContext): GraphJob {
    if (input.dedupeKey) {
      const existing = [...this.graphJobs.values()].find((job) =>
        job.kind === input.kind &&
        job.dedupeKey === input.dedupeKey &&
        (job.status === "pending" || job.status === "running")
      );
      if (existing) return existing;
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

  jobs(input: ListJobsInput = { limit: 25 }): GraphJob[] {
    return [...this.graphJobs.values()]
      .filter((job) => !input.status || job.status === input.status)
      .filter((job) => !input.kind || job.kind === input.kind)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 25);
  }

  runJob(input: RunJobInput = {}, context?: GraphOperationContext): GraphJob | null {
    const job = input.jobId
      ? this.graphJobs.get(input.jobId) ?? null
      : [...this.graphJobs.values()]
        .filter((candidate) => candidate.status === "pending")
        .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0] ?? null;
    if (!job || job.status !== "pending") return job;

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
      const result = this.performJob(running);
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
        status: "failed",
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

  private performJob(job: GraphJob): Record<string, unknown> {
    if (job.kind === "lint_graph") {
      return { lint: this.lint().summary };
    }

    if (job.kind === "refresh_obsidian_projection") {
      const projection = buildObsidianVaultExport(this.exportMarkdown(), this.timeline(), this.exportGraph());
      return {
        manifest: projection.manifest,
        fileCount: Object.keys(projection.files).length,
      };
    }

    return {
      provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "none",
      status: "skipped_no_embedding_provider",
      missing: {
        nodes: this.nodes.size,
        textUnits: this.textUnits.size,
        sources: this.sourceRows.size,
      },
    };
  }

  private enqueueMaintenanceJobs(
    context: GraphOperationContext | undefined,
    kinds: Array<GraphJob["kind"]>,
  ): void {
    for (const kind of kinds) {
      this.enqueueJob({
        kind,
        payload: { reason: "graph_mutation" },
        priority: kind === "refresh_embeddings" ? 40 : 60,
        dedupeKey: `maintenance:${kind}`,
      }, context);
    }
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

  private resolveViewMembers(input: CreateViewInput): { rootNodeId: string | null; nodeIds: string[]; edgeIds: string[] } {
    const rootNodeId = input.rootNodeId ?? this.slugIndex.get(input.rootSlug ?? "") ?? null;
    if ((input.rootNodeId || input.rootSlug) && (!rootNodeId || !this.nodes.has(rootNodeId))) {
      throw new Error("View root node could not be resolved.");
    }

    if (input.includedNodeIds?.length) {
      const nodeIds = input.includedNodeIds.filter((nodeId) => this.nodes.has(nodeId));
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
      const search = this.search({ query: input.query, includeTextUnits: false, mode: "hybrid", limit: 50 });
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
      return node ? [node] : [];
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

function entityTableForAction(action: string): string {
  if (action === "ingest") return "source";
  if (action === "link" || action === "invalidate_edge") return "edge";
  if (action === "annotate") return "annotation";
  if (action === "create_view" || action === "delete_view") return "graph_view";
  if (action === "enqueue_job" || action === "run_job" || action === "fail_job") return "graph_job";
  return "node";
}
