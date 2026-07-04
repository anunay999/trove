try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
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
  readDocumentInputSchema,
  readSourceInputSchema,
  recallInputSchema,
  runJobInputSchema,
  searchInputSchema,
  updateInputSchema,
} from "./contracts.js";
import {
  AuthError,
  authErrorBody,
  operationContextFromAuth,
  requireAuthFromHeaders,
  type AuthContext,
  type GraphMindScope,
} from "./auth.js";
import { createGraphStore } from "./createStore.js";
import { createGraphMindMcpServer } from "./mcpTools.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import { graphMindTools } from "./toolDefinitions.js";

const app = new Hono();
const { store, driver } = createGraphStore();

app.use("/mcp", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Authorization",
    "Content-Type",
    "X-GraphMind-Interface",
    "X-Request-Id",
    "mcp-session-id",
    "Last-Event-ID",
    "mcp-protocol-version",
  ],
  exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
}));

app.get("/health", (context) => {
  return context.json({
    ok: true,
    service: "graphmind",
    store: driver,
    auth: process.env.GRAPHMIND_SERVICE_TOKENS?.trim() ? "token" : "disabled",
  });
});

app.get("/ready", async (context) => {
  try {
    await store.health();
    return context.json({ ok: true, service: "graphmind", store: driver });
  } catch (error) {
    return context.json({
      ok: false,
      service: "graphmind",
      store: driver,
      error: error instanceof Error ? error.message : "Unknown readiness error",
    }, 503);
  }
});

app.all("/mcp", async (context) => {
  try {
    const authContext = requireAuthFromHeaders(context.req.raw.headers, ["graph:read"], "mcp");
    const transport = new WebStandardStreamableHTTPServerTransport();
    const mcpServer = createGraphMindMcpServer(store, authContext);
    await mcpServer.connect(transport);
    return transport.handleRequest(context.req.raw);
  } catch (error) {
    if (error instanceof AuthError) return context.json(authErrorBody(error), error.status);
    throw error;
  }
});

app.get("/v1/tools", (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json({
    tools: graphMindTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  });
});

app.get("/v1/graph", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json(await store.exportGraph());
});

