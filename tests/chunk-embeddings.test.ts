import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { remember } from "../src/agentOps.js";
import {
  CHUNK_TARGET_CHARS,
  buildTextChunks,
  chunkContextPrefix,
  chunkEmbeddingInput,
  isEmbeddableUnitText,
  splitTextUnits,
} from "../src/graphCore.js";
import { suiteStore, closeStore, hasPostgres, isolateDatabase } from "./helpers.js";

/**
 * Contextual chunk embeddings (R2).
 *
 * One vector per LINE was 98% of production's vector bytes and the direct cause
 * of the disk-full outage; a line is also too small to carry retrievable
 * meaning. The fix moves the vector index to a coarser grain — a contiguous run
 * of text units within one section, embedded with a written context prefix —
 * while leaving the CITATION grain exactly where it was. So these tests check
 * two things at once: that the chunking is what it claims to be, and that
 * nothing downstream of it can tell the difference except by counting vectors.
 */

process.env.TROVE_EMBEDDING_PROVIDER = "fake";
delete process.env.TROVE_SEMANTIC_MAX_DISTANCE;
await isolateDatabase("chunk_embeddings");
const { store, driver, context, stamp } = suiteStore("chunk-embeddings");

const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";

/** Run this suite's own maintenance jobs — on pg, this is what writes vectors. */
async function drainJobs(limit = 50): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const pending = (await store.jobs({ status: "pending", limit: 100 }))
      .filter((job) => job.dedupeKey?.startsWith("maintenance:"));
    const next = pending[0];
    if (!next) break;
    await store.runJob({ jobId: next.id });
  }
}

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

after(async () => {
  await drainJobs();
  await closeStore(store);
});

describe("buildTextChunks", () => {
  it("never lets a chunk straddle a section boundary", () => {
    const markdown = [
      "# Deployment",
      "The container boots, applies migrations, then starts the server process.",
      "Railway keeps the previous instance alive until the healthcheck passes.",
      "## Rollback",
      "A rollback redeploys the previous image and leaves the database untouched.",
    ].join("\n");
    const units = splitTextUnits(SOURCE_ID, markdown);
    const chunks = buildTextChunks(SOURCE_ID, "Deployment notes", units);

    assert.equal(chunks.length, 2, `expected one chunk per section, got ${chunks.length}`);
    for (const chunk of chunks) {
      const covered = units.filter((unit) => unit.ordinal >= chunk.firstOrdinal && unit.ordinal <= chunk.lastOrdinal);
      const sections = new Set(covered.map((unit) => unit.sectionPath.join(" ")));
      assert.equal(sections.size, 1, `chunk ${chunk.ordinal} covers ${sections.size} sections`);
    }
    assert.deepEqual(chunks[0]?.sectionPath, ["Deployment"]);
    assert.deepEqual(chunks[1]?.sectionPath, ["Deployment", "Rollback"]);
    // A section's heading opens its own chunk, which is what makes the chunk
    // text self-describing even before the prefix is added.
    assert.ok(chunks[1]?.text.startsWith("## Rollback"), "the heading must open its section's chunk");
  });

  it("closes a chunk before it passes CHUNK_TARGET_CHARS, and never splits a unit", () => {
    const line = "x".repeat(300);
    const markdown = Array.from({ length: 12 }, (_, index) => `${line} ${index}`).join("\n");
    const units = splitTextUnits(SOURCE_ID, markdown);
    const chunks = buildTextChunks(SOURCE_ID, "Long flat source", units);

    assert.ok(chunks.length > 1, "a source far past the target must produce several chunks");
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.length <= CHUNK_TARGET_CHARS,
        `chunk ${chunk.ordinal} is ${chunk.text.length} chars, past the ${CHUNK_TARGET_CHARS} target`,
      );
    }
    // Contiguous and complete: every unit lands in exactly one chunk, in order.
    const covered = chunks.flatMap((chunk) =>
      Array.from({ length: chunk.lastOrdinal - chunk.firstOrdinal + 1 }, (_, i) => chunk.firstOrdinal + i));
    assert.deepEqual(covered, units.map((unit) => unit.ordinal), "chunks must tile the source exactly once");

    // A single unit longer than the target is its own chunk rather than split:
    // the unit is the citation grain and must stay whole.
    const huge = splitTextUnits(SOURCE_ID, "y".repeat(CHUNK_TARGET_CHARS * 3));
    const hugeChunks = buildTextChunks(SOURCE_ID, "Giant line", huge);
    assert.equal(hugeChunks.length, 1);
    assert.equal(hugeChunks[0]?.text.length, CHUNK_TARGET_CHARS * 3);
  });

  it("embeds a written context prefix, and hashes what it embeds", () => {
    const units = splitTextUnits(SOURCE_ID, "## Retention\nTerminal job rows are pruned after fourteen days.");
    const [chunk] = buildTextChunks(SOURCE_ID, "Worker design", units);
    assert.ok(chunk);
    assert.equal(chunk.contextPrefix, chunkContextPrefix("Worker design", ["Retention"]));
    assert.match(chunk.contextPrefix, /Worker design/);
    assert.match(chunk.contextPrefix, /Retention/);
    // The prefix is embedded WITH the text and hashed WITH it, so retitling a
    // source re-embeds through the same content_sha256 check the refresh job
    // already uses — but the prefix is never part of the citation.
    assert.ok(chunkEmbeddingInput(chunk).startsWith(chunk.contextPrefix));
    assert.ok(chunkEmbeddingInput(chunk).endsWith(chunk.text));
    const [retitled] = buildTextChunks(SOURCE_ID, "Worker design v2", units);
    assert.notEqual(retitled?.contentSha256, chunk.contentSha256, "a changed prefix must change the hash");
  });

  it("drops a run with nothing embeddable in it, and keeps junk lines inside a real one", () => {
    const junk = buildTextChunks(SOURCE_ID, "Rules only", splitTextUnits(SOURCE_ID, "---\n***\n___"));
    assert.deepEqual(junk, [], "a run of horizontal rules is not worth a vector");

    const mixed = splitTextUnits(SOURCE_ID, "A sentence with enough substance to embed.\n---\nAnother real sentence here.");
    const [chunk] = buildTextChunks(SOURCE_ID, "Mixed", mixed);
    assert.ok(chunk);
    assert.equal(chunk.firstOrdinal, 0);
    assert.equal(chunk.lastOrdinal, 2, "the rule rides inside the chunk so the ordinal range stays contiguous");
    assert.equal(isEmbeddableUnitText("---"), false);
    assert.equal(isEmbeddableUnitText("A sentence with enough substance to embed."), true);
  });
});

