import { randomUUID } from "node:crypto";
import pg from "pg";
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
  isTextUnit,
  decodeEventCursor,
  encodeEventCursor,
  performRecall,
  renderAgentContext,
  renderMarkdownProjection,
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
  type ProjectResult,
  type ReadResult,
  type RecallResult,
  type SearchResult,
} from "./graphCore.js";
import { createEmbeddingProviderFromEnv, vectorLiteral, type EmbeddingProvider } from "./embeddings.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import { slugify } from "./slug.js";

const { Pool } = pg;

type PgStoreOptions = {
  connectionString: string;
};

export class PgGraphStore implements GraphStore {
  private pool: pg.Pool;

  constructor(options: PgStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  async ingest(input: IngestInput, context?: GraphOperationContext): Promise<{ source: GraphSource; textUnits: TextUnit[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const sourceId = randomUUID();
      const contentSha256 = sha256(input.contentText);
      const sourceResult = await client.query(
        `insert into source (id, kind, uri, title, content_sha256, content_text, metadata, created_by)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         on conflict (kind, content_sha256)
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
        ],
      );
      const source = mapSource(sourceResult.rows[0]);
      const units = splitTextUnits(source.id, input.contentText);

      for (const unit of units) {
        await client.query(
          `insert into text_unit (
             id, source_id, ordinal, section_path, char_start, char_end, text, token_count, content_sha256, metadata
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)
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
        "refresh_obsidian_projection",
        "lint_graph",
        "refresh_embeddings",
      ]);
      await client.query("commit");

      const textUnits = await this.textUnitsForSource(source.id);
      return { source, textUnits };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async sources(input: { limit?: number } = {}): Promise<Array<GraphSource & { metadata: Record<string, unknown> }>> {
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, metadata, created_at
       from source
       order by created_at desc
       limit $1`,
      [input.limit ?? 1000],
    );
    return result.rows.map((row) => ({ ...mapSource(row), metadata: asRecord(row.metadata) }));
  }

  async readSource(input: { sourceId: string }): Promise<(GraphSource & { metadata: Record<string, unknown>; contentText: string }) | null> {
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, metadata, content_text, created_at
       from source
       where id = $1`,
      [input.sourceId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      ...mapSource(row),
      metadata: asRecord(row.metadata),
      contentText: row.content_text === null ? "" : String(row.content_text),
    };
  }

  async readDocument(input: { uri: string }): Promise<{ uri: string; title: string; contentText: string; segmentCount: number } | null> {
    const episodes = await this.pool.query(
      `select title, content_text
       from source
       where metadata->>'episodeOf' = $1
       order by (metadata->>'episodeOrdinal')::int asc nulls last, created_at asc`,
      [input.uri],
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
       where uri = $1
       order by created_at desc
       limit 1`,
      [input.uri],
    );
    if (whole.rowCount === 0) return null;
    return {
      uri: input.uri,
      title: String(whole.rows[0].title),
      contentText: String(whole.rows[0].content_text ?? ""),
      segmentCount: 1,
    };
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const lexical = await this.lexicalSearch(input);
    if (input.mode === "lexical") return lexical;

    const provider = createEmbeddingProviderFromEnv();
    if (!provider) {
      return input.mode === "semantic" ? { nodes: [], textUnits: [] } : lexical;
    }

    const semantic = await this.semanticSearch(input, provider);
    if (input.mode === "semantic") return semantic;

    return {
      nodes: mergeById(lexical.nodes, semantic.nodes),
      textUnits: mergeById(lexical.textUnits, semantic.textUnits),
    };
  }

  private async lexicalSearch(input: SearchInput): Promise<SearchResult> {
    const typeFilter = input.types && input.types.length > 0 ? input.types : null;
    const nodeResult = await this.pool.query(
      `with q as (select websearch_to_tsquery('english', $1) as query)
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
         and ($2::node_type[] is null or n.type = any($2::node_type[]))
         and (
           to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')) @@ q.query
           or to_tsvector('english', coalesce(nr.content, '') || ' ' || coalesce(nr.projection_markdown, '')) @@ q.query
           or n.slug = lower(replace($1, ' ', '-'))
           or n.title ilike $4
           or coalesce(n.summary, '') ilike $4
           or coalesce(nr.content, '') ilike $4
         )
       order by rank desc, n.updated_at desc
       limit $3`,
      [input.query, typeFilter, input.limit, `%${input.query}%`],
    );

    const textUnitResult = input.includeTextUnits
      ? await this.pool.query(
        `with q as (select websearch_to_tsquery('english', $1) as query)
         select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256,
                greatest(
                  ts_rank_cd(to_tsvector('english', text), q.query),
                  case when text ilike $3 then 0.05 else 0 end
                ) as rank
         from text_unit
         cross join q
         where to_tsvector('english', text) @@ q.query
            or text ilike $3
         order by rank desc, created_at desc, ordinal
         limit $2`,
        [input.query, input.limit, `%${input.query}%`],
      )
      : { rows: [] };

    return {
      nodes: nodeResult.rows.map(mapNode),
      textUnits: textUnitResult.rows.map(mapTextUnit),
    };
  }

  private async semanticSearch(input: SearchInput, provider: EmbeddingProvider): Promise<SearchResult> {
    const [queryEmbedding] = await provider.embed([input.query]);
    if (!queryEmbedding) return { nodes: [], textUnits: [] };
    const queryVector = vectorLiteral(queryEmbedding);
    const typeFilter = input.types && input.types.length > 0 ? input.types : null;

    const nodeResult = await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from embedding e
       join node_revision nr on nr.id = e.owner_id and e.owner_table = 'node_revision'
       join node n on n.id = nr.node_id and n.deleted_at is null
       where e.model = $2
         and ($3::node_type[] is null or n.type = any($3::node_type[]))
       order by e.embedding <=> $1::vector
       limit $4`,
      [queryVector, provider.model, typeFilter, input.limit],
    );

    const textUnitResult = input.includeTextUnits
      ? await this.pool.query(
        `select tu.id, tu.source_id, tu.ordinal, tu.section_path, tu.char_start, tu.char_end, tu.text, tu.content_sha256
         from embedding e
         join text_unit tu on tu.id = e.owner_id and e.owner_table = 'text_unit'
         where e.model = $2
         order by e.embedding <=> $1::vector
         limit $3`,
        [queryVector, provider.model, input.limit],
      )
      : { rows: [] };

    return {
      nodes: nodeResult.rows.map(mapNode),
      textUnits: textUnitResult.rows.map(mapTextUnit),
    };
  }

  async read(input: ReadInput): Promise<ReadResult | null> {
    const params = input.nodeId ? [input.nodeId] : [input.slug];
    const predicate = input.nodeId ? "n.id = $1" : "n.slug = $1";
    const nodeResult = await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from node n
       left join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null and ${predicate}
       limit 1`,
      params,
    );
    if (nodeResult.rowCount === 0) return null;

    const node = mapNode(nodeResult.rows[0]);
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
    const annotations = await this.annotationsForNode(node.id);
    const evidence: Array<TextUnit | GraphSource> = [];

    for (const annotation of annotations) {
      if (annotation.textUnitId) {
        const textUnit = await this.textUnitById(annotation.textUnitId);
        if (textUnit) evidence.push(textUnit);
        continue;
      }
      if (annotation.sourceId) {
        const source = await this.sourceById(annotation.sourceId);
        if (source) evidence.push(source);
      }
    }

    return { ...node, evidence, annotations };
  }

  async neighborhood(input: NeighborhoodInput): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodeResult = await this.pool.query(
      `with recursive walk as (
         select n.id as node_id, 0 as depth, array[n.id] as path
         from node n
         where n.id = $1
         union all
         select next_node.id as node_id, walk.depth + 1 as depth, walk.path || next_node.id as path
         from walk
         join edge e
           on e.deleted_at is null
          and (e.from_node_id = walk.node_id or e.to_node_id = walk.node_id)
         join node next_node
           on next_node.deleted_at is null
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
       select distinct n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from walk
       join node n on n.id = walk.node_id
       left join node_revision nr on nr.id = n.current_revision_id`,
      [input.nodeId, input.depth ?? 1, input.predicates ?? null, input.asOf ?? null, input.includeExpired ?? false],
    );
    const nodes = nodeResult.rows.map(mapNode);
    const nodeIds = nodes.map((node) => node.id);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    const edgeResult = await this.pool.query(
      `select id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by
       from edge
       where deleted_at is null
         and from_node_id = any($1::uuid[])
         and to_node_id = any($1::uuid[])
         and ($3::boolean
           or ($2::timestamptz is null and expired_at is null)
           or ($2::timestamptz is not null
             and created_at <= $2::timestamptz
             and (expired_at is null or expired_at > $2::timestamptz)))`,
      [nodeIds, input.asOf ?? null, input.includeExpired ?? false],
    );

    return { nodes, edges: edgeResult.rows.map(mapEdge) };
  }

  async link(input: LinkInput, context?: GraphOperationContext): Promise<GraphEdge | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const fromNodeId = input.fromNodeId ?? await this.nodeIdForSlug(input.fromSlug, client);
      const toNodeId = input.toNodeId ?? await this.nodeIdForSlug(input.toSlug, client);
      if (!fromNodeId || !toNodeId) {
        await client.query("rollback");
        return null;
      }

      const result = await client.query(
        `insert into edge (id, from_node_id, to_node_id, predicate, weight, valid_from, created_by)
         values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7)
         on conflict (from_node_id, to_node_id, predicate) where deleted_at is null and expired_at is null
         do update set weight = excluded.weight
         returning id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by`,
        [randomUUID(), fromNodeId, toNodeId, input.predicate, input.weight, input.validFrom ?? null, actorUuid],
      );
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
        const expired = await client.query(
          `update edge
           set expired_at = now(), valid_until = $2::timestamptz, invalidated_by = $3
           where id = $1 and deleted_at is null and expired_at is null
           returning id`,
          [input.supersedesEdgeId, edge.validFrom, edge.id],
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

      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["refresh_obsidian_projection", "lint_graph"]);
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
      const existing = await client.query(
        `select id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by
         from edge
         where id = $1 and deleted_at is null
         for update`,
        [input.edgeId],
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

      const updated = await client.query(
        `update edge
         set expired_at = now(), valid_until = coalesce($2::timestamptz, now())
         where id = $1
         returning id, from_node_id, to_node_id, predicate, weight, created_at, valid_from, valid_until, expired_at, invalidated_by`,
        [input.edgeId, input.validUntil ?? null],
      );
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
      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["refresh_obsidian_projection", "lint_graph"]);
      await client.query("commit");
      return edge;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    return performRecall(this, input);
  }

  async capture(input: CaptureInput, context?: GraphOperationContext): Promise<GraphNode> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const id = randomUUID();
      const revisionId = randomUUID();
      const slug = await this.uniqueSlug(slugify(input.title), client);
      const content = input.content ?? null;

      await client.query(
        `insert into node (id, type, slug, title, summary, metadata)
         values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
        [id, input.type, slug, input.title, input.summary],
      );
      await client.query(
        `insert into node_revision (
           id, node_id, revision_number, content, projection_markdown, frontmatter, content_sha256, created_by
         )
         values ($1, $2, 1, $3, null, '{}'::jsonb, $4, $5)`,
        [revisionId, id, content, sha256(content ?? ""), actorUuid],
      );
      await client.query("update node set current_revision_id = $1 where id = $2", [revisionId, id]);

      for (const evidence of input.evidence) {
        await this.insertAnnotation(client, {
          motivation: "supports",
          sourceId: evidence.sourceId,
          textUnitId: evidence.textUnitId,
          nodeId: id,
          body: {},
          selector: evidence.selector,
        }, context, actorUuid);
      }

      for (const link of input.links) {
        const toNodeId = await this.nodeIdForSlug(link.toSlug, client);
        if (!toNodeId) continue;
        await client.query(
          `insert into edge (id, from_node_id, to_node_id, predicate, valid_from, created_by)
           values ($1, $2, $3, $4, now(), $5)
           on conflict (from_node_id, to_node_id, predicate) where deleted_at is null and expired_at is null
           do nothing`,
          [randomUUID(), id, toNodeId, link.predicate, actorUuid],
        );
      }

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
        "refresh_obsidian_projection",
        "lint_graph",
        "refresh_embeddings",
      ]);
      await client.query("commit");

