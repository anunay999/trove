import type { GraphOperationContext, GraphStore } from "./graphCore.js";

const WORKER_CONTEXT: GraphOperationContext = {
  actorId: "job-worker",
  interfaceId: "job-worker",
};

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
      if (job.status === "dead") {
        log(`job ${job.kind} (${job.id}) dead after ${job.attempts} attempts: ${job.error ?? "unknown error"}`);
        continue;
      }
      if (job.status === "failed") {
        log(`job ${job.kind} (${job.id}) failed: ${job.error ?? "unknown error"}`);
        continue;
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
