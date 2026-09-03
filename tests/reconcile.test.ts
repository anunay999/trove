import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "../src/contracts.js";
import type { GraphJob, GraphOperationContext, GraphStore } from "../src/graphCore.js";
import { performRecall } from "../src/graphCore.js";
import { InMemoryGraphStore } from "../src/store.js";
import { PgGraphStore } from "../src/pgStore.js";
import {
  createReconcileJudgeFromEnv,
  parseReconcileJudgment,
  parseReconcileJudgments,
  partitionReconcileCandidates,
  performReconcileNode,
  type ReconcileJudge,
} from "../src/reconcile.js";
import { isolateDatabase, hasPostgres } from "./helpers.js";

// Queue-state assertions: own database under Postgres (see helpers.isolateDatabase).
await isolateDatabase("reconcile");

const context: GraphOperationContext = {
  actorId: "reconcile-test",
  interfaceId: "reconcile-test",
  requestId: "reconcile-test",
};

async function reconcileJobFor(store: GraphStore, nodeId: string): Promise<GraphJob> {
  const listed = await store.jobs({ kind: "reconcile_node", limit: 100 });
  const job = listed.find((candidate) => (candidate.payload as Record<string, unknown>).nodeId === nodeId);
  assert.ok(job, `expected a reconcile_node job for node ${nodeId}`);
  return job;
}

async function capture(store: GraphStore, title: string, content: string): Promise<GraphNode> {
  return await store.capture({ title, type: "claim", summary: content, content, evidence: [], links: [] }, context);
}

describe("reconcile: write-path enqueue", () => {
  it("capture enqueues a per-node reconcile job; a content update dedupes onto it", async () => {
    const store = new InMemoryGraphStore();
    const node = await capture(store, "Enqueue target", "First version of the fact.");

    const first = await reconcileJobFor(store, node.id);
    assert.equal(first.dedupeKey, `reconcile:${node.id}`);

    const updated = await store.update({ nodeId: node.id, content: "Revised version of the fact.", baseRevisionId: node.revisionId }, context);
    assert.ok(updated && !("conflict" in updated), "update should succeed");

    const jobs = (await store.jobs({ kind: "reconcile_node", limit: 100 }))
      .filter((job) => (job.payload as Record<string, unknown>).nodeId === node.id);
    assert.equal(jobs.length, 1, "pending reconcile job must absorb the update's enqueue");
    assert.equal(jobs[0]?.id, first.id);
  });

  it("a title-only update does not enqueue a second reconcile job", async () => {
    const store = new InMemoryGraphStore();
    const node = await capture(store, "Title-only target", "Unchanged body.");
    const job = await reconcileJobFor(store, node.id);
    await store.runJob({ jobId: job.id }, context); // drain the capture's job

    await store.update({ nodeId: node.id, title: "Title-only target (renamed)", baseRevisionId: node.revisionId }, context);
    const jobs = (await store.jobs({ kind: "reconcile_node", limit: 100 }))
      .filter((job) => (job.payload as Record<string, unknown>).nodeId === node.id && job.status === "pending");
    assert.equal(jobs.length, 0, "no new claims means nothing to reconcile");
  });
});

describe("reconcile: heuristic judge (no LLM configured)", () => {
  it("flags near-identical titles as possible_duplicate and mutates nothing", async () => {
    const store = new InMemoryGraphStore();
    const oldNode = await capture(store, "Team offsite venue decision", "The offsite will be at the lakeside center.");
    const newNode = await capture(store, "Team offsite venue decision", "The offsite is at the lakeside center, confirmed.");

    const job = await reconcileJobFor(store, newNode.id);
    const done = await store.runJob({ jobId: job.id }, context);
    assert.equal(done?.status, "succeeded");
    const result = done?.result as Record<string, unknown>;
    assert.equal(result.judge, "heuristic");

    const flags = result.flags as Array<{ code: string; otherNodeId: string }>;
    assert.ok(
      flags.some((flag) => flag.code === "possible_duplicate" && flag.otherNodeId === oldNode.id),
      `expected a possible_duplicate flag against ${oldNode.id}; got ${JSON.stringify(flags)}`,
    );
    const superseded = await store.supersededBy([oldNode.id], context);
    assert.equal(superseded.size, 0, "the heuristic must never create supersedes edges");
  });

  it("leaves clearly distinct nodes alone", async () => {
    const store = new InMemoryGraphStore();
    await capture(store, "Recreational volleyball record", "The league record stands at 4-2.");
    const unrelated = await capture(store, "Banana bread recipe", "Two ripe bananas, one cup of flour.");

    const job = await reconcileJobFor(store, unrelated.id);
    const done = await store.runJob({ jobId: job.id }, context);
    const result = done?.result as Record<string, unknown>;
    assert.deepEqual(result.flags, []);
    assert.deepEqual(result.supersedesEdgesCreated, []);
  });
});

