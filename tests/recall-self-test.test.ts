import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickSelfTestSample,
  runRecallSelfTest,
  selfTestQuery,
  SELF_TEST_TOKEN_BUDGET,
} from "../src/recallSelfTest.js";
import type { GraphNode } from "../src/contracts.js";
import type { GraphSnapshot, RecallResult } from "../src/graphCore.js";

/**
 * The self-test asks the graph about its own notes in their own words and
 * reports what does not come back. These pin the two things that make the
 * number trustworthy: what counts as a probe, and which notes get probed.
 */

let counter = 0;
function node(overrides: Partial<GraphNode> & { slug: string }): GraphNode {
  counter += 1;
  return {
    id: `node-${counter}`,
    type: "claim",
    title: overrides.slug,
    summary: "A summary long enough to describe the note rather than name it.",
    content: null,
    revisionId: `rev-${counter}`,
    updatedAt: "2026-08-01T00:00:00.000Z",
    accessCount: 0,
    lastAccessedAt: null,
    ...overrides,
  };
}

function fakeStore(nodes: GraphNode[], answer: (query: string) => GraphNode[]) {
  return {
    exportGraph: (): GraphSnapshot => ({ nodes, edges: [], views: [] }),
    recall: (input: { query: string; tokenBudget?: number }): RecallResult => ({
      context: "",
      atoms: answer(input.query).map((hit) => ({
        node: hit,
        provenance: "agent_inference" as const,
        score: 1,
        hops: 0,
        tokens: 10,
        contentTruncated: false,
      })),
      edges: [],
      evidence: [],
      citations: [],
      tokenBudget: input.tokenBudget ?? 0,
      spentTokens: 0,
      truncated: false,
    }),
  };
}

describe("recall self-test probes", () => {
  it("asks with the summary, never the title", () => {
    // A title is matched almost verbatim by the lexical arm, so a title probe
    // would pass for every note — including the shadowed ones this exists to
    // find. The whole check would read clean and mean nothing.
    const described = node({ slug: "described", title: "Refunds", summary: "Annual plans are not refundable after fourteen days." });
    assert.equal(selfTestQuery(described), "Annual plans are not refundable after fourteen days.");
  });

  it("refuses to probe a note whose summary is a label", () => {
    assert.equal(selfTestQuery({ summary: null }), null);
    assert.equal(selfTestQuery({ summary: "   " }), null);
    assert.equal(selfTestQuery({ summary: "Billing" }), null);
  });
});

describe("recall self-test sampling", () => {
  it("takes never-read notes first", () => {
    const cold = node({ slug: "cold", accessCount: 0 });
    const warm = node({ slug: "warm", accessCount: 40 });
    const sample = pickSelfTestSample([warm, cold], 1);
    assert.deepEqual(sample.map((row) => row.slug), ["cold"]);
  });

  it("spreads across types, because shadowing happens inside one cluster", () => {
    const nodes = [
      node({ slug: "claim-a", type: "claim" }),
      node({ slug: "claim-b", type: "claim" }),
      node({ slug: "claim-c", type: "claim" }),
      node({ slug: "pattern-a", type: "pattern" }),
      node({ slug: "decision-a", type: "decision" }),
    ];
    const sample = pickSelfTestSample(nodes, 3);
    assert.deepEqual(
      [...new Set(sample.map((row) => row.type))].sort(),
      ["claim", "decision", "pattern"],
      "one type's luck was measured instead of the graph's",
    );
  });

  it("is deterministic, so two runs can be compared", () => {
    const nodes = [
      node({ slug: "b", type: "claim" }),
      node({ slug: "a", type: "claim" }),
      node({ slug: "c", type: "pattern" }),
    ];
    const first = pickSelfTestSample(nodes, 2).map((row) => row.slug);
    const second = pickSelfTestSample([...nodes].reverse(), 2).map((row) => row.slug);
    assert.deepEqual(first, second);
  });

  it("never picks a note it could not ask about", () => {
    const unprobeable = node({ slug: "bare", summary: null });
    assert.deepEqual(pickSelfTestSample([unprobeable], 5), []);
  });
});

describe("recall self-test results", () => {
  it("counts a note that comes back, and names what shadows one that does not", async () => {
    const hub = node({ slug: "how-ci-runs-the-suite", title: "How CI runs the suite" });
    const leaf = node({ slug: "run-the-suite-locally", title: "Run the suite locally" });
    const store = fakeStore([hub, leaf], (query) =>
      // Both notes describe the same cluster; the hub answers for both.
      query === leaf.summary ? [hub] : [hub]);

    const result = await runRecallSelfTest(store, { sampleSize: 2 });

    assert.equal(result.probed, 2);
    assert.equal(result.found, 1, "the hub found itself and should count");
    assert.equal(result.blindSpots.length, 1);
    const miss = result.blindSpots[0];
    assert.equal(miss?.slug, "run-the-suite-locally");
    assert.equal(miss?.rank, null);
    assert.deepEqual(
      miss?.shadowedBy.map((row) => row.title),
      ["How CI runs the suite"],
      "a miss must name what stood in front of it, or it is not actionable",
    );
  });

  it("probes on a small budget rather than a full pack", async () => {
    const only = node({ slug: "only" });
    let sawBudget: number | undefined;
    const store = {
      exportGraph: (): GraphSnapshot => ({ nodes: [only], edges: [], views: [] }),
      recall: (input: { query: string; tokenBudget?: number }): RecallResult => {
        sawBudget = input.tokenBudget;
        return fakeStore([only], () => [only]).recall(input);
      },
    };
    await runRecallSelfTest(store, { sampleSize: 1 });
    assert.equal(sawBudget, SELF_TEST_TOKEN_BUDGET);
  });

  it("reports the notes it could never have asked about", async () => {
    const askable = node({ slug: "askable" });
    const bare = node({ slug: "bare", summary: null });
    const store = fakeStore([askable, bare], () => [askable]);

    const result = await runRecallSelfTest(store, { sampleSize: 10 });

    assert.equal(result.probed, 1);
    assert.equal(result.found, 1);
    assert.equal(result.skipped, 1, "a clean result over half a graph is not a clean result");
  });
});
