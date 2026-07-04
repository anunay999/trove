import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const context = {
  actorId: "job-smoke",
  interfaceId: "job-smoke",
  requestId: `job-smoke-${Date.now()}`,
};

try {
  await store.capture({
    title: `Job smoke ${Date.now()}`,
    type: "claim",
    summary: "Graph writes should enqueue durable maintenance jobs.",
    content: "This node verifies that Trove schedules projection, lint, and embedding refresh work after mutations.",
    evidence: [],
    links: [],
  }, context);

  const pendingJobs = await store.jobs({ status: "pending", limit: 100 });
  const pendingKinds = new Set(pendingJobs.map((job) => job.kind));
  for (const expected of ["refresh_obsidian_projection", "lint_graph", "refresh_embeddings"]) {
    if (!pendingKinds.has(expected as never)) {
      throw new Error(`Expected pending maintenance job ${expected}.`);
    }
  }

  const manualJob = await store.enqueueJob({
    kind: "lint_graph",
    payload: { smoke: true },
    priority: 99,
    dedupeKey: `smoke:lint:${Date.now()}`,
  }, context);
  const completed = await store.runJob({ jobId: manualJob.id }, context);
  if (!completed || completed.status !== "succeeded") {
    throw new Error(`Expected lint job to succeed, got ${completed?.status ?? "missing"}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    autoQueuedKinds: [...pendingKinds].sort(),
    completedJob: {
      id: completed.id,
      kind: completed.kind,
      status: completed.status,
      attempts: completed.attempts,
      resultKeys: completed.result ? Object.keys(completed.result).sort() : [],
    },
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
