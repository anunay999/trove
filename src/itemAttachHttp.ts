import type { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import {
  attachFromItemDescInputSchema,
  attachMemoryInputSchema,
} from "./itemAttachContracts.js";
import { attachFromItemDesc, attachMemory } from "./itemAttachOps.js";
import { operationContextFromAuth, type AuthContext, type TroveScope } from "./auth.js";
import type { GraphStore } from "./graphCore.js";
import { EdgeValidityConflictError } from "./graphCore.js";

type Authorize = (headers: Headers, scopes: TroveScope[]) => Promise<AuthContext | Response>;
type ParseJson = <T>(raw: Promise<unknown>, schema: { parse: (v: unknown) => T }) => Promise<T>;

async function withEdgeValidityConflict<T>(
  context: HonoContext,
  run: () => T | Promise<T>,
): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EdgeValidityConflictError) {
      return context.json({ error: error.message, conflictingEdgeId: error.conflictingEdgeId }, 409);
    }
    throw error;
  }
}

/** Mount POST /v1/attach-memory and /v1/attach-from-item-desc on the Hono app. */
export function mountItemAttachHttpRoutes(
  app: Hono,
  store: GraphStore,
  authorizeRequest: Authorize,
  parseJsonOrThrow: ParseJson,
): void {
  app.post("/v1/attach-memory", async (context) => {
    const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:capture", "graph:write:link"]);
    if (auth instanceof Response) return auth;
    const input = await parseJsonOrThrow(context.req.json(), attachMemoryInputSchema);
    const result = await withEdgeValidityConflict(context, () => attachMemory(store, input, operationContextFromAuth(auth)));
    if (result instanceof Response) return result;
    return context.json(result, 201);
  });

  app.post("/v1/attach-from-item-desc", async (context) => {
    const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:ingest", "graph:write:capture", "graph:write:link"]);
    if (auth instanceof Response) return auth;
    const input = await parseJsonOrThrow(context.req.json(), attachFromItemDescInputSchema);
    const result = await withEdgeValidityConflict(context, () => attachFromItemDesc(store, input, operationContextFromAuth(auth)));
    if (result instanceof Response) return result;
    return context.json(result, 201);
  });
}
