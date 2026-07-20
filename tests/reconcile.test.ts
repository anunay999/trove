import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "../src/contracts.js";
import type { GraphJob, GraphOperationContext, GraphStore } from "../src/graphCore.js";
import { performRecall } from "../src/graphCore.js";
import { InMemoryGraphStore } from "../src/store.js";
import { PgGraphStore } from "../src/pgStore.js";
import { createReconcileJudgeFromEnv, parseReconcileJudgment, type ReconcileJudge } from "../src/reconcile.js";
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
  const supersedesJudge: ReconcileJudge = async ({ candidate }) =>
    candidate.title.includes("4-2")
      ? { verdict: "supersedes", confidence: 0.95, reason: "same metric, newer value" }
      : { verdict: "related", confidence: 0.9, reason: "different subject" };

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
      reconcileJudge: async () => ({ verdict: "contradicts", confidence: 0.9, reason: "values disagree, recency unclear" }),
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
      reconcileJudge: async () => parseReconcileJudgment("I'm not sure, these seem kind of similar?"),
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
  const judge: ReconcileJudge = async ({ candidate }) =>
    candidate.title.includes("4-2")
      ? { verdict: "supersedes", confidence: 0.95, reason: "same metric, newer value" }
      : { verdict: "related", confidence: 0.9, reason: "different subject" };

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
