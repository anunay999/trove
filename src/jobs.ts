import type { EnqueueJobInput, GraphJobKind } from "./contracts.js";
import { dreamOptionsFromPayload, performDream } from "./dream.js";
import { optedIn } from "./flags.js";
import type { EmbeddingCounts, GraphJob, GraphStore, OwnerScope, RefreshEmbeddingsResult } from "./graphCore.js";
import { jobResultAs, type GraphJobResult, type GraphJobResultMap } from "./jobResults.js";
import { runRecallSelfTest } from "./recallSelfTest.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { performReconcileNode, type ReconcileJudge } from "./reconcile.js";
import type { Reranker } from "./rerank.js";
import { observe, withTraceAttributes } from "./tracing.js";

/**
 * Attempts a job gets across all causes -- failures and lease reclaims alike.
 * One constant for both drivers and every query: the claim filter, the
 * dead-letter threshold and the lease-exhaustion retirement must agree, or a
 * job can sit in a state none of them matches.
 */
export const JOB_MAX_ATTEMPTS = 5;

/**
 * How long a finished job (succeeded/failed/dead/cancelled) stays in the
 * table. Rows are the audit trail of maintenance, not the graph; production
 * had ~5,000 succeeded rows and nothing ever removed one. The lint job prunes
 * past this age.
 */
export const TERMINAL_JOB_RETENTION_DAYS = 30;

/**
 * Minimum seconds between two maintenance lints of one scope. A write inside
 * this window after a successful lint enqueues no new lint; the next write
 * past it does. Time-based rather than write-counted because the cost being
 * bounded is lint runs per unit time, and a per-owner counter would need its
 * own table. 0 disables the throttle (tests).
 */
