import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  annotateInputSchema,
  createViewInputSchema,
  deleteViewInputSchema,
  enqueueJobInputSchema,
  eventFeedInputSchema,
  forgetInputSchema,
  grepInputSchema,
  ingestInputSchema,
  linkInputSchema,
  listViewsInputSchema,
  listJobsInputSchema,
  neighborhoodInputSchema,
  projectInputSchema,
  readAnyInputSchema,
  readViewInputSchema,
  recallInputSchema,
  rememberInputSchema,
  runJobInputSchema,
} from "./contracts.js";
import { assertScopes, operationContextFromAuth, type AuthContext, type TroveScope } from "./auth.js";
import { forget, readAny, remember } from "./agentOps.js";
import type { GraphStore } from "./graphCore.js";
import { visibleTiers } from "./toolDefinitions.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";

export function createTroveMcpServer(store: GraphStore, authContext?: AuthContext): McpServer {
  const operationContext = authContext ? operationContextFromAuth(authContext) : undefined;
  const tiers = visibleTiers(authContext?.scopes);
  const canWrite = !authContext
    || authContext.scopes.includes("graph:admin")
    || authContext.scopes.some((scope) => scope.startsWith("graph:write"));
  const server = new McpServer({
    name: "trove",
    version: "0.2.0",
  });

  registerTroveResources(server, store, authContext);
  registerTrovePrompts(server);

  // ---- core: the everyday agent vocabulary --------------------------------

  if (canWrite) server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Save a memory. If the title (or an explicit slug/nodeId) matches an existing node it revises it; otherwise it creates one. Returns the action taken plus similar nodes it did NOT merge into.",
      inputSchema: rememberInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:capture"],
      async () => jsonToolResult(await remember(store, input, operationContext)),
    ),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Retrieve relevant memory as a token-budgeted context pack with citations.",
      inputSchema: recallInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.recall(input))),
  );

  server.registerTool(
    "grep",
    {
      title: "Grep Memories",
      description:
        "Exact/regex text search over memories and raw sources. Use for identifiers, ports, error strings — anything where exact match beats semantic search.",
      inputSchema: grepInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.grep(input))),
  );

  server.registerTool(
    "read",
    {
      title: "Read",
      description: "Read anything by id or slug: a memory node with evidence, or a raw source document.",
      inputSchema: readAnyInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await readAny(store, input))),
  );

  if (canWrite) server.registerTool(
    "connect",
    {
      title: "Connect Memories",
      description:
        "Create a typed relationship between two memories. Pass supersedesEdgeId to replace an old belief on the record.",
      inputSchema: linkInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:link"],
      async () => jsonToolResult(await store.link(input, operationContext)),
    ),
  );

  if (canWrite) server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Retire beliefs on the record. Explicit edgeIds apply immediately; query mode previews first (dryRun defaults true). Nothing is deleted.",
      inputSchema: forgetInputSchema,
    },
    async (input) => withScopes(
      authContext,
      ["graph:write:link"],
      async () => jsonToolResult(await forget(store, input, operationContext)),
    ),
  );

  // ---- curator: ingestion and curation flows ------------------------------

  if (tiers.has("curator")) {
    server.registerTool(
      "ingest",
      {
        title: "Ingest Source",
        description: "Store a long-form source document as evidence, split into addressable text units.",
        inputSchema: ingestInputSchema,
      },
      async (input) => withScopes(
        authContext,
        ["graph:write:ingest"],
        async () => jsonToolResult(await store.ingest(input, operationContext)),
      ),
    );

    server.registerTool(
      "annotate",
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
      "neighborhood",
      {
        title: "Graph Neighborhood",
        description: "Return a bounded graph neighborhood, optionally as of a past time or including expired edges.",
        inputSchema: neighborhoodInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.neighborhood(input))),
    );

    server.registerTool(
      "project",
      {
        title: "Project Node",
        description: "Render a node as markdown, a mind map, or an agent context pack.",
        inputSchema: projectInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.project(input))),
    );

    server.registerTool(
      "views",
      {
        title: "List Views",
        description: "List saved mind-map and projection views.",
        inputSchema: listViewsInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.views(input))),
    );

    server.registerTool(
      "read_view",
      {
        title: "Read View",
        description: "Read a saved mind-map view with included nodes and edges.",
        inputSchema: readViewInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.readView(input))),
    );

    server.registerTool(
      "create_view",
      {
        title: "Create View",
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
      "delete_view",
      {
        title: "Delete View",
        description: "Delete a saved mind-map view by id or slug.",
        inputSchema: deleteViewInputSchema,
      },
      async (input) => withScopes(
        authContext,
        ["graph:write:update"],
        async () => jsonToolResult(await store.deleteView(input, operationContext)),
      ),
    );
  }

  // ---- operator: maintenance and sync plumbing -----------------------------

  if (tiers.has("operator")) {
    server.registerTool(
      "events",
      {
        title: "Event Feed",
        description: "Read cursor-paginated graph mutation events for interface sync.",
        inputSchema: eventFeedInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.events(input))),
    );

    server.registerTool(
      "lint",
      {
        title: "Lint Graph",
        description: "Find graph health issues such as orphan nodes, missing evidence, duplicate titles, and dangling edges.",
      },
      async () => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.lint())),
    );

    server.registerTool(
      "jobs",
      {
        title: "List Jobs",
        description: "List durable maintenance jobs for projections, lint, and embedding refresh.",
        inputSchema: listJobsInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.jobs(input))),
    );

    server.registerTool(
      "enqueue_job",
      {
        title: "Enqueue Job",
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
      "run_job",
      {
        title: "Run Job",
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
      "export_obsidian",
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
  }

  return server;
}

function registerTroveResources(
  server: McpServer,
  store: GraphStore,
  authContext: AuthContext | undefined,
): void {
  server.registerResource(
    "trove-health",
    "trove://health",
    {
      title: "Trove Health",
      description: "Read Trove store health and service status.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { service: "trove", health: await store.health() })),
  );

  server.registerResource(
    "trove-lint",
    "trove://lint",
    {
      title: "Trove Lint Report",
      description: "Read the current graph health report.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.lint())),
  );

  server.registerResource(
    "trove-events",
    "trove://events",
    {
      title: "Trove Event Feed",
      description: "Read the first page of cursor-paginated graph mutation events.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.events({ limit: 25 }) )),
  );

  server.registerResource(
    "trove-jobs",
    "trove://jobs",
    {
      title: "Trove Jobs",
      description: "Read recent durable maintenance jobs.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { jobs: await store.jobs({ limit: 25 }) })),
  );

  server.registerResource(
    "trove-views",
    "trove://views",
    {
      title: "Trove Views",
      description: "Read saved mind-map and projection views.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, { views: await store.views({ limit: 50 }) })),
  );

  server.registerResource(
    "trove-graph",
    "trove://graph",
    {
      title: "Trove Graph Snapshot",
      description: "Read the canonical node and edge snapshot used for projections.",
      mimeType: "application/json",
    },
    async (uri) => withScopes(authContext, ["graph:read"], async () =>
      jsonResource(uri, await store.exportGraph())),
  );
}

function registerTrovePrompts(server: McpServer): void {
  server.registerPrompt(
    "trove-recall",
    {
      title: "Trove Recall",
      description: "Answer a question from Trove memory with citations.",
      argsSchema: {
        question: z.string().describe("Question or topic to recall from Trove."),
      },
    },
    async ({ question }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Recall from Trove: ${question}`,
              "",
              "Call recall with a sensible tokenBudget first; use grep when the question contains exact identifiers.",
              "Answer concisely and cite node slugs or source evidence.",
              "If the session revealed durable new knowledge, suggest remember.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trove-remember",
    {
      title: "Trove Remember",
      description: "Save durable knowledge into Trove with evidence-first discipline.",
      argsSchema: {
        topic: z.string().describe("The thing that should become durable memory."),
      },
    },
    async ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Save to Trove: ${topic}`,
              "",
              "For long-form raw material, ingest it first, then remember the distilled facts citing that evidence.",
              "remember dedupes by exact title/slug; check the returned similar list and retarget with slug if it missed.",
              "Connect new memories to related nodes; supersede rather than duplicate when a belief changed.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

async function withScopes<T>(
  authContext: AuthContext | undefined,
  requiredScopes: TroveScope[],
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
