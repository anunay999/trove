import type { GraphStore } from "./graphCore.js";
import { PgGraphStore } from "./pgStore.js";
import { InMemoryGraphStore } from "./store.js";

export function createGraphStore(): { store: GraphStore; driver: "memory" | "postgres" } {
  const explicitDriver = process.env.TROVE_STORE;
  const databaseUrl = process.env.DATABASE_URL;

  if (explicitDriver === "postgres" || (!explicitDriver && databaseUrl)) {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when TROVE_STORE=postgres.");
    }
    return {
      store: new PgGraphStore({ connectionString: databaseUrl }),
      driver: "postgres",
    };
  }

  return {
    store: new InMemoryGraphStore(),
    driver: "memory",
  };
}