app.get("/v1/stats", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;

  const [snapshot, jobList, lintReport, latest, sourceRows] = await Promise.all([
    store.exportGraph(),
    store.jobs({ limit: 100 }),
    store.lint(),
    store.timeline(),
    store.sources({ limit: 5000 }),
  ]);

  // Domain time beats transaction time: date each document by what it says about
  // itself (frontmatter date, or a date in its path/title), not when it was imported.
  const isoDate = /\b(20\d{2}-\d{2}-\d{2})\b/;
  const domainDate = (row: (typeof sourceRows)[number]): string => {
    const entryDate = (row.metadata as { entryDate?: string }).entryDate;
    if (entryDate && isoDate.test(entryDate)) return isoDate.exec(entryDate)![1]!;
    const frontmatter = (row.metadata as { frontmatter?: Record<string, string> }).frontmatter ?? {};
    for (const candidate of [frontmatter.created, frontmatter.date, frontmatter.updated]) {
      if (candidate && isoDate.test(candidate)) return isoDate.exec(candidate)![1]!;
    }
    const relPath = (row.metadata as { relPath?: string }).relPath ?? "";
    const fromName = isoDate.exec(`${relPath} ${row.title}`);
    if (fromName) return fromName[1]!;
    return row.createdAt.slice(0, 10);
  };

  const sourcesPerDay = new Map<string, { date: string; documents: number }>();
  for (const row of sourceRows) {
    const date = domainDate(row);
    const entry = sourcesPerDay.get(date) ?? { date, documents: 0 };
    entry.documents += 1;
    sourcesPerDay.set(date, entry);
  }

  // Test suites tag their writes with "-smoke" actors; the audit log keeps
  // them forever, but the dashboard should reflect real memory activity.
  const isSmokeEvent = (event: (typeof latest)[number]): boolean =>
    (event.actorHandle ?? "").endsWith("-smoke") ||
    (event.actorId ?? "").endsWith("-smoke") ||
    (event.interfaceId ?? "").endsWith("-smoke");

  const allEvents: Awaited<ReturnType<typeof store.timeline>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 6; page += 1) {
    const feedPage = await store.events(cursor ? { afterCursor: cursor, limit: 500 } : { limit: 500 });
    allEvents.push(...feedPage.events.filter((event) => !isSmokeEvent(event)));
    if (!feedPage.hasMore || !feedPage.nextCursor) break;
    cursor = feedPage.nextCursor;
  }
  const feed = { events: allEvents, hasMore: allEvents.length >= 3000 };

  const countBy = <T>(items: T[], key: (item: T) => string): Array<{ key: string; count: number }> => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const k = key(item);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([k, count]) => ({ key: k, count }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  };

  const eventsPerDay = new Map<string, { date: string; total: number; writes: number }>();
  for (const event of feed.events) {
    const date = event.createdAt.slice(0, 10);
    const entry = eventsPerDay.get(date) ?? { date, total: 0, writes: 0 };
    entry.total += 1;
    if (["capture", "update", "link", "ingest", "annotate", "invalidate_edge"].includes(event.action)) {
      entry.writes += 1;
    }
    eventsPerDay.set(date, entry);
  }

  const topAccessed = [...snapshot.nodes]
    .filter((node) => node.accessCount > 0)
    .sort((left, right) => right.accessCount - left.accessCount || left.slug.localeCompare(right.slug))
    .slice(0, 10)
    .map((node) => ({
      id: node.id,
      slug: node.slug,
      title: node.title,
      type: node.type,
      accessCount: node.accessCount,
      lastAccessedAt: node.lastAccessedAt,
    }));

  // Job-queue churn is summarized on the health card; the activity feed shows
  // memory writes. Draw from the full walked pool: a busy worker can flood the
  // small timeline window with job events.
  const JOB_ACTIONS = new Set(["enqueue_job", "run_job", "fail_job"]);
  const recentEvents = feed.events
    .filter((event) => !JOB_ACTIONS.has(event.action))
    .slice(-12)
    .reverse();

  return context.json({
    totals: {
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      views: snapshot.views?.length ?? 0,
      events: feed.events.length,
      eventsTruncated: feed.hasMore,
      ingests: feed.events.filter((event) => event.action === "ingest").length,
      totalRecalls: snapshot.nodes.reduce((sum, node) => sum + node.accessCount, 0),
    },
    nodeTypes: countBy(snapshot.nodes, (node) => node.type),
    predicates: countBy(snapshot.edges, (edge) => edge.predicate),
    actions: countBy(feed.events, (event) => event.action),
    eventsPerDay: [...eventsPerDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
    sourcesPerDay: [...sourcesPerDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
    topAccessed,
    recentEvents,
    jobs: countBy(jobList, (job) => job.status),
    lint: {
      summary: lintReport.summary,
      findings: lintReport.findings.slice(0, 8),
    },
  });
});

app.post("/v1/search", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), searchInputSchema);
  return context.json(await store.search(input));
});

app.post("/v1/read", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readInputSchema);
  const node = await store.read(input);
  if (!node) return context.json({ error: "Node not found" }, 404);
  return context.json({ node });
});

app.post("/v1/neighborhood", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), neighborhoodInputSchema);
  return context.json(await store.neighborhood(input));
});

app.post("/v1/document", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readDocumentInputSchema);
  const document = await store.readDocument(input);
  if (!document) return context.json({ error: "Document not found" }, 404);
  return context.json({ document });
});

app.post("/v1/source", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readSourceInputSchema);
  const source = await store.readSource(input);
  if (!source) return context.json({ error: "Source not found" }, 404);
  return context.json({ source });
});

app.post("/v1/recall", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), recallInputSchema);
  return context.json(await store.recall(input));
});

app.post("/v1/invalidate-edge", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:link"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), invalidateEdgeInputSchema);
  const edge = await store.invalidateEdge(input, operationContextFromAuth(auth));
  if (!edge) return context.json({ error: "Edge not found" }, 404);
  return context.json({ edge });
});

app.post("/v1/link", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:link"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), linkInputSchema);
  const edge = await store.link(input, operationContextFromAuth(auth));
  if (!edge) return context.json({ error: "Unable to resolve link endpoints" }, 404);
  return context.json({ edge }, 201);
});

