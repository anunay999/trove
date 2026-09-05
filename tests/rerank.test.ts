import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecallRerankerFromEnv,
  parseRerankScores,
  rerankCandidates,
  rerankPrompt,
  mmrOrder,
  termOverlapSimilarity,
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

  it("needs a provider, and nothing else", () => {
    const noKeys = { OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, OPENAI_BASE_URL: undefined };
    // No key, no reranking, whatever the flag says.
    withEnv({ ...noKeys, TROVE_RECALL_RERANK: "1" }, () => {
      assert.equal(createRecallRerankerFromEnv(), null);
    });
    // A key is enough: this shipped opt-in and then sat dark for months in the
    // one deployment that had a key, handing every answer an unranked order.
    withEnv({ ...noKeys, TROVE_RECALL_RERANK: undefined, OPENAI_API_KEY: "sk-test" }, () => {
      assert.equal(typeof createRecallRerankerFromEnv(), "function");
    });
    // Whichever LLM key the deployment has is the reranker's key too. It needs
    // none of its own — two bespoke variables once existed for this and were
    // the wrong answer to a duplicated resolver.
    withEnv({ ...noKeys, OPENROUTER_API_KEY: "or-test" }, () => {
      assert.equal(typeof createRecallRerankerFromEnv(), "function");
    });
    // And a deployment can still say no.
    for (const value of ["0", "false", "off", "no"]) {
      withEnv({ ...noKeys, TROVE_RECALL_RERANK: value, OPENAI_API_KEY: "sk-test" }, () => {
        assert.equal(createRecallRerankerFromEnv(), null, `value ${JSON.stringify(value)} must disable reranking`);
      });
    }
  });

  /**
   * Reranking runs on every recall, so it is the call that most wants the cheap
   * provider. These pin that it follows the shared resolver — including the
   * model id, since a bare "gpt-4o-mini" is an OpenAI name and OpenRouter
   * namespaces the same model.
   */
  it("follows the shared provider, model id and all", async () => {
    const seen: Array<{ url: string; auth: string | null; model: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { headers?: Record<string, string>; body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { model?: unknown };
      seen.push({ url: String(url), auth: init?.headers?.authorization ?? null, model: body.model });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"scores":[{"index":1,"score":0.5}]}' } }] }),
      };
    }) as unknown as typeof globalThis.fetch;

    try {
      const cheap = withEnv({
        TROVE_RECALL_RERANK: "1",
        OPENROUTER_API_KEY: "or-cheap",
        OPENAI_API_KEY: "sk-embeddings",
        OPENAI_BASE_URL: undefined,
        TROVE_RECALL_RERANK_MODEL: undefined,
      }, () => createRecallRerankerFromEnv());
      assert.ok(cheap);
      await cheap({ query: "q", candidates: [candidate("a")] });

      const openai = withEnv({
        TROVE_RECALL_RERANK: "1",
        OPENROUTER_API_KEY: undefined,
        OPENAI_API_KEY: "sk-embeddings",
        OPENAI_BASE_URL: undefined,
        TROVE_RECALL_RERANK_MODEL: undefined,
      }, () => createRecallRerankerFromEnv());
      assert.ok(openai);
      await openai({ query: "q", candidates: [candidate("a")] });
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(seen[0]?.auth, "Bearer or-cheap");
    assert.equal(seen[0]?.model, "openai/gpt-4o-mini");
    assert.equal(seen[1]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen[1]?.auth, "Bearer sk-embeddings");
    assert.equal(seen[1]?.model, "gpt-4o-mini");
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

describe("maximal marginal relevance", () => {
  const item = (id: string, score: number, text: string) => ({ id, score, text });
  const accessors = {
    score: (entry: { score: number }) => entry.score,
    text: (entry: { text: string }) => entry.text,
  };
  const order = (items: Array<{ id: string; score: number; text: string }>, lambda?: number) =>
    mmrOrder(items, accessors, lambda === undefined ? {} : { lambda }).map((entry) => entry.id);

  const ledger = "quarterly ledger reconciles orbital burn receipts";
  const items = [
    item("best", 1, ledger),
    item("restatement", 0.95, `${ledger} each quarter`),
    item("different", 0.9, "custody rotation hands the signing key to the finance group"),
  ];

  it("demotes a near-duplicate below a lower-scored atom that says something else", () => {
    assert.deepEqual(order(items), ["best", "different", "restatement"]);
  });

  it("never demotes the top answer", () => {
    assert.equal(order(items)[0], "best");
  });

  it("reorders nothing when no two atoms are alike", () => {
    const distinct = [
      item("a", 1, "orbital burn receipts reconciled quarterly"),
      item("b", 0.9, "custody rotation signing key finance"),
      item("c", 0.8, "retention archives closed quarters after seven years"),
    ];
    assert.deepEqual(order(distinct), ["a", "b", "c"]);
  });

  it("is the identity at lambda 1, and a novelty sort at lambda 0", () => {
    assert.deepEqual(order(items, 1), ["best", "restatement", "different"]);
    assert.deepEqual(order(items, 0), ["best", "different", "restatement"]);
  });

  it("keeps every item — dropping is the budgeter's job", () => {
    assert.equal(mmrOrder(items, accessors).length, items.length);
  });

  it("scores overlap on the shared vocabulary, not on length", () => {
    const left = new Set(["ledger", "orbital", "burn"]);
    assert.equal(termOverlapSimilarity(left, left), 1);
    assert.equal(termOverlapSimilarity(left, new Set(["custody", "rotation"])), 0);
    assert.equal(termOverlapSimilarity(left, new Set()), 0);
  });
});
