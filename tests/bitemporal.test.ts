import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore, sleep } from "./helpers.js";

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
  });

  it("invalidateEdge retires an edge directly and records a timeline event", async () => {
    const directly = await store.invalidateEdge({ edgeId: newEdgeId }, context);
    assert.ok(directly, "invalidateEdge did not return the edge");
    assert.ok(directly.expiredAt, "invalidateEdge must set expiredAt");

    const emptied = await store.neighborhood({ nodeId: hubId, depth: 1 });
    assert.ok(
      !emptied.edges.some((edge) => edge.id === oldEdgeId || edge.id === newEdgeId),
      "neighborhood must exclude all invalidated edges",
    );

    const timeline = await store.timeline();
    assert.ok(timeline.some((event) => event.action === "invalidate_edge"), "timeline must record invalidate_edge events");
  });
});
