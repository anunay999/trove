import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("update", () => {
  const { store, context, stamp } = suiteStore("update");
  let nodeId: string;
  let baseRevisionId: string;
  let currentRevisionId: string;

  after(async () => {
    await closeStore(store);
  });

  it("captures a node with a base revision", async () => {
    const captured = await store.capture({
      title: `Update smoke ${stamp}`,
      type: "claim",
      summary: "graph.update should create a new revision.",
      content: "Original content before update.",
      evidence: [],
      links: [],
    }, context);
    assert.ok(captured.revisionId, "capture did not return a revision id");
    nodeId = captured.id;
    baseRevisionId = captured.revisionId;
  });

  it("update creates a new revision and persists content", async () => {
    const updated = await store.update({
      nodeId,
      baseRevisionId,
      summary: "Updated summary after supersession.",
      content: "Updated content after update.",
    }, context);
    assert.ok(updated && !("conflict" in updated), "expected a successful update");
    assert.notEqual(updated.revisionId, baseRevisionId, "update did not create a new revision");
    currentRevisionId = updated.revisionId;

    const readBack = await store.read({ nodeId });
    assert.equal(readBack?.content, "Updated content after update.", "updated content did not persist");
  });

  it("renames via slug, normalizing it, and read-by-slug follows", async () => {
    const renamed = await store.update({
      nodeId,
      baseRevisionId: currentRevisionId,
      slug: `Update Smoke Renamed ${stamp}`,
    }, context);
    assert.ok(renamed && !("conflict" in renamed), "expected a successful slug update");
    assert.match(renamed.slug, /^update-smoke-renamed-\d+$/, "expected a normalized slug");

    const bySlug = await store.read({ slug: renamed.slug });
    assert.equal(bySlug?.id, nodeId, "read by new slug did not resolve to the renamed node");
  });

  it("returns a conflict for a stale base revision", async () => {
    const stale = await store.update({
      nodeId,
      baseRevisionId,
      content: "Should not apply.",
    }, context);
    assert.ok(stale && "conflict" in stale, "expected a conflict on a stale base revision");
  });
});