describe("semantic search over chunks", () => {
  const marker = `chunkprobe${stamp}`;
  let sourceId = "";
  let unitIds: string[] = [];

  before(async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Chunk grain fixture ${stamp}`,
      contentText: [
        `# Ledger ${marker}`,
        "Quorum ledger reconciliation runs on a nightly cadence and writes a settlement digest.",
        "Every settlement digest is signed by the reconciliation quorum before it is published.",
        `## Kitchen ${marker}`,
        "Sourdough starters need feeding twice a day in a warm kitchen or they go flat.",
        "A cold kitchen slows fermentation and the loaf never rises properly overnight.",
      ].join("\n"),
      metadata: { smoke: true },
    }, context);
    sourceId = ingested.source.id;
    unitIds = ingested.textUnits.map((unit) => unit.id);
    await drainJobs();
  });

  it("resolves a chunk hit back to exactly the text units that chunk covers", async () => {
    const result = await store.search({
      query: "quorum ledger reconciliation settlement digest",
      includeTextUnits: true,
      mode: "semantic",
      limit: 10,
    }, context);

    const hits = result.textUnits.filter((unit) => unit.sourceId === sourceId);
    assert.ok(hits.length > 0, "the ledger chunk should have matched");
    // The hits are text units — same ids, same shape, same source — not chunks.
    for (const hit of hits) {
      assert.ok(unitIds.includes(hit.id), `${hit.id} is not one of the ingested text units`);
      assert.equal(typeof hit.ordinal, "number");
      assert.equal(typeof hit.charStart, "number");
      assert.equal(typeof hit.contentSha256, "string");
    }
    // And they are the ledger section's units, not the kitchen section's: the
    // chunk boundary is what keeps an unrelated paragraph out of the answer.
    const texts = hits.map((unit) => unit.text).join("\n");
    assert.match(texts, /reconciliation quorum/);
    assert.doesNotMatch(texts, /[Ss]ourdough/, "the kitchen chunk leaked into a ledger query");
    // A hit expands to its whole chunk, so more than one unit comes back for a
    // multi-line section — that is the point of the coarser grain.
    assert.ok(hits.length >= 2, `expected a chunk's worth of units, got ${hits.length}`);
  });

  it("marks every served unit in the session log, unchanged in shape", async () => {
    const result = await store.search({
      query: "sourdough starter fermentation kitchen",
      includeTextUnits: true,
      mode: "semantic",
      limit: 10,
      // The deterministic provider averages token vectors, so a chunk's
      // absolute distance is diluted by its own length; ordering is what
      // matters here, and the fixture is filtered to this source anyway.
      maxSemanticDistance: 1.0,
    }, context);
    const hits = result.textUnits.filter((unit) => unit.sourceId === sourceId);
    assert.ok(hits.length > 0, "the kitchen chunk should have matched");
    for (const hit of hits) {
      assert.equal(
        await store.textUnitWasServed({ textUnitId: hit.id }, context),
        true,
        `unit ${hit.id} came back from search but was not logged as served`,
      );
    }
  });

  it("a citation to a chunk-served unit still resolves, quote and all", async () => {
    const search = await store.search({
      query: "quorum ledger reconciliation settlement digest",
      includeTextUnits: true,
      mode: "semantic",
      limit: 10,
    }, context);
    const hit = search.textUnits.find((unit) => unit.sourceId === sourceId && /reconciliation quorum/.test(unit.text));
    assert.ok(hit, "fixture: expected the signed-digest line among the hits");

    const remembered = await remember(store, {
      title: `Chunk citation ${stamp}`,
      type: "claim",
      summary: "The settlement digest is signed by the reconciliation quorum.",
      content: "Recorded from the ledger fixture to prove a chunk-served unit is still citable.",
      evidence: [{ quote: "signed by the reconciliation quorum" }],
      links: [],
    }, context);
    assert.equal(remembered.evidenceRejected, undefined, `the quote must resolve: ${JSON.stringify(remembered.evidenceRejected)}`);
    assert.equal(remembered.evidenceUnserved, undefined, "search served this unit, so it must not be flagged unserved");
    const node = remembered.node;

    const read = await store.read({ nodeId: node.id }, context, { trackAccess: false });
    const annotations = read?.annotations ?? [];
    assert.equal(annotations.length, 1, "the quote citation did not resolve to one annotation");
    assert.equal(annotations[0]?.textUnitId, hit.id, "the citation resolved to a different unit than search served");
    assert.equal(annotations[0]?.sourceId, hit.sourceId, "the citation lost its source anchor");
    assert.equal(annotations[0]?.selector.type, "TextQuoteSelector", "the W3C selector shape changed");

    const recalled = await store.recall({
      query: `settlement digest ${marker}`,
      tokenBudget: 4000,
      includeEvidence: true,
    }, context);
    const citation = recalled.citations.find((entry) => entry.textUnitId === hit.id);
    assert.ok(citation, "the recall pack lost the citation to the chunk-served unit");
    assert.equal(typeof citation.nodeId, "string");
    assert.ok(recalled.evidence.some((unit) => unit.id === hit.id), "the recall pack lost the evidence unit");
  });
});

