import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecallRerankerFromEnv,
  parseRerankScores,
  rerankCandidates,
  rerankPrompt,
  toRerankCandidate,
  RERANK_CANDIDATE_CHARS,
  type RerankCandidate,
  type Reranker,
} from "../src/rerank.js";
import type { GraphNode } from "../src/contracts.js";

const candidate = (id: string): RerankCandidate => ({ id, title: id, summary: null, content: null });

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("recall reranker", () => {
  it("parses a complete reply and clamps scores into [0,1]", () => {
    const scores = parseRerankScores('{"scores":[{"index":2,"score":1.7},{"index":1,"score":-0.4}]}', 2);
    assert.deepEqual(scores, [0, 1]);
  });

  it("rejects a partial reply rather than filling the gaps", () => {
    // Half a ranking is not a ranking: a neutral fill would let an unscored
    // candidate outrank (or undercut) a scored one, indistinguishably.
    assert.equal(parseRerankScores('{"scores":[{"index":1,"score":0.9}]}', 3), null);
  });

  it("rejects replies that are not usable JSON score arrays", () => {
    assert.equal(parseRerankScores("no json here", 1), null);
    assert.equal(parseRerankScores("{not json}", 1), null);
    assert.equal(parseRerankScores('{"verdicts":[]}', 1), null);
    assert.equal(parseRerankScores('{"scores":[{"index":9,"score":1}]}', 1), null);
    assert.equal(parseRerankScores('{"scores":[{"index":1,"score":"high"}]}', 1), null);
  });

  it("bounds the text one candidate contributes to the prompt", () => {
    const node = {
      id: "n1",
      type: "pattern",
      slug: "long",
      title: "Long note",
      summary: "s".repeat(1000),
      content: "c".repeat(10_000),
      revisionId: "r1",
      updatedAt: new Date().toISOString(),
      accessCount: 0,
      lastAccessedAt: null,
    } as GraphNode;
    const bounded = toRerankCandidate(node);
    assert.equal(bounded.content?.length, RERANK_CANDIDATE_CHARS);
    assert.ok((bounded.summary?.length ?? 0) < 1000);
    assert.ok(rerankPrompt("q", [bounded]).length < 2_000);
  });

  it("is unconfigured unless the opt-in flag and a key are both present", () => {
    withEnv({ TROVE_RECALL_RERANK: undefined, OPENAI_API_KEY: "sk-test" }, () => {
      assert.equal(createRecallRerankerFromEnv(), null);
    });
    withEnv({ TROVE_RECALL_RERANK: "1", OPENAI_API_KEY: undefined }, () => {
      assert.equal(createRecallRerankerFromEnv(), null);
    });
    withEnv({ TROVE_RECALL_RERANK: "yes", OPENAI_API_KEY: "sk-test" }, () => {
      assert.equal(typeof createRecallRerankerFromEnv(), "function");
    });
  });

  describe("rerankCandidates fails open", () => {
    const batch = { query: "q", candidates: [candidate("a"), candidate("b")] };

    it("returns scores by id when the provider answers", async () => {
      const reranker: Reranker = async () => [0.2, 0.9];
      const scores = await rerankCandidates(reranker, batch);
      assert.deepEqual([...(scores ?? new Map())], [["a", 0.2], ["b", 0.9]]);
    });

    it("returns null with no provider or no candidates", async () => {
      assert.equal(await rerankCandidates(null, batch), null);
      assert.equal(await rerankCandidates(async () => [], { query: "q", candidates: [] }), null);
    });

    it("returns null when the provider throws", async () => {
      const reranker: Reranker = async () => {
        throw new Error("upstream 500");
      };
      assert.equal(await rerankCandidates(reranker, batch), null);
    });

    it("returns null when the provider outruns the timeout", async () => {
      const reranker: Reranker = () => new Promise<number[]>(() => {});
      const started = Date.now();
      assert.equal(await rerankCandidates(reranker, batch, { timeoutMs: 25 }), null);
      assert.ok(Date.now() - started < 2_000, "the deadline did not fire");
    });

    it("returns null when the reply does not line up with the candidates", async () => {
      assert.equal(await rerankCandidates(async () => [0.5], batch), null);
      assert.equal(await rerankCandidates(async () => [0.5, Number.NaN], batch), null);
    });
  });
});
