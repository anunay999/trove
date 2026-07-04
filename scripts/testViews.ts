import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const context = {
  actorId: "view-smoke",
  interfaceId: "view-smoke",
  requestId: `view-smoke-${Date.now()}`,
};

try {
  const root = await store.capture({
    title: `View smoke root ${Date.now()}`,
    type: "project",
    summary: "Saved views should persist durable mind-map projections.",
    content: "This node is the root for a saved Trove view smoke test.",
    evidence: [],
    links: [],
  }, context);
  const leaf = await store.capture({
    title: `View smoke leaf ${Date.now()}`,
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
  if (!edge) throw new Error("Expected smoke edge to be created.");

  const view = await store.createView({
    title: `View Smoke ${Date.now()}`,
    rootNodeId: root.id,
    depth: 1,
    summary: "A durable saved mind-map view created by the smoke test.",
    layout: {},
  }, context);
  if (!view.nodes.some((node) => node.id === root.id) || !view.nodes.some((node) => node.id === leaf.id)) {
    throw new Error("Saved view did not include expected neighborhood nodes.");
  }
  if (!view.edges.some((candidate) => candidate.id === edge.id)) {
    throw new Error("Saved view did not include expected edge.");
  }

  const read = await store.readView({ slug: view.slug });
  if (!read || read.id !== view.id) {
    throw new Error("Saved view could not be read back by slug.");
  }

  const listed = await store.views({ query: "View Smoke", limit: 10 });
  if (!listed.some((candidate) => candidate.id === view.id)) {
    throw new Error("Saved view was not listed.");
  }

  const graph = await store.exportGraph();
  if (!graph.views?.some((candidate) => candidate.id === view.id)) {
    throw new Error("Saved view was not included in graph export.");
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    view: {
      id: view.id,
      slug: view.slug,
      nodes: view.nodes.length,
      edges: view.edges.length,
    },
    listed: listed.length,
    exportedViews: graph.views?.length ?? 0,
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
