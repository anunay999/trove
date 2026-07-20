import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import pg from "pg";

/**
 * Query-plan regression tests.
 *
 * These exist because a 222x performance regression shipped to production
 * undetected. The semantic search sort key was wrapped in `least(...)` to
 * support dual-embedding; `least()` is not an indexable operator expression, so
 * embedding_hnsw_idx became unusable and every semantic search degraded to a
 * sequential scan. Nothing caught it:
 *
 *  - the type checker cannot see into a SQL string;
 *  - every functional test still passed, because the results were CORRECT,
 *    just slow;
 *  - repro-eval R15 counts SQL STATEMENTS, and the count did not change;
 *  - and on the 245-row repro fixture both the fast and slow forms plan a
 *    `Sort`, because Postgres ignores HNSW at that size — so even a hand check
 *    against the usual fixture returns a false negative.
 *
 * The only signal that separates the two is the PLAN, on a table big enough for
 * the planner to care. That is what this file asserts. It builds its own
 * throwaway database with a realistic row count, so it neither depends on nor
 * pollutes the suite fixtures.
 *
 * When one of these fails, the query still returns the right answer — it just
 * stopped using an index. Do not "fix" it by relaxing the assertion.
 */

const databaseUrl = process.env.DATABASE_URL;
const shouldRun = Boolean(databaseUrl) && process.env.TROVE_STORE !== "memory";

// Small on purpose. Because planOf() disables seqscan, these tests check whether
// an index path EXISTS, which is independent of table size — so the fixture only
// needs enough rows to build a usable HNSW index. Sizing it for planner
// preference instead (20k+ rows) exhausted the container's /dev/shm during the
// index build when the rest of the suite was running in parallel.
const ROWS = 2_000;
const DIMS = 384;

