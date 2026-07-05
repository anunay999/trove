import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const baseUrl = process.env.TROVE_BASE_URL ?? "http://localhost:8787";
const readToken = process.env.TROVE_READ_TOKEN ?? "read-token";
const writeToken = process.env.TROVE_WRITE_TOKEN ?? "write-token";
const adminToken = process.env.TROVE_ADMIN_TOKEN ?? "admin-token";

async function expectStatus(path: string, token: string | undefined, expectedStatus: number): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}; expected ${expectedStatus}`);
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
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}; expected ${expectedStatus}`);
  return response;
}

async function connectMcp(token: string, requestId?: string): Promise<Client> {
  const client = new Client({ name: "trove-auth-smoke-client", version: "0.1.0" });
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

async function expectTimelineEvent(
  token: string,
  expected: { action: string; actorHandle: string; interfaceId: string; requestId: string },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/timeline`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, `timeline returned ${response.status}`);
  const timeline = await response.json() as {
    events: Array<{ action: string; actorHandle: string | null; interfaceId: string | null; requestId: string | null }>;
  };
  const match = timeline.events.find((event) =>
    event.action === expected.action &&
    event.actorHandle === expected.actorHandle &&
    event.interfaceId === expected.interfaceId &&
    event.requestId === expected.requestId
  );
  assert.ok(match, `no attributed timeline event found for ${JSON.stringify(expected)}`);
}

// These checks exercise token scopes against a running server; opt in with TROVE_E2E=1.
describe("auth & scopes", { skip: process.env.TROVE_E2E === "1" ? false : "set TROVE_E2E=1 with a running server + tokens" }, () => {
  it("enforces HTTP scopes per token", async () => {
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
  });

  it("lists tier-appropriate tools and enforces MCP scopes", async () => {
    for (const token of [readToken, writeToken]) {
      const client = await connectMcp(token);
      try {
        const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
        assert.ok(tools.tools.some((tool) => tool.name === "grep"), "grep was not listed");
        const names = new Set(tools.tools.map((tool) => tool.name));
        const isWrite = token !== readToken;
        assert.equal(names.has("ingest"), isWrite, `curator tools visibility wrong for ${isWrite ? "write" : "read"} token`);
        assert.ok(!names.has("jobs"), "operator tools must be hidden from non-admin tokens");
        await client.request(
          { method: "tools/call", params: { name: "grep", arguments: { pattern: "Trove", limit: 1 } } },
          CallToolResultSchema,
        );
      } finally {
        await client.close();
      }
    }
  });

  it("denies capture through MCP for a read-only token", async () => {
    const client = await connectMcp(readToken);
    let denied = false;
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "remember",
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
      denied = Boolean(result.isError);
    } catch {
      denied = true;
    } finally {
      await client.close();
    }
    assert.ok(denied, "read-only token unexpectedly captured a node through MCP");
  });

  it("attributes HTTP writes to their service-token actor", async () => {
    const requestId = `auth-http-${Date.now()}`;
    const response = await fetch(`${baseUrl}/v1/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/json",
        "x-trove-interface": "auth-smoke-http",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        title: `Auth attribution HTTP smoke ${Date.now()}`,
        type: "claim",
        summary: "HTTP writes should be attributed to their service-token actor.",
        content: "This node is created by the auth smoke test.",
      }),
    });
    assert.equal(response.status, 201, `HTTP capture returned ${response.status}`);
    await expectTimelineEvent(writeToken, {
      action: "capture",
      actorHandle: "agent",
      interfaceId: "auth-smoke-http",
      requestId,
    });
  });

  it("attributes MCP writes to their service-token actor", async () => {
    const requestId = `auth-mcp-${Date.now()}`;
    const client = await connectMcp(writeToken, requestId);
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "remember",
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
      assert.ok(!result.isError, `MCP capture returned a tool error: ${JSON.stringify(result)}`);
    } finally {
      await client.close();
    }
    await expectTimelineEvent(writeToken, {
      action: "capture",
      actorHandle: "agent",
      interfaceId: "mcp",
      requestId,
    });
  });

  it("round-trips an admin-enqueued job", async () => {
    const enqueue = await expectJsonStatus("/v1/jobs", adminToken, 201, {
      kind: "lint_graph",
      payload: { authSmoke: true },
      priority: 98,
      dedupeKey: `auth-admin-job-${Date.now()}`,
    });
    const created = await enqueue.json() as { job: { id: string } };
    const run = await expectJsonStatus("/v1/jobs/run", adminToken, 200, { jobId: created.job.id });
    const completed = await run.json() as { job: { id: string; status: string; kind: string } | null };
    assert.ok(
      completed.job && completed.job.status === "succeeded" && completed.job.kind === "lint_graph",
      `admin job round trip failed: ${JSON.stringify(completed)}`,
    );
  });
});
