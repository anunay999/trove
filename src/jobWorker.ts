import type { GraphJob, GraphOperationContext, GraphStore } from "./graphCore.js";

const WORKER_CONTEXT: GraphOperationContext = {
  actorId: "job-worker",
  interfaceId: "job-worker",
};

// A refresh_embeddings batch embeds at most TROVE_EMBEDDING_JOB_LIMIT rows per
// run. When the finished job reports more missing rows than it embedded, the
// drain is not done and the worker must queue a follow-up batch.
export function embeddingDrainRemaining(job: GraphJob | null): number {
  if (!job || job.kind !== "refresh_embeddings" || job.status !== "succeeded") return 0;
  const result = job.result ?? {};
  if (result.status !== "refreshed") return 0;
  const missing = (result.missingBefore ?? {}) as Record<string, unknown>;
  const before = Number(missing.nodeRevisions ?? 0) + Number(missing.textUnits ?? 0);
  const embedded = Number(result.embedded ?? 0);
  if (!Number.isFinite(before) || !Number.isFinite(embedded)) return 0;
  return Math.max(0, before - embedded);
}

export interface JobWorkerOptions {
  intervalMs?: number;
  maxJobsPerTick?: number;
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface JobWorkerHandle {
  stop(): Promise<void>;
}

export function startJobWorker(store: GraphStore, options: JobWorkerOptions = {}): JobWorkerHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  const maxJobsPerTick = options.maxJobsPerTick ?? 20;
  const log = options.log ?? (() => {});
  const onError = options.onError ?? ((error: unknown) => {
    console.error("[job-worker]", error instanceof Error ? error.message : error);
  });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let activeTick: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    let ran = 0;
    while (!stopped && ran < maxJobsPerTick) {
      const job = await store.runJob({}, WORKER_CONTEXT);
      if (!job) break;
      ran += 1;
      // 'dead' is not in graphJobStatusSchema yet; compare via string.
      if ((job.status as string) === "dead") {
        log(`job ${job.kind} (${job.id}) dead after ${job.attempts} attempts: ${job.error ?? "unknown error"}`);
        continue;
      }
      if (job.status === "failed") {
        log(`job ${job.kind} (${job.id}) failed: ${job.error ?? "unknown error"}`);
        continue;
      }
      if (embeddingDrainRemaining(job) > 0) {
        await store.enqueueJob({
          kind: "refresh_embeddings",
          payload: { reason: "drain_continue" },
          priority: 40,
          dedupeKey: "maintenance:refresh_embeddings",
        }, WORKER_CONTEXT);
      }
    }
    if (ran > 0) log(`drained ${ran} job(s)`);
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      activeTick = tick().catch(onError).finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };

  activeTick = tick().catch(onError).finally(schedule);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await activeTick;
    },
  };
}
