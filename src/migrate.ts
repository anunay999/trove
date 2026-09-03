/**
 * Ledgered migration runner.
 *
 * Every container start runs the migrations before the server (see the
 * Dockerfile CMD). Until this module existed the runner replayed every file in
 * db/migrations on every boot with no record of what had already run. Most
 * files are guarded (`if not exists`), but some are not free to replay: 006
 * re-runs its owner backfill, 010 an anti-join delete over embeddings, 012 a
 * full update scan of node_revision. Each boot paid for all of it.
 *
 * The ledger is `schema_migrations(filename, checksum, applied_at)`. A file is
 * applied once, then skipped for as long as its sha256 matches the recorded
 * one. A recorded file whose contents changed fails the run and names the file:
 * applied migrations are immutable; the fix is a new file, never an edit.
 *
 * FIRST RUN ON AN EXISTING DATABASE. Production predates the ledger, so the
 * first boot with this runner finds no `schema_migrations` table and applies
 * every file once more — they are all idempotent, and this is exactly what the
 * previous runner did on every boot — then records each. Every boot after that
 * skips them all. Nothing needs seeding by hand.
 *
 * Concurrency: the whole run holds a session-level advisory lock, so two
 * containers booting side by side (Railway keeps the old instance up while the
 * new one starts) serialise; the second sees the first's ledger rows and skips.
 *
 * Transactions: each file runs in its own transaction and its ledger row
 * commits with it, so a failing file leaves nothing behind and is retried on
 * the next boot. A file whose first line is exactly `-- trove:no-transaction`
 * runs outside a transaction instead (needed for `create index concurrently`,
 * which Postgres refuses inside a transaction block); such a file must hold a
 * single statement, which the runner verifies before running it. Because the
 * ledger row for such a file is written after the statement, a crash between
 * the two re-runs it on the next boot — so it, too, must be idempotent
 * (`if not exists`).
 *
 * Fresh databases still bootstrap as db/schema.sql followed by this runner;
 * schema.sql is a historical snapshot, and every migration re-checks its own
 * preconditions, so replaying them over it is safe.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** First-line marker for a migration that must run outside a transaction. */
export const NO_TRANSACTION_MARKER = "-- trove:no-transaction";

/**
 * Advisory-lock key for the migration run. Arbitrary but fixed: any process
 * migrating this database must take the same key. (0x74726f7665 is "trove".)
 */
const MIGRATION_LOCK_KEY = 0x74726f7665;

export type MigrationSummary = {
  /** Filenames applied by this run, in order. */
  applied: string[];
  /** Filenames already recorded with a matching checksum, in order. */
  skipped: string[];
};

export type MigrateOptions = {
  /** Progress sink; silent when omitted. */
  log?: (message: string) => void;
};

/** The slice of pg.Client / pg.PoolClient the runner needs: one dedicated connection. */
export type MigrationClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export async function applyMigrations(
  client: MigrationClient,
  migrationsDir: string,
  options: MigrateOptions = {},
): Promise<MigrationSummary> {
  const log = options.log ?? (() => {});
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const summary: MigrationSummary = { applied: [], skipped: [] };

  // Session-level, not transaction-level: the run spans many transactions.
  // Taken before the ledger exists so concurrent first boots cannot race on
  // creating it either.
  await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    const recorded = new Map<string, string>();
    for (const row of (await client.query("select filename, checksum from schema_migrations")).rows) {
      recorded.set(String(row.filename), String(row.checksum));
    }

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = recorded.get(file);

      if (previous === checksum) {
        summary.skipped.push(file);
        continue;
      }
      if (previous !== undefined) {
        throw new Error(
          `Migration ${file} has changed since it was applied (recorded checksum ${previous}, ` +
            `file is now ${checksum}). Applied migrations are immutable; add a new migration ` +
            `instead of editing this one, or restore the original contents.`,
        );
      }

      if (isNoTransaction(sql)) {
        const count = countStatements(sql);
        if (count !== 1) {
          throw new Error(
            `Migration ${file} is marked ${NO_TRANSACTION_MARKER} but holds ${count} statements; ` +
              `a no-transaction migration must be a single statement. Split it into one file per statement.`,
          );
        }
        await run(client, file, sql, false);
        await record(client, file, checksum);
      } else {
        await client.query("begin");
        try {
          await run(client, file, sql, true);
          await record(client, file, checksum);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
      summary.applied.push(file);
      log(`Applied migration ${file}`);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
  }

  if (summary.applied.length === 0) {
    log(`Migrations up to date (${summary.skipped.length} recorded)`);
  }
  return summary;
}

async function run(client: MigrationClient, file: string, sql: string, inTransaction: boolean): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const rolledBack = inTransaction ? "; rolled back, nothing recorded" : "";
    throw new Error(`Migration ${file} failed: ${detail}${rolledBack}`, { cause: error });
  }
}

async function record(client: MigrationClient, file: string, checksum: string): Promise<void> {
  await client.query("insert into schema_migrations (filename, checksum) values ($1, $2)", [file, checksum]);
}

function isNoTransaction(sql: string): boolean {
  const firstLine = sql.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim() === NO_TRANSACTION_MARKER;
}

/**
 * Count top-level SQL statements: semicolons outside comments, quoted strings
 * and dollar-quoted bodies. Good enough to enforce "exactly one statement" on
 * no-transaction files; it is not a SQL parser.
 */
export function countStatements(sql: string): number {
  let count = 0;
  let sawText = false;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Doubled quotes escape themselves; skip to the closing quote.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      sawText = true;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        sawText = true;
        continue;
      }
    }
    if (ch === ";") {
      if (sawText) count++;
      sawText = false;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) sawText = true;
    i++;
  }

  // A trailing statement without its semicolon still counts.
  if (sawText) count++;
  return count;
}
