/**
 * Convert the embedding table to halfvec and stamp every row with its tenant.
 *
 * THIS IS A MAINTENANCE-WINDOW OPERATION, NOT A MIGRATION. Both halves rewrite
 * every row, and the HNSW rebuild that follows cannot finish inside Railway's
 * 120-second healthcheck window — a boot migration would be killed and retried
 * from the top on every restart. So it lives here, run by hand against a
 * database nothing is writing to, and db/migrations/021 does only the part that
 * is genuinely instant (adding the empty tenant_id column).
 *
 * The application does not depend on this having run: PgGraphStore reads the
 * embedding column's type and the tenant column's readiness from the catalog at
 * startup and serves either shape (see EmbeddingLayout in src/pgStore.ts). What
 * the conversion buys is size and speed, not correctness.
 *
 * ORDER MATTERS, and it is not the obvious one:
 *
 *   1. drop the HNSW index. Migration 016 measured the tenant backfill WITH the
 *      index in place: 176 s and the index doubling from 481 MB to 996 MB,
 *      because every updated row is a new tuple that has to be inserted into
 *      the graph, and the space never comes back without a REINDEX. With the
 *      index gone the same UPDATE is a fraction of that, and the index has to
 *      be rebuilt in step 4 regardless. Semantic search keeps working during
 *      the window — pgvector falls back to an exact scan, which is correct,
 *      just slower, and after migration 020's chunk grain the table is small
 *      enough for that to be survivable.
 *   2. backfill tenant_id in batches, resumable: each batch takes the rows that
 *      are still NULL, so an interrupted run simply continues.
 *   3. ALTER the column to halfvec. This rewrites the whole table, which is
 *      what reclaims the dead tuples step 2 just made AND the dead space left
 *      by the per-line vectors that migration 020's drain retired. One rewrite
 *      pays for both.
 *   4. rebuild the HNSW index on halfvec_cosine_ops, and index tenant_id.
 *
 * Safe to re-run: every step checks the catalog first and skips what is already
 * done, so a run against a converted database reports "already converted" and
 * changes nothing.
 *
 * MEMORY. An HNSW build wants maintenance_work_mem to hold the graph or it
 * spills. Parallel workers also need shared memory: the Trove container has
 * only 62 MB of /dev/shm, so a build THERE needs
 * `max_parallel_maintenance_workers = 0`, which this script sets by default.
 * Production is Supabase, not the container, and has room for parallel workers;
 * pass --parallel=N to use them. Measured locally on 5,000 real-shaped
 * 1536-dimension vectors with maintenance_work_mem=256MB and no parallel
 * workers: 17.5 s for vector, 7.6 s for halfvec, so production's ~18k vectors
 * (post-020) should rebuild in wall-clock seconds, not minutes.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/convertEmbeddingStorage.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/convertEmbeddingStorage.ts --apply
 *   ... --apply --batch=5000 --parallel=2 --maintenance-work-mem=512MB
 */

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env is optional; real environment variables always win.
}

import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

/** Unowned rows stamp this rather than NULL; NULL means "not backfilled yet". */
const UNOWNED_TENANT = "00000000-0000-0000-0000-000000000000";