describe("reconcile: LLM-judged path (fake judge)", () => {
  const supersedesJudge: ReconcileJudge = async ({ candidates }) =>
    candidates.map((candidate) =>
      candidate.title.includes("4-2")
        ? { verdict: "supersedes", confidence: 0.95, reason: "same metric, newer value" }
        : { verdict: "related", confidence: 0.9, reason: "different subject" },
    );

  async function runJudgedScenario(store: GraphStore): Promise<{ oldNode: GraphNode; newNode: GraphNode }> {
    const oldNode = await capture(store, "Volleyball record is 4-2", "The recreational league record is 4 wins, 2 losses.");
    const newNode = await capture(store, "Volleyball record is 5-2", "Update: the recreational league record is now 5 wins, 2 losses.");
    const job = await reconcileJobFor(store, newNode.id);
    const done = await store.runJob({ jobId: job.id }, context);
    assert.equal(done?.status, "succeeded");
    return { oldNode, newNode };
  }

  it("a confident supersedes verdict creates a supersedes edge and recall marks the old atom", async () => {
    const store = new InMemoryGraphStore({ reconcileJudge: supersedesJudge });
    const { oldNode, newNode } = await runJudgedScenario(store);

    const superseded = await store.supersededBy([oldNode.id], context);
    assert.equal(superseded.get(oldNode.id)?.byNodeId, newNode.id);

    const pack = await performRecall(store, { query: "volleyball record", tokenBudget: 8000, depth: 0, includeEvidence: false }, context);
    assert.ok(
      pack.context.includes(`SUPERSEDED by ${newNode.title}`),
      `expected the old atom's header to carry the supersede mark; context:\n${pack.context}`,
    );
  });

  it("a contradicts verdict flags the pair without mutating the graph", async () => {
    const store = new InMemoryGraphStore({
      reconcileJudge: async ({ candidates }) =>
        candidates.map(() => ({ verdict: "contradicts", confidence: 0.9, reason: "values disagree, recency unclear" })),
    });
    const oldNode = await capture(store, "Deploy window is Tuesday", "Releases go out on Tuesdays.");
    const newNode = await capture(store, "Deploy window is Thursday", "Releases go out on Thursdays.");

    const job = await reconcileJobFor(store, newNode.id);
    const done = await store.runJob({ jobId: job.id }, context);
    const result = done?.result as Record<string, unknown>;
    const flags = result.flags as Array<{ code: string; otherNodeId: string }>;
    assert.ok(flags.some((flag) => flag.code === "contradiction_candidate" && flag.otherNodeId === oldNode.id));
    assert.equal((await store.supersededBy([oldNode.id], context)).size, 0);
  });

  it("an unparseable or low-confidence judge reply triggers no action", async () => {
    const store = new InMemoryGraphStore({
      reconcileJudge: async ({ candidates }) => candidates.map(() => parseReconcileJudgment("I'm not sure, these seem kind of similar?")),
    });
    const oldNode = await capture(store, "Volleyball record is 4-2", "The recreational league record is 4-2.");
    const newNode = await capture(store, "Volleyball record is 5-2", "The recreational league record is now 5-2.");

    const job = await reconcileJobFor(store, newNode.id);
    const done = await store.runJob({ jobId: job.id }, context);
    const result = done?.result as Record<string, unknown>;
    assert.deepEqual(result.flags, []);
    assert.equal((await store.supersededBy([oldNode.id], context)).size, 0);
  });
});

