import type { EmbeddingCounts, GraphJob, GraphOperationContext, GraphStore } from "./graphCore.js";
import { jobResultAs } from "./jobResults.js";

const WORKER_CONTEXT: GraphOperationContext = {
  actorId: "job-worker",
  interfaceId: "job-worker",
};

// A refresh_embeddings batch embeds at most TROVE_EMBEDDING_JOB_LIMIT rows per
// run. When the finished job reports more missing rows than it embedded, the
// drain is not done and the worker must queue a follow-up batch.
export function embeddingDrainRemaining(job: GraphJob | null): number {
  if (!job) return 0;
  // Narrow through the typed envelope (jobResults.ts) — reading `embedded` as
  // a bare number off the untyped record is what produced NaN and stalled the
  // drain. Both halves are EmbeddingCounts; summing them through one helper
  // keeps the two sides from drifting apart again.
  const result = jobResultAs(job, "refresh_embeddings");
  if (!result || result.status !== "refreshed") return 0;
  const sum = (counts: EmbeddingCounts): number =>
    Number(counts.nodeRevisions ?? 0) + Number(counts.textUnits ?? 0);
  return Math.max(0, sum(result.missingBefore) - sum(result.embedded));
}

/**
 * Queue the next batch of an unfinished embedding drain, preserving the
 * finished job's owner scope: an owner-scoped drain must follow up with an
 * owner-scoped batch (and its own dedupe key), not get absorbed into the
 * global maintenance job. Shared by the background worker and any caller that
 * drains jobs directly via runJob (the thesis harness) — the follow-up is NOT
 * enqueued by performJob itself, so every drain loop needs this.
 */
export async function enqueueEmbeddingDrainFollowUp(store: GraphStore, job: GraphJob, context?: GraphOperationContext): Promise<boolean> {
  if (embeddingDrainRemaining(job) <= 0) return false;
  const ownerId = typeof job.payload.ownerId === "string" ? job.payload.ownerId : null;
  await store.enqueueJob({
    kind: "refresh_embeddings",
    payload: { reason: "drain_continue", ...(ownerId ? { ownerId } : {}) },
    priority: 40,
    dedupeKey: ownerId ? `maintenance:refresh_embeddings:${ownerId}` : "maintenance:refresh_embeddings",
  }, context);
  return true;
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
      await enqueueEmbeddingDrainFollowUp(store, job, WORKER_CONTEXT);
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
