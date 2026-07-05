try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const schemaPath = resolve("docs/schema.sql");
const sql = await readFile(schemaPath, "utf8");
const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  await client.query(sql);
  console.log(`Applied schema from ${schemaPath}`);
} finally {
  await client.end();
}
