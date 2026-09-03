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
import { toolDescription, TROVE_AGENT_DOCTRINE, visibleTiers } from "./toolDefinitions.js";
import { getSkill } from "./skills.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";

export function createTroveMcpServer(store: GraphStore, authContext?: AuthContext): McpServer {
  const operationContext = authContext ? operationContextFromAuth(authContext) : undefined;
  const tiers = visibleTiers(authContext?.scopes);
  const canWrite = !authContext
    || authContext.scopes.includes("graph:admin")
    || authContext.scopes.some((scope) => scope.startsWith("graph:write"));
  // Server-level instructions reach any MCP client that surfaces them on
  // initialize (Claude, Cursor, Codex, custom hosts). Skills are optional.
  const server = new McpServer(
    { name: "trove", version: "0.2.0" },
    { instructions: TROVE_AGENT_DOCTRINE },
  );

  registerTroveResources(server, store, authContext, operationContext);
  registerTrovePrompts(server);

  // ---- core: the everyday agent vocabulary --------------------------------
  // Descriptions come from toolDefinitions (shared with GET /v1/tools).

  if (canWrite) server.registerTool(
    "remember",
    {
      title: "Remember",
      description: toolDescription("remember"),
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
      description: toolDescription("recall"),
      inputSchema: recallInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.recall(input, operationContext))),
  );

  server.registerTool(
    "grep",
    {
      title: "Grep Memories",
      description: toolDescription("grep"),
      inputSchema: grepInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.grep(input, operationContext))),
  );

  server.registerTool(
    "read",
    {
      title: "Read",
      description: toolDescription("read"),
      inputSchema: readAnyInputSchema,
    },
    async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await readAny(store, input, operationContext))),
  );

  if (canWrite) server.registerTool(
    "connect",
    {
      title: "Connect Memories",
      description: toolDescription("connect"),
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
      description: toolDescription("forget"),
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
        description: toolDescription("ingest"),
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
        description: toolDescription("annotate"),
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
        description: toolDescription("neighborhood"),
        inputSchema: neighborhoodInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.neighborhood(input, operationContext))),
    );

    server.registerTool(
      "project",
      {
        title: "Project Node",
        description: toolDescription("project"),
        inputSchema: projectInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.project(input, operationContext))),
    );

    server.registerTool(
      "views",
      {
        title: "List Views",
        description: toolDescription("views"),
        inputSchema: listViewsInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.views(input, operationContext))),
    );

    server.registerTool(
      "read_view",
      {
        title: "Read View",
        description: toolDescription("read_view"),
        inputSchema: readViewInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.readView(input, operationContext))),
    );

    server.registerTool(
      "create_view",
      {
        title: "Create View",
        description: toolDescription("create_view"),
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
        description: toolDescription("delete_view"),
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
        description: toolDescription("events"),
        inputSchema: eventFeedInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.events(input, operationContext))),
    );

    server.registerTool(
      "lint",
      {
        title: "Lint Graph",
        description: toolDescription("lint"),
      },
      async () => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.lint(operationContext))),
    );

    server.registerTool(
      "jobs",
      {
        title: "List Jobs",
        description: toolDescription("jobs"),
        inputSchema: listJobsInputSchema,
      },
      async (input) => withScopes(authContext, ["graph:read"], async () => jsonToolResult(await store.jobs(input))),
    );

    server.registerTool(
      "enqueue_job",
      {
        title: "Enqueue Job",
        description: toolDescription("enqueue_job"),
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
        description: toolDescription("run_job"),
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
        description: toolDescription("export_obsidian"),
      },
      async () => withScopes(authContext, ["graph:export"], async () =>
        jsonToolResult(buildObsidianVaultExport(
          await store.exportMarkdown(operationContext),
          await store.timeline(operationContext),
          await store.exportGraph(operationContext),
        ))),
    );
  }

  return server;
}

