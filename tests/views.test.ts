import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("views", () => {
  const { store, context, stamp } = suiteStore("view");

  after(async () => {
    await closeStore(store);
  });

  it("saves a durable view over a node neighborhood", async () => {
    const root = await store.capture({
      title: `View smoke root ${stamp}`,
      type: "project",
      summary: "Saved views should persist durable mind-map projections.",
      content: "This node is the root for a saved Trove view smoke test.",
      evidence: [],
      links: [],
    }, context);
    const leaf = await store.capture({
      title: `View smoke leaf ${stamp}`,
      type: "claim",
      summary: "Saved views should include linked nodes and edges.",
      content: "This node should appear in the root neighborhood view.",
      evidence: [],
      links: [],
    }, context);
    const edge = await store.link({
      fromNodeId: root.id,
      toNodeId: leaf.id,
      predicate: "supports",
      weight: 1,
    }, context);
    assert.ok(edge, "expected smoke edge to be created");

    const view = await store.createView({
      title: `View Smoke ${stamp}`,
      rootNodeId: root.id,
      depth: 1,
      summary: "A durable saved mind-map view created by the smoke test.",
      layout: {},
    }, context);
    assert.ok(view.nodes.some((node) => node.id === root.id), "saved view must include the root node");
    assert.ok(view.nodes.some((node) => node.id === leaf.id), "saved view must include the leaf node");
    assert.ok(view.edges.some((candidate) => candidate.id === edge.id), "saved view must include the edge");

    const read = await store.readView({ slug: view.slug });
    assert.equal(read?.id, view.id, "saved view could not be read back by slug");

    const listed = await store.views({ query: "View Smoke", limit: 10 });
    assert.ok(listed.some((candidate) => candidate.id === view.id), "saved view was not listed");

    const graph = await store.exportGraph();
    assert.ok(graph.views?.some((candidate) => candidate.id === view.id), "saved view was not included in graph export");
  });
});
