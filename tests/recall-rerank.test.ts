import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { performRecall } from "../src/graphCore.js";
import type { Reranker } from "../src/rerank.js";
import { suiteStore, closeStore, isolateDatabase } from "./helpers.js";

// Recall packs are budget-sensitive and this suite asserts on exact ordering,
// so nodes left by a parallel suite would change what gets packed. Own database.
await isolateDatabase("recall-rerank");

describe("recall reranking", () => {
  const { store, context, stamp } = suiteStore("recall-rerank");
  const query = `perihelion ledger ${stamp}`;
  const recallInput = { query, tokenBudget: 8000, depth: 0, includeEvidence: false };

  /** Ids in capture order, so a fake can promote a known one. */
  const ids: string[] = [];
  let baseline: Awaited<ReturnType<typeof performRecall>>;

  before(async () => {
    for (const [index, body] of [
      "The perihelion ledger reconciles orbital burn receipts once per quarter.",
      "Perihelion ledger retention keeps closed quarters for seven years before archival.",
      "The perihelion ledger dashboard renders a burn-down of unreconciled receipts.",
      "Perihelion ledger access is granted through the finance group, never per person.",
    ].entries()) {
      const node = await store.capture({
        title: `Perihelion ledger note ${index} ${stamp}`,
        type: "pattern",
        summary: `Perihelion ledger note ${index}.`,
        content: body,
        evidence: [],
        links: [],
      }, context);
      ids.push(node.id);
    }

    baseline = await performRecall(store, recallInput, context);
    assert.ok(baseline.atoms.length >= 2, "fixture did not produce a rankable pack");
  });

  after(async () => {
    await closeStore(store);
  });

  const sameRanking = (
    actual: Awaited<ReturnType<typeof performRecall>>,
    message: string,
  ): void => {
    assert.deepEqual(actual.atoms.map((atom) => atom.node.id), baseline.atoms.map((atom) => atom.node.id), message);
    assert.equal(actual.context, baseline.context, `${message} (rendered context differs)`);
  };

  it("packs the candidate the reranker promoted, not the one the blend chose", async () => {
    const promoted = baseline.atoms.at(-1)?.node.id;
    assert.ok(promoted, "no trailing atom to promote");
    assert.notEqual(baseline.atoms[0]?.node.id, promoted, "the fixture already ranked it first");

    let calls = 0;
    const reranker: Reranker = async ({ candidates }) => {
      calls += 1;
      return candidates.map((candidate) => (candidate.id === promoted ? 1 : 0));
    };

    const reranked = await performRecall(store, recallInput, context, { reranker });
    assert.equal(calls, 1, "the reranker should be called once per recall, batched");
    assert.equal(reranked.atoms[0]?.node.id, promoted, "the promoted atom did not lead the pack");
    assert.ok(reranked.context.indexOf(String(reranked.atoms[0]?.node.slug)) >= 0);
  });

  it("keeps the reranker's relative order across the whole reranked head", async () => {
    // Score is the reverse of the fixture order, so the pack must invert too.
    const rank = new Map(ids.map((id, index) => [id, (index + 1) / ids.length]));
    const reranker: Reranker = async ({ candidates }) => candidates.map((candidate) => rank.get(candidate.id) ?? 0);
    const reranked = await performRecall(store, recallInput, context, { reranker });
    const order = reranked.atoms.map((atom) => atom.node.id).filter((id) => rank.has(id));
    const expected = [...order].sort((left, right) => (rank.get(right) ?? 0) - (rank.get(left) ?? 0));
    assert.deepEqual(order, expected);
  });

  it("falls back to today's ranking when the reranker throws", async () => {
    const reranker: Reranker = async () => {
      throw new Error("upstream 500");
    };
    sameRanking(await performRecall(store, recallInput, context, { reranker }), "a throwing reranker changed the ranking");
  });

  it("falls back to today's ranking when the reranker times out", async () => {
    const saved = process.env.TROVE_RECALL_RERANK_TIMEOUT_MS;
    process.env.TROVE_RECALL_RERANK_TIMEOUT_MS = "25";
    try {
      const reranker: Reranker = () => new Promise<number[]>(() => {});
      sameRanking(await performRecall(store, recallInput, context, { reranker }), "a hung reranker changed the ranking");
    } finally {
      if (saved === undefined) delete process.env.TROVE_RECALL_RERANK_TIMEOUT_MS;
      else process.env.TROVE_RECALL_RERANK_TIMEOUT_MS = saved;
    }
  });

  it("falls back to today's ranking when the reranker returns an unusable answer", async () => {
    sameRanking(
      await performRecall(store, recallInput, context, { reranker: async () => [0.5] }),
      "a short reply changed the ranking",
    );
  });

  it("is byte-identical to today with the opt-in flag off", async () => {
    // No injected provider and no TROVE_RECALL_RERANK: the env-built reranker
    // is null, so recall must take exactly the path it took before this landed.
    assert.ok(!process.env.TROVE_RECALL_RERANK, "the suite must run with the flag unset");
    sameRanking(await performRecall(store, recallInput, context), "the unflagged path diverged");
    sameRanking(await performRecall(store, recallInput, context, { reranker: null }), "an explicit null reranker diverged");
  });
});