describe("reconcile: judged flags reach lint", () => {
  // The other half of the loop: duplicate and contradiction verdicts used to
  // terminate in graph_job.result, which nothing read.
  const duplicateJudge: ReconcileJudge = async ({ candidates }) =>
    candidates.map(() => ({ verdict: "duplicate", confidence: 0.95, reason: "same fact restated" }));
  const contradictsJudge: ReconcileJudge = async ({ candidates }) =>
    candidates.map(() => ({ verdict: "contradicts", confidence: 0.9, reason: "values disagree, recency unclear" }));

  const reconcileFindings = async (store: GraphStore) =>
    (await store.lint(context)).findings.filter((finding) => finding.code.startsWith("reconcile_"));

  it("a judged duplicate becomes a reconcile_duplicate finding naming both nodes", async () => {
    const store = new InMemoryGraphStore({ reconcileJudge: duplicateJudge });
    const oldNode = await capture(store, "Standup is at nine", "The team standup starts at 09:00.");
    const newNode = await capture(store, "Standup is at nine am", "The team standup starts at nine in the morning.");

    const job = await reconcileJobFor(store, newNode.id);
    assert.equal((await store.runJob({ jobId: job.id }, context))?.status, "succeeded");

    const findings = await reconcileFindings(store);
    const finding = findings.find((candidate) => candidate.code === "reconcile_duplicate");
    assert.ok(finding, `expected a reconcile_duplicate finding; got ${JSON.stringify(findings)}`);
    assert.equal(finding.severity, "warning");
    assert.equal(finding.entityId, newNode.id, "the finding hangs off the node that was reconciled");
    assert.ok(finding.message.includes(oldNode.id), "the other node's id must be actionable from the message");
    assert.ok(finding.message.includes(oldNode.slug), "the other node's slug must be in the message");
    assert.ok(finding.message.includes("same fact restated"), "the judge's reason must survive");
  });

  it("a judged contradiction becomes a reconcile_contradiction finding naming both nodes", async () => {
    const store = new InMemoryGraphStore({ reconcileJudge: contradictsJudge });
    const oldNode = await capture(store, "Deploy window is Tuesday", "Releases go out on Tuesdays.");
    const newNode = await capture(store, "Deploy window is Thursday", "Releases go out on Thursdays.");

    const job = await reconcileJobFor(store, newNode.id);
    await store.runJob({ jobId: job.id }, context);

    const findings = await reconcileFindings(store);
    const finding = findings.find((candidate) => candidate.code === "reconcile_contradiction");
    assert.ok(finding, `expected a reconcile_contradiction finding; got ${JSON.stringify(findings)}`);
    assert.equal(finding.entityId, newNode.id);
    assert.ok(finding.message.includes(oldNode.id));
  });

  it("re-judging a node that is no longer flagged clears its finding", async () => {
    let verdict: "duplicate" | "related" = "duplicate";
    const store = new InMemoryGraphStore({
      reconcileJudge: async ({ candidates }) => candidates.map(() => ({ verdict, confidence: 0.95, reason: "judged" })),
    });
    await capture(store, "Standup is at nine", "The team standup starts at 09:00.");
    const newNode = await capture(store, "Standup is at nine am", "The team standup starts at nine in the morning.");
    await store.runJob({ jobId: (await reconcileJobFor(store, newNode.id)).id }, context);
    assert.equal((await reconcileFindings(store)).length, 1);

    verdict = "related";
    const rerun = await store.enqueueJob({ kind: "reconcile_node", payload: { nodeId: newNode.id }, priority: 50 }, context);
    await store.runJob({ jobId: rerun.id }, context);
    assert.deepEqual(await reconcileFindings(store), [], "the latest pass is the whole truth about that node");
  });

  it("nothing surfaces before reconciliation has run", async () => {
    const store = new InMemoryGraphStore({ reconcileJudge: duplicateJudge });
    await capture(store, "Standup is at nine", "The team standup starts at 09:00.");
    await capture(store, "Standup is at nine am", "The team standup starts at nine in the morning.");
    assert.deepEqual(await reconcileFindings(store), [], "the job is enqueued, not run");
  });

  it("nothing surfaces with the judge disabled, even when the heuristic flags a duplicate", async () => {
    // The heuristic's duplicate signal is title-token overlap, which is what
    // duplicate_title already reports; only a judged verdict earns a new code.
    const store = new InMemoryGraphStore();
    const oldNode = await capture(store, "Team offsite venue decision", "The offsite will be at the lakeside center.");
    const newNode = await capture(store, "Team offsite venue decision", "The offsite is at the lakeside center, confirmed.");

    const done = await store.runJob({ jobId: (await reconcileJobFor(store, newNode.id)).id }, context);
    const result = done?.result as Record<string, unknown>;
    const flags = result.flags as Array<{ code: string; otherNodeId: string }>;
    assert.ok(flags.some((flag) => flag.code === "possible_duplicate" && flag.otherNodeId === oldNode.id), "the job still flags it");
    assert.deepEqual(await reconcileFindings(store), []);
  });

  it("caps reconcile findings so a mass re-judge cannot flood the report", async () => {
    const store = new InMemoryGraphStore();
    const other = await capture(store, "Cap fixture anchor", "Anchor node for the cap fixture.");
    for (let i = 0; i < 60; i++) {
      const node = await capture(store, `Cap fixture ${i}`, `Body ${i}.`);
      await store.recordReconcileFlags(
        { nodeId: node.id, flags: [{ code: "possible_duplicate", otherNodeId: other.id, detail: "fixture" }] },
        context,
      );
    }
    assert.equal((await reconcileFindings(store)).length, 50);
  });
});