      const node = await this.read({ nodeId: id });
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
      const current = await client.query(
        `select n.id, n.current_revision_id, nr.content
         from node n
         left join node_revision nr on nr.id = n.current_revision_id
         where n.id = $1 and n.deleted_at is null
         for update of n`,
        [input.nodeId],
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

      const revisionNumberResult = await client.query(
        "select coalesce(max(revision_number), 0) + 1 as next_revision from node_revision where node_id = $1",
        [input.nodeId],
      );
      const revisionId = randomUUID();
      const content = input.content ?? current.rows[0].content ?? null;
      await client.query(
        `insert into node_revision (
           id, node_id, revision_number, content, projection_markdown, frontmatter, content_sha256, created_by
         )
         values ($1, $2, $3, $4, null, '{}'::jsonb, $5, $6)`,
        [revisionId, input.nodeId, revisionNumberResult.rows[0].next_revision, content, sha256(content ?? ""), actorUuid],
      );
      await client.query(
        `update node
         set title = coalesce($1, title),
             summary = coalesce($2, summary),
             current_revision_id = $3,
             updated_at = now()
         where id = $4`,
        [input.title ?? null, input.summary ?? null, revisionId, input.nodeId],
      );
      await this.recordEvent(
        client,
        "update",
        "node",
        input.nodeId,
        { revisionId, title: input.title, summary: input.summary },
        { revisionId: currentRevisionId },
        context,
        actorUuid,
      );
      await this.enqueueMaintenanceJobs(client, context, actorUuid, [
        "refresh_obsidian_projection",
        "lint_graph",
        "refresh_embeddings",
      ]);
      await client.query("commit");

      const updated = await this.read({ nodeId: input.nodeId });
      return updated ? stripReadResult(updated) : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async project(input: ProjectInput): Promise<ProjectResult | null> {
    const read = await this.read({ nodeId: input.nodeId });
    if (!read) return null;
    const node = stripReadResult(read);
    const neighborhood = await this.neighborhood({ nodeId: node.id, depth: input.depth });
    const evidence = read.evidence.filter(isTextUnit);

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

  async timeline(): Promise<GraphEvent[]> {
    const result = await this.pool.query(
      `select ge.id, ge.action, ge.entity_table, ge.entity_id, ge.actor_id, a.handle as actor_handle,
              ge.interface_id, ge.request_id, ge.created_at
       from graph_event ge
       left join actor a on a.id = ge.actor_id
       order by ge.created_at desc
       limit 100`,
    );
    return result.rows.map(mapEvent);
  }

  async events(input: EventFeedInput = { limit: 100 }): Promise<GraphEventFeed> {
    const after = input.afterCursor ? decodeEventCursor(input.afterCursor) : null;
    const result = await this.pool.query(
      `select ge.id, ge.action, ge.entity_table, ge.entity_id, ge.actor_id, a.handle as actor_handle,
              ge.interface_id, ge.request_id, ge.created_at
       from graph_event ge
       left join actor a on a.id = ge.actor_id
       where ($1::timestamptz is null or (ge.created_at, ge.id) > ($1::timestamptz, $2::uuid))
       order by ge.created_at asc, ge.id asc
       limit $3`,
      [after?.createdAt ?? null, after?.id ?? null, input.limit + 1],
    );
    const rows = result.rows.slice(0, input.limit);
    const events = rows.map(mapEvent);
    const last = events.at(-1);
    return {
      events,
      nextCursor: last ? encodeEventCursor(last) : input.afterCursor ?? null,
      hasMore: result.rows.length > rows.length,
    };
  }

  async lint(): Promise<GraphLintReport> {
    const [nodeCount, edgeCount, orphanNodes, missingEvidence, duplicateTitles, danglingEdges] = await Promise.all([
      this.pool.query("select count(*)::int as count from node where deleted_at is null"),
      this.pool.query("select count(*)::int as count from edge where deleted_at is null and expired_at is null"),
      this.pool.query(
        `select n.id, n.title
         from node n
         left join edge e on e.deleted_at is null and e.expired_at is null and (e.from_node_id = n.id or e.to_node_id = n.id)
         where n.deleted_at is null
         group by n.id, n.title
         having count(e.id) = 0
         order by n.updated_at desc
         limit 50`,
      ),
      this.pool.query(
        `select n.id, n.title
         from node n
         left join annotation a on a.node_id = n.id
         where n.deleted_at is null
         group by n.id, n.title
         having count(a.id) = 0
         order by n.updated_at desc
         limit 50`,
      ),
      this.pool.query(
        `select lower(title) as title_key, count(*)::int as count
         from node
         where deleted_at is null
         group by lower(title)
         having count(*) > 1
         order by count(*) desc, lower(title)
         limit 50`,
      ),
      this.pool.query(
        `select e.id
         from edge e
         left join node from_node on from_node.id = e.from_node_id and from_node.deleted_at is null
         left join node to_node on to_node.id = e.to_node_id and to_node.deleted_at is null
         where e.deleted_at is null and e.expired_at is null
           and (from_node.id is null or to_node.id is null)
         limit 50`,
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

  async exportMarkdown(): Promise<Record<string, string>> {
    const result = await this.pool.query("select id, slug from node where deleted_at is null order by slug");
    const files: Record<string, string> = {};
    for (const row of result.rows) {
      const projected = await this.project({ nodeId: row.id, format: "markdown", depth: 1 });
      if (projected?.format === "markdown") {
        files[`${row.slug}.md`] = projected.content;
      }
    }
    return files;
  }

  async exportGraph(): Promise<GraphSnapshot> {
    const nodeResult = await this.pool.query(
      `select n.id, n.type, n.slug, n.title, n.summary, nr.content, n.current_revision_id, n.updated_at, n.access_count, n.last_accessed_at
       from node n
       left join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null
       order by n.slug`,
    );
    const edgeResult = await this.pool.query(
      `select e.id, e.from_node_id, e.to_node_id, e.predicate, e.weight, e.created_at, e.valid_from, e.valid_until, e.expired_at, e.invalidated_by
       from edge e
       join node from_node on from_node.id = e.from_node_id and from_node.deleted_at is null
       join node to_node on to_node.id = e.to_node_id and to_node.deleted_at is null
       where e.deleted_at is null and e.expired_at is null
       order by e.predicate, e.id`,
    );

    return {
      nodes: nodeResult.rows.map(mapNode),
      edges: edgeResult.rows.map(mapEdge),
      views: await this.views({ limit: 100 }),
    };
  }

  async createView(input: CreateViewInput, context?: GraphOperationContext): Promise<GraphViewSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actorUuid = await this.actorUuidForContext(client, context);
      const id = randomUUID();
      const slug = await this.uniqueViewSlug(slugify(input.slug ?? input.title), client);
      const resolved = await this.resolveViewMembers(client, input);

      const result = await client.query(
        `insert into graph_view (
           id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids, summary, created_by
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid[], $8::uuid[], $9, $10)
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
      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["refresh_obsidian_projection"]);
      await client.query("commit");
      return await this.snapshotForView(view);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async views(input: ListViewsInput = { limit: 25 }): Promise<GraphView[]> {
    const result = await this.pool.query(
      `select id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
              summary, created_at, updated_at
       from graph_view
       where ($1::text is null or title ilike $1 or coalesce(summary, '') ilike $1 or coalesce(query, '') ilike $1)
       order by updated_at desc
       limit $2`,
      [input.query ? `%${input.query}%` : null, input.limit ?? 25],
    );
    return result.rows.map(mapView);
  }

  async readView(input: ReadViewInput): Promise<GraphViewSnapshot | null> {
    const params = input.viewId ? [input.viewId] : [input.slug];
    const predicate = input.viewId ? "id = $1" : "slug = $1";
    const result = await this.pool.query(
      `select id, slug, title, root_node_id, query, layout, included_node_ids, included_edge_ids,
              summary, created_at, updated_at
       from graph_view
       where ${predicate}
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
      const params = input.viewId ? [input.viewId] : [input.slug];
      const predicate = input.viewId ? "id = $1" : "slug = $1";
      const result = await client.query(
        `delete from graph_view
         where ${predicate}
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
      await this.enqueueMaintenanceJobs(client, context, actorUuid, ["refresh_obsidian_projection"]);
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
      if ((existing.rowCount ?? 0) > 0) return mapJob(existing.rows[0]);
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
      if ((existing.rowCount ?? 0) > 0) return mapJob(existing.rows[0]);
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
      const result = await client.query(
        `select id
         from graph_job
         where status = 'pending'
           and ($1::uuid is null or id = $1)
         order by priority desc, created_at
         for update skip locked
         limit 1`,
        [jobId ?? null],
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

  private async performJob(job: GraphJob): Promise<Record<string, unknown>> {
    if (job.kind === "lint_graph") {
      return { lint: (await this.lint()).summary };
    }

    if (job.kind === "refresh_obsidian_projection") {
      const projection = buildObsidianVaultExport(
        await this.exportMarkdown(),
        await this.timeline(),
        await this.exportGraph(),
      );
      return {
        manifest: projection.manifest,
        fileCount: Object.keys(projection.files).length,
      };
    }

    const provider = createEmbeddingProviderFromEnv();
    const model = provider?.model ?? process.env.TROVE_EMBEDDING_MODEL ?? "unconfigured";
    // Only the owner types the backfill actually embeds (and search actually
    // reads) are counted; whole-source vectors are a future feature, and
    // counting them here made every job report look permanently unfinished.
    const [nodeRevisions, textUnits] = await Promise.all([
      this.pool.query(
        `select count(*)::int as count
         from node n
         join node_revision nr on nr.id = n.current_revision_id
         where n.deleted_at is null
           and not exists (
             select 1 from embedding e
             where e.owner_table = 'node_revision'
               and e.owner_id = nr.id
               and e.model = $1
               and e.content_sha256 = nr.content_sha256
           )`,
        [model],
      ),
      this.pool.query(
        `select count(*)::int as count
         from text_unit tu
         where not exists (
           select 1 from embedding e
           where e.owner_table = 'text_unit'
             and e.owner_id = tu.id
             and e.model = $1
             and e.content_sha256 = tu.content_sha256
         )`,
        [model],
      ),
    ]);

    const missing = {
      nodeRevisions: Number(nodeRevisions.rows[0]?.count ?? 0),
      textUnits: Number(textUnits.rows[0]?.count ?? 0),
    };

    if (!provider) {
      return {
        provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "none",
        model,
        status: "skipped_no_embedding_provider",
        missing,
      };
    }

    const limit = Number(asRecord(job.payload).limit ?? process.env.TROVE_EMBEDDING_JOB_LIMIT ?? 24);
    const embedded = await this.refreshMissingEmbeddings(provider, Number.isFinite(limit) ? limit : 24);
    return {
      provider: process.env.TROVE_EMBEDDING_PROVIDER ?? "openai",
      model,
      status: "refreshed",
      missingBefore: missing,
      embedded,
    };
  }

  private async refreshMissingEmbeddings(
    provider: EmbeddingProvider,
    limit: number,
  ): Promise<{ nodeRevisions: number; textUnits: number }> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const nodeRevisionRows = await this.pool.query(
      `select nr.id, nr.content_sha256, concat_ws(E'\n', n.title, n.summary, nr.content) as text
       from node n
       join node_revision nr on nr.id = n.current_revision_id
       where n.deleted_at is null
         and length(trim(concat_ws(E'\n', n.title, n.summary, nr.content))) > 0
         and not exists (
           select 1 from embedding e
           where e.owner_table = 'node_revision'
             and e.owner_id = nr.id
             and e.model = $1
             and e.content_sha256 = nr.content_sha256
         )
       order by n.updated_at desc
       limit $2`,
      [provider.model, boundedLimit],
    );
    const remaining = Math.max(0, boundedLimit - nodeRevisionRows.rows.length);
    const textUnitRows = remaining === 0 ? { rows: [] } : await this.pool.query(
      `select tu.id, tu.content_sha256, tu.text
       from text_unit tu
       where length(trim(tu.text)) > 0
         and not exists (
           select 1 from embedding e
           where e.owner_table = 'text_unit'
             and e.owner_id = tu.id
             and e.model = $1
             and e.content_sha256 = tu.content_sha256
         )
       order by tu.created_at desc
       limit $2`,
      [provider.model, remaining],
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
    const embeddings = await provider.embed(rows.map((row) => String(row.text)));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const embedding = embeddings[index];
        if (!row || !embedding) continue;
        await client.query(
          `insert into embedding (owner_table, owner_id, model, dimensions, embedding, content_sha256)
           values ($1, $2, $3, $4, $5::vector, $6)
           on conflict (owner_table, owner_id, model, content_sha256) do nothing`,
          [
            ownerTable,
            row.id,
            provider.model,
            provider.dimensions,
            vectorLiteral(embedding),
            row.content_sha256,
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
         set status = $2,
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

  private async insertAnnotation(
    client: pg.PoolClient,
    input: AnnotateInput,
    context?: GraphOperationContext,
    actorUuid?: string | null,
  ): Promise<GraphAnnotation> {
    const resolvedActorUuid = actorUuid === undefined ? await this.actorUuidForContext(client, context) : actorUuid;
    const result = await client.query(
      `insert into annotation (
         id, motivation, source_id, text_unit_id, node_id, body, selector, created_by
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
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
      ],
    );
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
      `insert into graph_event (id, actor_id, interface_id, action, entity_table, entity_id, before, after, request_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
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
      ],
    );
  }

  private async uniqueSlug(baseSlug: string, client: pg.PoolClient): Promise<string> {
    let slug = baseSlug || "untitled";
    let counter = 2;
    while (true) {
      const result = await client.query("select 1 from node where slug = $1", [slug]);
      if (result.rowCount === 0) return slug;
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
  }

  private async uniqueViewSlug(baseSlug: string, client: pg.PoolClient): Promise<string> {
    let slug = baseSlug || "view";
    let counter = 2;
    while (true) {
      const result = await client.query("select 1 from graph_view where slug = $1", [slug]);
      if (result.rowCount === 0) return slug;
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
  }

  private async resolveViewMembers(
    client: pg.PoolClient,
    input: CreateViewInput,
  ): Promise<{ rootNodeId: string | null; nodeIds: string[]; edgeIds: string[] }> {
    const rootNodeId = input.rootNodeId ?? await this.nodeIdForSlug(input.rootSlug, client);
    if (input.rootNodeId || input.rootSlug) {
      if (!rootNodeId) throw new Error("View root node could not be resolved.");
      const root = await client.query("select 1 from node where id = $1 and deleted_at is null", [rootNodeId]);
      if (root.rowCount === 0) throw new Error("View root node could not be resolved.");
    }

    if (input.includedNodeIds?.length) {
      const nodes = await client.query(
        `select id
         from node
         where deleted_at is null and id = any($1::uuid[])
         order by array_position($1::uuid[], id)`,
        [input.includedNodeIds],
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
      const search = await this.search({ query: input.query, includeTextUnits: false, mode: "hybrid", limit: 50 });
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
      `select e.id, e.from_node_id, e.to_node_id, e.predicate, e.weight, e.created_at, e.valid_from, e.valid_until, e.expired_at, e.invalidated_by
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

  private async nodeIdForSlug(slug: string | undefined, client?: pg.PoolClient): Promise<string | null> {
    if (!slug) return null;
    const queryable = client ?? this.pool;
    const result = await queryable.query("select id from node where slug = $1 and deleted_at is null", [slug]);
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

  private async annotationsForNode(nodeId: string): Promise<GraphAnnotation[]> {
    const result = await this.pool.query(
      `select id, motivation, source_id, text_unit_id, node_id, body, selector, created_at
       from annotation
       where node_id = $1
       order by created_at`,
      [nodeId],
    );
    return result.rows.map(mapAnnotation);
  }

  private async textUnitById(id: string): Promise<TextUnit | null> {
    const result = await this.pool.query(
      `select id, source_id, ordinal, section_path, char_start, char_end, text, content_sha256
       from text_unit
       where id = $1`,
      [id],
    );
    return result.rowCount === 0 ? null : mapTextUnit(result.rows[0]);
  }

  private async sourceById(id: string): Promise<GraphSource | null> {
    const result = await this.pool.query(
      `select id, kind, title, uri, content_sha256, created_at
       from source
       where id = $1`,
      [id],
    );
    return result.rowCount === 0 ? null : mapSource(result.rows[0]);
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

function mergeById<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...primary, ...secondary]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
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
