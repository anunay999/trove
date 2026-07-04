import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "retrieval-smoke",
  interfaceId: "retrieval-smoke",
  requestId: `retrieval-smoke-${stamp}`,
};

try {
  const node = await store.capture({
    title: `Retrieval smoke ${stamp}`,
    type: "claim",
    summary: "Lexical graph search should rank semantic nodes through the hosted service.",
    content: "The retrieval smoke node checks ranked full text search over node revisions.",
    evidence: [],
    links: [],
  }, context);
  const ingested = await store.ingest({
    kind: "agent_note",
    title: `Retrieval source ${stamp}`,
    contentText: [
      "# Retrieval source",
      "",
      "GraphMind stores long-form evidence with transactional provenance and indexed source spans.",
      "Agents need to find this text without scanning markdown files directly.",
    ].join("\n"),
    metadata: { smoke: true },
  }, context);

  const nodeSearch = await store.search({
    query: "ranked full text search",
    includeTextUnits: false,
    mode: "lexical",
    limit: 10,
  });
  if (!nodeSearch.nodes.some((candidate) => candidate.id === node.id)) {
    throw new Error("Lexical search did not find the smoke node.");
  }

  const sourceSearch = await store.search({
    query: "transactional provenance indexed source spans",
    includeTextUnits: true,
    mode: "lexical",
    limit: 10,
  });
  const ingestedUnitIds = new Set(ingested.textUnits.map((unit) => unit.id));
  if (!sourceSearch.textUnits.some((unit) => ingestedUnitIds.has(unit.id))) {
    throw new Error("Lexical search did not find the smoke text unit.");
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    nodeSearch: {
      nodes: nodeSearch.nodes.length,
      textUnits: nodeSearch.textUnits.length,
    },
    sourceSearch: {
      nodes: sourceSearch.nodes.length,
      textUnits: sourceSearch.textUnits.length,
    },
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
