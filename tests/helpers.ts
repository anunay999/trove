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

/**
 * Give the calling suite its own freshly-migrated database.
 *
 * `node:test` runs files in PARALLEL against one DATABASE_URL, and the job queue
 * is global: maintenance jobs share dedupe keys (`maintenance:<kind>`), and
 * `runJob({})` claims whichever job is next rather than yours. Any suite that
 * asserts on queue state is therefore racing every other suite that writes —
 * observed failure modes include "expected pending maintenance jobs before the
 * worker starts" (a sibling's pending job absorbed this suite's enqueue) and
 * "runs an enqueued job to success" (runJob claimed a sibling's job instead).
 *
 * Isolating per file removes the shared queue entirely, and makes the suite
 * idempotent across repeated runs into the bargain.
 *
 * Call at module top level, BEFORE suiteStore(), and only under hasPostgres().
 */
export async function isolateDatabase(suiteName: string): Promise<void> {
  if (!hasPostgres()) return;
  const baseUrl = process.env.DATABASE_URL as string;
  // TROVE_TEST_DB_PREFIX lets several checkouts (worktrees, parallel CI jobs)
  // share one Postgres without dropping each other's suite databases.
  const prefix = (process.env.TROVE_TEST_DB_PREFIX ?? "").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
  const dbName = `trove_${prefix}${suiteName.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_test`;

  const { default: pg } = await import("pg");
  const { readdir, readFile } = await import("node:fs/promises");

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    // `with (force)` terminates stragglers from an interrupted previous run.
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const migrationsDir = new URL("../db/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations) {
      await client.query(await readFile(new URL(file, migrationsDir), "utf8"));
    }
  } finally {
    await client.end();
  }

  process.env.DATABASE_URL = url.toString();
}
