import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

const endpoint = process.env.TROVE_MCP_URL ?? "http://localhost:8787/mcp";
const serviceToken = process.env.TROVE_SERVICE_TOKEN;

// End-to-end HTTP transport needs a running server; opt in with TROVE_E2E=1.
describe("mcp http transport", { skip: process.env.TROVE_E2E === "1" ? false : "set TROVE_E2E=1 with a running server" }, () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  before(async () => {
    client = new Client({ name: "trove-http-smoke-client", version: "0.1.0" });
    transport = new StreamableHTTPClientTransport(
      new URL(endpoint),
      serviceToken ? { requestInit: { headers: { authorization: `Bearer ${serviceToken}` } } } : undefined,
    );
    await client.connect(transport as never);
  });

  after(async () => {
    await transport?.close();
  });

  it("lists tools, resources, and prompts over HTTP", async () => {
    const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const resources = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    const prompts = await client.request({ method: "prompts/list", params: {} }, ListPromptsResultSchema);
    assert.ok(tools.tools.some((tool) => tool.name === "grep"), "grep missing over HTTP");
    assert.ok(resources.resources.length > 0, "expected resources over HTTP");
    assert.ok(prompts.prompts.length >= 0, "prompts list should resolve");
  });

  it("reads the health, jobs, views, and events resources", async () => {
    for (const uri of ["trove://health", "trove://jobs", "trove://views", "trove://events"]) {
      const resource = await client.request(
        { method: "resources/read", params: { uri } },
        ReadResourceResultSchema,
      );
      assert.ok(resource.contents.length > 0, `resource ${uri} returned no contents`);
    }
  });

  it("calls grep, jobs, views, and events tools over HTTP", async () => {
    for (const [name, args] of [
      ["grep", { pattern: "Trove", limit: 2 }],
      ["jobs", { limit: 5 }],
      ["views", { limit: 5 }],
      ["events", { limit: 5 }],
    ] as const) {
      const result = await client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      );
      assert.ok(result.content.length > 0, `tool ${name} returned no content`);
    }
  });
});
