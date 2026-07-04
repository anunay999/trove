# Agent API Contract

Trove should feel like a native tool to agents, not like a folder they have to mutate carefully.

## Interfaces

### MCP

MCP is the primary agent interface because it standardizes tools, resources, prompts, and authorization for model clients.

Expose:

- `resources/list` and `resources/read` for stable graph resources
- `tools/list` for graph operations
- `prompts/list` for reusable Scribe workflows
- Streamable HTTP transport with OAuth or scoped service tokens for hosted agents
- stdio transport for local spawned agents

Relevant official docs:

- MCP resources: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- MCP tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

### HTTP JSON

HTTP exists for human interfaces and simple automations:

- Obsidian plugin
- web mind map
- command palette
- Raycast or Shortcuts actions
- admin UI

The HTTP API should mirror the MCP operations rather than becoming a second product.

## Tool Surface

### Read Tools

`graph.search`

- Input: `query`, optional `types`, `tags`, `time_range`, `limit`
- Output: ranked nodes, matching snippets, source citations, graph distance hints
- Backing indexes: Postgres full text search by default, optional pgvector semantic search when embeddings are configured
- `mode` can be `lexical`, `semantic`, or `hybrid`; `hybrid` falls back to lexical when no embedding provider is configured

`graph.read`

- Input: `node_id` or canonical slug
- Output: latest materialized page, current facts, outgoing/incoming edges, revision token

`graph.neighborhood`

- Input: `node_id`, `depth`, optional edge predicates, optional `asOf` timestamp, optional `includeExpired`
- Output: compact graph suitable for an agent context window or mind map
- Default view is current belief: invalidated edges are excluded. `asOf` time-travels along transaction time ("what did the graph believe then"), `includeExpired` returns full edge history.

`graph.recall`

- Input: `query`, `tokenBudget` (default 2000), optional `types`, `depth`, `asOf`, `includeEvidence`
- Output: a token-budgeted context pack — packed atoms with scores, connecting edges, evidence text units, citations, `spentTokens`, and `truncated`
- This is the flagship read operator: hybrid search seeds a graph expansion, candidates are ranked by match plus ACT-R-style activation (recency, frequency) plus degree, and a greedy packer fills the budget. Packing a node counts as a read, so recalled memories strengthen.
- Prefer one `graph.recall` call over search-then-read-then-neighborhood chains.

`graph.timeline`

- Input: optional node, source, project, or tag
- Output: ordered events and revisions, including `actorId`, `actorHandle`, `interfaceId`, and `requestId`

`graph.events`

- Input: optional `afterCursor`, `limit`
- Output: ascending event page, `nextCursor`, and `hasMore`
- Use this for Obsidian/web/mobile incremental sync after an initial export or read.

### Write Tools

`graph.capture`

- For saving a non-trivial answer, decision, or synthesis.
- Creates or updates nodes and edges in one transaction.
- Requires citations or an explicit `source: "agent_inference"` marker.

`graph.ingest`

- For raw external inputs: URL, file, paste, email, Slack thread, PDF, screenshot OCR.
- Stores raw source first, splits it into addressable text units, then extracts candidate graph changes.

`graph.annotate`

- For attaching meaning to a source span or text unit without rewriting the source.
- Creates annotations such as "supports claim", "contradicts claim", "mentions entity", "todo", or "important quote".

`graph.update`

- For targeted changes to existing nodes.
- Requires a `base_revision` token so stale agents cannot silently overwrite newer work.

`graph.link`

- For adding explicit edges between existing nodes.
- Useful when an agent discovers that two pages should be connected but should not rewrite either page.
- Also used by importers to turn Obsidian wikilinks into graph edges.
- Edges are bitemporal: `created_at` is transaction time, `valid_from`/`valid_until` are world time. Pass `supersedesEdgeId` to atomically invalidate the belief the new edge replaces — the old edge gets `expired_at`, `valid_until`, and `invalidated_by`, never a delete.

`graph.invalidate_edge`

- For retiring a belief without recording a replacement.
- Sets `expired_at` (and `valid_until`, default now) on the edge; history remains queryable through `graph.neighborhood` with `includeExpired` or `asOf`.

`graph.lint`

