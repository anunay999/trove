import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "recall-smoke",
  interfaceId: "recall-smoke",
  requestId: `recall-smoke-${stamp}`,
};

try {
  const ingested = await store.ingest({
    kind: "agent_note",
    title: `Recall evidence ${stamp}`,
    contentText: [
      "# Recall evidence",
      "",
      "The launchpad export smoke run confirmed that nightly sync workers copy universe rows into ClickHouse before the morning report window opens.",
    ].join("\n"),
    metadata: { smoke: true },
  }, context);
  const evidenceUnit = ingested.textUnits.at(-1);
  if (!evidenceUnit) throw new Error("Ingest produced no text units.");

  const hub = await store.capture({
    title: `Recall smoke hub ${stamp}`,
    type: "decision",
    summary: "Recall smoke packing should surface this hub first for the recall smoke query.",
    content: "The recall smoke hub records that budgeted context packs are assembled from hybrid seeds, one-hop expansion, and activation ranking so agents receive citations instead of raw markdown dumps.",
    evidence: [{ textUnitId: evidenceUnit.id, selector: {} }],
    links: [],
  }, context);

  const neighbor = await store.capture({
    title: `Expansion neighbor ${stamp}`,
    type: "pattern",
    summary: "Connected pattern that must arrive through graph expansion, not lexical match.",
    content: "Graph expansion should pull this pattern into the context pack because it is linked to the hub, demonstrating that traversal complements retrieval even when the query words never appear here. The pattern also carries enough prose that a tight token budget cannot afford both the hub and this block at the same time.",
    evidence: [],
    links: [],
  }, context);

  const edge = await store.link({
    fromNodeId: hub.id,
    toNodeId: neighbor.id,
    predicate: "depends_on",
    weight: 1,
  }, context);
  if (!edge) throw new Error("Hub-neighbor edge was not created.");

  const generous = await store.recall({ query: "recall smoke", tokenBudget: 2000 });
  if (generous.spentTokens <= 0) throw new Error("Recall must report spent tokens.");
  if (generous.spentTokens > 2000) throw new Error("Recall must respect the token budget.");
  if (!generous.atoms.some((atom) => atom.node.id === hub.id)) {
    throw new Error("Recall must pack the lexically matching hub.");
  }
  if (!generous.atoms.some((atom) => atom.node.id === neighbor.id)) {
    throw new Error("Recall must pack the linked neighbor via graph expansion.");
  }
  if (!generous.context.includes(hub.title)) {
    throw new Error("Recall context must include the hub title.");
  }
  if (!generous.citations.some((citation) => citation.textUnitId === evidenceUnit.id)) {
    throw new Error("Recall must cite the hub evidence text unit.");
  }
  if (!generous.edges.some((candidate) => candidate.id === edge.id)) {
    throw new Error("Recall must return edges between packed atoms.");
  }

  const tight = await store.recall({ query: "recall smoke", tokenBudget: 160 });
  if (tight.spentTokens > 160) throw new Error("Tight recall must stay within budget.");
  if (!tight.truncated) throw new Error("Tight recall must report truncation.");
  if (!tight.atoms.some((atom) => atom.node.id === hub.id)) {
    throw new Error("Tight recall must still pack the best-matching hub.");
  }
  if (tight.atoms.length >= generous.atoms.length && tight.evidence.length >= generous.evidence.length) {
    throw new Error("Tight recall must pack less than the generous recall.");
  }

  const first = await store.read({ nodeId: hub.id });
  if (!first) throw new Error("Hub read failed.");
  await store.read({ nodeId: hub.id });
  const third = await store.read({ nodeId: hub.id });
  if (!third) throw new Error("Hub re-read failed.");
  if (third.accessCount < first.accessCount + 2) {
    throw new Error("Reads must strengthen activation by bumping accessCount.");
  }
  if (!third.lastAccessedAt) throw new Error("Reads must stamp lastAccessedAt.");

  console.log(JSON.stringify({
    ok: true,
    driver,
    generous: {
      atoms: generous.atoms.length,
      evidence: generous.evidence.length,
      citations: generous.citations.length,
      spentTokens: generous.spentTokens,
      truncated: generous.truncated,
    },
    tight: {
      atoms: tight.atoms.length,
      evidence: tight.evidence.length,
      spentTokens: tight.spentTokens,
      truncated: tight.truncated,
    },
    activation: { accessCount: third.accessCount, lastAccessedAt: third.lastAccessedAt },
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