describe("reconcile: judge reply parsing", () => {
  it("parses a well-formed reply and clamps confidence", () => {
    const judgment = parseReconcileJudgment('{"verdict":"supersedes","confidence":1.4,"reason":"newer value"}');
    assert.equal(judgment.verdict, "supersedes");
    assert.equal(judgment.confidence, 1);
    assert.equal(judgment.reason, "newer value");
  });

  it("degrades garbage and unknown verdicts to a safe no-op", () => {
    const garbage = parseReconcileJudgment("not json at all");
    assert.equal(garbage.verdict, "related");
    assert.equal(garbage.confidence, 0);

    const unknown = parseReconcileJudgment('{"verdict":"merge","confidence":0.99}');
    assert.equal(unknown.verdict, "related");
    assert.equal(unknown.confidence, 0.99, "confidence is kept but the unknown verdict drives no action");
  });

  it("parses a batched reply index-aligned, degrading gaps to safe no-ops", () => {
    const judgments = parseReconcileJudgments(
      '{"verdicts":[{"index":2,"verdict":"supersedes","confidence":0.92,"reason":"newer value"},{"index":9,"verdict":"duplicate"}]}',
      2,
    );
    assert.equal(judgments.length, 2);
    assert.equal(judgments[0]?.verdict, "related", "a missing entry degrades to the safe default");
    assert.equal(judgments[0]?.confidence, 0);
    assert.equal(judgments[1]?.verdict, "supersedes");
    assert.equal(judgments[1]?.confidence, 0.92);

    const garbage = parseReconcileJudgments("not json at all", 3);
    assert.equal(garbage.length, 3);
    assert.ok(garbage.every((judgment) => judgment.verdict === "related" && judgment.confidence === 0));
  });

  it("rejects entries whose echoed title does not match the candidate they claim", () => {
    // Observed live: gpt-4o-mini copied a supersedes verdict onto an unrelated
    // candidate, reason and all. The echoed title makes the bleed detectable.
    const candidates = [{ title: "Volleyball record is 4-2" }, { title: "Banana bread recipe" }];
    const bled = parseReconcileJudgments(
      '{"verdicts":[' +
        '{"index":1,"title":"Volleyball record is 4-2","verdict":"supersedes","confidence":0.9,"reason":"newer value"},' +
        '{"index":2,"title":"Volleyball record is 4-2","verdict":"supersedes","confidence":0.9,"reason":"copied across"}' +
        "]}",
      2,
      candidates,
    );
    assert.equal(bled[0]?.verdict, "supersedes", "the correctly-grounded entry stands");
    assert.equal(bled[1]?.verdict, "related", "the copied verdict is rejected as unverifiable");
    assert.equal(bled[1]?.confidence, 0);

    const titleless = parseReconcileJudgments('{"verdicts":[{"index":1,"verdict":"supersedes","confidence":0.9}]}', 1, candidates);
    assert.equal(titleless[0]?.verdict, "related", "a missing echo is unverifiable, not trusted");
  });
});

describe("reconcile: batched judging", () => {
  it("judges every surviving candidate in ONE call", async () => {
    let calls = 0;
    let seen = 0;
    const store = new InMemoryGraphStore({
      reconcileJudge: async ({ candidates }) => {
        calls += 1;
        seen = candidates.length;
        return candidates.map(() => ({ verdict: "related", confidence: 0.9, reason: "counted" }));
      },
    });
    await capture(store, "Volleyball record is 4-2", "The recreational league record is 4 wins, 2 losses.");
    await capture(store, "Volleyball record is 4-3", "The recreational league record briefly stood at 4 wins, 3 losses.");
    const newNode = await capture(store, "Volleyball record is 5-2", "Update: the recreational league record is now 5 wins, 2 losses.");

    const job = await reconcileJobFor(store, newNode.id);
    const done = await store.runJob({ jobId: job.id }, context);
    const result = done?.result as Record<string, unknown>;
    assert.equal(calls, 1, "N candidates must cost exactly one judge call");
    assert.equal(seen, 2);
    assert.equal(result.judgeCalls, 1);
    const candidates = result.candidates as Array<{ via: string }>;
    assert.ok(candidates.every((candidate) => candidate.via === "judge"), "no provider configured: lexical-only hits are always judged");
  });
});