- Current implementation finds orphan nodes, nodes without evidence annotations, duplicate titles, and dangling/deleted-endpoint edges.
- Later passes should add contradiction detection, stale claim checks, weak hub detection, and safe-fix planning.

`graph.jobs`

- Lists durable maintenance jobs.
- Use this before expensive projection or embedding work so agents do not duplicate running jobs.

`graph.enqueue_job`

- Enqueues one of `refresh_obsidian_projection`, `lint_graph`, or `refresh_embeddings`.
- Requires `graph:admin`.
- Supports `dedupeKey` so repeated maintenance requests coalesce while pending or running.

`graph.run_job`

- Claims and runs one pending job inline, or a specific `jobId`.
- Requires `graph:admin`.
- Workers use the same store operation; hosted agents should prefer queueing over direct storage access.

Scribe-compatible aliases map to the same canonical graph operations:

- `scribe.query` -> `graph.search`
- `scribe.capture` -> `graph.capture`
- `scribe.ingest` -> `graph.ingest`
- `scribe.update` -> `graph.update`
- `scribe.lint` -> `graph.lint`
- `scribe.export_obsidian` -> `graph.export_obsidian`

`graph.export_obsidian`

- Regenerates markdown node pages, `Trove Index.md`, `Trove Log.md`, `Trove.canvas`, and `.trove/manifest.json`.
- Export is deterministic, so a diff is meaningful.
- The disk writer removes only files listed in the previous Trove manifest, preserving unrelated local Obsidian files.

`graph.project`

- For generating an interface-specific projection: markdown page, mind map, timeline, agent context pack, or dashboard slice.
- The projection should never become the only canonical copy of the meaning.

`graph.views`, `graph.read_view`, `graph.create_view`, `graph.delete_view`

- For durable mind maps and other saved graph projections.
- A view stores a root node or query, included nodes, included edges, layout JSON, and summary.
- Obsidian Canvas and web maps should read/write these view records rather than inventing their own sync model.

## Resource URIs

Use stable URI shapes:

```text
trove://health
trove://lint
trove://timeline
trove://events
trove://jobs
trove://views
trove://graph
trove://projection/obsidian/manifest
trove://node/{node_id}                         # planned
trove://slug/{slug}                            # planned
trove://source/{source_id}                     # planned
trove://text-unit/{text_unit_id}               # planned
trove://annotation/{annotation_id}             # planned
trove://view/{view_id}                         # planned
trove://search?q=deterministic+dedup           # planned
```

Current MCP resources expose health, lint, timeline, cursor events, jobs, saved views, graph snapshot, and Obsidian manifest. Node/source URI templates are the next resource expansion.

## Write Discipline

Every agent write should produce:

- a graph transaction id
- an append-only event
- before and after revision ids
- actor id and interface id
- citation or source-span coverage
- validation result

Destructive changes should be soft deletes first. A compaction job can hard-delete only after retention.

Current implementation:

- service-token `actor_id` values are upserted into the `actor` table as agent actors
- HTTP writes default to `interfaceId = "http"` unless `X-Trove-Interface` is set
- MCP Streamable HTTP writes default to `interfaceId = "mcp"`
- `X-Request-Id` is preserved as `graph_event.request_id`; otherwise the service generates one
- local stdio MCP writes use `local-stdio-agent` and `stdio-mcp`
- graph mutations enqueue `graph_job` maintenance rows for projection, lint, and embedding refresh
- interfaces should store the `graph.events.nextCursor` checkpoint and poll from it instead of resyncing generated markdown

## Agent Permissions

Suggested scopes:

- `graph:read`
- `graph:write`
- `graph:write:capture`
- `graph:write:update`
- `graph:write:link`
- `graph:write:ingest`
- `graph:export`
- `graph:admin`

Do not give every agent broad write access. Most agents need search/read plus capture/update with revision checks.

Development mode may run without `TROVE_SERVICE_TOKENS`. Hosted mode should set scoped service tokens or OAuth. Service-token entries use `token|actor_id|scope,scope`; callers send `Authorization: Bearer <token>`.

## Prompt Injection Boundary

Raw sources are untrusted. The service should store them as source material, but agent tools should clearly separate:

- source text
- extracted claims
- agent interpretation
- accepted canonical facts

An instruction found inside a source document is content, not an instruction to the agent or the service.
