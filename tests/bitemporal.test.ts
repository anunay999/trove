import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore, sleep, isolateDatabase } from "./helpers.js";
import { EdgeValidityConflictError, type GraphStore } from "../src/graphCore.js";
import type { GraphEdge } from "../src/contracts.js";

await isolateDatabase("bitemporal");

describe("bitemporal edges", () => {
  const { store, context, stamp } = suiteStore("bitemporal");

  let hubId: string;
  let oldEdgeId: string;
  let newEdgeId: string;
  let betweenTs: string;

  before(async () => {
    const hub = await store.capture({
      title: `Bitemporal hub ${stamp}`,
      type: "project",
      summary: "Root node for edge supersession checks.",
      evidence: [],
      links: [],
    }, context);
    hubId = hub.id;
    const oldTarget = await store.capture({
      title: `Bitemporal old target ${stamp}`,
      type: "infrastructure",
      summary: "The belief that gets superseded.",
      evidence: [],
      links: [],
    }, context);
    const newTarget = await store.capture({
      title: `Bitemporal new target ${stamp}`,
      type: "infrastructure",
      summary: "The belief that supersedes the old one.",
      evidence: [],
      links: [],
    }, context);

    const oldEdge = await store.link({ fromNodeId: hubId, toNodeId: oldTarget.id, predicate: "uses", weight: 1 }, context);
    assert.ok(oldEdge, "old edge was not created");
    oldEdgeId = oldEdge.id;
    assert.ok(oldEdge.recordedAt, "edge is missing recordedAt");
    assert.ok(oldEdge.validFrom, "edge is missing validFrom");
    assert.equal(oldEdge.expiredAt, null, "fresh edge must not be expired");
    assert.equal(oldEdge.invalidatedBy, null, "fresh edge must not be invalidated");

    await sleep(20);
    betweenTs = new Date().toISOString();
    await sleep(20);

    const newEdge = await store.link({
      fromNodeId: hubId,
      toNodeId: newTarget.id,
      predicate: "uses",
      weight: 1,
      supersedesEdgeId: oldEdgeId,
    }, context);
    assert.ok(newEdge, "superseding edge was not created");
    newEdgeId = newEdge.id;
    assert.equal(newEdge.expiredAt, null, "superseding edge must be active");
  });

  after(async () => {
    await closeStore(store);
  });

  it("default neighborhood shows the superseding edge, not the invalidated one", async () => {
    const current = await store.neighborhood({ nodeId: hubId, depth: 1 });
    const ids = new Set(current.edges.map((edge) => edge.id));
    assert.ok(!ids.has(oldEdgeId), "default neighborhood must exclude the invalidated edge");
    assert.ok(ids.has(newEdgeId), "default neighborhood must include the superseding edge");
  });

  it("asOf time-travel reflects the belief at that instant", async () => {
    const asOfPast = await store.neighborhood({ nodeId: hubId, depth: 1, asOf: betweenTs });
    const ids = new Set(asOfPast.edges.map((edge) => edge.id));
    assert.ok(ids.has(oldEdgeId), "asOf must include the edge that was believed then");
    assert.ok(!ids.has(newEdgeId), "asOf must exclude edges recorded later");
  });

  it("includeExpired returns the invalidated edge with supersession metadata", async () => {
    const full = await store.neighborhood({ nodeId: hubId, depth: 1, includeExpired: true });
    const invalidated = full.edges.find((edge) => edge.id === oldEdgeId);
    assert.ok(invalidated, "includeExpired neighborhood must return the invalidated edge");
    assert.equal(invalidated.invalidatedBy, newEdgeId, "invalidated edge must point at the superseding edge");
    assert.ok(invalidated.expiredAt, "invalidated edge must carry expiredAt");
    const newEdge = full.edges.find((edge) => edge.id === newEdgeId);
    assert.equal(invalidated.validUntil, newEdge?.validFrom, "validUntil must equal the superseding edge validFrom");
    assert.equal(invalidated.invalidationReason, "superseded", "supersession must record its reason");
    assert.equal(newEdge?.invalidationReason, null, "an active edge carries no invalidation reason");
  });

  it("invalidateEdge retires an edge directly and records a timeline event", async () => {
    const directly = await store.invalidateEdge({ edgeId: newEdgeId }, context);
    assert.ok(directly, "invalidateEdge did not return the edge");
    assert.ok(directly.expiredAt, "invalidateEdge must set expiredAt");
    assert.ok(directly.validUntil, "invalidateEdge must close validity");
    assert.equal(directly.invalidationReason, "invalidated", "invalidateEdge must record its reason");
    assert.equal(directly.invalidatedBy, null, "a direct invalidation has no superseding edge");

    const emptied = await store.neighborhood({ nodeId: hubId, depth: 1 });
    assert.ok(
      !emptied.edges.some((edge) => edge.id === oldEdgeId || edge.id === newEdgeId),
      "neighborhood must exclude all invalidated edges",
    );

    const timeline = await store.timeline();
    assert.ok(timeline.some((event) => event.action === "invalidate_edge"), "timeline must record invalidate_edge events");
  });
});

