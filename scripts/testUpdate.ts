import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const context = {
  actorId: "update-smoke",
  interfaceId: "update-smoke",
  requestId: `update-smoke-${Date.now()}`,
};

try {
  const captured = await store.capture({
    title: `Update smoke ${Date.now()}`,
    type: "claim",
    summary: "graph.update should create a new revision against Postgres.",
    content: "Original content before update.",
    evidence: [],
    links: [],
  }, context);

  const baseRevisionId = captured.revisionId;
  if (!baseRevisionId) throw new Error("Capture did not return a revision id.");

  const updated = await store.update({
    nodeId: captured.id,
    baseRevisionId,
    summary: "Updated summary after supersession.",
    content: "Updated content after update.",
  }, context);
  if (!updated || "conflict" in updated) {
    throw new Error(`Expected successful update, got ${JSON.stringify(updated)}.`);
  }
  if (updated.revisionId === baseRevisionId) {
    throw new Error("Update did not create a new revision.");
  }

  const readBack = await store.read({ nodeId: captured.id });
  if (!readBack || readBack.content !== "Updated content after update.") {
    throw new Error("Updated content did not persist.");
  }

  // Optimistic concurrency: a stale base revision must return a conflict.
  const stale = await store.update({
    nodeId: captured.id,
    baseRevisionId,
    content: "Should not apply.",
  }, context);
  if (!stale || !("conflict" in stale)) {
    throw new Error(`Expected conflict on stale base revision, got ${JSON.stringify(stale)}.`);
  }

  console.log(JSON.stringify({ ok: true, driver }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
