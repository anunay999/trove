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
    // MCP tool descriptions must carry routing doctrine (not the short stubs).
    const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.description ?? ""]));
    assert.match(byName.recall ?? "", /Open questions|exact/i, "recall description should steer tool choice");
    assert.match(byName.grep ?? "", /Prefer this over recall|exact string/i, "grep description should prefer exact lookup");
    assert.match(byName.read ?? "", /full|name|slug/i, "read description should mention full note by name");
    assert.match(byName.remember ?? "", /similar|linked|small/i, "remember description should discourage mega-dumps");
    assert.match(byName.ingest ?? "", /remember|evidence|Pipeline/i, "ingest description should point at remember pipeline");
  });

  it("exposes resources and prompts", async () => {
    const resources = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    const prompts = await client.request({ method: "prompts/list", params: {} }, ListPromptsResultSchema);
    assert.ok(resources.resources.length > 0, "expected at least one resource");
    assert.ok(prompts.prompts.length > 0, "expected at least one prompt");
    const uris = resources.resources.map((resource) => resource.uri);
    assert.ok(uris.includes("trove://doctrine"), "doctrine resource must be listed for MCP-only clients");
    const promptNames = prompts.prompts.map((prompt) => prompt.name);
    assert.ok(promptNames.includes("trove-session"), "trove-session prompt must be listed");
  });

  it("reads the doctrine, lint, jobs, views, and events resources", async () => {
    for (const uri of ["trove://doctrine", "trove://lint", "trove://jobs", "trove://views", "trove://events"]) {
      const resource = await client.request(
        { method: "resources/read", params: { uri } },
        ReadResourceResultSchema,
      );
      assert.ok(resource.contents.length > 0, `resource ${uri} returned no contents`);
      if (uri === "trove://doctrine") {
        const text = resource.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
        assert.match(text, /grep/i);
        assert.match(text, /remember/i);
        assert.match(text, /SESSION LOOP|session/i);
      }
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