describe("reconcile: distance gate (backlog #27)", () => {
  // The gate's partition is the load-bearing decision: far candidates are
  // excused without a call, unknown distance is never treated as far.
  it("partitionReconcileCandidates skips only known-far candidates", () => {
    const finalists = [
      { id: "near", distance: 0.1 },
      { id: "edge", distance: 0.45 },
      { id: "far", distance: 0.5 },
      { id: "lexical-only", distance: undefined },
    ];
    const { toJudge, skipped } = partitionReconcileCandidates(finalists, 0.45);
    assert.deepEqual(toJudge.map((entry) => entry.id), ["near", "edge", "lexical-only"]);
    assert.deepEqual(skipped.map((entry) => entry.id), ["far"]);
  });

  function fakeNode(id: string, title: string): GraphNode {
    return {
      id, type: "claim", slug: id, title, summary: null, content: null,
      revisionId: `${id}-rev`, updatedAt: new Date().toISOString(), accessCount: 0, lastAccessedAt: null,
    };
  }

  function stubStore(semantic: Array<GraphNode & { distance?: number }>, lexical: GraphNode[] = []): GraphStore {
    return {
      read: async () => fakeNode("new-node", "New fact title"),
      search: async (input: { mode?: string }) =>
        input.mode === "semantic" ? { nodes: semantic, textUnits: [] } : { nodes: lexical, textUnits: [] },
      link: async () => null,
      recordReconcileFlags: async () => {},
    } as unknown as GraphStore;
  }

  it("far candidates are recorded via distance_gate and never reach the judge", async () => {
    const near = { ...fakeNode("near", "Near neighbour"), distance: 0.1 };
    const far = { ...fakeNode("far", "Far neighbour"), distance: 0.5 };
    let judged: string[] = [];
    const result = await performReconcileNode(
      stubStore([near, far]),
      { nodeId: "new-node" },
      async ({ candidates }) => {
        judged = candidates.map((candidate) => candidate.id);
        return candidates.map(() => ({ verdict: "related", confidence: 0.5, reason: "ok" }));
      },
    );
    assert.deepEqual(judged, ["near"], "only the near candidate is judged");
    assert.equal(result.judgeCalls, 1);
    const gated = result.candidates.find((candidate) => candidate.nodeId === "far");
    assert.equal(gated?.via, "distance_gate");
    assert.equal(gated?.verdict, "distinct");
    assert.equal(gated?.distance, 0.5);
  });

  it("a write with no near neighbour makes ZERO judge calls", async () => {
    let calls = 0;
    const result = await performReconcileNode(
      stubStore([{ ...fakeNode("far-1", "Far one"), distance: 0.52 }, { ...fakeNode("far-2", "Far two"), distance: 0.49 }]),
      { nodeId: "new-node" },
      async ({ candidates }) => {
        calls += 1;
        return candidates.map(() => ({ verdict: "related", confidence: 0.5, reason: "ok" }));
      },
    );
    assert.equal(calls, 0);
    assert.equal(result.judgeCalls, 0);
    assert.equal(result.candidates.every((candidate) => candidate.via === "distance_gate"), true);
  });

  it("lexical-only candidates (no distance) are always judged", async () => {
    let judged: string[] = [];
    const result = await performReconcileNode(
      stubStore([], [fakeNode("renamed", "Renamed fact")]),
      { nodeId: "new-node" },
      async ({ candidates }) => {
        judged = candidates.map((candidate) => candidate.id);
        return candidates.map(() => ({ verdict: "related", confidence: 0.5, reason: "ok" }));
      },
    );
    assert.deepEqual(judged, ["renamed"], "a renamed fact is exactly the case embeddings can miss");
    assert.equal(result.candidates[0]?.distance, null);
  });

  it("the per-owner budget leaves overflow unjudged, flagged, and still succeeds", async () => {
    const saved = process.env.TROVE_RECONCILE_JUDGE_BUDGET;
    process.env.TROVE_RECONCILE_JUDGE_BUDGET = "1";
    const ownerId = `budget-test-${Date.now()}`;
    try {
      const store = stubStore([{ ...fakeNode("near", "Near neighbour"), distance: 0.1 }]);
      const judge: ReconcileJudge = async ({ candidates }) =>
        candidates.map(() => ({ verdict: "related", confidence: 0.5, reason: "ok" }));

      const first = await performReconcileNode(store, { nodeId: "new-node", ownerId }, judge);
      assert.equal(first.judgeCalls, 1, "the first write consumes the single budgeted call");

      const second = await performReconcileNode(store, { nodeId: "new-node", ownerId }, judge);
      assert.equal(second.judgeCalls, 0, "the second write is over budget");
      assert.equal(second.candidates[0]?.via, "budget");
      assert.ok(second.flags.some((flag) => flag.code === "judge_budget_exceeded"));
    } finally {
      if (saved === undefined) delete process.env.TROVE_RECONCILE_JUDGE_BUDGET;
      else process.env.TROVE_RECONCILE_JUDGE_BUDGET = saved;
    }
  });
});

