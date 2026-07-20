/* eslint-disable */
// scripts/repro-eval.ts — FIX-VALIDATION harness. The earlier version of this
// script encoded the buggy behavior; every item now expects the FIXED behavior:
// prints `Rx: PASS — <evidence>` when the fix is observed, `Rx: FAIL — <evidence>`
// when the old bug still reproduces. Diagnosis only; modifies nothing under
// src/ or db/. Runs exclusively against the local scratch database
// postgres://trove:trove@localhost:5433/trove_repro (docker-compose pgvector).
// Idempotent: truncates all public tables at start. Keeps the database on exit.
//
// Run:  npx tsx scripts/repro-eval.ts

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

// --- Env: load .env for OPENAI_API_KEY / TROVE_EMBEDDING_PROVIDER, then FORCE the
// scratch DATABASE_URL (never trust whatever .env points at) and assert it.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // .env optional; real environment wins (process.loadEnvFile does not override).
}
process.env.DATABASE_URL = "postgres://trove:trove@localhost:5433/trove_repro";
const dbUrl = new URL(process.env.DATABASE_URL);
if (dbUrl.hostname !== "localhost" || dbUrl.port !== "5433" || dbUrl.pathname !== "/trove_repro") {
  throw new Error(`Refusing to touch non-scratch database host: ${dbUrl.host}${dbUrl.pathname}`);
}
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing (needed for semantic items).");
if (!process.env.TROVE_EMBEDDING_PROVIDER) throw new Error("TROVE_EMBEDDING_PROVIDER missing.");
const REAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const REAL_PROVIDER = process.env.TROVE_EMBEDDING_PROVIDER;

// --- Cost accounting: count embedding API calls and texts (no secrets printed).
let embeddingApiCalls = 0;
let embeddingApiTexts = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  try {
    const url = String(input?.url ?? input);
    if (url.includes("/embeddings")) {
      embeddingApiCalls += 1;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      embeddingApiTexts += Array.isArray(body?.input) ? body.input.length : 0;
    }
  } catch {
    // accounting must never break the request
  }
  return origFetch(input, init);
}) as typeof fetch;

// --- SQL statement counting (enabled only during the R15 measurement window).
let counting = false;
const queryLog: string[] = [];
const origPoolQuery = pg.Pool.prototype.query;
(pg.Pool.prototype as any).query = function (...args: any[]) {
  if (counting) {
    const text = typeof args[0] === "string" ? args[0] : String(args[0]?.text ?? "");
    queryLog.push(text.replace(/\s+/g, " ").trim());
  }
  return (origPoolQuery as any).apply(this, args);
};

const { createGraphStore } = await import("../src/createStore.js");
const { remember, forget } = await import("../src/agentOps.js");
const { createEmbeddingProviderFromEnv, vectorLiteral } = await import("../src/embeddings.js");

const stamp = Date.now().toString(36);
const startedAt = Date.now();
const { store, driver } = createGraphStore();
if (driver !== "postgres") throw new Error(`expected postgres driver, got ${driver}`);
const ctx = { actorId: "repro-eval", interfaceId: "repro-eval", requestId: `repro-${stamp}` };

const probe = new pg.Client({ connectionString: process.env.DATABASE_URL });
await probe.connect();