export function lintMinIntervalSeconds(): number {
  const parsed = Number(process.env.TROVE_LINT_MIN_INTERVAL_SECONDS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 600;
}

/**
 * Minimum seconds between two recall self-tests of one scope. A day: two orders
 * of magnitude slacker than lint, because a self-test is twenty recalls rather
 * than one pass over a snapshot — and because what it measures moves on the
 * scale of weeks, not writes.
 *
 * A constant, not a variable. It shipped as one for about an hour and that was
 * a mistake of exactly the kind this codebase had accumulated thirty of.
 */
export function selfTestMinIntervalSeconds(): number {
  return 86_400;
}

/** Seconds between scheduled dreams for one owner. */
export const DREAM_MIN_INTERVAL_SECONDS = 6 * 3600;

/**
 * Claim order: higher runs first. Reconciliation and embeddings feed the next
 * recall, lint feeds a report, and the self-test and dreaming are background
 * passes nothing waits on, so they go last.
 */
export const JOB_PRIORITY = {
  lint_graph: 60,
  refresh_embeddings: 40,
  reconcile_node: 30,
  recall_self_test: 10,
  dream: 5,
} as const satisfies Record<GraphJobKind, number>;

/** One job a mutation wants queued: what to insert, and when to skip it. */
export type JobRequest = EnqueueJobInput & {
  dedupeKey: string;
  /** Skip when a job with this kind and key succeeded within this many seconds; 0 never skips. */
  throttleSeconds: number;
};

/**
 * The owner a job runs as. A job's payload is the one place it is written:
 * maintenance writes the writer's owner (or none, for the whole graph), and the
 * HTTP and MCP enqueue routes overwrite it with the caller's when the caller
 * is scoped (see scopeEnqueueInput), so only an unscoped operator can name one.
 */
export function jobOwner(job: Pick<GraphJob, "payload">): string | null {
  const owner = job.payload.ownerId;
  return typeof owner === "string" ? owner : null;
}

/** A scoped caller enqueues for itself, whatever its payload says. */
export function scopeEnqueueInput(input: EnqueueJobInput, scope: OwnerScope): EnqueueJobInput {
  if (!scope.scoped) return input;
  return { ...input, payload: { ...input.payload, ownerId: scope.ownerId } };
}

const ownedKey = (kind: GraphJobKind, owner: string | null) => (owner ? `maintenance:${kind}:${owner}` : `maintenance:${kind}`);
const maintenance = (kind: GraphJobKind, owner: string | null, throttleSeconds: number, payload: Record<string, unknown> = {}): JobRequest => ({
  kind,
  payload: { reason: "graph_mutation", ...(owner ? { ownerId: owner } : {}), ...payload },
  priority: JOB_PRIORITY[kind],
  dedupeKey: ownedKey(kind, owner),
  throttleSeconds,
});

/**
 * What a mutation queues. Lint, the self-test and dreaming run per owner, so
 * their findings belong to the tenant whose write caused them; embedding
 * refresh stays global, because its result is counts and one drain over every
 * owner's missing rows is cheaper than one per tenant. Dreaming writes on its
 * own, so it is scheduled only per owner and only with TROVE_DREAM=1.
 */
export function maintenanceRequests(changes: { lint?: boolean; embeddings?: boolean }, scope: OwnerScope): JobRequest[] {
  const owner = scope.scoped ? scope.ownerId : null;
  const requests: JobRequest[] = [];
  if (changes.lint) requests.push(maintenance("lint_graph", owner, lintMinIntervalSeconds()));
  if (changes.embeddings) requests.push(maintenance("refresh_embeddings", null, 0));
  requests.push(maintenance("recall_self_test", owner, selfTestMinIntervalSeconds()));
  if (owner && optedIn(process.env.TROVE_DREAM)) requests.push(maintenance("dream", owner, DREAM_MIN_INTERVAL_SECONDS));
  return requests;
}

/** Reconciliation for one written node. Deduped per node, never throttled. */
export function reconcileRequest(nodeId: string, scope: OwnerScope): JobRequest {
  return {
    kind: "reconcile_node",
    payload: { reason: "graph_mutation", nodeId, ownerId: scope.ownerId },
    priority: JOB_PRIORITY.reconcile_node,
    dedupeKey: `reconcile:${nodeId}`,
    throttleSeconds: 0,
  };
}

/**
 * Rows a finished embedding refresh left behind. A refresh embeds one bounded
 * batch; when it reports more missing than it embedded, the drain is not done.
 */
export function embeddingDrainRemaining(job: GraphJob | null): number {
  if (!job) return 0;
  const result = jobResultAs(job, "refresh_embeddings");
  if (!result || result.status !== "refreshed") return 0;
  const sum = (counts: EmbeddingCounts): number => Number(counts.nodeRevisions ?? 0) + Number(counts.textChunks ?? 0);
  return Math.max(0, sum(result.missingBefore) - sum(result.embedded));
}

/**
 * The job a finished job asks for next, or null. Only an unfinished embedding
 * drain continues, under the same owner and its own key, so an owner-scoped
 * drain is never absorbed into the global maintenance job. Both drivers apply
 * this when a job finishes, so no caller has to remember it.
 */
export function followUpRequest(job: GraphJob): JobRequest | null {
  if (embeddingDrainRemaining(job) <= 0) return null;
  const owner = jobOwner(job);
  return {
    kind: "refresh_embeddings",
    payload: { reason: "drain_continue", ...(owner ? { ownerId: owner } : {}) },
    priority: JOB_PRIORITY.refresh_embeddings,
    dedupeKey: ownedKey("refresh_embeddings", owner),
    throttleSeconds: 0,
  };
}

/** What a driver lends the job runners: its store, its judge, and the two data operations only it can do. */
export type JobHost = {
  store: GraphStore;
  reconcileJudge: ReconcileJudge | null;
  prune(): Promise<{ jobs: number; events: number }>;
  refreshEmbeddings(owner: string | null, limit: number): Promise<RefreshEmbeddingsResult>;
};

/** Rows one embedding refresh embeds unless the payload asks for another batch size. */
export const EMBEDDING_JOB_DEFAULT_LIMIT = 256;

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const RUNNERS: { [K in GraphJobKind]: (host: JobHost, owner: string | null, payload: Record<string, unknown>) => Promise<GraphJobResultMap[K]> } = {
  async lint_graph(host, owner) {
    const report = await host.store.lint(owner ? { ownerId: owner } : undefined);
    const pruned = await host.prune();
    // The findings themselves (capped): counts alone are not actionable.
    return { ownerId: owner, lint: { ...report.summary, findings: report.findings.slice(0, 200) }, prunedJobs: pruned.jobs, prunedEvents: pruned.events };
  },
  async refresh_embeddings(host, owner, payload) {
    const limit = positiveNumber(payload.limit) ?? Number(process.env.TROVE_EMBEDDING_JOB_LIMIT ?? EMBEDDING_JOB_DEFAULT_LIMIT);
    return host.refreshEmbeddings(owner, Number.isFinite(limit) && limit > 0 ? limit : EMBEDDING_JOB_DEFAULT_LIMIT);
  },
  async reconcile_node(host, owner, payload) {
    if (typeof payload.nodeId !== "string") throw new Error("reconcile_node: payload.nodeId is required");
    return performReconcileNode(host.store, { nodeId: payload.nodeId, ownerId: owner }, host.reconcileJudge);
  },
  async recall_self_test(host, owner, payload) {
    const sampleSize = positiveNumber(payload.sampleSize);
    return runRecallSelfTest(host.store, sampleSize === undefined ? {} : { sampleSize }, owner ? { ownerId: owner } : undefined);
  },
  async dream(host, owner, payload) {
    return performDream(host.store, { ...dreamOptionsFromPayload(payload), ownerId: owner });
  },
};

/** What a store is built with. Anything left out comes from the environment (memory: no reranker or judge). */
export type StoreOptions = {
  reconcileJudge?: ReconcileJudge | null;
  reranker?: Reranker | null;
  embeddings?: EmbeddingProvider | null;
  jobRunner?: JobRunner;
};

/** How a store turns a claimed job into a result. runJobKind is the real one; tests pass their own. */
export type JobRunner = (host: JobHost, job: GraphJob) => Promise<GraphJobResult>;

/** Run one claimed job, traced under its owner. Throws for a kind with no runner. */
export async function runJobKind(host: JobHost, job: GraphJob): Promise<GraphJobResult> {
  const runner = RUNNERS[job.kind] as ((host: JobHost, owner: string | null, payload: Record<string, unknown>) => Promise<GraphJobResult>) | undefined;
  if (!runner) throw new Error(`no runner for job kind ${job.kind}`);
  const owner = jobOwner(job);
  return withTraceAttributes(
    { ...(owner ? { userId: owner } : {}), tags: ["job", job.kind] },
    () => observe(`job:${job.kind}`, { asType: "span", input: { kind: job.kind, jobId: job.id, payload: job.payload } }, async (span) => {
      const result = await runner(host, owner, job.payload);
      span.update({ output: result });
      return result;
    }),
  );
}
