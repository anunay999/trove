import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { applyMigrations, NO_TRANSACTION_MARKER } from "../src/migrate.js";

/**
 * Migration-runner tests.
 *
 * These build their own throwaway databases (the same technique as
 * isolateDatabase) and, for the runner's behaviour, their own throwaway
 * migrations directory — so the assertions do not depend on what the repo's
 * migrations happen to contain, and sibling agents adding files to
 * db/migrations cannot break them. The last test is the exception on purpose:
 * it runs the real db/migrations against a fresh database twice and checks
 * the second pass records nothing, which is the invariant production boots
 * rely on.
 */

const baseUrl = process.env.DATABASE_URL;
const shouldRun = Boolean(baseUrl) && process.env.TROVE_STORE !== "memory";
const prefix = (process.env.TROVE_TEST_DB_PREFIX ?? "").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();

const REPO_MIGRATIONS = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const REPO_SCHEMA = fileURLToPath(new URL("../db/schema.sql", import.meta.url));

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Drop-and-create a database, returning a connected client bound to it. */
async function freshDatabase(name: string): Promise<pg.Client> {
  const dbName = `trove_${prefix}${name}_test`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl as string);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

async function ledger(client: pg.Client): Promise<Array<{ filename: string; checksum: string }>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    "select filename, checksum from schema_migrations order by filename",
  );
  return result.rows;
}

async function relationExists(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query<{ oid: string | null }>("select to_regclass($1) as oid", [name]);
  return result.rows[0]?.oid != null;
}