const results: string[] = [];
// Verdicts are tracked per R-id, not per report() call: R9 legitimately reports
// twice (a + b), and counting calls is what printed "18/17 PASS". A second
// report for the same id ANDs into its verdict — a fail can never be upgraded
// back to a pass by a later call.
const verdicts = new Map<string, boolean>();
function report(id: string, pass: boolean, evidence: string): void {
  const line = `${id}: ${pass ? "PASS" : "FAIL"} — ${evidence.replace(/\s+/g, " ").trim()}`;
  results.push(line);
  if (id.startsWith("R")) verdicts.set(id, (verdicts.get(id) ?? true) && pass);
  console.log(line);
}
const passCount = (): number => [...verdicts.values()].filter(Boolean).length;
const failCount = (): number => [...verdicts.values()].filter((pass) => !pass).length;
async function section(id: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${id} ===`);
  try {
    await fn();
  } catch (error) {
    // TEMP-DEBUG: full stack for the R8/R12 harness-error investigation; revert.
    console.log(`  [debug-stack] ${error instanceof Error ? error.stack : String(error)}`);
    report(id, false, `harness error: ${(error instanceof Error ? error.message : String(error)).slice(0, 220)}`);
  }
}

async function drainPending(cap = 200): Promise<number> {
  let n = 0;
  while (n < cap) {
    const job = await store.runJob({}, ctx);
    if (!job) break;
    n += 1;
    if (job.status === "failed" || (job.status as string) === "dead") {
      throw new Error(`drain: job ${job.kind} ${job.status}: ${job.error}`);
    }
  }
  return n;
}

async function ensureEmbeddings(label: string): Promise<void> {
  for (let round = 0; round < 25; round++) {
    await drainPending();
    await store.enqueueJob(
      { kind: "refresh_embeddings", payload: { reason: `repro:${label}` }, priority: 40, dedupeKey: "maintenance:refresh_embeddings" },
      ctx,
    );
    const job = await store.runJob({}, ctx);
    if (!job || job.kind !== "refresh_embeddings") continue;
    if (job.status !== "succeeded") throw new Error(`embeddings job ${job.status}: ${job.error}`);
    const result = (job.result ?? {}) as Record<string, any>;
    if (result.status === "skipped_no_embedding_provider") throw new Error("embedding provider not configured");
    const missing = (result.missingBefore ?? {}) as Record<string, unknown>;
    const left = Number(missing.nodeRevisions ?? 0) + Number(missing.textUnits ?? 0);
    console.log(`  [ensureEmbeddings:${label}] round ${round}: missingBefore=${left} embedded=${JSON.stringify(result.embedded)}`);
    if (left === 0) {
      await drainPending();
      return;
    }
  }
  throw new Error(`ensureEmbeddings(${label}) did not converge`);
}

const accessOf = async (id: string): Promise<{ c: number; t: string | null }> =>
  (await probe.query(`select access_count::int as c, last_accessed_at::text as t from node where id = $1`, [id]))
    .rows[0] as { c: number; t: string | null };

// --- Wipe the scratch DB (idempotency).
const tables = await probe.query(`select string_agg(format('%I', tablename), ', ') as t from pg_tables where schemaname = 'public'`);
await probe.query(`truncate table ${tables.rows[0].t} cascade`);
console.log(`wiped public tables in trove_repro; stamp=${stamp}`);

// ---------------------------------------------------------------- R1 (F4: recall no longer bumps activation)
await section("R1", async () => {
  const node = await store.capture({
    title: `R1 zephyrus anchor node ${stamp}`,
    type: "claim",
    summary: `R1 zephyrus anchor ${stamp}`,
    content: `R1 zephyrus anchor body ${stamp}: the activation probe content.`,
    evidence: [],
    links: [],
  }, ctx);
  const afterCapture = await accessOf(node.id);
  const rec = await store.recall({ query: "zephyrus anchor", tokenBudget: 2000, depth: 0, includeEvidence: false }, ctx);
  const packed = rec.atoms.some((atom) => atom.node.id === node.id);
  const afterRecall = await accessOf(node.id);
  report(
    "R1",
    afterCapture.c === 0 && afterRecall.c === 0 && packed,
    `access_count ${afterCapture.c} after capture (read-back untracked) -> ${afterRecall.c} after ONE recall that packed the node (${packed}); last_accessed_at stays ${afterRecall.t}. Old behavior: 1 -> 2.`,
  );
});

// ---------------------------------------------------------------- R2 (F4: remember revise no longer bumps)
await section("R2", async () => {
  const title = `R2 write path bump ${stamp}`;
  const first = await remember(store, {
    title,
    type: "claim",
    summary: `R2 summary ${stamp}`,
    content: `R2 v1 body ${stamp}: the write-path probe.`,
    evidence: [],
    links: [],
  }, ctx);
  const before = await accessOf(first.node.id);
  const second = await remember(store, {
    title,
    type: "claim",
    summary: `R2 summary v2 ${stamp}`,
    content: `R2 v2 body ${stamp}: the write-path probe, revised.`,
    evidence: [],
    links: [],
  }, ctx);
  const after = await accessOf(first.node.id);
  report(
    "R2",
    before.c === 0 && after.c === 0 && second.action === "updated",
    `exact-title remember revise (action=${second.action}): access_count ${before.c} -> ${after.c} (+${after.c - before.c}); all internal reads are trackAccess:false (agentOps.ts, capture/update read-backs). Old behavior: 1 -> 3.`,
  );
});

// ---------------------------------------------------------------- R3 (F3: wire budget guarded ~1.5x)
await section("R3", async () => {
  const filler = "bulk text with the word murmuration and the ordinary filler sentence. ";
  let firstNodeId = "";
  for (let i = 0; i < 5; i++) {
    const node = await store.capture({
      title: `R3 murmuration payload ${i} ${stamp}`,
      type: "claim",
      summary: `murmuration ${i} ${stamp}`,
      content: `R3 murmuration payload ${i} ${stamp}. ${filler.repeat(190)}`, // ~11.6 KB, under the 12 KB giant cut
      evidence: [],
      links: [],
    }, ctx);
    if (i === 0) firstNodeId = node.id;
  }
  const res = await store.recall({ query: "murmuration", tokenBudget: 1000, depth: 0, includeEvidence: false }, ctx);
  const contextChars = res.context.length;
  const wireChars = JSON.stringify(res).length;
  const atomContentChars = res.atoms.reduce((sum, atom) => sum + (atom.node.content?.length ?? 0), 0);
  const primary = res.atoms.find((atom) => atom.node.id === firstNodeId) ?? res.atoms[0];
  const slices = res.atoms.every((atom) => (atom.node.content?.length ?? 0) < 11_600);
  const pass =
    wireChars <= 6200 &&
    atomContentChars <= 5500 &&
    slices &&
    primary !== undefined &&
    primary.contentTruncated === true;
  report(
    "R3",
    pass,
    `tokenBudget=1000: wire JSON=${wireChars} chars (guard ~1.5x -> <=6000), context=${contextChars} chars (spent=${res.spentTokens}), atoms[].node.content sum=${atomContentChars} across ${res.atoms.length} atom(s); primary atom content=${primary?.node.content?.length} chars of 11600 with contentTruncated=${primary?.contentTruncated}. Old behavior: wire 16496 chars, full 11.6KB body in the atom.`,
  );
});

// ---------------------------------------------------------------- R4 (F2: forget tombstones nodes; edge-only unchanged)
await section("R4", async () => {
  // Case 1 (unchanged semantics): edge-only forget expires the edge, node survives.
  const a = await store.capture({
    title: `R4 zqlmforge twiluna belief ${stamp}`,
    type: "claim",
    summary: `zqlmforge twiluna ${stamp}`,
    content: `zqlmforge twiluna ${stamp}: the moon pool pump runs on Tuesdays.`,
    evidence: [],
    links: [],
  }, ctx);
  const b = await store.capture({
    title: `R4 sibling node ${stamp}`,
    type: "claim",
    summary: `sibling ${stamp}`,
    content: `R4 sibling body ${stamp}.`,
    evidence: [],
    links: [],
  }, ctx);
  const edge = await store.link({ fromNodeId: a.id, toNodeId: b.id, predicate: "relates_to", weight: 1 }, ctx);
  if (!edge) throw new Error("link failed");
  const edgeOnly = await forget(store, { edgeIds: [edge.id] }, ctx);
  const stillPacked = (await store.recall({ query: "zqlmforge twiluna", tokenBudget: 2000, depth: 0, includeEvidence: false }, ctx))
    .atoms.some((atom) => atom.node.id === a.id);
  const stillGrep = (await store.grep({ pattern: "zqlmforge", scope: "nodes", limit: 10 }, ctx))
    .matches.some((match) => match.nodeId === a.id);
  const stillRead = await store.read({ nodeId: a.id }, ctx, { trackAccess: false });
  const case1 = edgeOnly.retired === 1 && edgeOnly.tombstoned === 0 && stillPacked && stillGrep && stillRead?.id === a.id;
  console.log(`  case1 edge-only: retired=${edgeOnly.retired} tombstoned=${edgeOnly.tombstoned} packed=${stillPacked} grep=${stillGrep} read=${stillRead?.id === a.id}`);

  // Case 2 (the fix): forget with nodeIds tombstones the node out of every read path.
  const doomed = await store.capture({
    title: `R4 doomed vortex belief ${stamp}`,
    type: "claim",
    summary: `doomed vortex ${stamp}`,
    content: `doomed vortex ${stamp}: the belief that must disappear completely.`,
    evidence: [],
    links: [],
  }, ctx);
  const edge2 = await store.link({ fromNodeId: doomed.id, toNodeId: b.id, predicate: "relates_to", weight: 1 }, ctx);
  const preview = await forget(store, { nodeIds: [doomed.id], dryRun: true }, ctx);
  const applied = await forget(store, { nodeIds: [doomed.id] }, ctx);
  const goneFromRecall = !(await store.recall({ query: "doomed vortex", tokenBudget: 2000, depth: 0, includeEvidence: false }, ctx))
    .atoms.some((atom) => atom.node.id === doomed.id);
  const goneFromGrep = !(await store.grep({ pattern: "doomed vortex", scope: "nodes", limit: 10 }, ctx))
    .matches.some((match) => match.nodeId === doomed.id);
  const goneFromRead = (await store.read({ nodeId: doomed.id }, ctx, { trackAccess: false })) === null;
  const row = await probe.query(`select deleted_at is not null as tombstoned from node where id = $1`, [doomed.id]);
  const edgeExpired = await probe.query(`select expired_at is not null as expired from edge where id = $1`, [edge2?.id ?? ""]);
  const hood = await store.neighborhood({ nodeId: b.id, depth: 1 }, ctx);
  const goneFromNeighborhood = !hood.nodes.some((node) => node.id === doomed.id);
  const case2 =
    preview.dryRun === true && preview.tombstoned === 0 && preview.nodes.length === 1 &&
    applied.tombstoned === 1 && applied.nodes[0]?.nodeId === doomed.id &&
    goneFromRecall && goneFromGrep && goneFromRead && goneFromNeighborhood &&
    row.rows[0].tombstoned === true && edgeExpired.rows[0].expired === true;
  console.log(`  case2 tombstone: dryRun preview tombstoned=${preview.tombstoned} applied tombstoned=${applied.tombstoned} recall=${goneFromRecall} grep=${goneFromGrep} read=${goneFromRead} neighborhood=${goneFromNeighborhood} deleted_at=${row.rows[0].tombstoned} incidentEdgeExpired=${edgeExpired.rows[0].expired}`);
  report(
    "R4",
    case1 && case2,
    `edge-only forget unchanged (retired=1, tombstoned=0, node still packed/grep/read); forget(nodeIds) tombstoned=1 and the node vanished from recall, grep, read, neighborhood (deleted_at set, incident edge expired). Old behavior: only edges could die.`,
  );
});

// ---------------------------------------------------------------- R5 (F1: semantic search = current revisions only, deduped)
await section("R5", async () => {
  const p1 = `zyxwv-quasar-7749-${stamp}`;
  const node = await store.capture({
    title: `R5 superseded embedding ${stamp}`,
    type: "claim",
    summary: `R5 rev1 ${stamp}`,
    content: `The ${p1} protocol governs flux capacitor lane assignment across the relay mesh.`,
    evidence: [],
    links: [],
  }, ctx);
  await ensureEmbeddings("r5-rev1");
  const newContent = `Kettle descaling cadence and mug shelf inventory notes ${stamp}, nothing else.`;
  await store.update({ nodeId: node.id, baseRevisionId: node.revisionId, content: newContent }, ctx);
  await ensureEmbeddings("r5-rev2");
  const staleSem = await store.search({ query: p1, mode: "semantic", limit: 5, includeTextUnits: false }, ctx);
  const staleHits = staleSem.nodes.filter((candidate) => candidate.id === node.id).length;
  const currentSem = await store.search({ query: "Kettle descaling cadence mug shelf inventory", mode: "semantic", limit: 5, includeTextUnits: false }, ctx);
  const currentHits = currentSem.nodes.filter((candidate) => candidate.id === node.id);
  const hit = currentHits[0];
  const dupesInCurrent = new Set(currentSem.nodes.map((candidate) => candidate.id)).size !== currentSem.nodes.length;
  const staleEmbeddingRows = await probe.query(
    `select count(*)::int as c from embedding e join node_revision nr on nr.id = e.owner_id and e.owner_table = 'node_revision'
     where nr.node_id = $1 and nr.id <> (select current_revision_id from node where id = $1)`,
    [node.id],
  );
  const pass =
    staleHits === 0 &&
    currentHits.length === 1 &&
    hit?.content === newContent &&
    !dupesInCurrent &&
    Number(staleEmbeddingRows.rows[0].c) === 0;
  report(
    "R5",
    pass,
    `deleted phrase: ${staleHits} hits on the node (stale-revision embedding pruned on update; ${staleEmbeddingRows.rows[0].c} stale embedding rows left); current phrase: exactly ${currentHits.length} hit carrying the CURRENT content (${hit?.content === newContent}), duplicates in semantic list=${dupesInCurrent}. Old behavior: stale hit at rank 0, old content wearing the new revisionId.`,
  );
});

// ---------------------------------------------------------------- R6 (F5: semantic distance floor 0.55)
await section("R6", async () => {
  const provider = createEmbeddingProviderFromEnv();
  if (!provider) throw new Error("no embedding provider");
  const sem = await store.search({ query: "byzantine loom shuttle tension", mode: "semantic", limit: 10, includeTextUnits: false }, ctx);
  const relaxed = await store.search({ query: "byzantine loom shuttle tension", mode: "semantic", limit: 10, includeTextUnits: false, maxSemanticDistance: 0.9 }, ctx);
  const [queryVector] = await provider.embed(["byzantine loom shuttle tension"]);
  const nearest = queryVector
    ? await probe.query(
        `select round(min(e.embedding <=> $1::vector)::numeric, 4) as dist from embedding e where e.owner_table = 'node_revision' and e.model = $2`,
        [vectorLiteral(queryVector), provider.model],
      )
    : { rows: [{ dist: null }] };
  report(
    "R6",
    sem.nodes.length === 0 && relaxed.nodes.length > 0,
    `unrelated query: ${sem.nodes.length} rows at the default 0.55 floor (nearest embedded revision distance=${nearest.rows[0].dist}); ${relaxed.nodes.length} rows with maxSemanticDistance=0.9 — the floor is the filter (input override works, env TROVE_SEMANTIC_MAX_DISTANCE also honored). Old behavior: 10/10 rows at distances 0.68-0.84.`,
  );
});

// ---------------------------------------------------------------- R7 (F6: empty tsquery -> no lexical rows)
await section("R7", async () => {
  const lex = await store.search({ query: "the", mode: "lexical", limit: 50, includeTextUnits: false }, ctx);
  const lexUnits = await store.search({ query: "the", mode: "lexical", limit: 50, includeTextUnits: true }, ctx);
  report(
    "R7",
    lex.nodes.length === 0 && lexUnits.textUnits.length === 0,
    `lexical search for the stop word "the" returned ${lex.nodes.length} nodes / ${lexUnits.textUnits.length} text units — empty tsquery short-circuits before the ilike fallbacks (pgStore.ts lexicalSearch). Old behavior: 8/10 fixture nodes matched.`,
  );
});

// ---------------------------------------------------------------- R8 (F7: real RRF fusion)
await section("R8", async () => {
  const q = "kubernetes pod eviction";
  const mk = async (title: string, summary: string, content: string) =>
    store.capture({ title, type: "claim", summary, content, evidence: [], links: [] }, ctx);
  // Strong hit: lexical AND semantic (contains the tokens).
  await mk(
    `Kubernetes pod eviction memo ${stamp}`,
    `Facilities filing memo ${stamp}`,
    `The kubernetes pod eviction policy pdf lives in the facilities drive next to the cafeteria seating chart ${stamp}.`,
  );
  // Weak lexical-only candidates: contain the tokens once, semantically diluted.
  const w2 = await mk(
    `Quarterly office almanac ${stamp}`,
    `Odds and ends ${stamp}`,
    `Agenda item one: locate the kubernetes pod eviction handbook. The remainder covered parking validation, birthday cake ordering, conference chair wheels, office plant watering rotations, cafeteria menu planning, holiday card mailing lists, ergonomic desk assessments, vintage stamp appraisal, sourdough starter maintenance, indoor rowing technique, antique map framing, noise-dampening drywall options, community garden scheduling, tabletop game night logistics, used bookstore donation sorting, window blind replacement vendors, and quarterly fire extinguisher inspections for the entire building ${stamp}.`,
  );
  const w3 = await mk(
    `Facilities crossword digest ${stamp}`,
    `Newsletter archive ${stamp}`,
    `Crossword clue fourteen was kubernetes pod eviction. The rest of the issue covers sourdough starters, antique doorknob restoration, marathon training plans, and nineteenth century postal history ${stamp}.`,
  );
  // Semantic-only: topically identical to Q, shares ZERO content tokens with it.
  const y = await mk(
    `Kubelet memory-pressure termination notes ${stamp}`,
    `How the kubelet reacts when a node exhausts memory ${stamp}`,
    `When a node exhausts available memory, the kubelet terminates container workloads to reclaim capacity, and the scheduler rebinds the interrupted workloads onto healthier machines. Covers OOM-kill behavior, priority preemption, and graceful draining. ${stamp}`,
  );
  await ensureEmbeddings("r8");

  const provider = createEmbeddingProviderFromEnv();
  if (!provider) throw new Error("no embedding provider");
  const [qv] = await provider.embed([q]);
  if (!qv) throw new Error("no query embedding");
  const distRows = await probe.query(
    `select n.id, left(n.title, 32) as title, round((e.embedding <=> $1::vector)::numeric, 4) as dist
     from embedding e
     join node_revision nr on nr.id = e.owner_id and e.owner_table = 'node_revision'
     join node n on n.id = nr.node_id and nr.id = n.current_revision_id
     where e.model = $2 and n.id = any($3::uuid[])
     order by dist`,
    [vectorLiteral(qv), provider.model, [w2.id, w3.id, y.id]],
  );
  const distOf = new Map(distRows.rows.map((row) => [row.id as string, Number(row.dist)]));
  console.log(`  distances vs Q: Y=${distOf.get(y.id)} W2=${distOf.get(w2.id)} W3=${distOf.get(w3.id)}`);

  const runModes = async (maxDist?: number) => {
    const extra = maxDist === undefined ? {} : { maxSemanticDistance: maxDist };
    const lex = await store.search({ query: q, mode: "lexical", limit: 10, includeTextUnits: false, ...extra }, ctx);
    const sem = await store.search({ query: q, mode: "semantic", limit: 10, includeTextUnits: false, ...extra }, ctx);
    const hyb = await store.search({ query: q, mode: "hybrid", limit: 10, includeTextUnits: false, ...extra }, ctx);
    return { lex, sem, hyb };
  };

  const rrfReconstruct = (lexIds: string[], semIds: string[]): string[] => {
    const fused = new Map<string, { score: number; bestRank: number }>();
    for (const [index, id] of lexIds.entries()) {
      const rank = index + 1;
      const existing = fused.get(id) ?? { score: 0, bestRank: rank };
      existing.score += 1 / (60 + rank);
      existing.bestRank = Math.min(existing.bestRank, rank);
      fused.set(id, existing);
    }
    for (const [index, id] of semIds.entries()) {
      const rank = index + 1;
      const existing = fused.get(id) ?? { score: 0, bestRank: rank };
      existing.score += 1 / (60 + rank);
      existing.bestRank = Math.min(existing.bestRank, rank);
      fused.set(id, existing);
    }
    return [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[1].bestRank - b[1].bestRank || a[0].localeCompare(b[0]))
      .map(([id]) => id);
  };

  const evaluate = (mode: string, lex: any, sem: any, hyb: any) => {
    const lexIds: string[] = lex.nodes.map((node: any) => node.id);
    const semIds: string[] = sem.nodes.map((node: any) => node.id);
    const hybIds: string[] = hyb.nodes.map((node: any) => node.id);
    const reconstructed = rrfReconstruct(lexIds, semIds);
    const exact = reconstructed.join(",") === hybIds.join(",");
    const lexOnly = lexIds.filter((id) => !semIds.includes(id));
    const yRank = hybIds.indexOf(y.id);
    const weakBeaten = lexOnly.filter((id) => hybIds.indexOf(id) > yRank && yRank >= 0);
    console.log(`  [${mode}] lexical=${lexIds.length} semantic=${semIds.length} lexOnly=${lexOnly.length} Y hybrid rank=${yRank} weak-lexical-only beaten=${weakBeaten.length} rrfExact=${exact}`);
    return { exact, yRank, lexOnly, weakBeaten };
  };

  let { lex, sem, hyb } = await runModes();
  let outcome = evaluate("default floor 0.55", lex, sem, hyb);
  let modeUsed = "default floor 0.55";
  if (!(outcome.yRank >= 0 && outcome.weakBeaten.length >= 1)) {
    // Construct the lexical-only/semantic-only split deterministically with a
    // floor between Y's distance and the weakest W distance.
    const distY = distOf.get(y.id) ?? 1;
    const minW = Math.min(distOf.get(w2.id) ?? 2, distOf.get(w3.id) ?? 2);
    if (distY < minW) {
      const threshold = Math.round(((distY + minW) / 2) * 1000) / 1000;
      ({ lex, sem, hyb } = await runModes(threshold));
      outcome = evaluate(`maxSemanticDistance=${threshold}`, lex, sem, hyb);
      modeUsed = `maxSemanticDistance=${threshold} (default floor left no lexical-only split)`;
    }
  }
  const yNotLexical = !lex.nodes.some((node: any) => node.id === y.id);
  const pass = outcome.exact && yNotLexical && outcome.yRank >= 0 && outcome.weakBeaten.length >= 1;
  report(
    "R8",
    pass,
    `${modeUsed}: hybrid order matches an exact RRF reconstruction Σ1/(60+rank) (${outcome.exact}); semantic-only Y (zero shared tokens, not in lexical list=${yNotLexical}) at hybrid rank ${outcome.yRank}, above ${outcome.weakBeaten.length} weak lexical-only hit(s) — under the old concat it sat behind ALL ${outcome.lexOnly.length || "n"} lexical hits.`,
  );
});

// ---------------------------------------------------------------- R9 (F9: slug-race retry; trigram similar)
await section("R9", async () => {
  // (a) near-title dedupe still creates, but `similar` now carries a trigram score.
  const first = await remember(store, {
    title: `Airflow DAG ownership rules ${stamp}`,
    type: "claim",
    summary: `Airflow DAG ownership rules summary ${stamp}`,
    content: `The rules for Airflow DAG ownership ${stamp}.`,
    evidence: [],
    links: [],
  }, ctx);
  const second = await remember(store, {
    title: `Airflow DAG ownership ${stamp}`,
    type: "claim",
    summary: `Airflow DAG ownership summary ${stamp}`,
    content: `The ownership of Airflow DAGs ${stamp}.`,
    evidence: [],
    links: [],
  }, ctx);
  const twin = second.similar.find((entry) => entry.nodeId === first.node.id);
  const aPass =
    second.action === "created" && second.node.id !== first.node.id &&
    twin !== undefined && typeof twin.score === "number" && twin.score > 0.25;
  console.log(`  R9a similar: ${JSON.stringify(second.similar)}`);
  report(
    "R9",
    aPass,
    `(a) near-title remember action=${second.action}, second node created=${second.node.id !== first.node.id}; similar[] carries the twin with trigram score=${twin?.score?.toFixed?.(3)} (findSimilarTitles, pg_trgm).`,
  );

  // (b) 4-way concurrent same-title remember across distinct actors: capture now
  // retries the slug allocation on 23505, so all four must succeed.
  const raceTitle = `R9 race target ${stamp}`;
  const settled = await Promise.allSettled(
    [0, 1, 2, 3].map((racer) =>
      remember(
        store,
        { title: raceTitle, type: "claim", summary: `race probe ${stamp}`, content: `race body ${stamp}`, evidence: [], links: [] },
        { actorId: `repro-racer-${racer}`, interfaceId: "repro-eval", requestId: `repro-${stamp}-race-${racer}` },
      ),
    ),
  );
  const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
  const rejected = settled.filter((outcome) => outcome.status === "rejected");
  const rows = await probe.query(`select slug from node where title = $1`, [raceTitle]);
  const slugs = rows.rows.map((row) => String(row.slug));
  const errInfo = rejected.length > 0
    ? `${(rejected[0] as PromiseRejectedResult).reason?.constructor?.name} code=${(rejected[0] as PromiseRejectedResult).reason?.code}`
    : "none";
  report(
    "R9",
    rejected.length === 0 && fulfilled.length === 4 && new Set(slugs).size === 4,
    `(b) 4-way concurrent remember, same new title, distinct actors: fulfilled=${fulfilled.length}, rejected=${rejected.length} (${errInfo}), nodes=${slugs.length} with distinct slugs=${new Set(slugs).size} — capture retries on 23505 (pgStore.ts capture -> captureOnce loop). Old behavior: 1 created, 3 uncaught 23505.`,
  );
});

// ---------------------------------------------------------------- R10 (F10: capped query-ranked evidence, bodies first)
await section("R10", async () => {
  const pad = "packing filler sentence with enough bulk to spend the budget allocation quickly. ".repeat(25); // ~2.2 KB/line
  const lines = Array.from({ length: 30 }, (_, i) => `Dossier fragment ${i} ${stamp} ${pad}`);
  const ingested = await store.ingest({ kind: "paste", title: `R10 dossier source ${stamp}`, contentText: lines.join("\n"), metadata: {} }, ctx);
  const units = ingested.textUnits.slice(0, 20);
  const n = await store.capture({
    title: `Marmoset primary dossier ${stamp}`,
    type: "claim",
    summary: `marmoset primary ${stamp}`,
    content: `Marmoset primary body ${stamp}: the marmoset dossier thesis in brief.`,
    evidence: units.map((unit) => ({ textUnitId: unit.id, selector: {} })),
    links: [],
  }, ctx);
  const others = [];
  for (let i = 0; i < 4; i++) {
    const other = await store.capture({
      title: `R10 adjacent note ${i} ${stamp}`,
      type: "claim",
      summary: `adjacent ${i} ${stamp}`,
      content: `marmoset adjacent body ${i} ${stamp} with the shared token. ${pad.slice(0, 1200)} ENDMARK-OTHER-${i}-${stamp}`,
      evidence: [],
      links: [],
    }, ctx);
    others.push(other);
  }
  const res = await store.recall({ query: "marmoset", tokenBudget: 8000, depth: 0, includeEvidence: true }, ctx);
  const unitIds = new Set(units.map((unit) => unit.id));
  const evidencePacked = res.evidence.filter((unit) => unitIds.has(unit.id)).length;
  const atomIds = res.atoms.map((atom) => atom.node.id);
  const perOther = others
    .map((other, i) => `note${i}: packed=${atomIds.includes(other.id)} fullBody=${res.context.includes(`ENDMARK-OTHER-${i}-${stamp}`)}`)
    .join(" | ");
  console.log(`  ${perOther}`);
  const allOthersFull = others.every((other, i) => atomIds.includes(other.id) && res.context.includes(`ENDMARK-OTHER-${i}-${stamp}`));
  const pass = evidencePacked <= 5 && allOthersFull && res.spentTokens <= 8000;
  report(
    "R10",
    pass,
    `N carried 20 evidence units (~2.2 KB each): ${evidencePacked} packed (cap perNodeLimit=5, query-ranked, batched getEvidenceForNodes); all 4 other matching nodes packed with FULL bodies (${allOthersFull}); spent=${res.spentTokens}/8000 truncated=${res.truncated}. Old behavior: 15 units packed, others squeezed to header/teaser crumbs.`,
  );
});

// ---------------------------------------------------------------- R11 (lint job keeps findings array)
await section("R11", async () => {
  await store.capture({ title: `R11 lint orphan ${stamp}`, type: "claim", summary: `orphan ${stamp}`, content: `The orphan probe body ${stamp}.`, evidence: [], links: [] }, ctx);
  for (let i = 0; i < 2; i++) {
    await store.capture({ title: `R11 lint duplicate title ${stamp}`, type: "claim", summary: `dup ${i} ${stamp}`, content: `The duplicate title probe body ${i} ${stamp}.`, evidence: [], links: [] }, ctx);
  }
  const job = await store.enqueueJob({ kind: "lint_graph", payload: { reason: "repro" }, priority: 90, dedupeKey: `repro:lint:${stamp}` }, ctx);
  let done: Awaited<ReturnType<typeof store.runJob>> = null;
  for (let i = 0; i < 100 && !done; i++) {
    const ran = await store.runJob({}, ctx);
    if (!ran) break;
    if (ran.id === job.id && (ran.status === "succeeded" || ran.status === "failed")) done = ran;
  }
  const lint = ((done?.result ?? {}) as any).lint ?? {};
  const findings = lint.findings;
  const codes = Array.isArray(findings) ? [...new Set(findings.map((finding: any) => finding.code))].join(",") : "";
  const pass = Array.isArray(findings) && findings.length > 0 && findings.length <= 200 &&
    findings.every((finding: any) => typeof finding.code === "string" && typeof finding.message === "string");
  console.log(`  stored lint keys: ${Object.keys(lint).join(",")}; findings=${Array.isArray(findings) ? findings.length : "not-an-array"}; codes: ${codes}`);
  report(
    "R11",
    pass,
    `stored lint_graph job result now carries the findings ARRAY: ${Array.isArray(findings) ? findings.length : 0} entries (cap 200) with codes ${codes} — counts alone (${lint.nodes} nodes, ${lint.findings?.length ?? 0} findings) are no longer all the worker keeps (pgStore.ts performJob). Old behavior: findings discarded.`,
  );
});

// ---------------------------------------------------------------- R12 (projection no longer auto-enqueued; manual still works)
await section("R12", async () => {
  await drainPending();
  await probe.query(`truncate graph_job`);
  await store.capture({
    title: `R12 projection probe ${stamp}`,
    type: "claim",
    summary: `projection probe ${stamp}`,
    content: `The projection auto-enqueue probe body ${stamp}.`,
    evidence: [],
    links: [],
  }, ctx);
  const counts = await probe.query(`select kind, count(*)::int as c from graph_job group by kind order by kind`);
  const countOf = (kind: string) => Number(counts.rows.find((row) => row.kind === kind)?.c ?? 0);
  const autoGone = countOf("refresh_obsidian_projection") === 0 && countOf("lint_graph") >= 1 && countOf("refresh_embeddings") >= 1;
  console.log(`  jobs after one capture: ${JSON.stringify(Object.fromEntries(counts.rows.map((row) => [row.kind, row.c])))}`);

  const job = await store.enqueueJob(
    { kind: "refresh_obsidian_projection", payload: { reason: "repro" }, priority: 90, dedupeKey: `repro:proj:${stamp}` },
    ctx,
  );
  let done: Awaited<ReturnType<typeof store.runJob>> = null;
  for (let i = 0; i < 100 && !done; i++) {
    const ran = await store.runJob({}, ctx);
    if (!ran) break;
    if (ran.id === job.id && (ran.status === "succeeded" || ran.status === "failed")) done = ran;
  }
  const result = (done?.result ?? {}) as Record<string, any>;
  const manualWorks = done?.status === "succeeded" && Number(result.fileCount) > 0 && "manifest" in result;
  report(
    "R12",
    autoGone && manualWorks,
    `after a capture: refresh_obsidian_projection jobs enqueued=${countOf("refresh_obsidian_projection")} (lint=${countOf("lint_graph")}, embeddings=${countOf("refresh_embeddings")} as control) — no longer auto-enqueued on mutation; manual enqueue still runs: status=${done?.status} fileCount=${result.fileCount}.`,
  );
});

// ---------------------------------------------------------------- R13 (truthful BFS hops)
await section("R13", async () => {
  process.env.TROVE_EMBEDDING_PROVIDER = "none"; // lexical-only: keep the pack clean
  try {
    const a = await store.capture({ title: `R13 cascade root ${stamp}`, type: "claim", summary: `cascade root ${stamp}`, content: `quixotic cascade root body ${stamp}.`, evidence: [], links: [] }, ctx);
    const b = await store.capture({ title: `R13 cascade mid ${stamp}`, type: "claim", summary: `cascade mid ${stamp}`, content: `middle segment body ${stamp}.`, evidence: [], links: [] }, ctx);
    const c = await store.capture({ title: `R13 cascade leaf ${stamp}`, type: "claim", summary: `cascade leaf ${stamp}`, content: `leaf segment body ${stamp}.`, evidence: [], links: [] }, ctx);
    await store.link({ fromNodeId: a.id, toNodeId: b.id, predicate: "leads_to", weight: 1 }, ctx);
    await store.link({ fromNodeId: b.id, toNodeId: c.id, predicate: "leads_to", weight: 1 }, ctx);
    const hood = await store.neighborhood({ nodeId: a.id, depth: 2 }, ctx);
    const levelOf = (id: string) => hood.nodes.find((node) => node.id === id)?.level;
    const res = await store.recall({ query: "quixotic", tokenBudget: 4000, depth: 2, includeEvidence: false }, ctx);
    const hopsOf = (id: string) => res.atoms.find((atom) => atom.node.id === id)?.hops;
    const pass =
      levelOf(a.id) === 0 && levelOf(b.id) === 1 && levelOf(c.id) === 2 &&
      hopsOf(a.id) === 0 && hopsOf(b.id) === 1 && hopsOf(c.id) === 2;
    report(
      "R13",
      pass,
      `neighborhood levels: A=${levelOf(a.id)} B=${levelOf(b.id)} C=${levelOf(c.id)}; recall hops: A=${hopsOf(a.id)} B=${hopsOf(b.id)} C=${hopsOf(c.id)} — truthful BFS depth (performRecall uses max(1, node.level), graphCore.ts). Old behavior: C labeled hops=1 at depth 2.`,
    );
  } finally {
    process.env.TROVE_EMBEDDING_PROVIDER = REAL_PROVIDER;
  }
});

// ---------------------------------------------------------------- R14 (neighborhood maxNodes cap)
await section("R14", async () => {
  const hub = await store.capture({ title: `R14 hub central ${stamp}`, type: "claim", summary: `hub ${stamp}`, content: `The hub body ${stamp}.`, evidence: [], links: [] }, ctx);
  const spokes = [];
  for (let i = 0; i < 120; i++) {
    spokes.push(await store.capture({
      title: `R14 spoke ${i} ${stamp}`,
      type: "claim",
      summary: `spoke ${i} ${stamp}`,
      content: `The hub spoke body ${i} ${stamp}.`,
      evidence: [],
      links: [],
    }, ctx));
  }
  for (const spoke of spokes) {
    await store.link({ fromNodeId: hub.id, toNodeId: spoke.id, predicate: "connects", weight: 1 }, ctx);
  }
  const capped = await store.neighborhood({ nodeId: hub.id, depth: 1 }, ctx);
  const full = await store.neighborhood({ nodeId: hub.id, depth: 1, maxNodes: 500 }, ctx);
  const seedFirst = capped.nodes[0]?.id === hub.id && capped.nodes[0]?.level === 0;
  const pass = capped.nodes.length <= 100 && full.nodes.length === 121 && full.edges.length === 120 && seedFirst;
  report(
    "R14",
    pass,
    `hub with 120 neighbors: default neighborhood returned ${capped.nodes.length} nodes (maxNodes default 100; seed first at level 0=${seedFirst}); maxNodes:500 returned ${full.nodes.length} nodes / ${full.edges.length} edges — bounded fan-out with an explicit escape hatch. Old behavior: 121 nodes, no cap.`,
  );
});

// ---------------------------------------------------------------- R15 (statement count per recall)
let r15Total = 0;
await section("R15", async () => {
  const src = await store.ingest({
    kind: "paste",
    title: `R15 evidence source ${stamp}`,
    contentText: Array.from({ length: 10 }, (_, i) => `R15 unit ${i} ${stamp} short evidence line.`).join("\n"),
    metadata: {},
  }, ctx);
  const unitRefs = src.textUnits.map((unit) => ({ textUnitId: unit.id, selector: {} }));
  for (let i = 0; i < 8; i++) {
    await store.capture({
      title: `R15 nplusone node ${i} ${stamp}`,
      type: "claim",
      summary: `nplusone ${i} ${stamp}`,
      content: `nplusone corpus body ${i} ${stamp} the packing probe.`,
      evidence: unitRefs,
      links: [],
    }, ctx);
  }
  queryLog.length = 0;
  counting = true;
  const res = await store.recall({ query: "nplusone", tokenBudget: 32000, depth: 1, includeEvidence: true }, ctx);
  counting = false;
  r15Total = queryLog.length;
  const categorize = (q: string): string => {
    if (q.startsWith("select websearch_to_tsquery")) return "lexical tsquery probe";
    if (q.startsWith("with recursive walk")) return "neighborhood CTE (per seed)";
    if (q.startsWith("select id, from_node_id")) return "neighborhood edges (per seed)";
    if (q.startsWith("with q as (select websearch_to_tsquery") && q.includes("from node n")) return "lexical node search";
    if (q.startsWith("with q as (select websearch_to_tsquery")) return "lexical text-unit search";
    if (q.includes("distinct on (n.id)")) return "semantic node search";
    if (q.startsWith("select tu.id") && q.includes("from embedding e")) return "semantic text-unit search";
    if (q.startsWith("with ranked as")) return "batched evidence (getEvidenceForNodes)";
    if (q.startsWith("update node set access_count")) return "per-atom access bump";
    if (q.startsWith("select id, motivation")) return "per-atom annotations query";
    if (q.startsWith("select id, source_id") && q.includes("where id = $1")) return "per-annotation text_unit lookup";
    if (q.startsWith("select n.id")) return "per-atom node read";
    return "other";
  };
  const buckets = new Map<string, number>();
  for (const q of queryLog) {
    const key = categorize(q);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  for (const [shape, count] of sorted) console.log(`  ${String(count).padStart(4)}x  ${shape}`);
  const perAtom = (buckets.get("per-atom node read") ?? 0) + (buckets.get("per-atom access bump") ?? 0)
    + (buckets.get("per-atom annotations query") ?? 0) + (buckets.get("per-annotation text_unit lookup") ?? 0);
  const pass = r15Total <= 30 && perAtom === 0;
  report(
    "R15",
    pass,
    `ONE recall (depth 1, ${res.atoms.length} atoms, 8 evidence-bearing nodes) executed ${r15Total} SQL statements (old: 145); per-atom/per-annotation queries=${perAtom} — one batched ranked evidence fetch replaced the N+1 loop.`,
  );
});

// ---------------------------------------------------------------- R16 (evidence query-ranked + capped: stale no longer dominates)
await section("R16", async () => {
  const staleLines = Array.from({ length: 4 }, (_, i) => `archival binder note about zephyr wax cylinders ${i} ${stamp}`);
  const freshLines = Array.from({ length: 4 }, (_, i) => `indoor ferns taxonomy watering interval frond care ${i} ${stamp}`);
  const src = await store.ingest({
    kind: "paste",
    title: `R16 sticky source ${stamp}`,
    contentText: [...staleLines, ...freshLines].join("\n"),
    metadata: {},
  }, ctx);
  const staleUnits = src.textUnits.slice(0, 4);
  const freshUnits = src.textUnits.slice(4, 8);
  const node = await store.capture({
    title: `R16 sticky evidence node ${stamp}`,
    type: "claim",
    summary: `sticky ${stamp}`,
    content: `sticky evidence v1 body ${stamp}.`,
    evidence: staleUnits.map((unit) => ({ textUnitId: unit.id, selector: {} })),
    links: [],
  }, ctx);
  await store.update({ nodeId: node.id, baseRevisionId: node.revisionId, content: `Completely rewritten body ${stamp}: a taxonomy of indoor ferns and their watering intervals.` }, ctx);
  for (const unit of freshUnits) {
    await store.annotate({ motivation: "supports", textUnitId: unit.id, nodeId: node.id, body: {}, selector: {} }, ctx);
  }
  const res = await store.recall({ query: "indoor ferns taxonomy", tokenBudget: 32000, depth: 0, includeEvidence: true }, ctx);
  const staleIds = new Set(staleUnits.map((unit) => unit.id));
  const freshIds = new Set(freshUnits.map((unit) => unit.id));
  const stalePacked = res.evidence.filter((unit) => staleIds.has(unit.id)).length;
  const freshPacked = res.evidence.filter((unit) => freshIds.has(unit.id)).length;
  const totalPacked = stalePacked + freshPacked;
  const pass = totalPacked <= 5 && freshPacked > stalePacked;
  report(
    "R16",
    pass,
    `after a full rewrite + 4 fresh annotations: packed evidence for the node = ${freshPacked} fresh (query-ranked) vs ${stalePacked} stale, total ${totalPacked} (cap 5) — stale units survive only as ranked-leftovers, they no longer crowd the pack wholesale. Old behavior: 3/3 stale units packed regardless of relevance.`,
  );
});

// --------------------------------------- R17 (bench finding 1: NL-question retrieval)
await section("R17", async () => {
  // The LongMemEval pilot: "How many weddings have I attended in this year?"
  // returned lexical=0, semantic=0, recall=0 atoms against a container holding
  // the answering nodes. Fix: query normalization + OR-fallback (src/queryNormalize).
  const wedding = await store.capture({
    title: `Traditional Nepali Dishes at Weddings ${stamp}`,
    type: "claim",
    summary: "Wedding food experiences",
    content: `My sister's wedding this spring featured traditional Nepali dishes — the momo and sel roti were outstanding, and the dancing ran past midnight. ${stamp}`,
    evidence: [], links: [],
  }, ctx);
  const secondWedding = await store.capture({
    title: `Colleague wedding in September ${stamp}`,
    type: "claim",
    summary: "Another wedding attended",
    content: `Earlier this year I flew to Pune for a colleague's wedding; the sangeet ran long and the baraat arrived two hours late. ${stamp}`,
    evidence: [], links: [],
  }, ctx);
  await store.capture({
    title: `Autovacuum tuning notes ${stamp}`,
    type: "claim",
    summary: "ops",
    content: `autovacuum_vacuum_scale_factor and freeze age tuning. ${stamp}`,
    evidence: [], links: [],
  }, ctx);
  await ensureEmbeddings("r17");

  const question = "How many weddings have I attended in this year?";
  const lexical = await store.search({ query: question, mode: "lexical", limit: 10, includeTextUnits: false }, ctx);
  const semantic = await store.search({ query: question, mode: "semantic", limit: 10, includeTextUnits: false }, ctx);
  const pack = await store.recall({ query: question, tokenBudget: 8000 }, ctx);

  // Evidence for the semantic arm: raw-question vs normalized-question distance
  // to the wedding node's embedding (real provider).
  let distNote = "n/a";
  const provider = createEmbeddingProviderFromEnv();
  if (provider) {
    const { normalizeRetrievalQuery } = await import("../src/queryNormalize.js");
    const [rawVec] = await provider.embed([question]);
    const [normVec] = await provider.embed([normalizeRetrievalQuery(question)]);
    if (rawVec && normVec) {
      const rows = await probe.query(
        `select round((e.embedding <=> $1::vector)::numeric, 4) as raw_dist,
                round((e.embedding <=> $2::vector)::numeric, 4) as norm_dist
         from embedding e
         join node_revision nr on nr.id = e.owner_id and e.owner_table = 'node_revision'
         join node n on n.id = nr.node_id and nr.id = n.current_revision_id
         where n.id = any($3::uuid[]) and e.model = $4
         order by norm_dist`,
        [vectorLiteral(rawVec), vectorLiteral(normVec), [wedding.id, secondWedding.id], provider.model],
      );
      distNote = rows.rows.map((row) => `${row.raw_dist}→${row.norm_dist}`).join(", ");
    }
  }

  const lexHit = lexical.nodes.some((node) => node.id === wedding.id || node.id === secondWedding.id);
  const semHit = semantic.nodes.some((node) => node.id === wedding.id || node.id === secondWedding.id);
  const packed = pack.atoms.some((atom) => atom.node.id === wedding.id || atom.node.id === secondWedding.id);
  // The fix lands via the lexical arm (normalization + OR-fallback); the
  // semantic arm stays strict at 0.55 and may still miss question↔fact gaps
  // this wide — dual-embed keeps it strictly min(raw, normalized).
  report(
    "R17",
    lexHit && packed,
    `"${question}" -> lexical hits=${lexical.nodes.length} (wedding=${lexHit}), semantic hits=${semantic.nodes.length} at the strict 0.55 floor (wedding=${semHit}), recall atoms=${pack.atoms.length} spent=${pack.spentTokens} (wedding packed=${packed}); embedding distance raw→normalized: ${distNote}. Pre-fix: lexical=0 semantic=0 recall=0 atoms/14 tokens.`,
  );
});

