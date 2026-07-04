import { createGraphStore } from "../src/createStore.js";

const maxJobs = Number(process.env.TROVE_WORKER_MAX_JOBS ?? process.argv[2] ?? 10);
if (!Number.isInteger(maxJobs) || maxJobs < 1) {
  throw new Error("TROVE_WORKER_MAX_JOBS must be a positive integer.");
}

const { store, driver } = createGraphStore();
const context = {
  actorId: process.env.TROVE_WORKER_ACTOR ?? "trove-worker",
  interfaceId: "worker",
  requestId: `worker-${Date.now()}`,
};

let processed = 0;

try {
  while (processed < maxJobs) {
    const job = await store.runJob({}, context);
    if (!job || job.status === "pending" || job.status === "running") break;

    processed += 1;
    console.log(JSON.stringify({
      id: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
    }));
  }

  console.log(JSON.stringify({ ok: true, driver, processed }));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
