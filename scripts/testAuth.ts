import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const baseUrl = process.env.TROVE_BASE_URL ?? "http://localhost:8787";
const readToken = process.env.TROVE_READ_TOKEN ?? "read-token";
const writeToken = process.env.TROVE_WRITE_TOKEN ?? "write-token";
const adminToken = process.env.TROVE_ADMIN_TOKEN ?? "admin-token";

await expectStatus("/v1/tools", undefined, 401);
await expectStatus("/v1/tools", readToken, 200);
await expectStatus("/v1/export/obsidian", readToken, 403);
await expectStatus("/v1/jobs", readToken, 200);
await expectStatus("/v1/views", readToken, 200);
await expectStatus("/v1/events", readToken, 200);
await expectJsonStatus("/v1/jobs", readToken, 403, {
  kind: "lint_graph",
  payload: {},
  priority: 50,
  dedupeKey: `auth-read-denied-${Date.now()}`,
});
await expectJsonStatus("/v1/views", readToken, 403, {
  title: "Read token must not create views",
  query: "Trove",
});
await expectJsonStatus("/v1/jobs/run", writeToken, 403, {});

await expectMcpSearch(readToken);
await expectMcpCaptureDenied(readToken);
await expectMcpSearch(writeToken);
await expectHttpCaptureAttributed(writeToken);
await expectMcpCaptureAttributed(writeToken);
await expectAdminJobRoundTrip(adminToken);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "http_missing_token_rejected",
    "http_read_token_allowed",
    "http_read_token_export_denied",
    "http_read_token_jobs_allowed",
    "http_read_token_views_allowed",
    "http_read_token_events_allowed",
    "http_read_token_enqueue_denied",
    "http_read_token_create_view_denied",
    "http_write_token_run_job_denied",
    "mcp_read_token_search_allowed",
    "mcp_read_token_capture_denied",
    "mcp_write_token_search_allowed",
    "http_capture_attributed",
    "mcp_capture_attributed",
    "http_admin_job_round_trip",
  ],
}, null, 2));

async function expectStatus(path: string, token: string | undefined, expectedStatus: number): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}; expected ${expectedStatus}. Body: ${await response.text()}`);
  }
}

async function expectJsonStatus(
  path: string,
  token: string | undefined,
  expectedStatus: number,
  body: unknown,
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}; expected ${expectedStatus}. Body: ${await response.text()}`);
  }
  return response;
}

async function expectMcpSearch(token: string): Promise<void> {
  const client = await connectMcp(token);
  try {
    const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    if (!tools.tools.some((tool) => tool.name === "graph.search")) {
      throw new Error("graph.search was not listed.");
    }

    await client.request(
      {
        method: "tools/call",
        params: {
          name: "graph.search",
          arguments: {
            query: "Trove",
            limit: 1,
          },
        },
      },
      CallToolResultSchema,
    );
  } finally {
    await client.close();
  }
}

async function expectMcpCaptureDenied(token: string): Promise<void> {
  const client = await connectMcp(token);
  try {
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "graph.capture",
          arguments: {
            title: "Auth smoke should not be captured",
            type: "claim",
            summary: "A read-only token must not be allowed to capture nodes.",
            content: "If this exists in the graph, auth scope enforcement failed.",
          },
        },
      },
      CallToolResultSchema,
    );

    if (result.isError) return;
  } catch {
    return;
  } finally {
    await client.close();
  }

  throw new Error("Read-only token unexpectedly captured a node through MCP.");
}

async function expectHttpCaptureAttributed(token: string): Promise<void> {
  const title = `Auth attribution HTTP smoke ${Date.now()}`;
  const requestId = `auth-http-${Date.now()}`;
  const response = await fetch(`${baseUrl}/v1/capture`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-trove-interface": "auth-smoke-http",
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      title,
      type: "claim",
      summary: "HTTP writes should be attributed to their service-token actor.",
      content: "This node is created by the auth smoke test.",
    }),
  });
  if (response.status !== 201) {
    throw new Error(`HTTP capture returned ${response.status}: ${await response.text()}`);
  }

  await expectTimelineEvent(token, {
    action: "capture",
    actorHandle: "agent",
    interfaceId: "auth-smoke-http",
    requestId,
  });
}

async function expectMcpCaptureAttributed(token: string): Promise<void> {
  const requestId = `auth-mcp-${Date.now()}`;
  const client = await connectMcp(token, requestId);
  try {
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "graph.capture",
          arguments: {
            title: `Auth attribution MCP smoke ${Date.now()}`,
            type: "claim",
            summary: "MCP writes should be attributed to their service-token actor.",
            content: "This node is created by the auth smoke test.",
          },
        },
      },
      CallToolResultSchema,
    );
    if (result.isError) throw new Error(`MCP capture returned tool error: ${JSON.stringify(result)}`);
  } finally {
    await client.close();
  }

  await expectTimelineEvent(token, {
    action: "capture",
    actorHandle: "agent",
    interfaceId: "mcp",
    requestId,
  });
}

async function expectAdminJobRoundTrip(token: string): Promise<void> {
  const enqueue = await expectJsonStatus("/v1/jobs", token, 201, {
    kind: "lint_graph",
    payload: { authSmoke: true },
    priority: 98,
    dedupeKey: `auth-admin-job-${Date.now()}`,
  });
  const created = await enqueue.json() as { job: { id: string } };
  const run = await expectJsonStatus("/v1/jobs/run", token, 200, { jobId: created.job.id });
  const completed = await run.json() as { job: { id: string; status: string; kind: string } | null };
  if (!completed.job || completed.job.status !== "succeeded" || completed.job.kind !== "lint_graph") {
    throw new Error(`Admin job round trip failed: ${JSON.stringify(completed)}`);
  }
}

async function expectTimelineEvent(
  token: string,
  expected: { action: string; actorHandle: string; interfaceId: string; requestId: string },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/timeline`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    throw new Error(`Timeline returned ${response.status}: ${await response.text()}`);
  }

  const timeline = await response.json() as {
    events: Array<{
      action: string;
      actorHandle: string | null;
      interfaceId: string | null;
      requestId: string | null;
    }>;
  };
  const match = timeline.events.find((event) =>
    event.action === expected.action &&
    event.actorHandle === expected.actorHandle &&
    event.interfaceId === expected.interfaceId &&
    event.requestId === expected.requestId
  );
  if (!match) {
    throw new Error(`No attributed timeline event found for ${JSON.stringify(expected)}.`);
  }
}

async function connectMcp(token: string, requestId?: string): Promise<Client> {
  const client = new Client({
    name: "trove-auth-smoke-client",
    version: "0.1.0",
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    },
  });

  await client.connect(transport as never);
  return client;
}
