try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import v8 from "node:v8";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { getSkill, llmsTxt, skillsIndexMarkdown } from "./skills.js";
import { z } from "zod";
import {
  annotateInputSchema,
  captureInputSchema,
  createViewInputSchema,
  deleteViewInputSchema,
  enqueueJobInputSchema,
  eventFeedInputSchema,
  forgetInputSchema,
  grepInputSchema,
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
  rememberInputSchema,
  runJobInputSchema,
  searchInputSchema,
  updateInputSchema,
} from "./contracts.js";
import { forget, remember } from "./agentOps.js";
import {
  AuthError,
  applyImpersonation,
  authErrorBody,
  listServiceTokenSummaries,
  operationContextFromAuth,
  requireAuthFromHeaders,
  type AuthContext,
  type AuthResolvers,
  type TroveScope,
} from "./auth.js";
import { createApiKeyResolver, createClerkResolver, createOAuthResolver, createServiceOwnerResolver } from "./clerkAuth.js";
import {
  buildProtectedResourceMetadata,
  requestOrigin,
  resourceMetadataUrl,
} from "./oauthMetadata.js";
import { createGraphStore } from "./createStore.js";
import { EdgeValidityConflictError, isSmokeEvent } from "./graphCore.js";
import { startJobWorker } from "./jobWorker.js";
import { createTroveMcpServer } from "./mcpTools.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";
import { troveTools, visibleTiers } from "./toolDefinitions.js";
import { UserStore, type ApiKeySummary } from "./users.js";

const app = new Hono();
const { store, driver } = createGraphStore();

// User accounts and per-user API keys need Postgres; without it (in-memory
// dev store) the Clerk/key resolvers stay off and env tokens rule alone.
const userStore = process.env.DATABASE_URL
  ? new UserStore({ connectionString: process.env.DATABASE_URL })
  : null;
const authResolvers: AuthResolvers = {};
if (userStore) {
  authResolvers.resolveApiKey = createApiKeyResolver(userStore);
  const clerkResolver = createClerkResolver(userStore);
  if (clerkResolver) authResolvers.resolveClerkToken = clerkResolver;
  const oauthResolver = createOAuthResolver(userStore);
  if (oauthResolver) authResolvers.resolveOAuthToken = oauthResolver;
  authResolvers.resolveServiceOwnerId = createServiceOwnerResolver(userStore);
}

app.use("/mcp", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Authorization",
    "Content-Type",
    "X-Trove-Interface",
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
    service: "trove",
    store: driver,
    auth: process.env.TROVE_SERVICE_TOKENS?.trim() ? "token" : "disabled",
  });
});

