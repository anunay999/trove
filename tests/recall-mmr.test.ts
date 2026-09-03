import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { performRecall } from "../src/graphCore.js";
import type { Reranker } from "../src/rerank.js";
import { suiteStore, closeStore, isolateDatabase } from "./helpers.js";

// Asserts on exact pack order under a fixed budget; a parallel suite's nodes
// would compete for it. Own database.
await isolateDatabase("recall-mmr");

describe("recall diversity", () => {
  const { store, context, stamp } = suiteStore("recall-mmr");
  const query = `syzygy manifest ${stamp}`;
  const recallInput = { query, tokenBudget: 8000, depth: 0, includeEvidence: false };

  const idByLabel = new Map<string, string>();
  const id = (label: string): string => {
    const value = idByLabel.get(label);
    assert.ok(value, `fixture ${label} was not captured`);
    return value;
  };

  before(async () => {
    const body = "The syzygy manifest reconciles orbital burn receipts once per quarter and closes the ledger.";
    for (const [label, summary, content] of [
      ["best", "Syzygy manifest reconciliation.", body],
      // A restatement of `best`: the same fact, the same vocabulary, nothing new.
      ["restatement", "Syzygy manifest reconciliation, restated.", `${body} Each quarter the syzygy manifest reconciles orbital burn receipts.`],
      // Same subject, a different fact — the atom a pack should spend its
      // second slot on.
      ["different", "Syzygy manifest custody.", "Syzygy manifest custody rotation hands the signing key to the finance group, never to a person."],
    ] as const) {
      const node = await store.capture({
        title: `Syzygy manifest ${label} ${stamp}`,
        type: "pattern",
        summary,
        content,
        evidence: [],
        links: [],
      }, context);
      idByLabel.set(label, node.id);
    }
  });

  after(async () => {
    await closeStore(store);
  });

  // The reranker's own order is best > restatement > different. Diversity is
  // the only thing that can move `different` ahead of `restatement`.
  const scores = () => new Map([[id("best"), 1], [id("restatement"), 0.95], [id("different"), 0.9]]);
  const reranker: Reranker = async ({ candidates }) => {
    const byId = scores();
    return candidates.map((candidate) => byId.get(candidate.id) ?? 0);
  };

  it("spends the second slot on a different atom, not a restatement of the first", async () => {
    const pack = await performRecall(store, recallInput, context, { reranker });
    assert.deepEqual(
      pack.atoms.map((atom) => atom.node.id),
      [id("best"), id("different"), id("restatement")],
    );
  });

  it("drops the near-duplicate first when the budget only fits two atoms", async () => {
    // 300 tokens is room for two of these three atoms and no more (the whole
    // pack costs 227 in context and about 400 on the wire). The length
    // assertion is part of the test: if the fixture ever grows, this fails
    // loudly instead of passing for the wrong reason.
    const tight = await performRecall(store, { ...recallInput, tokenBudget: 300 }, context, { reranker });
    const packed = tight.atoms.map((atom) => atom.node.id);
    assert.equal(packed.length, 2, "the budget did not cut exactly one atom");
    assert.deepEqual(packed, [id("best"), id("different")], "the restatement survived the cut");
    assert.equal(tight.truncated, true);
  });

  it("leaves the pack alone when the reranker did not run", async () => {
    const blended = await performRecall(store, recallInput, context);
    const failed = await performRecall(store, recallInput, context, {
      reranker: async () => {
        throw new Error("upstream 500");
      },
    });
    assert.deepEqual(failed.atoms.map((atom) => atom.node.id), blended.atoms.map((atom) => atom.node.id));
    assert.equal(failed.context, blended.context);
  });
});