app.post("/v1/ingest", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:ingest"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), ingestInputSchema);
  return context.json(await store.ingest(input, operationContextFromAuth(auth)), 201);
});

app.post("/v1/capture", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:capture"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), captureInputSchema);
  return context.json({ node: await store.capture(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/annotate", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), annotateInputSchema);
  return context.json({ annotation: await store.annotate(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/update", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), updateInputSchema);
  const result = await store.update(input, operationContextFromAuth(auth));
  if (!result) return context.json({ error: "Node not found" }, 404);
  if ("conflict" in result) return context.json(result, 409);
  return context.json({ node: result });
});

app.post("/v1/project", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), projectInputSchema);
  const result = await store.project(input);
  if (!result) return context.json({ error: "Node not found" }, 404);
  return context.json(result);
});

app.get("/v1/timeline", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json({ events: await store.timeline() });
});

app.get("/v1/events", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = eventFeedInputSchema.parse({
    afterCursor: context.req.query("afterCursor") || undefined,
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json(await store.events(input));
});

app.get("/v1/lint", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json(await store.lint());
});

app.get("/v1/jobs", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = listJobsInputSchema.parse({
    status: context.req.query("status"),
    kind: context.req.query("kind"),
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json({ jobs: await store.jobs(input) });
});

app.get("/v1/views", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = listViewsInputSchema.parse({
    query: context.req.query("query") || undefined,
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json({ views: await store.views(input) });
});

app.post("/v1/views/read", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readViewInputSchema);
  const view = await store.readView(input);
  if (!view) return context.json({ error: "View not found" }, 404);
  return context.json({ view });
});

app.post("/v1/views", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), createViewInputSchema);
  try {
    return context.json({ view: await store.createView(input, operationContextFromAuth(auth)) }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "View root node could not be resolved.") {
      return context.json({ error: "invalid_view_root", message: error.message }, 400);
    }
    throw error;
  }
});

app.post("/v1/views/delete", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), deleteViewInputSchema);
  const result = await store.deleteView(input, operationContextFromAuth(auth));
  if (!result.deleted) return context.json({ error: "View not found" }, 404);
  return context.json(result);
});

app.post("/v1/jobs", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), enqueueJobInputSchema);
  return context.json({ job: await store.enqueueJob(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/jobs/run", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), runJobInputSchema);
  const job = await store.runJob(input, operationContextFromAuth(auth));
  if (!job) return context.json({ job: null, message: "No pending job available." });
  return context.json({ job });
});

app.get("/v1/export/obsidian", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:export"]);
  if (auth instanceof Response) return auth;
  return context.json(buildObsidianVaultExport(
    await store.exportMarkdown(),
    await store.timeline(),
    await store.exportGraph(),
  ));
});

app.post("/v1/scribe/query", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), searchInputSchema);
  return context.json(await store.search(input));
});

app.get("/v1/scribe/lint", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json(await store.lint());
});

app.get("/v1/scribe/export/obsidian", async (context) => {
  const auth = authorizeRequest(context.req.raw.headers, ["graph:export"]);
  if (auth instanceof Response) return auth;
  return context.json(buildObsidianVaultExport(
    await store.exportMarkdown(),
    await store.timeline(),
    await store.exportGraph(),
  ));
});

function authorizeRequest(headers: Headers, scopes: GraphMindScope[]): AuthContext | Response {
  try {
    return requireAuthFromHeaders(headers, scopes, "http");
  } catch (error) {
    if (error instanceof AuthError) return new Response(JSON.stringify(authErrorBody(error)), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
    throw error;
  }
}

async function parseJsonOrThrow<T extends z.ZodType>(
  jsonPromise: Promise<unknown>,
  schema: T,
): Promise<z.infer<T>> {
  const json = await jsonPromise;
  return schema.parse(json);
}

// Serve the built dashboard (web/dist) for any non-API path. Run `npm run build`
// inside web/ first; without a build these routes simply 404.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("/", serveStatic({ path: "./web/dist/index.html" }));

const port = Number(process.env.PORT ?? "8787");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`GraphMind listening on http://localhost:${info.port} (${driver})`);
});
