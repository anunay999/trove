import { createGraphStore } from "../src/createStore.js";
import type { GraphStore } from "../src/graphCore.js";

export type WriteContext = {
  actorId: string;
  interfaceId: string;
  requestId: string;
};

/**
 * A store bound to a suite, with a deterministic write context and a shared
 * timestamp for building unique-but-stable fixture titles.
 *
 * By default this is the in-memory store; set DATABASE_URL (or TROVE_STORE=postgres)
 * to run the same suites against Postgres.
 */
export function suiteStore(name: string): {
  store: GraphStore;
  driver: "memory" | "postgres";
  context: WriteContext;
  stamp: number;
} {
  const { store, driver } = createGraphStore();
  const stamp = Date.now();
  return {
    store,
    driver,
    stamp,
    context: {
      actorId: `${name}-test`,
      interfaceId: `${name}-test`,
      requestId: `${name}-test-${stamp}`,
    },
  };
}

export async function closeStore(store: GraphStore): Promise<void> {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** True when a Postgres-backed store is configured. */
export function hasPostgres(): boolean {
  return Boolean(process.env.DATABASE_URL) && process.env.TROVE_STORE !== "memory";
}
