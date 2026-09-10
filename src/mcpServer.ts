import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AuthContext } from "./auth.js";
import { createGraphStore } from "./createStore.js";
import { createTroveMcpServer } from "./mcpTools.js";

const { store, driver } = createGraphStore();
const localStdioAuthContext: AuthContext = {
  actorId: process.env.TROVE_ACTOR_ID ?? "local-stdio-agent",
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
  requestId: process.env.TROVE_REQUEST_ID ?? "stdio-session",
};

async function main(): Promise<void> {
  // serveStdio owns the era decision: the opening exchange (server/discover
  // probe vs initialize handshake) pins ONE instance from the factory to the
  // connection. The same factory serves both eras; the tasks extension is
  // not advertised here because its methods are dispatched at the HTTP seam
  // only (see src/mcpTasks.ts).
  serveStdio(() => createTroveMcpServer(store, localStdioAuthContext), {
    onerror: (error) => console.error("[mcp-stdio]", error),
  });
  console.error(`Trove MCP server running on stdio (${driver})`);
}

main().catch((error: unknown) => {
  console.error("Trove MCP server error:", error);
  process.exit(1);
});
