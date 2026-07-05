import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("retrieval", () => {
  const { store, context, stamp } = suiteStore("retrieval");
  let nodeId: string;
  let ingestedUnitIds: Set<string>;

  after(async () => {
    await closeStore(store);
  });

  it("captures a node and ingests a source", async () => {
    const node = await store.capture({
      title: `Retrieval smoke ${stamp}`,
      type: "claim",
      summary: "Lexical graph search should rank semantic nodes.",
      content: "The retrieval smoke node checks ranked full text search over node revisions.",
      evidence: [],
      links: [],
    }, context);
    nodeId = node.id;

    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Retrieval source ${stamp}`,
      contentText: [
        "# Retrieval source",
        "",
        "Trove stores long-form evidence with transactional provenance and indexed source spans.",
        "Agents need to find this text without scanning markdown files directly.",
      ].join("\n"),
      metadata: { smoke: true },
    }, context);
    ingestedUnitIds = new Set(ingested.textUnits.map((unit) => unit.id));
  });

  it("finds the node through lexical search over node revisions", async () => {
    const nodeSearch = await store.search({
      query: "ranked full text search",
      includeTextUnits: false,
      mode: "lexical",
      limit: 10,
    });
    assert.ok(nodeSearch.nodes.some((candidate) => candidate.id === nodeId), "lexical search did not find the smoke node");
  });

  it("finds the ingested text unit through lexical search over sources", async () => {
    const sourceSearch = await store.search({
      query: "indexed source spans",
      includeTextUnits: true,
      mode: "lexical",
      limit: 10,
    });
    assert.ok(
      sourceSearch.textUnits.some((unit) => ingestedUnitIds.has(unit.id)),
      "lexical search did not find the smoke text unit",
    );
  });
});
