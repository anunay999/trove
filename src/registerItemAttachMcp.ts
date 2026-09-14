import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertScopes, type AuthContext, type TroveScope } from "./auth.js";
import type { GraphOperationContext, GraphStore } from "./graphCore.js";
import { attachFromItemDesc, attachMemory } from "./itemAttachOps.js";
import {
  attachFromItemDescInputSchema,
  attachMemoryInputSchema,
} from "./itemAttachContracts.js";
import { toolDescription } from "./toolDefinitions.js";

function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function withScopes<T>(
  authContext: AuthContext | undefined,
  requiredScopes: TroveScope[],
  action: () => Promise<T>,
): Promise<T> {
  if (authContext) assertScopes(authContext, requiredScopes);
  return action();
}

/** Register Outcome OS attach_memory / attach_from_item_desc on an MCP server. */
export function registerItemAttachMcpTools(
  server: McpServer,
  store: GraphStore,
  authContext: AuthContext | undefined,
  operationContext: GraphOperationContext | undefined,
  canWrite: boolean,
  hasCurator: boolean,
): void {
  if (canWrite) {
    server.registerTool(
      "attach_memory",
      {
        title: "Attach Memory to Item",
        description: toolDescription("attach_memory"),
        inputSchema: attachMemoryInputSchema,
      },
      async (input) => withScopes(
        authContext,
        ["graph:write:capture", "graph:write:link"],
        async () => jsonToolResult(await attachMemory(store, input, operationContext)),
      ),
    );
  }

  if (hasCurator) {
    server.registerTool(
      "attach_from_item_desc",
      {
        title: "Attach From Item Description",
        description: toolDescription("attach_from_item_desc"),
        inputSchema: attachFromItemDescInputSchema,
      },
      async (input) => withScopes(
        authContext,
        ["graph:write:ingest", "graph:write:capture", "graph:write:link"],
        async () => jsonToolResult(await attachFromItemDesc(store, input, operationContext)),
      ),
    );
  }
}
