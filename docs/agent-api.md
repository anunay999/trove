# Agent API Contract

Trove should feel like a native tool to agents, not like a folder they have to mutate carefully.

## Interfaces

### MCP

MCP is the primary agent interface because it standardizes tools, resources, prompts, and authorization for model clients.

Expose:

- `resources/list` and `resources/read` for stable graph resources
- `tools/list` for graph operations
- `prompts/list` for reusable Trove workflows
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

Visibility is tiered by credential scope: **core** tools are shown to every credential, **curator** tools require a write scope, **operator** tools require `graph:admin`. Call-time scope checks apply regardless.

### Core Tools

**Retrieval routing (agents):** exact string (ticket id, error text, config key) → `grep` (then optional `read`) · known note name → `read` · open question (“how do we handle refunds?”) → `recall` (then `read` if the brief is thin). Full guide: [agent-usage.md](agent-usage.md).

`recall`

- Input: `query`, `tokenBudget` (default **8000**), optional `types`, `depth`, `asOf`, `includeEvidence`, `maxSemanticDistance` (cosine-distance ceiling 0–2 for semantic hits; server default 0.55, configurable via `TROVE_SEMANTIC_MAX_DISTANCE`)
- Output: a token-budgeted context pack — packed atoms with scores, connecting edges, evidence text units, citations, `spentTokens`, and `truncated`
- Open-ended questions only: hybrid search seeds a graph expansion, candidates are ranked by match plus ACT-R-style activation (recency, frequency) plus degree, and a greedy packer fills the budget. The budget covers the whole serialized response: atoms carry the packed body slice (`contentTruncated` marks cut bodies — `read` the slug for the full note), `hops` is the true graph distance from the match, and per-node evidence is relevance-ranked to the query, capped at 5 units each.
- The pack is a **brief**, not always a full note. Packing never counts as a read — only an explicit `read` strengthens activation. Primary hits pack deeply; giant catalog notes are teaser-capped. Prefer one good `recall` for open questions; follow with `read` when you need the complete note.

`grep`

- Input: `pattern` (regex; invalid regex degrades to a literal match), optional `scope` (`nodes` | `sources` | `all`), `caseSensitive`, `limit`
- Output: matches with node/source ids, the matched field, and an excerpt around the first hit
- **Prefer over `recall`** when the query contains an exact string — ports, IPs, slugs, env vars, error messages. Exact match beats semantic search there.

`read`

- Input: `id` or `slug`
- Output: a memory node (latest revision, **full content body**, evidence, annotations, revision token) or, when the id belongs to a source, the raw source document
- One read door: node lookup first, source fallback. Use for known note names and for full text after `grep`/`recall` found the right atom.

`remember`

- Input: `title`, `type`, `summary`, optional `content`, `evidence`, `links`, and optional `nodeId`/`slug` to force a target
- One write door. Exact title/slug match → new revision of that node (optimistic concurrency handled server-side); no match → new node.
- Output: `action` (`created` | `updated`), the node, and `similar` — near-matches it did NOT merge into, scored by trigram title similarity. Check it; re-call with `slug` if the dedupe missed.
- Cite evidence or say it is agent inference in the summary. This is enforced by the `missing_evidence` lint check (detective), not rejected at write time.

`connect`

- For adding explicit edges between existing nodes.
- Edges are bitemporal: `created_at` is transaction time, `valid_from`/`valid_until` are world time. Pass `supersedesEdgeId` to atomically invalidate the belief the new edge replaces — the old edge gets `expired_at`, `valid_until`, and `invalidated_by`, never a delete.

`forget`

- Input: `edgeIds`, `nodeIds`, `slugs`, and/or `query`, optional `dryRun`, `validUntil`
- Retires beliefs on the record. Explicit `edgeIds` expire edges; explicit `nodeIds`/`slugs` tombstone whole nodes so they leave `recall`, `grep`, and `read` (unknown slugs are a hard error). Both apply immediately. `query` mode defaults to a dry-run preview of active edges around matching nodes.
- Nothing is deleted; history remains queryable through `neighborhood` with `includeExpired` or `asOf`.

### Curator Tools

`ingest`

- For raw external inputs: URL, file, paste, email, Slack thread, transcript.
- Stores the raw source first and splits it into addressable text units. Then `remember` the distilled facts citing those units.

`annotate`

- For attaching meaning to a source span or text unit without rewriting the source.
- Creates annotations such as "supports claim", "contradicts claim", "mentions entity", "todo", or "important quote".

`neighborhood`

- Input: `nodeId`, `depth`, optional edge predicates, optional `asOf` timestamp, optional `includeExpired`, `maxNodes` (default 100, max 500), `validAt` (valid-time edge filter)
- Output: compact graph suitable for an agent context window or mind map; each returned node carries its BFS `level` from the seed
- Default view is current belief: invalidated edges are excluded. `asOf` time-travels along transaction time, `validAt` filters along world time (`valid_from <= t`, unexpired or `valid_until > t`), `includeExpired` returns full edge history.

`project`

- For generating an interface-specific projection: markdown page, mind map, or agent context pack.
- The projection should never become the only canonical copy of the meaning.

`views`, `read_view`, `create_view`, `delete_view`

- For durable mind maps and other saved graph projections.
- A view stores a root node or query, included nodes, included edges, layout JSON, and summary.
- Obsidian Canvas and web maps should read/write these view records rather than inventing their own sync model.

### Operator Tools (admin only)

`events`

- Input: optional `afterCursor`, `limit`, `order`
- Output: event page, `nextCursor`, and `hasMore`
- Use this for Obsidian/web/mobile incremental sync after an initial export or read.

`lint`

- Finds orphan nodes, nodes without evidence annotations, duplicate titles, and dangling/deleted-endpoint edges.

`jobs` / `enqueue_job` / `run_job`

- The durable maintenance queue (projection refresh, lint, embedding refresh). The in-server worker drains it automatically; these tools exist for inspection and manual nudges.
- `enqueue_job` supports `dedupeKey` so repeated maintenance requests coalesce while pending or running.

`export_obsidian`

- Regenerates markdown node pages, `Trove Index.md`, `Trove Log.md`, `Trove.canvas`, and `.trove/manifest.json`.
- Export is deterministic, so a diff is meaningful.
- The disk writer removes only files listed in the previous Trove manifest, preserving unrelated local Obsidian files.

## Resource URIs

Use stable URI shapes:

```text
trove://health
trove://lint
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

Current MCP resources expose health, lint, cursor events, jobs, saved views, and the graph snapshot. Node/source URI templates are the next resource expansion.

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
- interfaces should store the `events.nextCursor` checkpoint and poll from it instead of resyncing generated markdown

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
