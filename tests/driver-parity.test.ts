import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGraphStore } from "../src/store.js";
import { UnknownEvidenceReferenceError } from "../src/graphCore.js";

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

// Owner scoping on the in-memory driver is limited to what it tracks: sources
// (and so their text units) carry an owner, nodes do not. annotate is the one
// write where that is observable, and it must mirror Postgres: a scoped caller
// citing another owner's source or unit gets the same named error as a
// nonexistent one, so existence never leaks.
describe("in-memory driver owner scoping", () => {
  const ctx = (ownerId?: string) => ({ actorId: "parity-test", interfaceId: "parity-test", ownerId });

  it("annotate rejects another owner's source and text unit like an unknown ref", async () => {
    const store = new InMemoryGraphStore();
    const alice = ctx("alice");
    const bob = ctx("bob");
    const source = await store.ingest({ kind: "agent_note", title: "Alice note", contentText: "Alice's private evidence.", metadata: {} }, alice);
    const unit = source.textUnits[0]!;
    const bobNode = await store.capture({ title: "Bob claim", type: "claim", summary: "Bob's claim.", evidence: [], links: [] }, bob);

    await assert.rejects(
      async () => store.annotate({ motivation: "supports", nodeId: bobNode.id, sourceId: source.source.id, body: {}, selector: {} }, bob),
      UnknownEvidenceReferenceError,
    );
    await assert.rejects(
      async () => store.annotate({ motivation: "supports", nodeId: bobNode.id, textUnitId: unit.id, body: {}, selector: {} }, bob),
      UnknownEvidenceReferenceError,
    );
    // capture's evidence takes the same path.
    await assert.rejects(
      async () => store.capture({ title: "Bob cites Alice", type: "claim", summary: "x", evidence: [{ textUnitId: unit.id, selector: {} }], links: [] }, bob),
      UnknownEvidenceReferenceError,
    );

    // The owner herself, and an unscoped (internal) caller, are unaffected.
    const own = await store.annotate({ motivation: "mentions", textUnitId: unit.id, body: { note: "mine" }, selector: {} }, alice);
    assert.equal(own.textUnitId, unit.id);
    const internal = await store.annotate({ motivation: "mentions", sourceId: source.source.id, body: { note: "system" }, selector: {} }, ctx());
    assert.equal(internal.sourceId, source.source.id);
  });
});
