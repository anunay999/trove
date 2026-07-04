import { createGraphStore } from "../src/createStore.js";
import { embeddingDrainRemaining, startJobWorker } from "../src/jobWorker.js";
import type { GraphJob } from "../src/graphCore.js";

const { store, driver } = createGraphStore();
const context = {
  actorId: "job-worker-smoke",
  interfaceId: "job-worker-smoke",
  requestId: `job-worker-smoke-${Date.now()}`,
};

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

async function pendingCount(): Promise<number> {
  const pending = await store.jobs({ status: "pending", limit: 100 });
  return pending.length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // 1. The drain-continuation decision is pure and covers each result shape.
  const saturated = fabricateJob({
    result: { status: "refreshed", embedded: 24, missingBefore: { nodeRevisions: 4, textUnits: 96 } },
  });
  if (embeddingDrainRemaining(saturated) !== 76) {
    throw new Error(`Expected 76 remaining after saturated batch, got ${embeddingDrainRemaining(saturated)}.`);
  }
  const finished = fabricateJob({
    result: { status: "refreshed", embedded: 5, missingBefore: { nodeRevisions: 0, textUnits: 5 } },
  });
  if (embeddingDrainRemaining(finished) !== 0) {
    throw new Error("Expected 0 remaining when the batch embedded everything missing.");
  }
  const skipped = fabricateJob({
    result: { status: "skipped_no_embedding_provider", missing: { nodeRevisions: 9, textUnits: 9 } },
  });
  if (embeddingDrainRemaining(skipped) !== 0) {
    throw new Error("Provider-less skips must not re-enqueue.");
  }
  const lint = fabricateJob({ kind: "lint_graph", result: { lint: {} } });
  if (embeddingDrainRemaining(lint) !== 0) {
    throw new Error("Non-embedding jobs must not re-enqueue.");
  }

  // 2. A mutation enqueues maintenance jobs; the worker drains them without help.
  await store.capture({
    title: `Job worker smoke ${Date.now()}`,
    type: "claim",
    summary: "The background worker should drain maintenance jobs automatically.",
    content: "Ingest-time jobs must complete without a manual jobs:run invocation.",
    evidence: [],
    links: [],
  }, context);

  if (await pendingCount() === 0) {
    throw new Error("Expected pending maintenance jobs before the worker starts.");
  }

  const worker = startJobWorker(store, { intervalMs: 25, maxJobsPerTick: 10 });
  const deadline = Date.now() + 5000;
  while (await pendingCount() > 0) {
    if (Date.now() > deadline) throw new Error("Worker did not drain pending jobs within 5s.");
    await sleep(25);
  }
  await worker.stop();

  const unfinished = (await store.jobs({ limit: 100 }))
    .filter((job) => job.status === "pending" || job.status === "running");
  if (unfinished.length > 0) {
    throw new Error(`Expected no pending/running jobs after drain, found ${unfinished.length}.`);
  }

  // 3. After stop(), new jobs stay untouched.
  const afterStop = await store.enqueueJob({
    kind: "lint_graph",
    payload: { smoke: "after-stop" },
    priority: 99,
    dedupeKey: `worker-smoke:after-stop:${Date.now()}`,
  }, context);
  await sleep(150);
  const stillPending = (await store.jobs({ status: "pending", limit: 100 }))
    .some((job) => job.id === afterStop.id);
  if (!stillPending) {
    throw new Error("Worker kept running after stop().");
  }

  console.log(JSON.stringify({ ok: true, driver }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
