import type { RecallSelfTestResult } from "./recallSelfTest.js";
/**
 * Typed result envelopes for `graph_job` kinds (backlog #5).
 *
 * `GraphJob.result` on the wire is `Record<string, unknown> | null` — the job
 * row is kind-agnostic, so producer and consumer were never checked against
 * each other. That is how `Number({nodeRevisions, textUnits})` → NaN compiled
 * silently and stalled the production embedding drain. This module is the
 * contract both sides check against:
 *
 * - producers annotate each performJob branch with `GraphJobResultMap[kind]`,
 *   so a branch returning the wrong shape for its kind fails to compile;
 * - consumers narrow a finished job through `jobResultAs(job, kind)` instead of
 *   re-deriving (or fabricating) the shape, so a consumer reading the wrong
 *   kind's fields fails to compile.
 *
 * Adding a job kind means adding its entry to GraphJobResultMap — the compiler
 * then points at every untyped producer and consumer.
 */

import type { GraphJobKind } from "./contracts.js";
import type {
  EmbeddingCounts,
  GraphJob,
  GraphLintFinding,
  GraphLintReport,
  RefreshEmbeddingsResult,
} from "./graphCore.js";
import type { ObsidianManifest } from "./obsidianExport.js";
import type { ReconcileResult } from "./reconcile.js";

export type LintGraphJobResult = {
  /** Owner the lint ran over; null is the whole graph (operator-triggered). */
  ownerId: string | null;
  /** Summary counts plus the findings themselves (capped), never counts alone. */
  lint: Omit<GraphLintReport["summary"], "findings"> & { findings: GraphLintFinding[] };
  /** Terminal job rows past TERMINAL_JOB_RETENTION_DAYS removed on this run. */
  prunedJobs: number;
  /** Audit events past TROVE_EVENT_RETENTION_DAYS removed on this run, capped per run. */
  prunedEvents: number;
};

export type RefreshObsidianProjectionJobResult = {
  manifest: ObsidianManifest;
  fileCount: number;
};

export type GraphJobResultMap = {
  lint_graph: LintGraphJobResult;
  refresh_embeddings: RefreshEmbeddingsResult;
  refresh_obsidian_projection: RefreshObsidianProjectionJobResult;
  reconcile_node: ReconcileResult;
  recall_self_test: RecallSelfTestResult;
};

/** What the graph could not find in its own words; see src/recallSelfTest.ts. */
export type { RecallSelfTestResult };

export type GraphJobResult<K extends GraphJobKind = GraphJobKind> = GraphJobResultMap[K];

/**
 * Narrow a job to a kind's result envelope. Returns null unless the job is
 * that kind AND succeeded with a result — callers get the typed shape or
 * nothing, never a maybe-wrong record.
 */
export function jobResultAs<K extends GraphJobKind>(job: GraphJob, kind: K): GraphJobResultMap[K] | null {
  if (job.kind !== kind || job.status !== "succeeded" || job.result === null) return null;
  return job.result as GraphJobResultMap[K];
}

export type { EmbeddingCounts, RefreshEmbeddingsResult };
