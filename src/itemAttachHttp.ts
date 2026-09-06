import type { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import type { z } from "zod";
import {
  attachFromItemDescInputSchema,
  attachMemoryInputSchema,
} from "./itemAttachContracts.js";
import { attachFromItemDesc, attachMemory } from "./itemAttachOps.js";
import { operationContextFromAuth, type AuthContext, type TroveScope } from "./auth.js";
import type { GraphStore } from "./graphCore.js";
import { EdgeValidityConflictError } from "./graphCore.js";

/** Looser than a named Authorize alias so server.ts function refs typecheck. */
type Authorize = (
  headers: Headers,
  scopes: TroveScope[],
) => Promise<unknown>;

type ParseJson = <Schema extends z.ZodType>(
  raw: Promise<unknown>,
  schema: Schema,
) => Promise<z.infer<Schema>>;

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
    const result = await withEdgeValidityConflict(context, () =>
      attachMemory(store, input, operationContextFromAuth(auth as AuthContext)),
    );
    if (result instanceof Response) return result;
    return context.json(result, 201);
  });

  app.post("/v1/attach-from-item-desc", async (context) => {
    const auth = await authorizeRequest(context.req.raw.headers, ["graph:write:ingest", "graph:write:capture", "graph:write:link"]);
    if (auth instanceof Response) return auth;
    const input = await parseJsonOrThrow(context.req.json(), attachFromItemDescInputSchema);
    const result = await withEdgeValidityConflict(context, () =>
      attachFromItemDesc(store, input, operationContextFromAuth(auth as AuthContext)),
    );
    if (result instanceof Response) return result;
    return context.json(result, 201);
  });
}
