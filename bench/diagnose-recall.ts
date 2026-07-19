/* eslint-disable */
// bench/diagnose-recall.ts — minimal reproduction of the empty-pack bug found by
// the 2026-07-19 LongMemEval pilot (see bench/FINDINGS.md, finding 1).
//
// `recall` returns an empty context pack for natural-language questions even
// when the answering atoms plainly exist in the graph. This script proves it by
// showing, for one container:
//
//   grep "wedding"   -> 10 nodes exist
//   lexical/semantic -> 0 nodes each
//   recall(default)  -> 0 atoms
//   recall(dist=0.8) -> 10 atoms
//
// Run against the benchmark scratch database populated by a MemoryBench run:
//
//   npx tsx bench/diagnose-recall.ts [containerTag] [question]
//
// Defaults reproduce the exact pilot case. It only reads — no writes, no jobs.

import pg from "pg";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env optional; the real environment wins.
}

const DB = process.env.TROVE_BENCH_DATABASE_URL ?? "postgres://trove:trove@localhost:5433/trove_bench";
const url = new URL(DB);
if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
  throw new Error(`Refusing to run against non-local database ${url.hostname}.`);
}
process.env.DATABASE_URL = DB;
process.env.TROVE_STORE = "postgres";

// The container from the pilot run, and the question that returned nothing.
const CONTAINER = process.argv[2] ?? "gpt4_2f8be40d-trove-smoke";
const QUERY = process.argv[3] ?? "How many weddings have I attended in this year?";
// A single word that we know appears in the answering atoms' titles, used to
// prove the data is present before showing that retrieval cannot reach it.
const GREP_TERM = QUERY.split(/\s+/).find((word) => word.length > 5)?.replace(/\W/g, "") ?? "wedding";

const { createGraphStore } = await import("../src/createStore.js");
const { store } = createGraphStore();

const probe = new pg.Client({ connectionString: DB });
await probe.connect();

const { rows } = await probe.query(`select id from app_user where clerk_user_id = $1`, [`bench:${CONTAINER}`]);
if (!rows[0]) {
  throw new Error(
    `No container "bench:${CONTAINER}" in ${url.pathname}. Run a MemoryBench pilot first (see bench/README.md).`,
  );
}
const ownerId = String(rows[0].id);
const ctx = { actorId: "diagnose", interfaceId: "diagnose", requestId: "diagnose", ownerId };

const counts = await probe.query(
  `select (select count(*) from node where owner_id = $1) as nodes,
          (select count(*) from text_unit where owner_id = $1) as units`,
  [ownerId],
);
console.log(`container ${CONTAINER}: ${counts.rows[0].nodes} nodes, ${counts.rows[0].units} text units`);
console.log(`query: "${QUERY}"\n`);

// 1. The answering atoms exist — grep finds them by a single keyword.
const grep = await store.grep({ pattern: GREP_TERM, scope: "nodes", limit: 10 }, ctx);
console.log(`grep "${GREP_TERM}" -> ${grep.matches.length} node matches`);
for (const match of grep.matches.slice(0, 5)) console.log(`   - ${match.title ?? match.nodeId}`);

// 1b. But grep is NOT a fallback for the question itself. It is documented as an
// exact-string tool, and it behaves like one: the full question matches nothing.
// Every read verb is keyword-shaped; only recall advertises natural language.
const grepFull = await store.grep({ pattern: QUERY, scope: "nodes", limit: 10 }, ctx);
console.log(`grep "<the full question>" -> ${grepFull.matches.length} node matches`);

// 2. But no retrieval mode can reach them from the question.
console.log(`\n--- search modes ---`);
for (const mode of ["lexical", "semantic", "hybrid"] as const) {
  const res = await store.search({ query: QUERY, mode, limit: 10, includeTextUnits: false }, ctx);
  console.log(`${mode.padEnd(9)} -> ${res.nodes.length} nodes`);
}

// 3. The semantic ceiling is the reason. 0.55 is the default (pgStore.ts:2245).
console.log(`\n--- semantic distance floor sweep ---`);
for (const distance of [0.55, 0.7, 0.8, 0.9, 1.0, 1.2]) {
  const res = await store.search(
    { query: QUERY, mode: "semantic", limit: 20, includeTextUnits: false, maxSemanticDistance: distance },
    ctx,
  );
  console.log(`maxSemanticDistance=${distance} -> ${res.nodes.length} nodes`);
}

// 3b. The decisive comparison: the SAME graph, the same recall, asked as a
// keyword instead of a question. If this returns atoms, nothing is missing from
// the index and nothing is wrong with ranking — the query shape is the whole bug.
console.log(`\n--- same question, keyword-shaped ---`);
const keyword = GREP_TERM;
for (const q of [QUERY, keyword]) {
  const lex = await store.search({ query: q, mode: "lexical", limit: 20, includeTextUnits: false }, ctx);
  const sem = await store.search({ query: q, mode: "semantic", limit: 20, includeTextUnits: false }, ctx);
  const rec = await store.recall({ query: q, tokenBudget: 8000, depth: 1, includeEvidence: false }, ctx);
  console.log(
    `  "${q.length > 40 ? q.slice(0, 40) + "…" : q}" -> ` +
      `lexical=${lex.nodes.length} semantic=${sem.nodes.length} recall=${rec.atoms.length} atoms (${rec.spentTokens} tok)`,
  );
}

// 4. And it propagates all the way to an empty context pack.
console.log(`\n--- recall packs (tokenBudget 8000) ---`);
for (const distance of [undefined, 0.7, 0.8, 1.0]) {
  const res = await store.recall(
    {
      query: QUERY,
      tokenBudget: 8000,
      depth: 1,
      includeEvidence: true,
      ...(distance ? { maxSemanticDistance: distance } : {}),
    },
    ctx,
  );
  console.log(
    `recall(maxSemanticDistance=${distance ?? "default 0.55"}) -> ` +
      `${res.atoms.length} atoms, ${res.spentTokens}/8000 tokens`,
  );
}

await probe.end();
if ("close" in store && typeof (store as any).close === "function") await (store as any).close();