const flag = (name: string, fallback: string): string => {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const apply = process.argv.includes("--apply");
const batchSize = Math.max(100, Number(flag("batch", "5000")));
const parallelWorkers = Math.max(0, Number(flag("parallel", "0")));
const maintenanceWorkMem = flag("maintenance-work-mem", "256MB");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

const log = (message: string): void => {
  console.log(`[convert-embeddings] ${new Date().toISOString()} ${message}`);
};

type State = {
  vectorType: string;
  hasTenant: boolean;
  unstamped: number;
  rows: number;
  hnswIndex: string | null;
  tenantIndex: boolean;
  totalBytes: number;
};

async function readState(): Promise<State> {
  const shape = await client.query(
    `select
       (select format_type(a.atttypid, null)
          from pg_attribute a
         where a.attrelid = 'embedding'::regclass and a.attname = 'embedding') as vector_type,
       (select true from pg_attribute a
         where a.attrelid = 'embedding'::regclass and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant,
       (select indexdef from pg_indexes where tablename = 'embedding' and indexname = 'embedding_hnsw_idx') as hnsw,
       (select true from pg_indexes where tablename = 'embedding' and indexname = 'embedding_tenant_idx') as tenant_index,
       pg_total_relation_size('embedding') as total_bytes,
       (select count(*)::bigint from embedding) as rows`,
  );
  const row = shape.rows[0] ?? {};
  const hasTenant = row.has_tenant === true;
  const unstamped = hasTenant
    ? Number((await client.query("select count(*)::bigint as c from embedding where tenant_id is null")).rows[0].c)
    : Number(row.rows ?? 0);
  return {
    vectorType: String(row.vector_type ?? "unknown"),
    hasTenant,
    unstamped,
    rows: Number(row.rows ?? 0),
    hnswIndex: row.hnsw === null || row.hnsw === undefined ? null : String(row.hnsw),
    tenantIndex: row.tenant_index === true,
    totalBytes: Number(row.total_bytes ?? 0),
  };
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const before = await readState();
log(
  `embedding: ${before.rows} rows, ${before.vectorType}, ${mb(before.totalBytes)} total, ` +
    `tenant column ${before.hasTenant ? "present" : "absent"}, ${before.unstamped} rows unstamped`,
);

if (!before.hasTenant) {
  throw new Error(
    "embedding.tenant_id does not exist. Apply db/migrations (npm run db:migrate) before running this script.",
  );
}

const needsBackfill = before.unstamped > 0;
const needsHalfvec = !before.vectorType.startsWith("halfvec");
const needsTenantIndex = !before.tenantIndex;

if (!needsBackfill && !needsHalfvec && !needsTenantIndex) {
  log("already converted; nothing to do.");
  await client.end();
  process.exit(0);
}

if (!apply) {
  log("DRY RUN. Would:");
  if (needsBackfill) log(`  - drop embedding_hnsw_idx, then stamp ${before.unstamped} rows in batches of ${batchSize}`);
  if (needsHalfvec) log(`  - rewrite embedding.embedding to halfvec(1536) (${before.vectorType} today)`);
  log(`  - rebuild embedding_hnsw_idx on halfvec_cosine_ops (max_parallel_maintenance_workers=${parallelWorkers})`);
  if (needsTenantIndex) log("  - create embedding_tenant_idx on embedding(tenant_id)");
  log("Re-run with --apply. Take writes offline first: this locks the table during the rewrite.");
  await client.end();
  process.exit(0);
}

const started = Date.now();
const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

// Step 1. The index is rebuilt at the end no matter what, and leaving it in
// place makes the backfill several times more expensive and permanently bloats
// it (migration 016 measured 481 MB -> 996 MB). Dropping first is strictly
// cheaper; searches fall back to an exact scan until step 4.
if (needsBackfill && before.hnswIndex) {
  log("dropping embedding_hnsw_idx for the duration of the backfill");
  await client.query("drop index if exists embedding_hnsw_idx");
}

// Step 2. Resumable by construction: the predicate IS the progress marker, so
// an interrupted run continues rather than restarting.
if (needsBackfill) {
  let stamped = 0;
  for (;;) {
    const batch = await client.query(
      `with doomed as (
         select id from embedding where tenant_id is null limit $1
       )
       update embedding e
          set tenant_id = coalesce(
            case e.owner_table
              when 'node_revision' then (select n.owner_id from node_revision nr join node n on n.id = nr.node_id where nr.id = e.owner_id)
              when 'text_chunk'    then (select tc.owner_id from text_chunk tc where tc.id = e.owner_id)
              when 'text_unit'     then (select tu.owner_id from text_unit tu where tu.id = e.owner_id)
              when 'source'        then (select s.owner_id from source s where s.id = e.owner_id)
              when 'annotation'    then (select a.owner_id from annotation a where a.id = e.owner_id)
              when 'node'          then (select n.owner_id from node n where n.id = e.owner_id)
            end,
            $2::uuid)
        where e.id in (select id from doomed)`,
      [batchSize, UNOWNED_TENANT],
    );
    if (batch.rowCount === 0) break;
    stamped += batch.rowCount ?? 0;
    log(`stamped ${stamped}/${before.unstamped} rows (${elapsed()})`);
  }
}

// Step 3. One rewrite pays for the tenant backfill's dead tuples, the dead
// space left by the retired per-line vectors, and the halved column.
if (needsHalfvec) {
  log(`rewriting embedding.embedding to halfvec(1536) (${elapsed()})`);
  await client.query("alter table embedding alter column embedding type halfvec(1536) using embedding::halfvec(1536)");
  log(`rewrite done (${elapsed()})`);
}

// Step 4. /dev/shm in the Trove container is 62 MB, which a parallel HNSW build
// exhausts; 0 workers is the safe default and what the container needs.
// Supabase has room, so --parallel=N is available for production.
log(`rebuilding embedding_hnsw_idx (parallel workers ${parallelWorkers}, maintenance_work_mem ${maintenanceWorkMem})`);
await client.query(`set max_parallel_maintenance_workers = ${parallelWorkers}`);
await client.query(`set maintenance_work_mem = '${maintenanceWorkMem}'`);
await client.query("drop index if exists embedding_hnsw_idx");
await client.query("create index embedding_hnsw_idx on embedding using hnsw (embedding halfvec_cosine_ops)");
if (needsTenantIndex) {
  await client.query("create index if not exists embedding_tenant_idx on embedding(tenant_id)");
}
log(`indexes rebuilt (${elapsed()})`);

await client.query("analyze embedding");

const after = await readState();
log(
  `done in ${elapsed()}: ${after.rows} rows, ${after.vectorType}, ` +
    `${mb(before.totalBytes)} -> ${mb(after.totalBytes)}, ${after.unstamped} rows unstamped`,
);
if (after.unstamped > 0) {
  log("WARNING: rows are still unstamped; the store will keep filtering through the owning row. Re-run this script.");
}
log("Restart the app (or wait one minute) so it picks the converted layout up.");

await client.end();
