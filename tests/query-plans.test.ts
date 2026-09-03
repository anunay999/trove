import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import pg from "pg";
import {
  LEXICAL_NODE_SEARCH_SQL,
  LEXICAL_UNIT_SEARCH_SQL,
  SEMANTIC_UNIT_SEARCH_SQL,
  grepIndexLiteral,
  grepNodeSql,
  grepUnitSql,
  semanticNodeSearchSql,
} from "../src/pgStore.js";

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
 * The lexical arm had the same disease in a different coat: an OR-chain that
 * mixed tsvector matches with unanchored ilike patterns across the node /
 * node_revision join, which no index can serve, so every hybrid search
 * recomputed to_tsvector over every current revision. The lexical statements
 * are therefore imported from pgStore rather than copied, so the plan under
 * test is the plan production runs.
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
// Two owners: a large one holding 95% of the rows and a small one with the
// rest, so a scoped probe has to look past the first hnsw.ef_search candidates.
const LARGE_OWNER = "11111111-1111-1111-1111-111111111111";
const SMALL_OWNER = "22222222-2222-2222-2222-222222222222";
const SMALL_OWNER_ROWS = 100;

describe("query plans", { skip: shouldRun ? false : "requires a Postgres DATABASE_URL" }, () => {
  const probeName = `trove_${process.env.TROVE_TEST_DB_PREFIX ?? ""}plans_${process.pid}`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
  let admin: pg.Client;
  let probe: pg.Client;

  const setup = async (): Promise<void> => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${probeName} with (force)`);
    await admin.query(`create database ${probeName}`);

    const probeUrl = new URL(databaseUrl as string);
    probeUrl.pathname = `/${probeName}`;
    probe = new pg.Client({ connectionString: probeUrl.toString() });
    await probe.connect();

    // A minimal stand-in for the real schema: just the columns the search and
    // grep statements touch, typed as they are in production. Using the actual
    // schema here would make the test depend on migrations, which is not what
    // it is checking — with one exception below.
    await probe.query(`create extension if not exists vector`);
    await probe.query(`create extension if not exists pg_trgm`);
    await probe.query(`
      create type node_type as enum ('claim');
      create table node_revision (
        id serial primary key, node_id int, content text
      );
      create table node (
        id int primary key, current_revision_id int, deleted_at timestamptz, title text, summary text,
        slug text, type node_type, owner_id uuid, updated_at timestamptz not null default now(),
        access_count bigint not null default 0, last_accessed_at timestamptz
      );
      create table source (id int primary key, title text);
      create table text_unit (
        id int primary key, source_id int, ordinal int, section_path text[], char_start int, char_end int,
        text text, content_sha256 text, owner_id uuid, created_at timestamptz not null default now()
      );
      -- The grain the vector index is built on since migration 020. One chunk
      -- per source here, covering that source's single unit, so the expansion
      -- join is exercised without changing what the probe has to walk.
      create table text_chunk (
        id int primary key, source_id int, ordinal int, first_ordinal int, last_ordinal int,
        section_path text[], context_prefix text, text text, content_sha256 text, owner_id uuid,
        created_at timestamptz not null default now()
      );
      create table embedding (
        id serial primary key, owner_id int, owner_table text, model text, embedding vector(${DIMS})
      );
    `);
    await probe.query(`
      insert into node_revision (node_id, content)
        select g, 'revision body ' || g from generate_series(1, ${ROWS}) g;
      insert into node (id, current_revision_id, deleted_at, title, summary, slug, type, owner_id)
        select g, g, null, 'node ' || g, 'summary ' || g, 'node-' || g, 'claim',
               case when g > ${ROWS - SMALL_OWNER_ROWS} then '${SMALL_OWNER}'::uuid else '${LARGE_OWNER}'::uuid end
        from generate_series(1, ${ROWS}) g;
      insert into source select g, 'source ' || g from generate_series(1, ${ROWS}) g;
      -- Long enough to clear EMBEDDABLE_TEXT_UNIT, which the chunk expansion
      -- re-applies: a sub-12-character line is junk and is never served.
      insert into text_unit (id, source_id, ordinal, text, content_sha256, owner_id)
        select g, g, 0, 'unit ' || g || ' carries a whole sentence of prose', 'sha' || g,
               case when g > ${ROWS - SMALL_OWNER_ROWS} then '${SMALL_OWNER}'::uuid else '${LARGE_OWNER}'::uuid end
        from generate_series(1, ${ROWS}) g;
      -- Two clusters, not random vectors: random 384-d vectors are all nearly
      -- equidistant, and an HNSW walk over them says nothing reliable. The
      -- large owner's rows point along dimension 1, the small owner's along
      -- dimension 2, and the query points along dimension 1 — so the small
      -- owner's rows are strictly farther from it than every large-owner row.
      insert into embedding (owner_id, owner_table, model, embedding)
        select g, 'node_revision', 'm1',
               (select array_agg(case when i = (case when g > ${ROWS - SMALL_OWNER_ROWS} then 2 else 1 end) then 10.0 else random() end)::vector(${DIMS})
                from generate_series(1, ${DIMS}) i)
        from generate_series(1, ${ROWS}) g;
      insert into text_chunk (id, source_id, ordinal, first_ordinal, last_ordinal, context_prefix, text, content_sha256, owner_id)
        select g, g, 0, 0, 0, 'Source: source ' || g, 'unit ' || g || ' carries a whole sentence of prose', 'csha' || g,
               case when g > ${ROWS - SMALL_OWNER_ROWS} then '${SMALL_OWNER}'::uuid else '${LARGE_OWNER}'::uuid end
        from generate_series(1, ${ROWS}) g;
      -- Both owner types share one embedding table, as in the real schema. The
      -- HNSW index does NOT cover owner_table, so a probe restricted to one type
      -- is a genuine test of whether the planner can still use it.
      insert into embedding (owner_id, owner_table, model, embedding)
        select g, 'text_chunk', 'm1',
               (select array_agg(case when i = (case when g > ${ROWS - SMALL_OWNER_ROWS} then 2 else 1 end) then 10.0 else random() end)::vector(${DIMS})
                from generate_series(1, ${DIMS}) i)
        from generate_series(1, ${ROWS}) g;
    `);
    await probe.query(`create index embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops)`);
    // The full-text indexes as db/schema.sql declares them.
    await probe.query(`
      create index node_search_idx on node using gin(
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
      ) where deleted_at is null;
      create index revision_content_search_idx on node_revision using gin(
        to_tsvector('english', coalesce(content, ''))
      );
      create index text_unit_search_idx on text_unit using gin(to_tsvector('english', text));
      create index node_title_trgm_idx on node using gin (title gin_trgm_ops);
    `);
    // The trigram indexes come from the migration file itself, so a lexical
    // plan can only pass here if the migration really creates what it needs.
    await probe.query(await readFile(new URL("../db/migrations/015_lexical_indexes.sql", import.meta.url), "utf8"));
    await probe.query(`create index text_unit_source_idx on text_unit(source_id, ordinal)`);
    await probe.query(`analyze node_revision; analyze node; analyze text_unit; analyze text_chunk; analyze source; analyze embedding`);
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
    // What semanticSearch sets on its own connection; harmless for the rest.
    await probe.query(`set enable_hashjoin = off`);
    await probe.query(`set enable_mergejoin = off`);
    const explained = await probe.query(`explain (costs off) ${sql}`, params);
    return explained.rows
      .map((row) => String(row["QUERY PLAN"]))
      // Inlined vector literals are ~384 floats; unabridged they bury the plan
      // in the failure message and make the actual node types unreadable.
      .map((line) => line.replace(/'\[[-0-9.,e ]{40,}\]'/g, "'[…vector…]'"))
      .join("\n");
  };

  /** A query along dimension 1: near the large owner's cluster, far from the small owner's. */
  const sampleVector = async (): Promise<string> => `[${[10, ...Array.from({ length: DIMS - 1 }, () => 0.5)].join(",")}]`;

  after(async () => {
    await probe?.end();
    if (admin) {
      await admin.query(`drop database if exists ${probeName}`).catch(() => undefined);
      await admin.end();
    }
  });

  // Parameters as semanticSearch binds them for one query vector: model, type
  // filter, limit, unscoped, owner, max distance, %query%, query, candidates.
  const nodeParams = (vector: string, owner: string | null): unknown[] =>
    [vector, "m1", null, 10, owner === null, owner, 2.0, "%node%", "node", 100];
  const unitParams = (vector: string, owner: string | null): unknown[] =>
    [vector, "m1", owner === null, owner, 10, 2.0];

  it("semantic node search probes embedding_hnsw_idx instead of scanning", async () => {
    await setup();
    const vector = await sampleVector();

    const plan = await planOf(semanticNodeSearchSql(1), nodeParams(vector, null));

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

  it("an owner-scoped semantic node search still probes the index, with the owner joined inside", async () => {
    const vector = await sampleVector();

    // The owner filter is reached through node_revision → node INSIDE the
    // limited branch. That must not cost the ordered index path: the probe has
    // to stay an HNSW scan with pkey lookups on top, not a join that is sorted
    // afterwards — a Sort over the whole join is the filter-then-sort shape the
    // candidate CTE exists to avoid.
    const plan = await planOf(semanticNodeSearchSql(1), nodeParams(vector, SMALL_OWNER));

    assert.match(
      plan,
      /Index Scan using embedding_hnsw_idx/,
      `the owner-scoped probe lost the HNSW index. Plan:\n${plan}`,
    );
    assert.doesNotMatch(plan, /Seq Scan on embedding/, `owner-scoped probe scans every embedding row. Plan:\n${plan}`);
    assert.doesNotMatch(plan, /Hash Join|Merge Join/, `a non-streaming join sits between the probe and its limit. Plan:\n${plan}`);
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

  it("semantic text-unit search probes the index per vector, scoped or not", async () => {
    const vector = await sampleVector();

    for (const owner of [null, SMALL_OWNER]) {
      const plan = await planOf(SEMANTIC_UNIT_SEARCH_SQL, unitParams(vector, owner));
      assert.match(plan, /Index Scan using embedding_hnsw_idx/, `text-unit probe (owner ${owner}) lost the HNSW index. Plan:\n${plan}`);
      assert.doesNotMatch(
        plan,
        /Seq Scan on embedding/,
        `semantic text-unit search (owner ${owner}) is scanning every embedding row. Plan:\n${plan}`,
      );
    }
  });

  it("hnsw.iterative_scan is what lets a scoped probe fill its limit — the SET semanticSearch issues", async () => {
    const vector = await sampleVector();

    // Without iteration an HNSW scan yields at most hnsw.ef_search (40)
    // candidates and stops; every one of them is the large owner's (its
    // cluster is nearer the query), so the join filter starves the limit.
    // With iteration the scan keeps walking until the limit is met. Both runs
    // use the statements production runs, under the session settings
    // semanticSearch applies, on a table where the planner really chooses the
    // index (seqscan is off for this session).
    await probe.query(`set hnsw.iterative_scan = off`);
    const starved = await probe.query(semanticNodeSearchSql(1), nodeParams(vector, SMALL_OWNER));
    const starvedUnits = await probe.query(SEMANTIC_UNIT_SEARCH_SQL, unitParams(vector, SMALL_OWNER));
    await probe.query(`set hnsw.iterative_scan = relaxed_order`);
    const filled = await probe.query(semanticNodeSearchSql(1), nodeParams(vector, SMALL_OWNER));
    const filledUnits = await probe.query(SEMANTIC_UNIT_SEARCH_SQL, unitParams(vector, SMALL_OWNER));
    await probe.query(`reset hnsw.iterative_scan`);

    assert.ok(starved.rows.length < 10, `expected the un-iterated probe to starve, got ${starved.rows.length} rows`);
    assert.ok(starvedUnits.rows.length < 10, `expected the un-iterated unit probe to starve, got ${starvedUnits.rows.length} rows`);
    assert.equal(filled.rows.length, 10, "the iterated node probe did not fill its limit");
    assert.equal(filledUnits.rows.length, 10, "the iterated unit probe did not fill its limit");
    assert.ok(filled.rows.every((row) => Number(row.id) > ROWS - SMALL_OWNER_ROWS), "a large-owner row leaked into the scoped probe");
  });

  // The lexical arm. Each of these plans the statement pgStore actually runs,
  // with the parameters lexicalSearch / grep would bind for an unscoped call.

  it("lexical node search reaches node and node_revision through their GIN indexes", async () => {
    const plan = await planOf(LEXICAL_NODE_SEARCH_SQL, [
      "revision body 7", null, 10, "%revision body 7%", true, null, "'revis' & 'bodi' & '7'",
    ]);

    assert.doesNotMatch(
      plan,
      /Seq Scan on node_revision/,
      `lexical node search is scanning every revision (and recomputing its tsvector). Plan:\n${plan}`,
    );
    assert.doesNotMatch(plan, /Seq Scan on node\b/, `lexical node search is scanning every node. Plan:\n${plan}`);
    assert.match(plan, /revision_content_search_idx/, `the revision full-text index is unused. Plan:\n${plan}`);
    assert.match(plan, /node_revision_content_trgm_idx/, `the revision trigram index is unused. Plan:\n${plan}`);
  });

  it("lexical text-unit search reaches text_unit through its GIN indexes", async () => {
    const plan = await planOf(LEXICAL_UNIT_SEARCH_SQL, [10, "%unit 7%", true, null, "'unit' & '7'"]);

    assert.doesNotMatch(
      plan,
      /Seq Scan on text_unit/,
      `lexical text-unit search is scanning every text unit. Plan:\n${plan}`,
    );
    assert.match(plan, /text_unit_search_idx/, `the text-unit full-text index is unused. Plan:\n${plan}`);
    assert.match(plan, /text_unit_text_trgm_idx/, `the text-unit trigram index is unused. Plan:\n${plan}`);
  });

  it("grep over sources with a literal pattern is served by the trigram index", async () => {
    const literal = grepIndexLiteral("unit 7");
    assert.equal(literal, "unit 7");
    const plan = await planOf(grepUnitSql("~*", literal !== null), ["unit 7", 21, true, null, `%${literal}%`]);

    assert.doesNotMatch(
      plan,
      /Seq Scan on text_unit/,
      `grep is scanning every text unit for a literal pattern. Plan:\n${plan}`,
    );
    assert.match(plan, /text_unit_text_trgm_idx/, `grep is not using the text-unit trigram index. Plan:\n${plan}`);
  });

  it("grep over nodes with a literal pattern is served by the trigram indexes", async () => {
    const literal = grepIndexLiteral("body 7");
    const plan = await planOf(grepNodeSql("~*", literal !== null), ["body 7", 21, true, null, `%${literal}%`]);

    assert.doesNotMatch(
      plan,
      /Seq Scan on node_revision/,
      `grep is scanning every revision for a literal pattern. Plan:\n${plan}`,
    );
    assert.doesNotMatch(plan, /Seq Scan on node\b/, `grep is scanning every node. Plan:\n${plan}`);
    // With seqscan disabled the old OR-across-the-join shape hides behind a
    // full Index Scan of node_revision_pkey feeding a hash join — no "Seq Scan"
    // in the text, every revision still read. Only the positive check catches it.
    assert.match(plan, /node_revision_content_trgm_idx/, `grep is not using the revision trigram index. Plan:\n${plan}`);
  });

  it("grepIndexLiteral only extracts a run every match must contain", () => {
    // Pure literals and regex-free runs come through whole.
    assert.equal(grepIndexLiteral("wedding venue"), "wedding venue");
    assert.equal(grepIndexLiteral("wedding.*venue"), "wedding");
    // A quantifier makes its preceding character optional: it cannot be relied on.
    assert.equal(grepIndexLiteral("colou?r"), "colo");
    assert.equal(grepIndexLiteral("ab*cdef"), "cdef");
    assert.equal(grepIndexLiteral("ab{0,2}cdef"), "cdef");
    // `+` keeps its character (at least one occurrence is required).
    assert.equal(grepIndexLiteral("abc+d"), "abc");
    // Alternation, groups, classes and escapes are ambiguous; give up.
    assert.equal(grepIndexLiteral("wedding|venue"), null);
    assert.equal(grepIndexLiteral("(wedding)"), null);
    assert.equal(grepIndexLiteral("[wedding]"), null);
    assert.equal(grepIndexLiteral("wed\\.ding"), null);
    // Fewer than three literal characters cannot be served by a trigram index.
    assert.equal(grepIndexLiteral("ab"), null);
    assert.equal(grepIndexLiteral("a.b.c"), null);
    assert.equal(grepIndexLiteral(""), null);
  });
});