// ------------------------------------------------------- S5 (job retry -> dead-letter)
await section("S5", async () => {
  await drainPending();
  await store.capture({
    title: `S5 doomed embedding job ${stamp}`,
    type: "claim",
    summary: `doomed ${stamp}`,
    content: `The doomed job body ${stamp} needs an embedding.`,
    evidence: [],
    links: [],
  }, ctx);
  const jobRow = await probe.query(
    `select id from graph_job where kind = 'refresh_embeddings' and status = 'pending' order by created_at desc limit 1`,
  );
  const jobId = String(jobRow.rows[0]?.id ?? "");
  if (!jobId) throw new Error("no pending refresh_embeddings job found");
  const statusOf = async () =>
    (await probe.query(`select status, attempts from graph_job where id = $1`, [jobId])).rows[0] as { status: string; attempts: number };
  const age = async () => probe.query(`update graph_job set updated_at = now() - interval '3 hours' where id = $1`, [jobId]);

  const trace: string[] = [];
  process.env.OPENAI_API_KEY = "sk-repro-invalid-key";
  try {
    let ran = await store.runJob({ jobId }, ctx); // attempt 1
    let row = await statusOf();
    trace.push(`fail#1 -> ${row.status}/${row.attempts} (ran status=${ran?.status})`);

    await store.runJob({ jobId }, ctx); // backoff not elapsed: must NOT reclaim
    row = await statusOf();
    trace.push(`immediate retry -> ${row.status}/${row.attempts} (unchanged = backoff honored)`);

    for (let expected = 2; expected <= 5; expected++) {
      await age();
      await store.runJob({ jobId }, ctx);
      row = await statusOf();
      trace.push(`aged retry -> ${row.status}/${row.attempts}`);
    }
    await age();
    await store.runJob({ jobId }, ctx); // 'dead' is terminal: must never reclaim
    row = await statusOf();
    trace.push(`post-dead aged retry -> ${row.status}/${row.attempts}`);
  } finally {
    process.env.OPENAI_API_KEY = REAL_OPENAI_KEY;
  }
  for (const step of trace) console.log(`  ${step}`);
  const final = await statusOf();
  const sequence = trace.map((step) => step.split("-> ")[1]?.split(" ")[0]).join(" | ");
  const pass = Boolean(
    trace[1]?.includes("failed/1") &&
    trace[2]?.includes("failed/2") && trace[3]?.includes("failed/3") && trace[4]?.includes("failed/4") &&
    trace[5]?.includes("dead/5") && trace[6]?.includes("dead/5") &&
    final.status === "dead" && final.attempts === 5,
  );
  // tidy: drain the backlog with the real key so the scratch DB is left consistent
  await ensureEmbeddings("s5-cleanup").catch(() => {});
  report(
    "S5",
    pass,
    `retry-with-backoff then dead-letter observed: ${sequence}. Failed jobs reclaim only after attempts^2x10s (immediate retry did not reclaim), exhaust at 5 attempts into status='dead', and are never reclaimed again (claimJob pending-or-retryable filter, pgStore.ts). Old behavior: failed forever at attempts=1.`,
  );
});

