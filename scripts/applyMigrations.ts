import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const migrationsDir = resolve("docs/migrations");
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  for (const file of files) {
    const path = resolve(migrationsDir, file);
    const sql = await readFile(path, "utf8");
    await client.query(sql);
    console.log(`Applied migration ${file}`);
  }
} finally {
  await client.end();
}
