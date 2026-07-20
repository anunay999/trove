import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import type { GraphOperationContext } from "../src/graphCore.js";
import { embeddingDrainRemaining } from "../src/jobWorker.js";
import { PgGraphStore } from "../src/pgStore.js";
import { isolateDatabase, hasPostgres } from "./helpers.js";

// Owner scoping is a Postgres concern (the in-memory driver has no embedding
// backfill). Fake provider: deterministic, offline.
process.env.TROVE_EMBEDDING_PROVIDER = "fake";
await isolateDatabase("embedding_backfill");

// node.owner_id references app_user — owners must exist.
let ownerA = "";
let ownerB = "";
let ctxA: GraphOperationContext;
let ctxB: GraphOperationContext;

async function insertOwner(email: string): Promise<string> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      "insert into app_user (clerk_user_id, email, status) values ($1, $2, 'active') returning id",
      [`test-${email}`, email],
    );
    return String(result.rows[0].id);
  } finally {
    await client.end();
  }
}

describe("embedding backfill: owner scoping and batching", { skip: !hasPostgres() }, () => {
  const store = new PgGraphStore({ connectionString: process.env.DATABASE_URL as string });

  before(async () => {
    ownerA = await insertOwner("alpha@example.com");
    ownerB = await insertOwner("beta@example.com");
    ctxA = { actorId: "backfill-test", interfaceId: "backfill-test", ownerId: ownerA };
    ctxB = { actorId: "backfill-test", interfaceId: "backfill-test", ownerId: ownerB };
  });

  after(async () => {
    await store.close();
  });

  it("an owner-scoped refresh drains only that owner's rows", async () => {
    for (const title of ["Alpha one", "Alpha two"]) {
      await store.capture({ title, type: "claim", summary: `${title} summary`, content: `${title} content`, evidence: [], links: [] }, ctxA);
    }
    for (const title of ["Beta one", "Beta two", "Beta three"]) {
      await store.capture({ title, type: "claim", summary: `${title} summary`, content: `${title} content`, evidence: [], links: [] }, ctxB);
    }

    const scoped = await store.enqueueJob({
      kind: "refresh_embeddings",
      payload: { reason: "owner_import", ownerId: ownerA },
      priority: 40,
      dedupeKey: `test:refresh:${ownerA}`,
    }, ctxA);
    const done = await store.runJob({ jobId: scoped.id }, ctxA);
    assert.equal(done?.status, "succeeded");
    const result = done?.result as Record<string, unknown>;
    assert.equal(result.ownerId, ownerA);
    const missingBefore = result.missingBefore as { nodeRevisions: number; textUnits: number };
    const embedded = result.embedded as { nodeRevisions: number; textUnits: number };
    assert.equal(missingBefore.nodeRevisions, 2, "the scoped count sees only owner A's rows");
    assert.equal(embedded.nodeRevisions, 2, "the scoped backfill embeds only owner A's rows");

    // What remains globally is exactly owner B's three — proving A's rows were
    // embedded and B's were untouched.
    const globalJob = await store.enqueueJob({
      kind: "refresh_embeddings",
      payload: { reason: "global_check" },
      priority: 40,
      dedupeKey: "test:refresh:global",
    }, ctxA);
    const globalDone = await store.runJob({ jobId: globalJob.id }, ctxA);
    const globalResult = globalDone?.result as Record<string, unknown>;
    assert.equal(globalResult.ownerId, null);
    assert.equal((globalResult.missingBefore as { nodeRevisions: number }).nodeRevisions, 3);
    assert.equal((globalResult.embedded as { nodeRevisions: number }).nodeRevisions, 3);

    // Fully drained: another global run reports nothing missing.
    const clean = await store.enqueueJob({ kind: "refresh_embeddings", payload: {}, priority: 40, dedupeKey: "test:refresh:clean" }, ctxA);
    const cleanDone = await store.runJob({ jobId: clean.id }, ctxA);
    const cleanResult = cleanDone?.result as Record<string, unknown>;
    assert.deepEqual(cleanResult.missingBefore, { nodeRevisions: 0, textUnits: 0 });
    assert.equal(embeddingDrainRemaining(cleanDone), 0);
  });

  it("the job limit is honored end-to-end and the drain math reports the remainder", async () => {
    const ownerC = await insertOwner("gamma@example.com");
    const ctxC: GraphOperationContext = { actorId: "backfill-test", interfaceId: "backfill-test", ownerId: ownerC };
    for (const title of ["Gamma one", "Gamma two", "Gamma three"]) {
      await store.capture({ title, type: "claim", summary: `${title} summary`, content: `${title} content`, evidence: [], links: [] }, ctxC);
    }

    const limited = await store.enqueueJob({
      kind: "refresh_embeddings",
      payload: { ownerId: ownerC, limit: 2 },
      priority: 40,
      dedupeKey: `test:refresh:${ownerC}`,
    }, ctxC);
    const done = await store.runJob({ jobId: limited.id }, ctxC);
    assert.equal(done?.status, "succeeded");
    const result = done?.result as Record<string, unknown>;
    assert.equal((result.missingBefore as { nodeRevisions: number }).nodeRevisions, 3);
    assert.equal((result.embedded as { nodeRevisions: number }).nodeRevisions, 2, "payload.limit caps the batch");
    assert.equal(embeddingDrainRemaining(done), 1, "one row remains, so the worker must follow up");

    // Drain the remainder so this suite leaves no global residue.
    const rest = await store.enqueueJob({ kind: "refresh_embeddings", payload: { ownerId: ownerC }, priority: 40, dedupeKey: `test:refresh:${ownerC}:rest` }, ctxC);
    await store.runJob({ jobId: rest.id }, ctxC);
  });
});
