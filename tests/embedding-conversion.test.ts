import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import type { GraphOperationContext } from "../src/graphCore.js";
import { PgGraphStore } from "../src/pgStore.js";
import { applyMigrations } from "../src/migrate.js";
import { hasPostgres } from "./helpers.js";

/**
 * The halfvec + tenant conversion, on both sides of it.
 *
 * db/schema.sql declares the CONVERTED end state, but production predates it
 * and will hold vector(1536) with an all-NULL tenant_id until the maintenance
 * script has run. A deploy must not depend on that having happened, so the
 * store reads the real shape from the catalog and builds its probes to match.
 * These tests are therefore parameterised over both shapes: the same
 * assertions, once on a converted database and once on one reverted to what
 * production looks like today.
 *
 * The script itself is exercised end to end — spawned exactly as an operator
 * would run it — for its two operational promises: safe to re-run, and
 * resumable after an interruption.
 */

process.env.TROVE_EMBEDDING_PROVIDER = "fake";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.DATABASE_URL;
const prefix = (process.env.TROVE_TEST_DB_PREFIX ?? "").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const QUERY = "quorum ledger reconciliation cadence";

/** pgvector 0.7 introduced halfvec; without it there is nothing to convert to. */
async function supportsHalfvec(): Promise<boolean> {
  if (!baseUrl) return false;
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_type where typname = 'halfvec'");
    return (found.rowCount ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

const halfvec = await supportsHalfvec();
const skip = !hasPostgres()
  ? "requires a Postgres DATABASE_URL"
  : (halfvec ? false : "requires pgvector 0.7+ (halfvec)");

type Shape = "converted" | "legacy";

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Build a database in one of the two shapes.
 *
 * "converted" is db/schema.sql as written. "legacy" then reverts the embedding
 * table to what production holds today: a vector(1536) column, an HNSW index on
 * vector_cosine_ops, and no tenant column at all — migration 021 is undone as
 * well, so the store sees exactly the pre-deploy catalog.
 */
async function buildDatabase(name: string, shape: Shape): Promise<string> {
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
  const connectionString = url.toString();
  await withClient(connectionString, async (client) => {
    await client.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    await applyMigrations(client, fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    if (shape === "legacy") {
      await client.query("drop index if exists embedding_hnsw_idx");
      await client.query("drop index if exists embedding_tenant_idx");
      await client.query("alter table embedding alter column embedding type vector(1536) using embedding::vector(1536)");
      await client.query("alter table embedding drop column tenant_id");
      await client.query("create index embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops)");
    }
  });
  return connectionString;
}

async function insertOwner(url: string, email: string): Promise<string> {
  return withClient(url, async (client) => {
    const result = await client.query(
      "insert into app_user (clerk_user_id, email, status) values ($1, $2, 'active') returning id",
      [`test-${email}`, email],
    );
    return String(result.rows[0].id);
  });
}

/** Ingest for two tenants and drain the embedding backfill. */
async function seed(store: PgGraphStore, ctx: GraphOperationContext, tag: string): Promise<string[]> {
  const ingested = await store.ingest({
    kind: "agent_note",
    title: `${tag} source`,
    contentText: [
      `# ${tag} ledger`,
      `${QUERY} paragraph one, long enough to be worth embedding on its own.`,
      `${QUERY} paragraph two, also long enough to be worth embedding.`,
    ].join("\n"),
    metadata: {},
  }, ctx);
  const job = await store.enqueueJob({
    kind: "refresh_embeddings",
    payload: { reason: "conversion_test", limit: 1000 },
    priority: 40,
    dedupeKey: `conversion:${tag}`,
  }, ctx);
  const done = await store.runJob({ jobId: job.id }, ctx);
  assert.equal(done?.status, "succeeded", `refresh_embeddings for ${tag} did not succeed`);
  return ingested.textUnits.map((unit) => unit.id);
}

describe("embedding storage conversion", { skip }, () => {
  const urls = new Map<Shape, string>();
  const cleanup: Array<() => Promise<void>> = [];

  after(async () => {
    for (const close of cleanup) await close();
  });

  for (const shape of ["converted", "legacy"] as const) {
    describe(`semantic search on a ${shape} embedding table`, () => {
      let store: PgGraphStore;
      let ctxA: GraphOperationContext;
      let ctxB: GraphOperationContext;
      let unitsA: string[] = [];
      let unitsB: string[] = [];

      before(async () => {
        const url = await buildDatabase(`embedconv_${shape}`, shape);
        urls.set(shape, url);
        store = new PgGraphStore({ connectionString: url });
        cleanup.push(() => store.close());
        const ownerA = await insertOwner(url, `${shape}-a@example.com`);
        const ownerB = await insertOwner(url, `${shape}-b@example.com`);
        ctxA = { actorId: "conversion-test", interfaceId: "conversion-test", ownerId: ownerA };
        ctxB = { actorId: "conversion-test", interfaceId: "conversion-test", ownerId: ownerB };
        unitsA = await seed(store, ctxA, `${shape}-a`);
        unitsB = await seed(store, ctxB, `${shape}-b`);
      });

      it("serves a tenant its own text units and nothing else", async () => {
        const result = await store.search({
          query: QUERY,
          includeTextUnits: true,
          mode: "semantic",
          limit: 10,
          maxSemanticDistance: 1.0,
        }, ctxB);
        const ids = result.textUnits.map((unit) => unit.id);
        assert.ok(ids.length > 0, `${shape}: the tenant's own units did not come back`);
        assert.ok(ids.every((id) => unitsB.includes(id)), `${shape}: a foreign tenant's units leaked`);
        assert.ok(ids.every((id) => !unitsA.includes(id)), `${shape}: tenant A's units leaked into B`);
      });

      it("builds the probe for the shape it actually found, and still iterates the HNSW scan", async () => {
        const pool = (store as unknown as { pool: pg.Pool }).pool;
        const connect = pool.connect.bind(pool);
        const statements: string[] = [];
        (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
          const client = await connect();
          const query = client.query.bind(client);
          (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
            statements.push(String(args[0]));
            return (query as (...inner: unknown[]) => unknown)(...args);
          };
          return client;
        };
        try {
          await store.search({ query: QUERY, includeTextUnits: true, mode: "semantic", limit: 5, maxSemanticDistance: 1.0 }, ctxB);
        } finally {
          (pool as unknown as { connect: typeof connect }).connect = connect;
        }

        const probes = statements.filter((statement) => statement.includes("embedding e"));
        assert.ok(probes.length > 0, "no semantic probe was issued");
        for (const probe of probes) {
          if (shape === "converted") {
            assert.match(probe, /::halfvec/, "a converted table must be probed with a halfvec query vector");
            assert.match(probe, /e\.tenant_id/, "a converted table must filter on the embedding row's own tenant");
          } else {
            assert.match(probe, /::vector/, "an unconverted table must be probed with a vector query vector");
            assert.doesNotMatch(probe, /e\.tenant_id/, "the unconverted table has no tenant column to filter on");
          }
        }
        // The setting that lets a scoped probe fill its limit does not depend
        // on the shape; losing it on either side re-opens the starvation bug.
        assert.ok(
          statements.some((statement) => /set local hnsw\.iterative_scan = relaxed_order/.test(statement)),
          "hnsw.iterative_scan was not enabled for the probes",
        );
      });
    });
  }

  describe("the conversion script", () => {
    let url = "";

    const state = async (): Promise<{ type: string; unstamped: number; hnsw: string; hasTenant: boolean }> =>
      withClient(url, async (client) => {
        const shape = await client.query(
          `select
             (select format_type(a.atttypid, null) from pg_attribute a
               where a.attrelid = 'embedding'::regclass and a.attname = 'embedding') as type,
             (select true from pg_attribute a
               where a.attrelid = 'embedding'::regclass and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant,
             (select coalesce(indexdef, '') from pg_indexes
               where tablename = 'embedding' and indexname = 'embedding_hnsw_idx') as hnsw`,
        );
        const hasTenant = shape.rows[0].has_tenant === true;
        const unstamped = hasTenant
          ? Number((await client.query("select count(*)::int as c from embedding where tenant_id is null")).rows[0].c)
          : -1;
        return {
          type: String(shape.rows[0].type ?? ""),
          hasTenant,
          unstamped,
          hnsw: String(shape.rows[0].hnsw ?? ""),
        };
      });

    const run = async (...args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync(
        "npx",
        ["tsx", "scripts/convertEmbeddingStorage.ts", ...args],
        { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url }, timeout: 300_000 },
      );
      return stdout;
    };

    before(async () => {
      // Start from production's shape, with real rows to convert. The tenant
      // column is then re-added the way migration 021 adds it at boot.
      url = await buildDatabase("embedconv_script", "legacy");
      const store = new PgGraphStore({ connectionString: url });
      cleanup.push(() => store.close());
      const owner = await insertOwner(url, "script@example.com");
      await seed(store, { actorId: "conversion-test", interfaceId: "conversion-test", ownerId: owner }, "script");
      await withClient(url, (client) => client.query("alter table embedding add column tenant_id uuid"));
    });

    it("reports what it would do without touching anything", async () => {
      const rows = await withClient(url, async (client) =>
        Number((await client.query("select count(*)::int as c from embedding")).rows[0].c));
      assert.ok(rows > 0, "fixture: expected vectors to convert");

      const output = await run();
      assert.match(output, /DRY RUN/);
      const unchanged = await state();
      assert.match(unchanged.type, /^vector/, "a dry run rewrote the column");
      assert.equal(unchanged.unstamped, rows, "a dry run stamped rows");
    });

    it("converts the column, stamps every row, and rebuilds the index on halfvec", async () => {
      await run("--apply", "--batch=2");
      const converted = await state();
      assert.match(converted.type, /^halfvec/, `expected halfvec, got ${converted.type}`);
      assert.equal(converted.unstamped, 0, "rows were left unstamped");
      assert.match(converted.hnsw, /halfvec_cosine_ops/, "the HNSW index was not rebuilt for halfvec");
      assert.match(converted.hnsw, /hnsw/, "the HNSW index is missing");
      // Unowned rows carry the sentinel, never NULL — that is what lets the
      // store tell a finished backfill from an unfinished one.
      const nulls = await withClient(url, async (client) =>
        Number((await client.query("select count(*)::int as c from embedding where tenant_id is null")).rows[0].c));
      assert.equal(nulls, 0);
    });

    it("is safe to run again", async () => {
      const output = await run("--apply");
      assert.match(output, /already converted/);
      const again = await state();
      assert.match(again.type, /^halfvec/);
      assert.equal(again.unstamped, 0);
    });

    it("resumes a backfill that was interrupted part-way", async () => {
      // Exactly what an interrupted run leaves behind: some rows stamped, some
      // not, on a table that is otherwise already converted.
      const cleared = await withClient(url, async (client) =>
        (await client.query(
          "update embedding set tenant_id = null where id in (select id from embedding limit 2)",
        )).rowCount ?? 0);
      assert.ok(cleared > 0, "fixture: expected to un-stamp some rows");
      assert.equal((await state()).unstamped, cleared);

      await run("--apply", "--batch=1");
      assert.equal((await state()).unstamped, 0, "the resumed run left rows unstamped");
    });

    it("leaves a store built after it serving the converted shape", async () => {
      const store = new PgGraphStore({ connectionString: url });
      cleanup.push(() => store.close());
      const owner = await withClient(url, async (client) =>
        String((await client.query("select id from app_user limit 1")).rows[0].id));
      const ctx: GraphOperationContext = { actorId: "conversion-test", interfaceId: "conversion-test", ownerId: owner };
      const result = await store.search({
        query: QUERY,
        includeTextUnits: true,
        mode: "semantic",
        limit: 10,
        maxSemanticDistance: 1.0,
      }, ctx);
      assert.ok(result.textUnits.length > 0, "semantic search stopped returning units after the conversion");
    });
  });
});