/**
 * The closed edge is invisible through every graph read (both drivers drop
 * edges whose far end is tombstoned), so the tombstone assertions read the
 * stored row itself: the table on Postgres, the driver's edge map in memory.
 */
async function storedEdge(
  store: GraphStore,
  driver: "memory" | "postgres",
  edgeId: string,
): Promise<{ expiredAt: string | null; validUntil: string | null; invalidationReason: string | null; metadata: Record<string, unknown> } | null> {
  if (driver === "memory") {
    const edge = (store as unknown as { edges: Map<string, GraphEdge> }).edges.get(edgeId);
    return edge
      ? { expiredAt: edge.expiredAt, validUntil: edge.validUntil, invalidationReason: edge.invalidationReason, metadata: {} }
      : null;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      "select expired_at, valid_until, invalidation_reason, metadata from edge where id = $1",
      [edgeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      expiredAt: row.expired_at ? new Date(row.expired_at).toISOString() : null,
      validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
      invalidationReason: row.invalidation_reason ?? null,
      metadata: row.metadata ?? {},
    };
  } finally {
    await client.end();
  }
}

describe("edge temporal integrity", () => {
  const { store, driver, context, stamp } = suiteStore("edge_temporal");
  after(async () => closeStore(store));

  const capture = (suffix: string) =>
    store.capture({
      title: `Edge temporal ${suffix} ${stamp}`,
      type: "claim",
      summary: `Fixture for temporal integrity: ${suffix}.`,
      evidence: [],
      links: [],
    }, context);

  const conflictsWith = (edgeId: string) => (error: unknown) =>
    error instanceof EdgeValidityConflictError
      && error.conflictingEdgeId === edgeId
      && error.message.includes(edgeId);

  it("refuses a new version whose validity overlaps the closed one, naming it", async () => {
    const from = await capture("overlap from");
    const to = await capture("overlap to");
    const first = await store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "depends_on", weight: 1 }, context);
    assert.ok(first);
    // Let the version hold for a measurable moment: closed within the same
    // millisecond it would be the empty interval [t, t), which overlaps nothing.
    await sleep(5);
    const closed = await store.invalidateEdge({ edgeId: first.id }, context);
    assert.ok(closed?.validUntil, "invalidation must close validity");

    const earlier = new Date(Date.parse(closed.validUntil) - 3_600_000).toISOString();
    await assert.rejects(
      async () => store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "depends_on", weight: 1, validFrom: earlier }, context),
      conflictsWith(first.id),
      "a validFrom inside the closed version's validity must be rejected, not clamped",
    );

    // The default path starts at now(), after every closed version, so it
    // always succeeds and yields a fresh row rather than resurrecting the old one.
    const again = await store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "depends_on", weight: 1 }, context);
    assert.ok(again);
    assert.notEqual(again.id, first.id, "a re-link after invalidation must be a new version");
    assert.equal(again.expiredAt, null);
    assert.equal(again.invalidationReason, null);
    assert.ok(again.validFrom && again.validFrom >= closed.validUntil, "the new version must start at or after the old one closed");
  });

  it("capture-path links obey the same rule, and a refused link rolls the revision back", async () => {
    const from = await capture("capture-link from");
    const to = await capture("capture-link to");
    const first = await store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "depends_on", weight: 1 }, context);
    assert.ok(first);
    // Close the version in the future: it still owns "now", so a fresh
    // version starting now would overlap it.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const closed = await store.invalidateEdge({ edgeId: first.id, validUntil: future }, context);
    assert.ok(closed?.validUntil);

    await assert.rejects(
      async () => store.update({
        nodeId: from.id,
        baseRevisionId: from.revisionId,
        summary: "revised with a link that cannot be valid yet",
        links: [{ toSlug: to.slug, predicate: "depends_on" }],
      }, context),
      conflictsWith(first.id),
      "a capture-path link into a future-closed version must raise the named error, not a raw constraint error",
    );
    const unchanged = await store.read({ nodeId: from.id }, context);
    assert.equal(unchanged?.revisionId, from.revisionId, "the refused update must roll back the revision too");
  });

  it("supersession closes the old edge at the new validFrom, and refuses to start before the old one did", async () => {
    const from = await capture("supersede from");
    const oldTarget = await capture("supersede old target");
    const newTarget = await capture("supersede new target");
    const old = await store.link({ fromNodeId: from.id, toNodeId: oldTarget.id, predicate: "uses", weight: 1 }, context);
    assert.ok(old?.validFrom);

    const beforeOld = new Date(Date.parse(old.validFrom) - 3_600_000).toISOString();
    await assert.rejects(
      async () => store.link({
        fromNodeId: from.id,
        toNodeId: newTarget.id,
        predicate: "uses",
        weight: 1,
        validFrom: beforeOld,
        supersedesEdgeId: old.id,
      }, context),
      conflictsWith(old.id),
      "a successor cannot start before the edge it supersedes",
    );
    const afterRefusal = await store.neighborhood({ nodeId: from.id, depth: 1 }, context);
    assert.deepEqual(
      afterRefusal.edges.filter((edge) => edge.predicate === "uses").map((edge) => edge.id),
      [old.id],
      "a refused supersession must leave no edge behind",
    );

    await sleep(5);
    const successor = await store.link({
      fromNodeId: from.id,
      toNodeId: newTarget.id,
      predicate: "uses",
      weight: 1,
      supersedesEdgeId: old.id,
    }, context);
    assert.ok(successor);
    const history = await store.neighborhood({ nodeId: from.id, depth: 1, includeExpired: true }, context);
    const superseded = history.edges.find((edge) => edge.id === old.id);
    assert.ok(superseded);
    assert.equal(superseded.validUntil, successor.validFrom);
    assert.equal(superseded.invalidatedBy, successor.id);
    assert.equal(superseded.invalidationReason, "superseded");
  });

  it("invalidateEdge records 'invalidated' and refuses a validUntil before validFrom", async () => {
    const from = await capture("invalidate from");
    const to = await capture("invalidate to");
    const edge = await store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "cites", weight: 1 }, context);
    assert.ok(edge?.validFrom);

    const beforeStart = new Date(Date.parse(edge.validFrom) - 60_000).toISOString();
    await assert.rejects(
      async () => store.invalidateEdge({ edgeId: edge.id, validUntil: beforeStart }, context),
      conflictsWith(edge.id),
      "validity cannot end before it began",
    );
    const untouched = await store.neighborhood({ nodeId: from.id, depth: 1 }, context);
    assert.ok(untouched.edges.some((candidate) => candidate.id === edge.id && candidate.expiredAt === null), "a refused invalidation must not expire the edge");

    const closed = await store.invalidateEdge({ edgeId: edge.id }, context);
    assert.ok(closed);
    assert.equal(closed.invalidationReason, "invalidated");
    assert.ok(closed.validUntil && closed.validUntil >= edge.validFrom);
  });

  it("tombstone closes validity and records 'tombstoned' without the metadata hack", async () => {
    const survivor = await capture("tombstone survivor");
    const doomed = await capture("tombstone doomed");
    const edge = await store.link({ fromNodeId: survivor.id, toNodeId: doomed.id, predicate: "relates_to", weight: 1 }, context);
    assert.ok(edge);

    const result = await store.tombstoneNodes([doomed.id], context);
    assert.deepEqual(result.tombstoned, [doomed.id]);

    const stored = await storedEdge(store, driver, edge.id);
    assert.ok(stored, "the tombstoned edge row must still exist");
    assert.ok(stored.expiredAt, "tombstone must expire incident edges");
    assert.ok(stored.validUntil, "tombstone must close validity, not only belief");
    assert.equal(stored.invalidationReason, "tombstoned");
    assert.equal(stored.metadata.invalidatedBy, undefined, "the reason lives in its own column, not metadata");
  });

  it("null valid_from can no longer be written", { skip: driver !== "postgres" }, async () => {
    const from = await capture("null valid_from from");
    const to = await capture("null valid_from to");
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await assert.rejects(
        client.query(
          "insert into edge (from_node_id, to_node_id, predicate, valid_from) values ($1, $2, 'relates_to', null)",
          [from.id, to.id],
        ),
        (error: unknown) => (error as { code?: string }).code === "23502",
        "valid_from must be not null",
      );
      const defaulted = await client.query(
        "insert into edge (from_node_id, to_node_id, predicate) values ($1, $2, 'relates_to') returning valid_from",
        [from.id, to.id],
      );
      assert.ok(defaulted.rows[0].valid_from, "valid_from must default to now()");
    } finally {
      await client.end();
    }
  });
});
