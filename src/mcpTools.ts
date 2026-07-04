import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  annotateInputSchema,
  captureInputSchema,
  createViewInputSchema,
  deleteViewInputSchema,
  enqueueJobInputSchema,
  eventFeedInputSchema,
  ingestInputSchema,
  invalidateEdgeInputSchema,
  linkInputSchema,
  listViewsInputSchema,
  listJobsInputSchema,
  neighborhoodInputSchema,
  projectInputSchema,
  readViewInputSchema,
  readInputSchema,
  readSourceInputSchema,
  recallInputSchema,
  runJobInputSchema,
  searchInputSchema,
  updateInputSchema,
} from "./contracts.js";
import { assertScopes, operationContextFromAuth, type AuthContext, type GraphMindScope } from "./auth.js";
import type { GraphStore } from "./graphCore.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";

export function createGraphMindMcpServer(store: GraphStore, authContext?: AuthContext): McpServer {
  const operationContext = authContext ? operationContextFromAuth(authContext) : undefined;
  const server = new McpServer({
    name: "graphmind",
    version: "0.1.0",
  });

  registerGraphMindResources(server, store, authContext);
  registerGraphMindPrompts(server);

  server.registerTool(
    "graph.search",
    {
      title: "Search GraphMind",
      description: "Search semantic nodes and long-form source text units.",
      inputSchema: searchInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.search(input))),
  );

  server.registerTool(
    "graph.read",
    {
      title: "Read GraphMind Node",
      description: "Read a semantic node with evidence and annotations.",
      inputSchema: readInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.read(input))),
  );

  server.registerTool(
    "graph.neighborhood",
    {
      title: "Graph Neighborhood",
      description: "Return a bounded graph neighborhood for mind maps or agent context.",
      inputSchema: neighborhoodInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.neighborhood(input))),
  );

  server.registerTool(
    "graph.read_source",
    {
      title: "Read Source Document",
      description: "Read a raw source document in full, including its original text.",
      inputSchema: readSourceInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.readSource(input))),
  );

  server.registerTool(
    "graph.recall",
    {
      title: "Recall Context Pack",
      description: "Build a token-budgeted context pack from hybrid search, graph expansion, and activation ranking.",
      inputSchema: recallInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.recall(input))),
  );

  server.registerTool(
    "graph.invalidate_edge",
    {
      title: "Invalidate Edge",
      description: "Mark an edge as no longer believed. History is preserved: the edge is expired, never deleted.",
      inputSchema: invalidateEdgeInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:link"],
      async () => jsonToolResult(await store.invalidateEdge(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.link",
    {
      title: "Link Graph Nodes",
      description: "Create or update a typed relationship between semantic graph nodes.",
      inputSchema: linkInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:link"],
      async () => jsonToolResult(await store.link(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.ingest",
    {
      title: "Ingest Source",
      description: "Ingest long-form source content and split it into addressable text units.",
      inputSchema: ingestInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:ingest"],
      async () => jsonToolResult(await store.ingest(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.capture",
    {
      title: "Capture Semantic Atom",
      description: "Capture a semantic graph atom with optional evidence references.",
      inputSchema: captureInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:capture"],
      async () => jsonToolResult(await store.capture(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.annotate",
    {
      title: "Annotate Evidence",
      description: "Attach meaning to a source or text unit without rewriting raw evidence.",
      inputSchema: annotateInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:update"],
      async () => jsonToolResult(await store.annotate(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.update",
    {
      title: "Update Semantic Node",
      description: "Update a node with optimistic revision checking.",
      inputSchema: updateInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:update"],
      async () => jsonToolResult(await store.update(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.project",
    {
      title: "Project GraphMind Node",
      description: "Render a node as markdown, a mind map, or an agent context pack.",
      inputSchema: projectInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.project(input))),
  );

  server.registerTool(
    "graph.timeline",
    {
      title: "Graph Event Timeline",
      description: "Return recent graph mutation events.",
    },
    async () => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.timeline())),
  );

  server.registerTool(
    "graph.events",
    {
      title: "Graph Event Feed",
      description: "Return cursor-paginated graph mutation events for interface sync.",
      inputSchema: eventFeedInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.events(input))),
  );

  server.registerTool(
    "graph.lint",
    {
      title: "Lint GraphMind",
      description: "Find graph health issues such as orphan nodes, missing evidence, duplicate titles, and dangling edges.",
    },
    async () => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.lint())),
  );

  server.registerTool(
    "graph.views",
    {
      title: "List GraphMind Views",
      description: "List saved mind-map and projection views.",
      inputSchema: listViewsInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.views(input))),
  );

  server.registerTool(
    "graph.read_view",
    {
      title: "Read GraphMind View",
      description: "Read a saved mind-map view with included nodes and edges.",
      inputSchema: readViewInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.readView(input))),
  );

  server.registerTool(
    "graph.create_view",
    {
      title: "Create GraphMind View",
      description: "Create a durable saved mind-map view from a root node, search query, or explicit node set.",
      inputSchema: createViewInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:update"],
      async () => jsonToolResult(await store.createView(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.delete_view",
    {
      title: "Delete GraphMind View",
      description: "Delete a saved mind-map view by id or slug.",
      inputSchema: deleteViewInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:update"],
      async () => jsonToolResult(await store.deleteView(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.jobs",
    {
      title: "List GraphMind Jobs",
      description: "List durable maintenance jobs for projections, lint, and embedding refresh.",
      inputSchema: listJobsInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.jobs(input))),
  );

  server.registerTool(
    "graph.enqueue_job",
    {
      title: "Enqueue GraphMind Job",
      description: "Enqueue a durable maintenance job. Admin scope required.",
      inputSchema: enqueueJobInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:admin"],
      async () => jsonToolResult(await store.enqueueJob(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.run_job",
    {
      title: "Run GraphMind Job",
      description: "Claim and run one pending durable maintenance job inline. Admin scope required.",
      inputSchema: runJobInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:admin"],
      async () => jsonToolResult(await store.runJob(input, operationContext)),
    ),
  );

  server.registerTool(
    "graph.export_obsidian",
    {
      title: "Export Obsidian Projection",
      description: "Render semantic nodes as deterministic Obsidian-compatible markdown files.",
    },
    async () => withScopes(authContext, ["graph:export"], async () =>
      jsonToolResult(buildObsidianVaultExport(
        await store.exportMarkdown(),
        await store.timeline(),
        await store.exportGraph(),
      ))),
  );

  server.registerTool(
    "scribe.query",
    {
      title: "Scribe Query",
      description: "Scribe-compatible query over the hosted GraphMind knowledge graph.",
      inputSchema: searchInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.search(input))),
  );

  server.registerTool(
    "scribe.capture",
    {
      title: "Scribe Capture",
      description: "Scribe-compatible capture of a durable semantic note.",
      inputSchema: captureInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:capture"],
      async () => jsonToolResult(await store.capture(input, operationContext)),
    ),
  );

  server.registerTool(
    "scribe.ingest",
    {
      title: "Scribe Ingest",
      description: "Scribe-compatible source ingestion into the evidence graph.",
      inputSchema: ingestInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:ingest"],
      async () => jsonToolResult(await store.ingest(input, operationContext)),
    ),
  );

  server.registerTool(
    "scribe.update",
    {
      title: "Scribe Update",
      description: "Scribe-compatible update with revision checking.",
      inputSchema: updateInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:update"],
      async () => jsonToolResult(await store.update(input, operationContext)),
    ),
  );

  server.registerTool(
    "scribe.lint",
    {
      title: "Scribe Lint",
      description: "Scribe-compatible wiki health check backed by GraphMind lint.",
    },
    async () => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.lint())),
  );

  server.registerTool(
    "scribe.export_obsidian",
    {
      title: "Scribe Export Obsidian",
      description: "Scribe-compatible Obsidian projection export with markdown files, canvas, log, and manifest.",
    },
    async () => withScopes(authContext, ["graph:export"], async () =>
      jsonToolResult(buildObsidianVaultExport(
        await store.exportMarkdown(),
        await store.timeline(),
        await store.exportGraph(),
      ))),
  );

  return server;
}

function registerGraphMindResources(
  server: McpServer,
  store: GraphStore,
  authContext: AuthContext | undefined,
): void {
  server.registerResource(
    "graphmind-health",
    "graphmind://health",
    {
      title: "GraphMind Health",
      description: "Read GraphMind store health and service status.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { service: "graphmind", health: await store.health() })),
  );

  server.registerResource(
    "graphmind-lint",
    "graphmind://lint",
    {
      title: "GraphMind Lint Report",
      description: "Read the current graph health report.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.lint())),
  );

  server.registerResource(
    "graphmind-timeline",
    "graphmind://timeline",
    {
      title: "GraphMind Timeline",
      description: "Read recent graph mutation events.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { events: await store.timeline() })),
  );

  server.registerResource(
    "graphmind-events",
    "graphmind://events",
    {
      title: "GraphMind Event Feed",
      description: "Read the first page of cursor-paginated graph mutation events.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.events({ limit: 25 }) )),
  );

  server.registerResource(
    "graphmind-jobs",
    "graphmind://jobs",
    {
      title: "GraphMind Jobs",
      description: "Read recent durable maintenance jobs.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { jobs: await store.jobs({ limit: 25 }) })),
  );

  server.registerResource(
    "graphmind-views",
    "graphmind://views",
    {
      title: "GraphMind Views",
      description: "Read saved mind-map and projection views.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { views: await store.views({ limit: 50 }) })),
  );

  server.registerResource(
    "graphmind-graph",
    "graphmind://graph",
    {
      title: "GraphMind Graph Snapshot",
      description: "Read the canonical node and edge snapshot used for projections.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.exportGraph())),
  );

  server.registerResource(
    "graphmind-obsidian-manifest",
    "graphmind://projection/obsidian/manifest",
    {
      title: "GraphMind Obsidian Projection Manifest",
      description: "Read the deterministic manifest for the current Obsidian projection.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () => {
      const vaultExport = buildObsidianVaultExport(
        await store.exportMarkdown(),
        await store.timeline(),
        await store.exportGraph(),
      );
      return jsonResource(uri, vaultExport.manifest);
    }),
  );
}

function registerGraphMindPrompts(server: McpServer): void {
  server.registerPrompt(
    "scribe-query",
    {
      title: "Scribe Query",
      description: "Query GraphMind like the old Scribe wiki, with citations and next actions.",
      argsSchema: {
        question: z.string().describe("Question or topic to query in GraphMind."),
      },
    },
    async ({ question }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Query GraphMind for: ${question}`,
              "",
              "Use scribe.query or graph.search first. Then read the most relevant node.",
              "Return a concise answer with cited node slugs or source evidence when available.",
              "If the answer reveals durable knowledge, suggest scribe.capture rather than editing markdown directly.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "scribe-capture",
    {
      title: "Scribe Capture",
      description: "Capture durable knowledge into GraphMind with evidence-first discipline.",
      argsSchema: {
        topic: z.string().describe("The thing that should become durable knowledge."),
      },
    },
    async ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Prepare a GraphMind capture for: ${topic}`,
              "",
              "Prefer scribe.ingest for raw long-form material, then scribe.capture for the semantic atom.",
              "Include title, type, summary, content, links, and evidence references when available.",
              "Do not treat generated Obsidian markdown as canonical truth.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "scribe-lint",
    {
      title: "Scribe Lint",
      description: "Review GraphMind health and propose safe cleanup steps.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run scribe.lint or graph.lint.",
              "Group findings by severity and code.",
              "Suggest safe next actions, but do not mutate the graph unless explicitly asked.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

async function withScopes<T>(
  authContext: AuthContext | undefined,
  requiredScopes: GraphMindScope[],
  action: () => Promise<T>,
): Promise<T> {
  if (authContext) assertScopes(authContext, requiredScopes);
  return action();
}

function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