describe("query plans", { skip: shouldRun ? false : "requires a Postgres DATABASE_URL" }, () => {
  const probeName = `trove_plans_${process.pid}`;
  let admin: pg.Client;
  let probe: pg.Client;

  const setup = async (): Promise<void> => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${probeName}`);
    await admin.query(`create database ${probeName}`);

    const probeUrl = new URL(databaseUrl as string);
    probeUrl.pathname = `/${probeName}`;
    probe = new pg.Client({ connectionString: probeUrl.toString() });
    await probe.connect();

    // A minimal stand-in for the real schema: just the columns the semantic
    // queries touch. Using the actual schema here would make the test depend on
    // migrations, which is not what it is checking.
    await probe.query(`create extension if not exists vector`);
    await probe.query(`
      create table node_revision (id serial primary key, node_id int, content text);
      create table node (id int primary key, current_revision_id int, deleted_at timestamptz, title text, slug text, type text);
      create table text_unit (id int primary key, body text);
      create table embedding (
        id serial primary key, owner_id int, owner_table text, model text, embedding vector(${DIMS})
      );
    `);
    await probe.query(`
      insert into node_revision (node_id, content)
        select g, 'revision body ' || g from generate_series(1, ${ROWS}) g;
      insert into node
        select g, g, null, 'node ' || g, 'node-' || g, 'claim' from generate_series(1, ${ROWS}) g;
      insert into text_unit select g, 'unit ' || g from generate_series(1, ${ROWS}) g;
      insert into embedding (owner_id, owner_table, model, embedding)
        select g, 'node_revision', 'm1',
               (select array_agg(random())::vector(${DIMS}) from generate_series(1, ${DIMS}))
        from generate_series(1, ${ROWS}) g;
      -- Both owner types share one embedding table, as in the real schema. The
      -- HNSW index does NOT cover owner_table, so a probe restricted to one type
      -- is a genuine test of whether the planner can still use it.
      insert into embedding (owner_id, owner_table, model, embedding)
        select g, 'text_unit', 'm1',
               (select array_agg(random())::vector(${DIMS}) from generate_series(1, ${DIMS}))
        from generate_series(1, ${ROWS}) g;
    `);
    await probe.query(`create index embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops)`);
    await probe.query(`analyze node_revision; analyze node; analyze text_unit; analyze embedding`);
  };

  /**
   * Plan a query with sequential scans disabled.
   *
   * This asserts INDEXABILITY, not planner preference. Whether Postgres chooses
   * the index is cost-based and moves with table size, statistics and load —
   * under a parallel suite that makes for a flaky test. Whether an index path
   * EXISTS is a property of the SQL alone, which is exactly what regressed:
   * `least(...)` has no index path even with seqscan disabled, while the plain
   * distance operator does.
   */
  const planOf = async (sql: string, params: unknown[]): Promise<string> => {
    await probe.query(`set enable_seqscan = off`);
    const explained = await probe.query(`explain (costs off) ${sql}`, params);
    return explained.rows
      .map((row) => String(row["QUERY PLAN"]))
      // Inlined vector literals are ~384 floats; unabridged they bury the plan
      // in the failure message and make the actual node types unreadable.
      .map((line) => line.replace(/'\[[-0-9.,e ]{40,}\]'/g, "'[…vector…]'"))
      .join("\n");
  };

  const sampleVector = async (): Promise<string> =>
    String((await probe.query(`select embedding::text as v from embedding limit 1`)).rows[0].v);

  after(async () => {
    await probe?.end();
    if (admin) {
      await admin.query(`drop database if exists ${probeName}`).catch(() => undefined);
      await admin.end();
    }
  });

  it("semantic node search probes embedding_hnsw_idx instead of scanning", async () => {
    await setup();
    const vector = await sampleVector();

    // The shape pgStore.semanticSearch builds: per-vector HNSW probe into a
    // bounded candidate set, then join and filter.
    const plan = await planOf(
      `with candidates as (
         select e.owner_id, e.embedding <=> $1::vector as distance
         from embedding e
         where e.owner_table = 'node_revision' and e.model = $2
         order by e.embedding <=> $1::vector
         limit 200
       ),
       best as (select owner_id, min(distance) as distance from candidates group by owner_id)
       select n.id, best.distance
       from best
       join node_revision nr on nr.id = best.owner_id
       join node n on n.id = nr.node_id and n.deleted_at is null and nr.id = n.current_revision_id
       where best.distance < $3
       order by best.distance
       limit 10`,
      [vector, "m1", 0.55],
    );

    assert.match(
      plan,
      /Index Scan using embedding_hnsw_idx/,
      `semantic node search stopped using the HNSW index. Plan:\n${plan}`,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on embedding/,
      `semantic node search is scanning every embedding row. Plan:\n${plan}`,
    );
  });

  it("least() over two vectors cannot use the index — the regression this guards", async () => {
    const vector = await sampleVector();

    // Documents WHY the candidate-CTE shape exists. If a future pgvector makes
    // this indexable, this test fails and the workaround can be simplified —
    // that is a good failure, not a bad one.
    const plan = await planOf(
      `select e.owner_id
       from embedding e
       where e.model = $2
       order by least(e.embedding <=> $1::vector, e.embedding <=> $1::vector)
       limit 10`,
      [vector, "m1"],
    );

    assert.doesNotMatch(
      plan,
      /Index Scan using embedding_hnsw_idx/,
      "least() became indexable — the candidate-CTE workaround in semanticSearch can now be simplified.\n" +
        `Plan:\n${plan}`,
    );
  });

  it("semantic text-unit search probes the index per vector", async () => {
    const vector = await sampleVector();

    const plan = await planOf(
      `select tu.id, (e.embedding <=> $1::vector) as distance
       from embedding e
       join text_unit tu on tu.id = e.owner_id and e.owner_table = 'text_unit'
       where e.model = $2 and (e.embedding <=> $1::vector) < $3
       order by e.embedding <=> $1::vector
       limit 10`,
      [vector, "m1", 0.55],
    );

    assert.doesNotMatch(
      plan,
      /Seq Scan on embedding/,
      `semantic text-unit search is scanning every embedding row. Plan:\n${plan}`,
    );
  });
});
