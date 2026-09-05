import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultUtilityModel, resolveLlmProvider } from "../src/llmProvider.js";

/**
 * One resolver, three callers. Chat, reranking and the reconcile judge each had
 * their own copy of this question and gave three different answers, which is how
 * two callers ended up unconfigurable on a deployment whose LLM key is an
 * OpenRouter one. These pin the single answer.
 */

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

const CLEAR = {
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
};

describe("llm provider resolution", () => {
  it("is null when the deployment has no LLM key at all", () => {
    withEnv(CLEAR, () => assert.equal(resolveLlmProvider(), null));
  });

  it("prefers OpenRouter, because it is the cheap key", () => {
    withEnv({ ...CLEAR, OPENROUTER_API_KEY: "or-1", OPENAI_API_KEY: "sk-1" }, () => {
      const provider = resolveLlmProvider();
      assert.equal(provider?.apiKey, "or-1");
      assert.equal(provider?.baseUrl, "https://openrouter.ai/api/v1");
      assert.equal(provider?.openRouter, true);
    });
  });

  it("falls back to OpenAI when that is the only key", () => {
    withEnv({ ...CLEAR, OPENAI_API_KEY: "sk-1" }, () => {
      const provider = resolveLlmProvider();
      assert.equal(provider?.apiKey, "sk-1");
      assert.equal(provider?.baseUrl, "https://api.openai.com/v1");
      assert.equal(provider?.openRouter, false);
    });
  });

  it("does not move a deployment that named its own endpoint", () => {
    // OPENAI_API_KEY plus an explicit base is someone pointing at a specific
    // gateway. Silently redirecting that to OpenRouter would be the resolver
    // overruling a deliberate choice.
    withEnv({
      ...CLEAR,
      OPENAI_API_KEY: "sk-1",
      OPENROUTER_API_KEY: "or-1",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
    }, () => {
      const provider = resolveLlmProvider();
      assert.equal(provider?.apiKey, "sk-1");
      assert.equal(provider?.baseUrl, "https://api.deepseek.com/v1");
      assert.equal(provider?.openRouter, false);
    });
  });

  it("trims the trailing slash, so callers can append a path", () => {
    withEnv({ ...CLEAR, OPENAI_API_KEY: "sk-1", OPENAI_BASE_URL: "https://gateway.example/v1/" }, () => {
      assert.equal(resolveLlmProvider()?.baseUrl, "https://gateway.example/v1");
    });
  });

  it("names the utility model the way the resolved provider names it", () => {
    assert.equal(
      defaultUtilityModel({ apiKey: "x", baseUrl: "y", openRouter: true }),
      "openai/gpt-4o-mini",
    );
    assert.equal(
      defaultUtilityModel({ apiKey: "x", baseUrl: "y", openRouter: false }),
      "gpt-4o-mini",
    );
  });
});