describe("vector count on a realistic source", { skip: !hasPostgres() }, () => {
  it("indexes one vector per chunk instead of one per line", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      `Paragraph ${index} of the density fixture describes how the reconciliation worker leases a job, heartbeats it, and releases the lease on completion.`);
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Vector density fixture ${stamp}`,
      contentText: [`# Density ${stamp}`, ...paragraphs].join("\n"),
      metadata: { smoke: true },
    }, context);
    await drainJobs();

    const embeddableUnits = ingested.textUnits.filter((unit) => isEmbeddableUnitText(unit.text)).length;
    const counts = await withClient(async (client) => {
      const chunks = await client.query(
        "select count(*)::int as c from text_chunk where source_id = $1",
        [ingested.source.id],
      );
      const chunkVectors = await client.query(
        `select count(*)::int as c
         from embedding e
         join text_chunk tc on tc.id = e.owner_id
         where e.owner_table = 'text_chunk' and tc.source_id = $1`,
        [ingested.source.id],
      );
      const unitVectors = await client.query(
        `select count(*)::int as c
         from embedding e
         join text_unit tu on tu.id = e.owner_id
         where e.owner_table = 'text_unit' and tu.source_id = $1`,
        [ingested.source.id],
      );
      return {
        chunks: Number(chunks.rows[0].c),
        chunkVectors: Number(chunkVectors.rows[0].c),
        unitVectors: Number(unitVectors.rows[0].c),
      };
    });

    assert.equal(counts.unitVectors, 0, "the per-line vectors are gone");
    assert.equal(counts.chunkVectors, counts.chunks, "every chunk must be embedded exactly once");
    // 41 lines of ~145 characters against a 1200-character target: the source
    // should collapse to roughly an eighth of the vectors it used to need.
    assert.ok(
      counts.chunks * 4 <= embeddableUnits,
      `expected at least a 4x drop, got ${counts.chunks} chunks for ${embeddableUnits} embeddable units`,
    );
  });

  it("retires a pre-020 source's per-line vectors once its chunks are indexed", async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Legacy per-line fixture ${stamp}`,
      contentText: [
        `# Legacy ${stamp}`,
        "The first legacy paragraph explains how vectors used to be written one per line.",
        "The second legacy paragraph explains why that filled the disk in September.",
      ].join("\n"),
      metadata: { smoke: true },
    }, context);
    await drainJobs();

    // Rewind this source to the pre-migration shape: chunks gone, one vector
    // per line, exactly what production holds for everything ingested earlier.
    await withClient(async (client) => {
      await client.query("delete from text_chunk where source_id = $1", [ingested.source.id]);
      await client.query(
        `insert into embedding (owner_table, owner_id, model, dimensions, embedding, content_sha256)
         select 'text_unit', tu.id, 'fake', 1536, (select array_fill(0.01, array[1536])::vector), tu.content_sha256
         from text_unit tu where tu.source_id = $1`,
        [ingested.source.id],
      );
    });
    const before = await withClient(async (client) =>
      Number((await client.query(
        `select count(*)::int as c from embedding e join text_unit tu on tu.id = e.owner_id
         where e.owner_table = 'text_unit' and tu.source_id = $1`,
        [ingested.source.id],
      )).rows[0].c));
    assert.ok(before > 0, "fixture: expected per-line vectors to rewind onto");

    // The background worker's job, run by hand: chunk what is unchunked, embed
    // the chunks, then retire the per-line vectors the chunks replaced.
    for (const tag of ["chunk", "retire"]) {
      const job = await store.enqueueJob({
        kind: "refresh_embeddings",
        payload: { reason: "legacy_retire" },
        priority: 40,
        dedupeKey: `chunk-embeddings:${tag}:${stamp}`,
      }, context);
      await store.runJob({ jobId: job.id }, context);
    }

    const after = await withClient(async (client) => ({
      unitVectors: Number((await client.query(
        `select count(*)::int as c from embedding e join text_unit tu on tu.id = e.owner_id
         where e.owner_table = 'text_unit' and tu.source_id = $1`,
        [ingested.source.id],
      )).rows[0].c),
      chunks: Number((await client.query(
        "select count(*)::int as c from text_chunk where source_id = $1",
        [ingested.source.id],
      )).rows[0].c),
    }));

    assert.ok(after.chunks > 0, "the refresh job did not chunk the un-chunked source");
    assert.equal(after.unitVectors, 0, "the per-line vectors were not retired after chunking");
  });
});

describe("driver parity for the chunk grain", () => {
  it("reports the chunk grain in the refresh job result on both drivers", async () => {
    const job = await store.enqueueJob({
      kind: "refresh_embeddings",
      payload: { reason: "chunk_grain_shape" },
      priority: 40,
      dedupeKey: `chunk-embeddings:${stamp}`,
    }, context);
    const done = await store.runJob({ jobId: job.id }, context);
    assert.equal(done?.status, "succeeded");
    const result = done?.result as Record<string, unknown>;
    const counts = (result.missingBefore ?? result.missing) as Record<string, unknown>;
    assert.ok("textChunks" in counts, `expected chunk counts, got ${JSON.stringify(counts)}`);
    assert.equal("textUnits" in counts, false, "the refresh job still counts per-line vectors");
    if (driver === "postgres") {
      assert.equal(typeof result.retiredTextUnitVectors, "number");
      assert.equal(typeof result.chunkedSources, "number");
    }
  });
});
