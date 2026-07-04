import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

const endpoint = process.env.GRAPHMIND_MCP_URL ?? "http://localhost:8787/mcp";
const serviceToken = process.env.GRAPHMIND_SERVICE_TOKEN;

const client = new Client({
  name: "graphmind-http-smoke-client",
  version: "0.1.0",
});

const transport = new StreamableHTTPClientTransport(
  new URL(endpoint),
  serviceToken ? { requestInit: { headers: { authorization: `Bearer ${serviceToken}` } } } : undefined,
);

await client.connect(transport as never);

try {
  const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
  const resources = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
  const prompts = await client.request({ method: "prompts/list", params: {} }, ListPromptsResultSchema);
  const timeline = await client.request(
    { method: "resources/read", params: { uri: "graphmind://timeline" } },
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
    endpoint,
    toolCount: tools.tools.length,
    toolNames: tools.tools.map((tool) => tool.name),
    resourceCount: resources.resources.length,
    resourceUris: resources.resources.map((resource) => resource.uri),
    promptCount: prompts.prompts.length,
    promptNames: prompts.prompts.map((prompt) => prompt.name),
    timelineContentCount: timeline.contents.length,
    timelineTextLength: timeline.contents
      .filter((content): content is typeof content & { text: string } => "text" in content)
      .reduce((total, content) => total + content.text.length, 0),
    jobsResourceContentCount: jobsResource.contents.length,
    viewsResourceContentCount: viewsResource.contents.length,
    eventsResourceContentCount: eventsResource.contents.length,
    searchContentCount: search.content.length,
    searchTextLength: searchText.length,
    jobsContentCount: jobs.content.length,
    viewsContentCount: views.content.length,
    eventsContentCount: events.content.length,
  }, null, 2));
} finally {
  await transport.close();
}
