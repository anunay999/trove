import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "bitemporal-smoke",
  interfaceId: "bitemporal-smoke",
  requestId: `bitemporal-smoke-${stamp}`,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

try {
  const hub = await store.capture({
    title: `Bitemporal hub ${stamp}`,
    type: "project",
    summary: "Root node for edge supersession checks.",
    evidence: [],
    links: [],
  }, context);
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

  const oldEdge = await store.link({
    fromNodeId: hub.id,
    toNodeId: oldTarget.id,
    predicate: "uses",
    weight: 1,
  }, context);
  if (!oldEdge) throw new Error("Old edge was not created.");
  if (!oldEdge.recordedAt) throw new Error("Edge is missing recordedAt.");
  if (!oldEdge.validFrom) throw new Error("Edge is missing validFrom.");
  if (oldEdge.expiredAt !== null) throw new Error("Fresh edge must not be expired.");
  if (oldEdge.invalidatedBy !== null) throw new Error("Fresh edge must not be invalidated.");

  await sleep(20);
  const betweenTs = new Date().toISOString();
  await sleep(20);

  const newEdge = await store.link({
    fromNodeId: hub.id,
    toNodeId: newTarget.id,
    predicate: "uses",
    weight: 1,
    supersedesEdgeId: oldEdge.id,
  }, context);
  if (!newEdge) throw new Error("Superseding edge was not created.");
  if (newEdge.expiredAt !== null) throw new Error("Superseding edge must be active.");

  const current = await store.neighborhood({ nodeId: hub.id, depth: 1 });
  const currentEdgeIds = new Set(current.edges.map((edge) => edge.id));
  if (currentEdgeIds.has(oldEdge.id)) {
    throw new Error("Default neighborhood must exclude the invalidated edge.");
  }
  if (!currentEdgeIds.has(newEdge.id)) {
    throw new Error("Default neighborhood must include the superseding edge.");
  }

  const asOfPast = await store.neighborhood({ nodeId: hub.id, depth: 1, asOf: betweenTs });
  const pastEdgeIds = new Set(asOfPast.edges.map((edge) => edge.id));
  if (!pastEdgeIds.has(oldEdge.id)) {
    throw new Error("asOf time-travel must include the edge that was believed then.");
  }
  if (pastEdgeIds.has(newEdge.id)) {
    throw new Error("asOf time-travel must exclude edges recorded later.");
  }

  const full = await store.neighborhood({ nodeId: hub.id, depth: 1, includeExpired: true });
  const invalidated = full.edges.find((edge) => edge.id === oldEdge.id);
  if (!invalidated) throw new Error("includeExpired neighborhood must return the invalidated edge.");
  if (invalidated.invalidatedBy !== newEdge.id) {
    throw new Error("Invalidated edge must point at the superseding edge.");
  }
  if (!invalidated.expiredAt) throw new Error("Invalidated edge must carry expiredAt.");
  if (invalidated.validUntil !== newEdge.validFrom) {
    throw new Error("Invalidated edge validUntil must equal the superseding edge validFrom.");
  }

  const directlyInvalidated = await store.invalidateEdge({ edgeId: newEdge.id }, context);
  if (!directlyInvalidated) throw new Error("invalidateEdge did not return the edge.");
  if (!directlyInvalidated.expiredAt) throw new Error("invalidateEdge must set expiredAt.");

  const emptied = await store.neighborhood({ nodeId: hub.id, depth: 1 });
  if (emptied.edges.some((edge) => edge.id === oldEdge.id || edge.id === newEdge.id)) {
    throw new Error("Neighborhood must exclude all invalidated edges.");
  }

  const timeline = await store.timeline();
  if (!timeline.some((event) => event.action === "invalidate_edge")) {
    throw new Error("Timeline must record invalidate_edge events.");
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    oldEdge: { id: oldEdge.id, invalidatedBy: invalidated.invalidatedBy, validUntil: invalidated.validUntil },
    newEdge: { id: newEdge.id, expiredAt: directlyInvalidated.expiredAt },
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
