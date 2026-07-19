/* eslint-disable */
// bench/extraction-recall.ts — did the write path keep the answer at all?
//
// A retrieval score is meaningless if the fact was never stored. This measures
// the step before retrieval, and separates two failure modes that a MemScore
// cannot tell apart:
//
//   ingested but not distilled  -> the answer is in a text_unit and in NO atom.
//                                  The extraction step dropped it. Retrieval
//                                  tuning cannot fix this.
//   never ingested              -> the answer is in neither. Harness or
//                                  ingest-side problem.
//   present in an atom          -> the write path is fine; any failure is
//                                  ranking or reading.
//
// Method: take the distinctive content terms of the ground-truth answer (proper
// nouns, numerals, rare words — stop words and question scaffolding removed via
// the same normalizer retrieval uses) and ask what fraction appear in the
// container's atoms vs its raw text units. This is a PROXY, not a judge: it
// measures term presence, not semantic equivalence, so treat per-question
// numbers as a signal and the aggregate as the finding. An LLM judge would be
// more accurate and much more expensive.
//
//   npx tsx bench/extraction-recall.ts <runId> [containerSuffix]
//
// Reads MemoryBench's checkpoint for ground truths, and the bench database for
// what was actually stored.

import { readFileSync } from "node:fs";
import pg from "pg";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env optional
}

const runId = process.argv[2];
if (!runId) throw new Error("usage: npx tsx bench/extraction-recall.ts <runId> [containerSuffix]");
const containerSuffix = process.argv[3] ?? runId;

const DB = process.env.TROVE_BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB) throw new Error("TROVE_BENCH_DATABASE_URL (or DATABASE_URL) is required.");
const url = new URL(DB);
if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
  throw new Error(`Refusing to run against non-local database ${url.hostname}.`);
}

const checkpointPath = new URL(
  `./.memorybench/data/runs/${runId}/checkpoint.json`,
  import.meta.url,
).pathname;
const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
  questions: Record<string, { questionId: string; question: string; groundTruth: string; questionType: string }>;
};

const { contentTerms } = await import("../src/queryNormalize.js");

const client = new pg.Client({ connectionString: DB });
await client.connect();

type Row = { questionType: string; inAtoms: number; inUnits: number; total: number };
const rows: Array<Row & { questionId: string }> = [];

for (const question of Object.values(checkpoint.questions)) {
  const { rows: owners } = await client.query(
    `select id from app_user where clerk_user_id = $1`,
    [`bench:${question.questionId}-${containerSuffix}`],
  );
  if (!owners[0]) continue;
  const ownerId = String(owners[0].id);

  // Distinctive terms only. Numerals are kept (counts are often the answer);
  // very short tokens are dropped as noise.
  const terms = contentTerms(question.groundTruth).filter((term) => term.length > 3 || /^\d+$/.test(term));
  if (terms.length === 0) continue;

  const { rows: atomHits } = await client.query(
    `select count(*)::int as c from unnest($2::text[]) as t(term)
      where exists (
        select 1 from node n
        join node_revision nr on nr.id = n.current_revision_id
        where n.owner_id = $1 and n.deleted_at is null
          and (lower(n.title) like '%'||t.term||'%'
            or lower(coalesce(n.summary,'')) like '%'||t.term||'%'
            or lower(coalesce(nr.content,'')) like '%'||t.term||'%')
      )`,
    [ownerId, terms],
  );
  const { rows: unitHits } = await client.query(
    `select count(*)::int as c from unnest($2::text[]) as t(term)
      where exists (
        select 1 from text_unit tu where tu.owner_id = $1 and lower(tu.text) like '%'||t.term||'%'
      )`,
    [ownerId, terms],
  );

  rows.push({
    questionId: question.questionId,
    questionType: question.questionType,
    inAtoms: Number(atomHits[0].c),
    inUnits: Number(unitHits[0].c),
    total: terms.length,
  });
}

if (rows.length === 0) {
  console.log(`No containers found for run "${runId}" (suffix "${containerSuffix}") in ${url.pathname}.`);
} else {
  const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1)}%`.padStart(6));
  console.log(`extraction recall — run ${runId} (${rows.length} questions)\n`);
  console.log(`${"question".padEnd(22)} ${"type".padEnd(26)} ${"in atoms".padStart(9)} ${"in units".padStart(9)}  lost`);
  for (const row of rows) {
    const lost = row.inUnits - row.inAtoms;
    console.log(
      `${row.questionId.padEnd(22)} ${row.questionType.padEnd(26)} ` +
        `${pct(row.inAtoms, row.total)}    ${pct(row.inUnits, row.total)}  ` +
        `${lost > 0 ? `${lost}/${row.total} terms dropped by extraction` : "-"}`,
    );
  }

  const sum = (pick: (row: Row) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
  const total = sum((row) => row.total);
  const atoms = sum((row) => row.inAtoms);
  const units = sum((row) => row.inUnits);
  console.log(`\n${"OVERALL".padEnd(49)} ${pct(atoms, total)}    ${pct(units, total)}`);
  console.log(
    `\nanswer terms present in raw ingested text: ${pct(units, total)} — anything missing here was ` +
      `never ingested (harness or ingest bug).\n` +
      `answer terms surviving into atoms:         ${pct(atoms, total)} — the gap between these two is ` +
      `extraction loss, which no amount of retrieval tuning recovers.`,
  );
}

await client.end();