describe("reconcile: judge is opt-in via TROVE_RECONCILE_JUDGE=1", () => {
  // The env-var default is what keeps unbounded per-write LLM spend out of
  // deployments that never asked for it (backlog #27 is the real gate).
  function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      saved[key] = process.env[key];
      if (vars[key] === undefined) delete process.env[key];
      else process.env[key] = vars[key];
    }
    try {
      run();
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it("stays off for absent, falsey and unrecognised values, even with a key present", () => {
    // Unrecognised means OFF: the expensive direction must never be reached by
    // accident. Absence of the var is the shipped default.
    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      withEnv({ TROVE_RECONCILE_JUDGE: value, OPENAI_API_KEY: "sk-test" }, () => {
        assert.equal(createReconcileJudgeFromEnv(), null, `value ${JSON.stringify(value)} must not enable the judge`);
      });
    }
  });

  it("accepts the affirmative forms an operator actually types", () => {
    // A strict `=== "1"` made TROVE_RECONCILE_JUDGE=true a silent no-op —
    // config that reads as enabled and is not. Same failure class as #9.
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      withEnv({ TROVE_RECONCILE_JUDGE: value, OPENAI_API_KEY: "sk-test" }, () => {
        assert.ok(createReconcileJudgeFromEnv(), `value ${JSON.stringify(value)} should enable the judge`);
      });
    }
  });

  it("returns null with =1 but no OpenAI key", () => {
    withEnv({ TROVE_RECONCILE_JUDGE: "1", OPENAI_API_KEY: undefined }, () => {
      assert.equal(createReconcileJudgeFromEnv(), null);
    });
  });

  it("returns a judge only with =1 and a key", () => {
    withEnv({ TROVE_RECONCILE_JUDGE: "1", OPENAI_API_KEY: "sk-test" }, () => {
      assert.ok(createReconcileJudgeFromEnv());
    });
  });
});

describe("reconcile: postgres driver", { skip: !hasPostgres() }, () => {
  const judge: ReconcileJudge = async ({ candidates }) =>
    candidates.map((candidate) =>
      candidate.title.includes("4-2")
        ? { verdict: "supersedes", confidence: 0.95, reason: "same metric, newer value" }
        : { verdict: "related", confidence: 0.9, reason: "different subject" },
    );

  it("runs the judged flow end-to-end on Postgres", async () => {
    const store = new PgGraphStore({ connectionString: process.env.DATABASE_URL as string, reconcileJudge: judge });
    try {
      const oldNode = await capture(store, "Volleyball record is 4-2", "The recreational league record is 4 wins, 2 losses.");
      const newNode = await capture(store, "Volleyball record is 5-2", "Update: the recreational league record is now 5 wins, 2 losses.");

      const job = await reconcileJobFor(store, newNode.id);
      assert.equal(job.dedupeKey, `reconcile:${newNode.id}`);
      const done = await store.runJob({ jobId: job.id }, context);
      assert.equal(done?.status, "succeeded");
      const result = done?.result as Record<string, unknown>;
      const edges = result.supersedesEdgesCreated as Array<{ fromNodeId: string; toNodeId: string }>;
      assert.deepEqual(edges, [{ fromNodeId: newNode.id, toNodeId: oldNode.id }]);

      const superseded = await store.supersededBy([oldNode.id], context);
      assert.equal(superseded.get(oldNode.id)?.byTitle, newNode.title);

      const pack = await performRecall(store, { query: "volleyball record", tokenBudget: 8000, depth: 0, includeEvidence: false }, context);
      assert.ok(pack.context.includes(`SUPERSEDED by ${newNode.title}`), "pg recall must carry the mark");
    } finally {
      await store.close();
    }
  });
});
