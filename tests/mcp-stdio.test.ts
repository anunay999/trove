import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("mcp stdio server", () => {
  let client: Client;
  let transport: StdioClientTransport;

  before(async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    client = new Client({ name: "trove-smoke-client", version: "0.1.0" });
    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcpServer.ts"],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    await client.connect(transport);
  });

  after(async () => {
    await transport?.close();
  });

  it("lists the current agent toolset without legacy names", async () => {
    const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const required of ["remember", "recall", "grep", "read", "connect", "forget", "ingest", "jobs"]) {
      assert.ok(toolNames.includes(required), `tool ${required} missing from tools/list`);
    }
    assert.ok(
      !toolNames.some((name) => name.startsWith("scribe.") || name.startsWith("graph.")),
      "old scribe.*/graph.* tool names must not be listed",
    );
  });

  it("exposes resources and prompts", async () => {
    const resources = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    const prompts = await client.request({ method: "prompts/list", params: {} }, ListPromptsResultSchema);
    assert.ok(resources.resources.length > 0, "expected at least one resource");
    assert.ok(prompts.prompts.length > 0, "expected at least one prompt");
  });

  it("reads the lint, jobs, views, and events resources", async () => {
    for (const uri of ["trove://lint", "trove://jobs", "trove://views", "trove://events"]) {
      const resource = await client.request(
        { method: "resources/read", params: { uri } },
        ReadResourceResultSchema,
      );
      assert.ok(resource.contents.length > 0, `resource ${uri} returned no contents`);
    }
  });

  it("renders the recall prompt", async () => {
    const prompt = await client.request(
      { method: "prompts/get", params: { name: "trove-recall", arguments: { question: "Trove" } } },
      GetPromptResultSchema,
    );
    assert.ok(prompt.messages.length > 0, "recall prompt returned no messages");
  });

  it("calls grep, jobs, views, and events tools", async () => {
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
