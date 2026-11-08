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
