import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGraphStore } from "../src/store.js";

// Driver parity boundary (backlog #6): the in-memory driver approximates pg's
// stemmed token matching with tokenized, lightly singularized vocabularies.
// These lock in both halves of the decision — the divergences that are fixed
// and the asymmetry that is deliberately declared.
describe("in-memory driver token matching", () => {
  const context = { actorId: "parity-test", interfaceId: "parity-test" };

  it("plural query terms match singular stored text (pg tsvector parity)", async () => {
    const store = new InMemoryGraphStore();
    const node = await store.capture({
      title: "Sister's wedding",
      type: "claim",
      summary: "My sister's wedding was a small ceremony in June.",
      content: "The ceremony was outdoors.",
      evidence: [],
      links: [],
    }, context);

    const hits = await store.search({ query: "weddings", mode: "lexical", limit: 10, includeTextUnits: false });
    assert.ok(hits.nodes.some((hit) => hit.id === node.id), "'weddings' must find stored 'wedding'");
  });

  it("terms match on token boundaries, never inside other words", async () => {
    const store = new InMemoryGraphStore();
    const node = await store.capture({
      title: "Phone etiquette",
      type: "claim",
      summary: "Call me maybe, but text first.",
      content: "Small talk is fine.",
      evidence: [],
      links: [],
    }, context);

    // The seed graph may legitimately contain the token "all"; the assertion
    // is that matching is by token, so "call"/"small" must NOT count as hits.
    const hits = await store.search({ query: "all", mode: "lexical", limit: 10, includeTextUnits: false });
    assert.ok(!hits.nodes.some((hit) => hit.id === node.id), "'all' must not match inside 'call'/'small'");
  });

  it("declared residual asymmetry: deep morphology is not approximated", async () => {
    const store = new InMemoryGraphStore();
    const node = await store.capture({
      title: "Yesterday's run",
      type: "claim",
      summary: "I ran five kilometers before breakfast.",
      content: "Felt easy.",
      evidence: [],
      links: [],
    }, context);

    // pg's stemmer would relate run/running/ran; the test double deliberately
    // does not (store.ts module doc). This locks the declared boundary so a
    // future parity push must update this test on purpose.
    const hits = await store.search({ query: "running", mode: "lexical", limit: 10, includeTextUnits: false });
    assert.ok(!hits.nodes.some((hit) => hit.id === node.id));
  });
});