// OAuth 2.0 Protected Resource Metadata (RFC 9728). Browser MCP connectors
// (claude.ai) read this to discover the Clerk authorization server. Served at
// both the bare path and the /mcp-suffixed path, and left public + CORS-open.
const serveProtectedResourceMetadata = (context: HonoContext) => {
  const origin = requestOrigin(context.req.url, context.req.raw.headers);
  const metadata = buildProtectedResourceMetadata(origin);
  context.header("Access-Control-Allow-Origin", "*");
  if (!metadata) {
    return context.json({ error: "oauth_not_configured", message: "No Clerk publishable key configured." }, 404);
  }
  return context.json(metadata);
};
app.get("/.well-known/oauth-protected-resource", serveProtectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", serveProtectedResourceMetadata);

app.get("/ready", async (context) => {
  try {
    await store.health();
    return context.json({ ok: true, service: "trove", store: driver });
  } catch (error) {
    return context.json({
      ok: false,
      service: "trove",
      store: driver,
      error: error instanceof Error ? error.message : "Unknown readiness error",
    }, 503);
  }
});

app.all("/mcp", async (context) => {
  try {
    const authContext = await requireAuthFromHeaders(context.req.raw.headers, ["graph:read"], "mcp", authResolvers);
    const transport = new WebStandardStreamableHTTPServerTransport();
    const mcpServer = createTroveMcpServer(store, authContext);
    await mcpServer.connect(transport);
    return transport.handleRequest(context.req.raw);
  } catch (error) {
    if (error instanceof AuthError) {
      // Point browser MCP clients at the resource metadata so they can start
      // the OAuth flow (RFC 9728 §5.1). Only meaningful on a 401.
      if (error.status === 401) {
        const origin = requestOrigin(context.req.url, context.req.raw.headers);
        context.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`);
      }
      return context.json(authErrorBody(error), error.status);
    }
    throw error;
  }
});

// Every REST body is parsed with a zod schema; without this a bad body fell
// through to Hono's default handler as a bare 500 and the caller never saw
// which field was wrong. Auth errors keep their own status codes above.
app.onError((error, context) => {
  if (error instanceof z.ZodError) {
    return context.json({
      error: "invalid_input",
      message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
      issues: error.issues,
    }, 400);
  }
  console.error(error);
  return context.text("Internal Server Error", 500);
});

app.get("/v1/tools", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const tiers = visibleTiers(auth.scopes);
  return context.json({
    tools: troveTools
      .filter((tool) => tiers.has(tool.tier))
      .map((tool) => ({
        name: tool.name,
        tier: tool.tier,
        description: tool.description,
      })),
  });
});

app.get("/v1/graph", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json(await store.exportGraph(operationContextFromAuth(auth)));
});

app.get("/v1/stats", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;

  const owner = operationContextFromAuth(auth);
  const [snapshot, jobList, lintReport, latest, sourceRows] = await Promise.all([
    store.exportGraph(owner),
    store.jobs({ limit: 100 }, owner),
    store.lint(owner),
    store.timeline(owner),
    store.sources({ limit: 5000 }, owner),
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

  // Whole-log rollups come from an aggregate, not from paging the feed. The
  // paged version stopped after 10,000 events and reported zero for every day
  // it never reached, so the cadence chart went blank for the most recent week
  // while writes were still landing.
  const eventStats = await store.eventStats(owner);

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
  // memory writes. Read newest-first so recency never depends on how far any
  // forward walk got (the log outgrew that window once already).
  const JOB_ACTIONS = new Set(["enqueue_job", "run_job", "fail_job"]);
  const recentEvents: typeof latest = [];
  let recentCursor: string | undefined;
  for (let page = 0; page < 5 && recentEvents.length < 12; page += 1) {
    const recentPage = await store.events({
      ...(recentCursor ? { afterCursor: recentCursor } : {}),
      limit: 100,
      order: "desc",
    }, owner);
    recentEvents.push(...recentPage.events.filter((event) =>
      !isSmokeEvent(event) && !JOB_ACTIONS.has(event.action)));
    if (!recentPage.hasMore || !recentPage.nextCursor) break;
    recentCursor = recentPage.nextCursor;
  }
  recentEvents.splice(12);

  return context.json({
    totals: {
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      views: snapshot.views?.length ?? 0,
      events: eventStats.total,
      // The rollup covers the whole log now; nothing is dropped for size.
      eventsTruncated: false,
      ingests: eventStats.actions.find((row) => row.key === "ingest")?.count ?? 0,
      totalRecalls: snapshot.nodes.reduce((sum, node) => sum + node.accessCount, 0),
    },
    nodeTypes: countBy(snapshot.nodes, (node) => node.type),
    predicates: countBy(snapshot.edges, (edge) => edge.predicate),
    actions: eventStats.actions,
    eventsPerDay: eventStats.perDay,
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
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), searchInputSchema);
  return context.json(await store.search(input, operationContextFromAuth(auth)));
});

app.post("/v1/read", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readInputSchema);
  const node = await store.read(input, operationContextFromAuth(auth));
  if (!node) return context.json({ error: "Node not found" }, 404);
  return context.json({ node });
});

app.post("/v1/neighborhood", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), neighborhoodInputSchema);
  return context.json(await store.neighborhood(input, operationContextFromAuth(auth)));
});

app.post("/v1/document", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readDocumentInputSchema);
  const document = await store.readDocument(input, operationContextFromAuth(auth));
  if (!document) return context.json({ error: "Document not found" }, 404);
  return context.json({ document });
});

app.post("/v1/source", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readSourceInputSchema);
  const source = await store.readSource(input, operationContextFromAuth(auth));
  if (!source) return context.json({ error: "Source not found" }, 404);
  return context.json({ source });
});

app.post("/v1/recall", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), recallInputSchema);
  return context.json(await store.recall(input, operationContextFromAuth(auth)));
});

app.post("/v1/invalidate-edge", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:link"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), invalidateEdgeInputSchema);
  const edge = await withEdgeValidityConflict(context, () => store.invalidateEdge(input, operationContextFromAuth(auth)));
  if (edge instanceof Response) return edge;
  if (!edge) return context.json({ error: "Edge not found" }, 404);
  return context.json({ edge });
});

app.post("/v1/link", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:link"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), linkInputSchema);
  const edge = await withEdgeValidityConflict(context, () => store.link(input, operationContextFromAuth(auth)));
  if (edge instanceof Response) return edge;
  if (!edge) return context.json({ error: "Unable to resolve link endpoints" }, 404);
  return context.json({ edge }, 201);
});

// A write that would give one link two versions at the same world-time
// instant, or end a version before it began, is the caller's conflict (409),
// not a server failure. The body names the edge that owns the interval.
async function withEdgeValidityConflict<T>(
  context: HonoContext,
  run: () => T | Promise<T>,
): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EdgeValidityConflictError) {
      return context.json({ error: error.message, conflictingEdgeId: error.conflictingEdgeId }, 409);
    }
    throw error;
  }
}

app.post("/v1/ingest", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:ingest"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), ingestInputSchema);
  return context.json(await store.ingest(input, operationContextFromAuth(auth)), 201);
});

app.post("/v1/capture", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:capture"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), captureInputSchema);
  return context.json({ node: await store.capture(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/remember", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:capture"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), rememberInputSchema);
  return context.json(await remember(store, input, operationContextFromAuth(auth)), 201);
});

app.post("/v1/grep", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), grepInputSchema);
  return context.json(await store.grep(input, operationContextFromAuth(auth)));
});

app.post("/v1/forget", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:link"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), forgetInputSchema);
  return context.json(await forget(store, input, operationContextFromAuth(auth)));
});

app.post("/v1/annotate", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), annotateInputSchema);
  return context.json({ annotation: await store.annotate(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/update", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), updateInputSchema);
  const result = await store.update(input, operationContextFromAuth(auth));
  if (!result) return context.json({ error: "Node not found" }, 404);
  if ("conflict" in result) return context.json(result, 409);
  return context.json({ node: result });
});

app.post("/v1/project", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), projectInputSchema);
  const result = await store.project(input, operationContextFromAuth(auth));
  if (!result) return context.json({ error: "Node not found" }, 404);
  return context.json(result);
});

app.get("/v1/timeline", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json({ events: await store.timeline(operationContextFromAuth(auth)) });
});

app.get("/v1/events", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = eventFeedInputSchema.parse({
    afterCursor: context.req.query("afterCursor") || undefined,
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json(await store.events(input, operationContextFromAuth(auth)));
});

app.get("/v1/lint", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  return context.json(await store.lint(operationContextFromAuth(auth)));
});

// Operator surface, like the MCP `jobs` tool: results carry lint findings and
// reconcile candidates, and the list is owner-scoped besides.
app.get("/v1/jobs", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  const input = listJobsInputSchema.parse({
    status: context.req.query("status"),
    kind: context.req.query("kind"),
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json({ jobs: await store.jobs(input, operationContextFromAuth(auth)) });
});

app.get("/v1/views", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = listViewsInputSchema.parse({
    query: context.req.query("query") || undefined,
    limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
  });
  return context.json({ views: await store.views(input, operationContextFromAuth(auth)) });
});

app.post("/v1/views/read", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:read"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), readViewInputSchema);
  const view = await store.readView(input, operationContextFromAuth(auth));
  if (!view) return context.json({ error: "View not found" }, 404);
  return context.json({ view });
});

app.post("/v1/views", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
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
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:update"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), deleteViewInputSchema);
  const result = await store.deleteView(input, operationContextFromAuth(auth));
  if (!result.deleted) return context.json({ error: "View not found" }, 404);
  return context.json(result);
});

app.post("/v1/jobs", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), enqueueJobInputSchema);
  return context.json({ job: await store.enqueueJob(input, operationContextFromAuth(auth)) }, 201);
});

app.post("/v1/jobs/run", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  const input = await parseJsonOrThrow(context.req.json(), runJobInputSchema);
  const job = await store.runJob(input, operationContextFromAuth(auth));
  if (!job) return context.json({ job: null, message: "No pending job available." });
  return context.json({ job });
});

// Memory forensics. Production RSS climbed ~0.42 GB/day from Aug 25 with flat
// CPU and no FD growth, and the leak could not be pinned from outside the
// process: the cgroup only says "anonymous memory", which is true of a JS
// object leak, a Buffer leak and heap fragmentation alike. These three numbers
// separate those cases — heapUsed climbing means JS objects are retained,
// external/arrayBuffers climbing means Buffers (pg rows, fetch bodies) are, and
// neither climbing while rss does means native allocator fragmentation.
// Admin-only: heap space names and sizes are an internal detail.
app.get("/v1/debug/memory", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:admin"]);
  if (auth instanceof Response) return auth;
  return context.json({
    uptimeSeconds: Math.round(process.uptime()),
    memoryUsage: process.memoryUsage(),
    heapStatistics: v8.getHeapStatistics(),
    heapSpaceStatistics: v8.getHeapSpaceStatistics(),
    resourceUsage: process.resourceUsage(),
  });
});

app.get("/v1/export/obsidian", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, ["graph:export"]);
  if (auth instanceof Response) return auth;
  const owner = operationContextFromAuth(auth);
  return context.json(buildObsidianVaultExport(
    await store.exportMarkdown(owner),
    await store.timeline(owner),
    await store.exportGraph(owner),
  ));
});

// ---- Identity, per-user API keys, admin ----------------------------------

const createKeyInputSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(["graph:read", "graph:write", "graph:export"])).min(1),
});

const approveUserInputSchema = z.object({
  clerkUserId: z.string().min(1),
});

const setUserStatusInputSchema = z.object({
  clerkUserId: z.string().min(1),
  status: z.enum(["active", "waitlisted", "suspended"]),
});

// Who am I? Passes with zero scopes so waitlisted users can see their status.
app.get("/v1/me", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  return context.json({
    actorId: auth.actorId,
    mode: auth.mode,
    scopes: auth.scopes,
    identity: auth.identity ?? null,
    // Set while an admin is viewing Trove as someone else; the dashboard shows
    // this account's graph and keys, and offers the way back.
    impersonating: auth.impersonating ?? null,
  });
});

/**
 * Always the real caller, never an impersonated account: API keys are bearer
 * credentials that outlive the "view as" session, so viewing as a member must
 * not read, mint or revoke their keys.
 */
function requireIdentity(auth: AuthContext): Response | NonNullable<AuthContext["identity"]> {
  const identity = auth.identity;
  if (!identity || !userStore) {
    return new Response(
      JSON.stringify({ error: "clerk_required", message: "Sign in with Clerk to manage API keys." }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  return identity;
}

app.get("/v1/keys", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireIdentity(auth);
  if (identity instanceof Response) return identity;
  // Admins also see the env-configured service tokens (masked) so agent
  // credentials aren't invisible infrastructure.
  const serviceTokens = identity.role === "admin" ? listServiceTokenSummaries() : [];
  return context.json({ keys: await userStore!.listApiKeys(identity.userId), serviceTokens });
});

app.post("/v1/keys", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireIdentity(auth);
  if (identity instanceof Response) return identity;
  if (identity.status !== "active") {
    return context.json({ error: "waitlisted", message: "Your account is on the waitlist." }, 403);
  }
  const input = await parseJsonOrThrow(context.req.json(), createKeyInputSchema);
  const key: ApiKeySummary = await userStore!.createApiKey(identity.userId, input);
  return context.json({ key, secret: key.secret }, 201);
});

app.delete("/v1/keys/:id", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireIdentity(auth);
  if (identity instanceof Response) return identity;
  const revoked = await userStore!.revokeApiKey(identity.userId, context.req.param("id"));
  return context.json({ revoked });
});

function requireAdmin(auth: AuthContext): Response | NonNullable<AuthContext["identity"]> {
  const identity = requireIdentity(auth);
  if (identity instanceof Response) return identity;
  if (identity.role !== "admin" || identity.status !== "active") {
    return new Response(
      JSON.stringify({ error: "admin_required", message: "Superuser access required." }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  return identity;
}

app.get("/v1/admin/users", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireAdmin(auth);
  if (identity instanceof Response) return identity;
  return context.json({ users: await userStore!.listUsers() });
});

app.post("/v1/admin/users/approve", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireAdmin(auth);
  if (identity instanceof Response) return identity;
  const input = await parseJsonOrThrow(context.req.json(), approveUserInputSchema);
  const approved = await userStore!.approveUser(input.clerkUserId, identity.userId);
  if (!approved) return context.json({ error: "not_found", message: "No such user." }, 404);
  return context.json({ user: approved });
});

// Grant / revoke access: move a user between waitlisted / active / suspended.
app.post("/v1/admin/users/status", async (context) => {
  const auth = await authorizeRequest(context.req.raw.headers, []);
  if (auth instanceof Response) return auth;
  const identity = requireAdmin(auth);
  if (identity instanceof Response) return identity;
  const input = await parseJsonOrThrow(context.req.json(), setUserStatusInputSchema);
  if (input.clerkUserId === identity.clerkUserId) {
    return context.json({ error: "cannot_change_self", message: "You can't change your own access." }, 400);
  }
  const updated = await userStore!.setUserStatus(input.clerkUserId, input.status, identity.userId);
  if (!updated) return context.json({ error: "not_found", message: "No such user." }, 404);
  return context.json({ user: updated });
});

async function authorizeRequest(headers: Headers, scopes: TroveScope[]): Promise<AuthContext | Response> {
  try {
    const auth = await requireAuthFromHeaders(headers, scopes, "http", authResolvers);
    // With no user directory (no DATABASE_URL) nothing resolves, so the header
    // is refused rather than ignored — a silently dropped impersonation would
    // write into the caller's own graph while the caller believed otherwise.
    return await applyImpersonation(auth, headers, async (clerkUserId) => {
      const user = await userStore?.userByClerkId(clerkUserId);
      return user
        ? { userId: user.id, clerkUserId: user.clerkUserId, email: user.email, role: user.role, status: user.status }
        : null;
    });
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

// The companion skills, readable by URL so a user can hand an agent
// "read https://mytrove.in/skills/trove-curate.md and follow it" instead of
// pasting. Same files as the npx install and the MCP prompts (src/skills.ts).
// Public on purpose: they contain procedure, never data.
const MARKDOWN = "text/markdown; charset=utf-8";
const SKILLS_CACHE = "public, max-age=300";
function publicBaseUrl(context: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const url = new URL(context.req.url);
  const proto = context.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = context.req.header("x-forwarded-host") ?? context.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}
app.get("/skills.md", (context) =>
  context.body(skillsIndexMarkdown(publicBaseUrl(context)), 200, { "content-type": MARKDOWN, "cache-control": SKILLS_CACHE }),
);
app.get("/llms.txt", (context) =>
  context.body(llmsTxt(publicBaseUrl(context)), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": SKILLS_CACHE }),
);
app.get("/skills/:name", (context) => {
  const skill = getSkill(context.req.param("name").replace(/\.md$/, ""));
  if (!skill) return context.text("Unknown skill.", 404);
  return context.body(skill.raw, 200, { "content-type": MARKDOWN, "cache-control": SKILLS_CACHE });
});

// Serve the built dashboard (web/dist) for any non-API path. Run `npm run build`
// inside web/ first; without a build these routes simply 404.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("/", serveStatic({ path: "./web/dist/index.html" }));

const port = Number(process.env.PORT ?? "8787");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Trove listening on http://localhost:${info.port} (${driver})`);
});

// Background maintenance: drain graph_job (embeddings, lint, projections) so
// ingests become semantically searchable without a manual jobs:run. Claiming
// uses `for update skip locked`, so extra instances stay safe. Opt out with
// TROVE_AUTORUN_JOBS=0.
if ((process.env.TROVE_AUTORUN_JOBS ?? "1") !== "0") {
  const intervalMs = Number(process.env.TROVE_JOB_INTERVAL_MS ?? 30_000);
  const worker = startJobWorker(store, {
    intervalMs,
    log: (message) => console.log(`[job-worker] ${message}`),
  });
  console.log(`Job worker running (every ${Math.round(intervalMs / 1000)}s; TROVE_AUTORUN_JOBS=0 disables).`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void worker.stop().finally(() => process.exit(0));
    });
  }
}
