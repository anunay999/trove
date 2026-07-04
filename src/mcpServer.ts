import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AuthContext } from "./auth.js";
import { createGraphStore } from "./createStore.js";
import { createGraphMindMcpServer } from "./mcpTools.js";

const { store, driver } = createGraphStore();
const localStdioAuthContext: AuthContext = {
  actorId: process.env.GRAPHMIND_ACTOR_ID ?? "local-stdio-agent",
  scopes: [
    "graph:admin",
    "graph:read",
    "graph:write",
    "graph:write:capture",
    "graph:write:update",
    "graph:write:link",
    "graph:write:ingest",
    "graph:export",
  ],
  mode: "disabled",
  interfaceId: "stdio-mcp",
  requestId: process.env.GRAPHMIND_REQUEST_ID ?? "stdio-session",
};
const server = createGraphMindMcpServer(store, localStdioAuthContext);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`GraphMind MCP server running on stdio (${driver})`);
}

main().catch((error: unknown) => {
  console.error("GraphMind MCP server error:", error);
  process.exit(1);
});
