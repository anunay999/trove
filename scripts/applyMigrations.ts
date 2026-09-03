try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import { resolve } from "node:path";
import pg from "pg";
import { applyMigrations } from "../src/migrate.js";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

// Relative to the working directory on purpose: the container runs the
// compiled copy (dist/scripts/applyMigrations.js) from /app with db/ copied
// beside dist/, so a module-relative path would point into dist/.
const migrationsDir = resolve("db/migrations");
const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  await applyMigrations(client, migrationsDir, { log: console.log });
} finally {
  await client.end();
}
