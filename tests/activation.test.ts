import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import pg from "pg";
import { closeStore, hasPostgres, isolateDatabase, suiteStore } from "./helpers.js";

/**
 * Activation is batched (finding #13).
 *
 * Every tracked read used to fire its own `update node set access_count = ...`:
 * one round trip, one transaction and one dead tuple apiece, on the table that
 * churns hardest in the graph. The bumps are now buffered and drained in a
 * single `unnest` statement, so what these tests pin is (a) the statement
 * count, which is the whole point, and (b) that nothing about the semantics
 * moved — a read still counts, a projection still does not, counts still add
 * up, and a shutdown still writes what it buffered.
 */

// A long window so nothing drains behind the assertions; every drain in this
// file is explicit. Must be set before the store is constructed.
process.env.TROVE_ACTIVATION_FLUSH_MS = "60000";

// Count activation statements the way repro-eval R15 does: wrap the pool, look
// at the SQL. Node runs each test file in its own process, so the patch is
// confined to this suite.
const activationStatements: string[] = [];
const originalQuery = pg.Pool.prototype.query;
(pg.Pool.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function patched(
  this: pg.Pool,
  ...args: unknown[]
) {
  const first = args[0];
  const text = typeof first === "string" ? first : String((first as { text?: string } | undefined)?.text ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.startsWith("update node") && normalized.includes("access_count")) {
    activationStatements.push(normalized);
  }
  return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(this, args);
};

await isolateDatabase("activation");
const { store, context, stamp } = suiteStore("activation");

type Flushable = { flushActivation: () => Promise<void> };
const flush = (): Promise<void> => (store as unknown as Flushable).flushActivation();

after(async () => {
  await closeStore(store);
});

const captureNode = async (label: string): Promise<string> => {
  const node = await store.capture({
    title: `Activation ${label} ${stamp}`,
    type: "claim",
    summary: `activation ${label} probe ${stamp}`,
    content: `body for activation ${label} probe ${stamp}`,
    evidence: [],
    links: [],
  }, context);
  return node.id;
};

describe("activation semantics (both drivers)", () => {
  it("a tracked read counts, an untracked one and a projection do not", async () => {
    const nodeId = await captureNode("semantics");
    const first = await store.read({ nodeId }, context);
    assert.equal(first?.accessCount, 1, "a default read still strengthens the atom");

    await store.project({ nodeId, format: "markdown", depth: 1 }, context);
    await store.read({ nodeId }, context, { trackAccess: false });

    const observed = await store.read({ nodeId }, context, { trackAccess: false });
    assert.equal(observed?.accessCount, 1, "project and trackAccess:false must not bump");
  });

  it("counts add up across several reads, buffered or not", async () => {
    const nodeId = await captureNode("adding-up");
    for (let expected = 1; expected <= 3; expected += 1) {
      const read = await store.read({ nodeId }, context);
      assert.equal(read?.accessCount, expected, "a read must observe its own bump immediately");
    }
    await flush();
    const afterFlush = await store.read({ nodeId }, context, { trackAccess: false });
    assert.equal(afterFlush?.accessCount, 3, "the flush must not double-count or lose a bump");

    // And the buffer keeps counting from the flushed baseline.
    const fourth = await store.read({ nodeId }, context);
    assert.equal(fourth?.accessCount, 4);
    await flush();
    const settled = await store.read({ nodeId }, context, { trackAccess: false });
    assert.equal(settled?.accessCount, 4);
  });

  it("a read moves lastAccessedAt forward", async () => {
    const nodeId = await captureNode("timestamp");
    const before = Date.now();
    const read = await store.read({ nodeId }, context);
    assert.ok(read?.lastAccessedAt, "a tracked read must stamp lastAccessedAt");
    assert.ok(Date.parse(read.lastAccessedAt as string) >= before - 1_000);
    await flush();
    const settled = await store.read({ nodeId }, context, { trackAccess: false });
    assert.ok(settled?.lastAccessedAt, "the flush must persist the stamp");
  });
});

describe("activation batching (postgres)", { skip: hasPostgres() ? false : "requires a Postgres DATABASE_URL" }, () => {
  const probe = async (nodeId: string): Promise<{ count: number; lastAccessedAt: string | null }> => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query(
        `select access_count::int as count, last_accessed_at from node where id = $1`,
        [nodeId],
      );
      return {
        count: Number(result.rows[0]?.count ?? -1),
        lastAccessedAt: result.rows[0]?.last_accessed_at ?? null,
      };
    } finally {
      await client.end();
    }
  };

  it("six reads over three nodes issue ONE activation statement, not six", async () => {
    const ids = [await captureNode("batch-a"), await captureNode("batch-b"), await captureNode("batch-c")];
    activationStatements.length = 0;

    for (const nodeId of ids) {
      await store.read({ nodeId }, context);
      await store.read({ nodeId }, context);
    }
    assert.equal(activationStatements.length, 0, "reads must not write activation inline");

    await flush();
    assert.equal(
      activationStatements.length,
      1,
      `a window of reads must drain in one statement, got ${activationStatements.length}: ${activationStatements.join(" | ")}`,
    );
    assert.ok(activationStatements[0]?.includes("unnest"), "the drain is the bulk unnest form");

    for (const nodeId of ids) {
      const row = await probe(nodeId);
      assert.equal(row.count, 2, "both reads of every node must land");
      assert.ok(row.lastAccessedAt, "the drain must set last_accessed_at");
    }
  });

  it("close() flushes what is buffered, so shutdown loses nothing", async () => {
    const { store: shortLived, context: shortContext } = suiteStore("activation-shutdown");
    const node = await shortLived.capture({
      title: `Activation shutdown ${stamp}`,
      type: "claim",
      summary: `activation shutdown probe ${stamp}`,
      content: `body for activation shutdown probe ${stamp}`,
      evidence: [],
      links: [],
    }, shortContext);
    await shortLived.read({ nodeId: node.id }, shortContext);
    await shortLived.read({ nodeId: node.id }, shortContext);
    assert.equal((await probe(node.id)).count, 0, "the bumps are still buffered before close");

    await closeStore(shortLived);
    assert.equal((await probe(node.id)).count, 2, "close() must drain the buffer");
  });
});
