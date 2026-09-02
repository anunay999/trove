try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const migrationsDir = resolve("db/migrations");
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  // Ledger of what has already run. Without it every boot replayed all twelve
  // migrations, and each one still takes its DDL locks even when it is a no-op:
  // `create index if not exists ... using hnsw` must lock `embedding`, so while
  // a refresh_embeddings drain was writing to that table the statement queued
  // behind it. Measured in production: 90s on 2026-09-02T03:32 (the container
  // started serving 13s after the healthcheck window closed, so the deploy was
  // rolled back) and 52s on the retry that happened to win the race. Container
  // boot must not depend on winning a lock race against the job queue.
  await client.query(`
    create table if not exists schema_migration (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);

  const applied = new Set(
    (await client.query("select filename from schema_migration")).rows.map((row) => String(row.filename)),
  );

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    // Every migration is written to be re-runnable (if not exists / if exists),
    // which is what makes adopting the ledger safe on a database that already
    // has all of them: the first boot after this change replays them once more,
    // records them, and every boot after that touches nothing.
    await client.query(sql);
    await client.query(
      "insert into schema_migration (filename) values ($1) on conflict (filename) do nothing",
      [file],
    );
    console.log(`Applied migration ${file}`);
    ran += 1;
  }
  console.log(`Migrations up to date (${ran} applied, ${files.length - ran} already recorded).`);
} finally {
  await client.end();
}
