import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("jobs", () => {
  const { store, context, stamp } = suiteStore("job");

  after(async () => {
    await closeStore(store);
  });

  it("a graph write enqueues durable maintenance jobs", async () => {
    await store.capture({
      title: `Job smoke ${stamp}`,
      type: "claim",
      summary: "Graph writes should enqueue durable maintenance jobs.",
      content: "This node verifies that Trove schedules projection, lint, and embedding refresh work after mutations.",
      evidence: [],
      links: [],
    }, context);

    const pendingJobs = await store.jobs({ status: "pending", limit: 100 });
    const pendingKinds = new Set(pendingJobs.map((job) => job.kind));
    for (const expected of ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"]) {
      assert.ok(pendingKinds.has(expected as never), `expected pending maintenance job ${expected}`);
    }
  });

  it("runs an enqueued job to success", async () => {
    const manualJob = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: true },
      priority: 99,
      dedupeKey: `smoke:lint:${stamp}`,
    }, context);
    const completed = await store.runJob({ jobId: manualJob.id }, context);
    assert.equal(completed?.status, "succeeded", "expected the lint job to succeed");
  });
});