describe("migration runner", { skip: shouldRun ? false : "requires a Postgres DATABASE_URL" }, () => {
  let client: pg.Client;
  let dir: string;

  before(async () => {
    client = await freshDatabase("migrations_runner");
    dir = await mkdtemp(join(tmpdir(), "trove-migrations-"));
  });

  after(async () => {
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("applies every file in order and records each with its checksum", async () => {
    const first = "create table widget (id int primary key, label text);\ncreate index widget_label_idx on widget(label);\n";
    const second = "alter table widget add column if not exists weight int;\n";
    // Written out of lexical order on purpose: the runner must sort, not trust readdir.
    await writeFile(join(dir, "002_weight.sql"), second);
    await writeFile(join(dir, "001_widget.sql"), first);

    const summary = await applyMigrations(client, dir);

    assert.deepEqual(summary, { applied: ["001_widget.sql", "002_weight.sql"], skipped: [] });
    assert.equal(await relationExists(client, "widget"), true);
    assert.deepEqual(await ledger(client), [
      { filename: "001_widget.sql", checksum: sha256(first) },
      { filename: "002_weight.sql", checksum: sha256(second) },
    ]);
  });

  it("a second run applies nothing", async () => {
    const summary = await applyMigrations(client, dir);
    assert.deepEqual(summary, { applied: [], skipped: ["001_widget.sql", "002_weight.sql"] });
    assert.equal((await ledger(client)).length, 2);
  });

  it("a file that changed after it was applied fails the run and names the file", async () => {
    const original = await readFile(join(dir, "001_widget.sql"), "utf8");
    await writeFile(join(dir, "001_widget.sql"), `${original}-- edited after the fact\n`);
    try {
      await assert.rejects(
        () => applyMigrations(client, dir),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /001_widget\.sql/);
          assert.match(error.message, /checksum/i);
          return true;
        },
      );
      // The ledger still holds the checksum of what actually ran.
      assert.equal((await ledger(client))[0]?.checksum, sha256(original));
    } finally {
      await writeFile(join(dir, "001_widget.sql"), original);
    }
  });

  it("a failing file is rolled back whole and left unrecorded", async () => {
    await writeFile(join(dir, "003_broken.sql"), "create table gadget (id int);\nselect 1/0;\n");
    try {
      await assert.rejects(
        () => applyMigrations(client, dir),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /003_broken\.sql/);
          return true;
        },
      );
      // Its first statement succeeded, but the file ran in its own transaction.
      assert.equal(await relationExists(client, "gadget"), false);
      assert.ok(!(await ledger(client)).some((row) => row.filename === "003_broken.sql"));
      // And the connection is usable again afterwards (no stuck aborted transaction).
      assert.equal((await client.query("select 1 as ok")).rows[0]?.ok, 1);
    } finally {
      await rm(join(dir, "003_broken.sql"));
    }
  });

  it(`${NO_TRANSACTION_MARKER} runs a concurrent index build outside a transaction`, async () => {
    await writeFile(
      join(dir, "003_widget_weight_idx.sql"),
      `${NO_TRANSACTION_MARKER}\ncreate index concurrently if not exists widget_weight_idx on widget(weight);\n`,
    );

    const summary = await applyMigrations(client, dir);

    assert.deepEqual(summary.applied, ["003_widget_weight_idx.sql"]);
    const indexes = await client.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'widget'",
    );
    assert.ok(indexes.rows.some((row) => row.indexname === "widget_weight_idx"));
    assert.ok((await ledger(client)).some((row) => row.filename === "003_widget_weight_idx.sql"));

    // Idempotent on the next pass like everything else.
    assert.deepEqual((await applyMigrations(client, dir)).applied, []);
  });

  it("rejects a no-transaction file holding more than one statement", async () => {
    await writeFile(
      join(dir, "004_two_statements.sql"),
      [
        NO_TRANSACTION_MARKER,
        "-- a comment; with a semicolon, and a 'string; literal' below, neither of which count",
        "create index concurrently if not exists widget_label2_idx on widget(label) where label <> 'a;b';",
        "create index concurrently if not exists widget_label3_idx on widget(label);",
        "",
      ].join("\n"),
    );
    try {
      await assert.rejects(
        () => applyMigrations(client, dir),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /004_two_statements\.sql/);
          assert.match(error.message, /single statement/i);
          return true;
        },
      );
      // Validation happens before anything runs: neither index exists, nothing recorded.
      const indexes = await client.query<{ indexname: string }>(
        "select indexname from pg_indexes where tablename = 'widget'",
      );
      assert.ok(!indexes.rows.some((row) => /^widget_label[23]_idx$/.test(row.indexname)));
      assert.ok(!(await ledger(client)).some((row) => row.filename === "004_two_statements.sql"));
    } finally {
      await rm(join(dir, "004_two_statements.sql"));
    }
  });

  it("a semicolon inside a dollar-quoted body is still one statement", async () => {
    await writeFile(
      join(dir, "004_do_block.sql"),
      `${NO_TRANSACTION_MARKER}\ndo $$ begin perform 1; perform 2; end $$;\n`,
    );
    assert.deepEqual((await applyMigrations(client, dir)).applied, ["004_do_block.sql"]);
  });

  it("ignores files that are not .sql", async () => {
    await writeFile(join(dir, "README.md"), "not a migration\n");
    await writeFile(join(dir, "notes.sql.bak"), "select 1/0;\n");
    const summary = await applyMigrations(client, dir);
    assert.deepEqual(summary.applied, []);
    assert.ok(!summary.skipped.includes("README.md"));
  });
});

describe("repo migrations", { skip: shouldRun ? false : "requires a Postgres DATABASE_URL" }, () => {
  let client: pg.Client;

  before(async () => {
    client = await freshDatabase("migrations_repo");
    await client.query(await readFile(REPO_SCHEMA, "utf8"));
  });

  after(async () => {
    await client?.end();
  });

  it("apply on a fresh database, and the second pass records nothing", async () => {
    const files = (await readdir(REPO_MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(files.length >= 12, `expected the repo's migrations, saw ${files.length} files`);

    const first = await applyMigrations(client, REPO_MIGRATIONS);
    assert.deepEqual(first.applied, files);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual((await ledger(client)).map((row) => row.filename), files);

    const second = await applyMigrations(client, REPO_MIGRATIONS);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, files);
  });
});
