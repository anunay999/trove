import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

/**
 * MCP 2026-07-28 (stateless) era + io.modelcontextprotocol/tasks extension,
 * driven over raw JSON-RPC fetch on purpose — no SDK client between the
 * assertions and the wire, so the exact resultType/_meta/ttlMs shapes the
 * spec demands are what gets asserted. Opt in with TROVE_E2E=1 and a running
 * server (TROVE_MCP_URL), like the other HTTP suites.
 */
const endpoint = process.env.TROVE_MCP_URL ?? "http://localhost:8788/mcp";
const serviceToken = process.env.TROVE_SERVICE_TOKEN;
const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "trove-tasks-smoke", version: "0.1.0" };
const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

let nextId = 0;

function envelope(extraClientCapabilities: Record<string, unknown> = {}) {
  return {
    [PROTOCOL_VERSION_KEY]: PROTOCOL_VERSION,
    [CLIENT_INFO_KEY]: CLIENT_INFO,
    [CLIENT_CAPABILITIES_META_KEY]: {
      tools: {},
      resources: {},
      prompts: {},
      ...extraClientCapabilities,
    },
  };
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

type WireRequest = {
  method: string;
  params?: Record<string, unknown>;
  /** Adds the tasks extension to the per-request capability envelope. */
  declareTasks?: boolean;
  /** Overrides the Mcp-Method header (to test mismatch rejection). */
  headerMethod?: string;
  /** Omits the per-request envelope entirely (2025-era shape). */
  legacy?: boolean;
};

async function rpc(request: WireRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = ++nextId;
  const params: Record<string, unknown> = { ...request.params };
  if (!request.legacy) params._meta = envelope(request.declareTasks ? { extensions: { [TASKS_EXTENSION_ID]: {} } } : {});
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
      "content-type": "application/json",
      "Mcp-Method": request.headerMethod ?? request.method,
      // SEP-2243: Mcp-Name is the tool name on tools/call, the taskId on tasks/*.
      ...(request.params && "taskId" in request.params
        ? { "Mcp-Name": String(request.params.taskId) }
        : request.params && "name" in request.params
          ? { "Mcp-Name": String(request.params.name) }
          : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: request.method, params }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  assert.equal(body.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(body.error)}`);
  return body.result as Record<string, unknown>;
}

describe("mcp 2026-07-28 era + tasks extension", { skip: process.env.TROVE_E2E === "1" ? false : "set TROVE_E2E=1 with a running server + token" }, () => {
  before(() => {
    assert.ok(serviceToken, "TROVE_SERVICE_TOKEN (with graph:export) is required for the export_obsidian flows");
  });

  it("answers server/discover with versions, capabilities, the tasks extension, and instructions", async () => {
    const result = resultOf(await rpc({ method: "server/discover" }).then((r) => r.body));
    assert.ok((result.supportedVersions as string[]).includes(PROTOCOL_VERSION), "2026-07-28 must be supported");
    const capabilities = result.capabilities as { extensions?: Record<string, unknown> };
    assert.ok(capabilities.extensions?.[TASKS_EXTENSION_ID], "tasks extension must be advertised");
    assert.match(String(result.instructions ?? ""), /Trove/, "server instructions must surface on discover");
    assert.equal(result.resultType, "complete");
  });

  it("rejects Mcp-Method/body disagreement with -32020", async () => {
    const body = (await rpc({ method: "tools/list", headerMethod: "server/discover" })).body;
    assert.equal((body.error as { code: number }).code, -32020);
  });

  it("serves tools/list with a cache hint and server identity", async () => {
    const result = resultOf(await rpc({ method: "tools/list" }).then((r) => r.body));
    assert.equal(result.resultType, "complete");
    assert.equal(result.ttlMs, 300_000, "tools/list should advertise the five-minute ttl");
    assert.equal(result.cacheScope, "private", "per-caller tool lists must never be shared-cached");
    const meta = result._meta as Record<string, { name: string }>;
    assert.equal(meta["io.modelcontextprotocol/serverInfo"]?.name, "trove");
    const tools = result.tools as Array<{ name: string }>;
    assert.ok(tools.some((tool) => tool.name === "export_obsidian"), "export_obsidian must be listed");
  });

  it("keeps export_obsidian blocking for clients that do not declare the extension", async () => {
    const result = resultOf(await rpc({ method: "tools/call", params: { name: "export_obsidian", arguments: {} } }).then((r) => r.body));
    assert.equal(result.resultType, "complete");
    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content.length > 0 && content[0]?.type === "text");
  });

  it("runs export_obsidian as a polled task for clients that declare the extension", async () => {
    const created = resultOf(
      await rpc({ method: "tools/call", params: { name: "export_obsidian", arguments: {} }, declareTasks: true }).then((r) => r.body),
    );
    assert.equal(created.resultType, "task", "task-augmented call must answer with the task discriminator");
    const taskId = created.taskId as string;
    assert.ok(typeof taskId === "string" && taskId.length > 0, "CreateTaskResult must carry a taskId");
    assert.equal(created.status, "working");
    assert.ok(typeof (created.pollIntervalMs as number) === "number" && (created.pollIntervalMs as number) >= 1);
    assert.ok(typeof (created.ttlMs as number) === "number" && (created.ttlMs as number) > 0);
    assert.match(String(created.createdAt), /^\d{4}-\d{2}-\d{2}T/, "timestamps are ISO-8601 strings");

    // Poll to a terminal state, honoring pollIntervalMs as a floor.
    let final: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 120 && !final; attempt++) {
      const task = resultOf(await rpc({ method: "tasks/get", params: { taskId }, declareTasks: true }).then((r) => r.body));
      assert.equal(task.resultType, "complete");
      assert.equal(task.taskId, taskId);
      if (task.status !== "working") {
        final = task;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(final, "task never reached a terminal state");
    assert.equal(final!.status, "completed", `task should complete, got: ${JSON.stringify(final)}`);
    const result = final!.result as { content?: Array<{ type: string; text: string }> };
    assert.ok(result.content?.length, "completed task must inline the CallToolResult");
    // Same payload the blocking path returns: a JSON vault export.
    const vaultText = result.content?.[0]?.text;
    assert.ok(vaultText, "task result content must carry text");
    const vault = JSON.parse(vaultText) as Record<string, unknown>;
    assert.ok(Object.keys(vault).length > 0, "task result must parse as the Obsidian vault export");
  });

  it("refuses tasks/get for clients that did not declare the extension (-32021)", async () => {
    const body = (await rpc({ method: "tasks/get", params: { taskId: "00000000-0000-0000-0000-000000000000" } })).body;
    const error = body.error as { code: number; data?: { requiredCapabilities?: Record<string, unknown> } };
    assert.equal(error.code, -32021);
    assert.ok(error.data?.requiredCapabilities, "-32021 must name the required capabilities");
  });

  it("answers tasks/get for an unknown task with -32602", async () => {
    const body = (await rpc({
      method: "tasks/get",
      params: { taskId: "00000000-0000-0000-0000-000000000000" },
      declareTasks: true,
    })).body;
    assert.equal((body.error as { code: number }).code, -32602);
  });

  it("acknowledges tasks/cancel and marks the task cancelled", async () => {
    const created = resultOf(
      await rpc({ method: "tools/call", params: { name: "export_obsidian", arguments: {} }, declareTasks: true }).then((r) => r.body),
    );
    const taskId = created.taskId as string;
    const ack = resultOf(await rpc({ method: "tasks/cancel", params: { taskId }, declareTasks: true }).then((r) => r.body));
    assert.equal(ack.resultType, "complete");
    const task = resultOf(await rpc({ method: "tasks/get", params: { taskId }, declareTasks: true }).then((r) => r.body));
    assert.ok(["cancelled", "completed"].includes(String(task.status)), "cancel is cooperative; the task reaches a terminal state");
  });
});
