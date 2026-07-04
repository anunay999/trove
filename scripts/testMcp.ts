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

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

const client = new Client({
  name: "graphmind-smoke-client",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcpServer.ts"],
  cwd: process.cwd(),
  env,
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
});

await client.connect(transport);

try {
  const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
  const resources = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
  const prompts = await client.request({ method: "prompts/list", params: {} }, ListPromptsResultSchema);
  const lintResource = await client.request(
    { method: "resources/read", params: { uri: "graphmind://lint" } },
    ReadResourceResultSchema,
  );
  const jobsResource = await client.request(
    { method: "resources/read", params: { uri: "graphmind://jobs" } },
    ReadResourceResultSchema,
  );
  const viewsResource = await client.request(
    { method: "resources/read", params: { uri: "graphmind://views" } },
    ReadResourceResultSchema,
  );
  const eventsResource = await client.request(
    { method: "resources/read", params: { uri: "graphmind://events" } },
    ReadResourceResultSchema,
  );
  const queryPrompt = await client.request(
    { method: "prompts/get", params: { name: "scribe-query", arguments: { question: "GraphMind" } } },
    GetPromptResultSchema,
  );
  const search = await client.request(
    {
      method: "tools/call",
      params: {
        name: "graph.search",
        arguments: {
          query: "GraphMind",
          includeTextUnits: true,
          limit: 2,
        },
      },
    },
      CallToolResultSchema,
  );
  const jobs = await client.request(
    {
      method: "tools/call",
      params: {
        name: "graph.jobs",
        arguments: { limit: 5 },
      },
    },
    CallToolResultSchema,
  );
  const views = await client.request(
    {
      method: "tools/call",
      params: {
        name: "graph.views",
        arguments: { limit: 5 },
      },
    },
    CallToolResultSchema,
  );
  const events = await client.request(
    {
      method: "tools/call",
      params: {
        name: "graph.events",
        arguments: { limit: 5 },
      },
    },
    CallToolResultSchema,
  );

  const searchText = search.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");

  console.log(JSON.stringify({
    toolCount: tools.tools.length,
    toolNames: tools.tools.map((tool) => tool.name),
    resourceCount: resources.resources.length,
    resourceUris: resources.resources.map((resource) => resource.uri),
    promptCount: prompts.prompts.length,
    promptNames: prompts.prompts.map((prompt) => prompt.name),
    lintContentCount: lintResource.contents.length,
    lintTextLength: lintResource.contents
      .filter((content): content is typeof content & { text: string } => "text" in content)
      .reduce((total, content) => total + content.text.length, 0),
    jobsResourceContentCount: jobsResource.contents.length,
    viewsResourceContentCount: viewsResource.contents.length,
    eventsResourceContentCount: eventsResource.contents.length,
    queryPromptMessageCount: queryPrompt.messages.length,
    searchContentCount: search.content.length,
    searchTextLength: searchText.length,
    jobsContentCount: jobs.content.length,
    viewsContentCount: views.content.length,
    eventsContentCount: events.content.length,
  }, null, 2));
} finally {
  await transport.close();
}