function registerTroveResources(
  server: McpServer,
  store: GraphStore,
  authContext: AuthContext | undefined,
  operationContext: ReturnType<typeof operationContextFromAuth> | undefined,
): void {
  // Always-available doctrine: clients that ignore server instructions can still
  // resources/read this URI (or hosts can inject it into the system prompt).
  server.registerResource(
    "trove-doctrine",
    "trove://doctrine",
    {
      title: "Trove Agent Operating Doctrine",
      description:
        "How any LLM should use Trove: read routing (grep/read/recall), continuous capture (ingest→remember→connect), supersession, session loop. Read this at session start.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: TROVE_AGENT_DOCTRINE,
        },
      ],
    }),
  );

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
      jsonResource(uri, await store.lint(operationContext))),
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
      jsonResource(uri, await store.events({ limit: 25 }, operationContext))),
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
      jsonResource(uri, { views: await store.views({ limit: 50 }, operationContext) })),
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
      jsonResource(uri, await store.exportGraph(operationContext))),
  );
}

function registerTrovePrompts(server: McpServer): void {
  server.registerPrompt(
    "trove-recall",
    {
      title: "Trove Recall",
      description: "Answer a question from Trove memory with citations (grep/read/recall routing).",
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
              "Follow Trove doctrine (also at resource trove://doctrine):",
              "1) Exact string (ticket id, error text, config key) → grep first, then read if you need the full note.",
              "2) Known note name → read for the full body.",
              "3) Open question ('how do we handle refunds?') → recall with tokenBudget around 8000.",
              "If the top hit is right but the brief is thin, follow with read on that note.",
              "Answer concisely and cite note names. If the answer is a useful synthesis, remember it back.",
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
      description: "Save durable knowledge with ingest→remember→connect discipline (not one mega-node).",
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
              "Follow Trove doctrine (resource trove://doctrine):",
              "- Long notes (meeting, doc, paste) → ingest first, then remember 3–7 short facts citing those spans, then connect each to a topic hub.",
              "- One fact or decision → remember with type + summary + links; cite evidence or say agent inference.",
              "- Prefer several small linked notes over one 'notes from today' blob.",
              "- remember matches exact title/slug; check similar and retarget with slug if it almost matched.",
              "- Outdated beliefs: connect with supersedesEdgeId or forget — never delete.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trove-session",
    {
      title: "Trove Session Loop",
      description: "Run a full boot→work→capture→close loop against Trove for a topic or task.",
      argsSchema: {
        task: z.string().describe("What you are about to work on or just finished."),
      },
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Trove session for: ${task}`,
              "",
              TROVE_AGENT_DOCTRINE,
              "",
              "Now: (1) load relevant context with the read routing above,",
              "(2) do the work,",
              "(3) capture crystallised decisions/facts/gotchas as separate atoms with links,",
              "(4) do not dump a single end-of-day mega-node.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  // The curator. The body is skills/trove-curate/SKILL.md verbatim, so the
  // slash command, the pasted prompt on the dashboard, and the installed skill
  // are one procedure. The fallback only exists for a checkout without the
  // skills directory (stdio dev runs from odd cwds).
  server.registerPrompt(
    "trove-curate",
    {
      title: "Trove Curate",
      description:
        "Clean up the memory graph from this session: merge duplicates, record supersession, link orphans, retire stale beliefs. Bounded, reversible, proposes anything destructive.",
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe("Optional: a topic, project, or lint code to concentrate on (e.g. 'duplicates', 'project trove')."),
      },
    },
    async ({ focus }) => {
      const skill = getSkill("trove-curate");
      const procedure =
        skill?.body ??
        [
          "Run lint. For duplicate_title pairs, read both and connect the newer to the older with a supersedes edge when they state the same fact.",
          "For orphan_node, read the node, recall its hub, connect with mentions or part_of when unambiguous.",
          "Propose (do not apply) merges, forget, and stale invalidations. Never rewrite content. Stop after 25 nodes and report.",
        ].join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                focus ? `Curate my Trove graph, focusing on: ${focus}` : "Curate my Trove graph.",
                "",
                procedure,
              ].join("\n"),
            },
          },
        ],
      };
    },
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
