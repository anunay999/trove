import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("jobs", () => {
  const { store, context, stamp } = suiteStore("job");

  after(async () => {
    await closeStore(store);
  });

  it("a graph write enqueues durable maintenance jobs", async () => {
    // Maintenance jobs use a global dedupe key (`maintenance:${kind}`). Under
    // parallel node:test + shared Postgres, a sibling suite (or job-worker)
    // may already hold the pending/running row — or drain it between capture
    // and list. Assert "active or just-finished", not "pending in isolation".
    const startedAt = Date.now();
    await store.capture({
      title: `Job smoke ${stamp}`,
      type: "claim",
      summary: "Graph writes should enqueue durable maintenance jobs.",
      content: "This node verifies that Trove schedules projection, lint, and embedding refresh work after mutations.",
      evidence: [],
      links: [],
    }, context);

    const listed = await store.jobs({ limit: 200 });
    for (const expected of ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"] as const) {
      const ofKind = listed.filter((job) => job.kind === expected);
      const active = ofKind.some(
        (job) => job.status === "pending" || job.status === "running",
      );
      const justFinished = ofKind.some((job) => {
        if (job.status !== "succeeded" && job.status !== "failed") return false;
        const stampMs = Date.parse(job.finishedAt ?? job.updatedAt);
        return Number.isFinite(stampMs) && stampMs >= startedAt - 2_000;
      });
      assert.ok(
        active || justFinished,
        `expected maintenance job ${expected} pending/running or finished around this capture; saw ${
          ofKind.map((j) => j.status).join(",") || "none"
        }`,
      );
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
