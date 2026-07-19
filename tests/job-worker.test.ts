import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { embeddingDrainRemaining, startJobWorker } from "../src/jobWorker.js";
import type { GraphJob } from "../src/graphCore.js";
import { suiteStore, closeStore, sleep } from "./helpers.js";

function fabricateJob(overrides: Partial<GraphJob>): GraphJob {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    kind: "refresh_embeddings",
    status: "succeeded",
    priority: 40,
    payload: {},
    result: null,
    error: null,
    dedupeKey: null,
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as GraphJob;
}

describe("job worker", () => {
  const { store, context, stamp } = suiteStore("job-worker");

  after(async () => {
    await closeStore(store);
  });

  describe("embeddingDrainRemaining", () => {
    it("reports remaining work after a saturated batch (real store shape)", () => {
      // pgStore reports embedded as { nodeRevisions, textUnits }; a drain
      // calculator that Number()s that object gets NaN and never re-enqueues.
      const saturated = fabricateJob({
        result: {
          status: "refreshed",
          embedded: { nodeRevisions: 4, textUnits: 20 },
          missingBefore: { nodeRevisions: 4, textUnits: 96 },
        },
      });
      assert.equal(embeddingDrainRemaining(saturated), 76);
    });

    it("reports zero when the batch embedded everything missing", () => {
      const finished = fabricateJob({
        result: {
          status: "refreshed",
          embedded: { nodeRevisions: 0, textUnits: 5 },
          missingBefore: { nodeRevisions: 0, textUnits: 5 },
        },
      });
      assert.equal(embeddingDrainRemaining(finished), 0);
    });

    it("does not re-enqueue provider-less skips", () => {
      const skipped = fabricateJob({
        result: { status: "skipped_no_embedding_provider", missing: { nodeRevisions: 9, textUnits: 9 } },
      });
      assert.equal(embeddingDrainRemaining(skipped), 0);
    });

    it("does not re-enqueue non-embedding jobs", () => {
      const lint = fabricateJob({ kind: "lint_graph", result: { lint: {} } });
      assert.equal(embeddingDrainRemaining(lint), 0);
    });
  });

  it("drains maintenance jobs enqueued by a mutation, then stops cleanly", async () => {
    // Parallel node:test files share one Postgres and maintenance jobs use
    // global dedupe keys — scope drain assertions to jobs created by this
    // test, or sibling suites' enqueues flake the "queue empty" checks.
    const startedAt = Date.now();
    const pendingSinceStart = async (): Promise<number> =>
      (await store.jobs({ limit: 100 }))
        .filter((job) => job.status === "pending" || job.status === "running")
        .filter((job) => Date.parse(job.createdAt) >= startedAt - 1_000)
        .length;

    await store.capture({
      title: `Job worker smoke ${stamp}`,
      type: "claim",
      summary: "The background worker should drain maintenance jobs automatically.",
      content: "Ingest-time jobs must complete without a manual jobs:run invocation.",
      evidence: [],
      links: [],
    }, context);

    // The capture above enqueues lint_graph/refresh_embeddings under GLOBAL
    // dedupe keys (`maintenance:<kind>`, pgStore.ts). When a sibling suite —
    // node:test runs files in parallel — already has one of those pending, our
    // enqueue dedupes onto ITS row, which keeps the older createdAt and falls
    // outside the window above, so the mutation leaves nothing this test can
    // see. Anchor the assertion on a uniquely-keyed job instead: the mutation
    // path is still exercised, but the precondition no longer depends on
    // winning a race against every other suite.
    await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "pre-drain" },
      priority: 50,
      dedupeKey: `worker-smoke:pre-drain:${stamp}`,
    }, context);

    assert.notEqual(await pendingSinceStart(), 0, "expected pending maintenance jobs before the worker starts");

    const worker = startJobWorker(store, { intervalMs: 25, maxJobsPerTick: 10 });
    const deadline = Date.now() + 5000;
    while (await pendingSinceStart() > 0) {
      assert.ok(Date.now() <= deadline, "worker did not drain pending jobs within 5s");
      await sleep(25);
    }
    await worker.stop();

    // A drain-continuation enqueued by the worker's final in-flight tick is a
    // legitimate straggler, not a worker failure — drain it manually.
    for (let i = 0; i < 20 && (await pendingSinceStart()) > 0; i += 1) {
      await store.runJob({}, context);
    }
    assert.equal(await pendingSinceStart(), 0, "expected no pending/running jobs after drain");

    // After stop(), new jobs stay untouched.
    const afterStop = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "after-stop" },
      priority: 99,
      dedupeKey: `worker-smoke:after-stop:${stamp}`,
    }, context);
    await sleep(150);
    const stillPending = (await store.jobs({ status: "pending", limit: 100 }))
      .some((job) => job.id === afterStop.id);
    assert.ok(stillPending, "worker kept running after stop()");
  });
});