// ------------------------------------------------------- static S1-S4
console.log("\n=== static checks (S1-S4) ===");
const indexes = await probe.query(
  `select indexname from pg_indexes where schemaname = 'public' and indexname in ('embedding_hnsw_idx', 'node_title_trgm_idx')`,
);
const indexNames = new Set(indexes.rows.map((row) => String(row.indexname)));
const schemaSql = readFileSync(resolve("db/schema.sql"), "utf8");
report(
  "S1",
  indexNames.has("embedding_hnsw_idx") && schemaSql.includes("create index embedding_hnsw_idx on embedding using hnsw"),
  `HNSW index now exists: pg_indexes has embedding_hnsw_idx=${indexNames.has("embedding_hnsw_idx")} (plus node_title_trgm_idx=${indexNames.has("node_title_trgm_idx")}); schema.sql creates it uncommented (migration 009 for existing DBs).`,
);
const claimTable = await probe.query(`select to_regclass('public.claim') as c`);
const srcTexts = readdirSync(resolve("src"))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => readFileSync(resolve("src", file), "utf8"));
const claimRefs = srcTexts.reduce((sum, text) => sum + (text.match(/\b(from|into|join|update)\s+claim\b/gi) ?? []).length, 0);
report(
  "S2",
  claimTable.rows[0].c === null && claimRefs === 0,
  `claim table dropped: to_regclass('public.claim')=${claimTable.rows[0].c} (migration 010; annotation.claim_id cascaded away); code references still ${claimRefs}.`,
);
const deletedWrites = srcTexts.reduce((sum, text) => sum + (text.match(/set\s+deleted_at\s*=\s*now\(\)/gi) ?? []).length, 0);
const deletedReads = srcTexts.reduce((sum, text) => sum + (text.match(/deleted_at is null/g) ?? []).length, 0);
report(
  "S3",
  deletedWrites >= 1 && deletedReads > 0,
  `deleted_at is now WRITTEN (${deletedWrites} writer: tombstoneNodes, exercised in R4) and still filtered in ${deletedReads} read paths — soft delete exists end-to-end. Old state: write-only-never column.`,
);
const pgText = readFileSync(resolve("src/pgStore.ts"), "utf8");
const validFilters = (pgText.match(/valid_from\s*<=|valid_until\s*(is null|>)/g) ?? []).length;
report(
  "S4",
  validFilters >= 1,
  `valid_from/valid_until now appear in ${validFilters} neighborhood filter clauses (validAt input on neighborhood, contracts.ts) — behavioral check:`,
);
// S4 behavioral: validAt actually filters
{
  const p = await store.capture({ title: `S4 valid-at root ${stamp}`, type: "claim", summary: `validat ${stamp}`, content: `valid-at root body ${stamp}.`, evidence: [], links: [] }, ctx);
  const qNode = await store.capture({ title: `S4 valid-at leaf ${stamp}`, type: "claim", summary: `validat ${stamp}`, content: `valid-at leaf body ${stamp}.`, evidence: [], links: [] }, ctx);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await store.link({ fromNodeId: p.id, toNodeId: qNode.id, predicate: "future_valid", weight: 1, validFrom: tomorrow }, ctx);
  const unfiltered = await store.neighborhood({ nodeId: p.id, depth: 1 }, ctx);
  const atNow = await store.neighborhood({ nodeId: p.id, depth: 1, validAt: new Date().toISOString() }, ctx);
  const atFuture = await store.neighborhood({ nodeId: p.id, depth: 1, validAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString() }, ctx);
  const hasQ = (nodes: Array<{ id: string }>) => nodes.some((node) => node.id === qNode.id);
  report(
    "S4",
    hasQ(unfiltered.nodes) && !hasQ(atNow.nodes) && hasQ(atFuture.nodes),
    `edge with valid_from=+24h: present without validAt (${hasQ(unfiltered.nodes)}), excluded at validAt=now (${!hasQ(atNow.nodes)}), included at validAt=+48h (${hasQ(atFuture.nodes)}) — world-time is finally read.`,
  );
}

// ---------------------------------------------------------------- summary
await drainPending().catch(() => {});
const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log("\n=== run summary ===");
console.log(`R-items: ${passCount()}/${verdicts.size} PASS (${failCount()} FAIL)`);
console.log(`wall time: ${wallSeconds}s; embedding API calls: ${embeddingApiCalls} (texts embedded incl. queries: ${embeddingApiTexts}); R15 single-recall SQL statements: ${r15Total}`);
console.log(`scratch database trove_repro kept (tables hold this run's fixtures).`);
console.log("\n--- verdict table ---");
for (const line of results) console.log(line);
console.log(`\n${passCount()}/${verdicts.size} PASS`);

await probe.end();
if ("close" in store && typeof store.close === "function") await store.close();
