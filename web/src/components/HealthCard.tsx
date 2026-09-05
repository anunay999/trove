import { STATUS } from "@/lib/viz";
import type { Stats } from "@/lib/api";

const SEVERITY_COLOR: Record<string, string> = {
  error: STATUS.critical,
  warning: STATUS.warning,
  info: STATUS.good,
};

/**
 * Notes the graph could not retrieve when asked about them in their own words.
 *
 * Lint answers "is this note well-formed". This answers the only question that
 * decides whether a memory graph works: when you go looking for something you
 * wrote, does it come back. A note can be perfectly linked, freshly written and
 * still unreachable, because reachability belongs to the note AND everything
 * around it — so it degrades as the graph grows, with no defect anywhere to
 * find. The usual cause is a general note in the same cluster absorbing the
 * query, which is why the row names what stood in front of it: that is the
 * half you can act on.
 */
function BlindSpots({ selfTest }: { selfTest: Stats["selfTest"] }) {
  if (!selfTest || selfTest.probed === 0) return null;
  const missed = selfTest.blindSpots.length;
  const worst = selfTest.blindSpots[0];
  const shadow = worst?.shadowedBy[0]?.title;

  return (
    <div className="border-t pt-3">
      <p className="text-[13px] leading-snug text-muted-foreground">
        <span
          className="mr-1.5 inline-block size-1.5 rounded-full align-middle"
          style={{ background: missed === 0 ? STATUS.good : SEVERITY_COLOR.warning }}
          aria-hidden
        />
        <span className="text-foreground">{missed}</span>
        {missed === 1 ? " note" : " notes"} unreachable of {selfTest.probed} sampled
      </p>
      {worst ? (
        <p className="mt-1 truncate text-[12px] text-muted-foreground" title={worst.title}>
          e.g. \u201c{worst.title}\u201d
          {shadow ? <> \u2014 shadowed by \u201c{shadow}\u201d</> : null}
        </p>
      ) : null}
    </div>
  );
}

// Status colors never carry meaning alone: each row pairs the dot with a label.
export function HealthCard({ stats }: { stats: Stats }) {
  const { summary, findings } = stats.lint;
  const jobsPending = stats.jobs.find((row) => row.key === "pending")?.count ?? 0;
  const jobsFailed = stats.jobs.find((row) => row.key === "failed")?.count ?? 0;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <span className="text-4xl font-medium leading-none">{summary.findings}</span>
        <span className="text-sm text-muted-foreground">open findings</span>
      </div>
      <div className="flex gap-4 border-b pb-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: SEVERITY_COLOR.error }} aria-hidden />
          {summary.errors} errors
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: SEVERITY_COLOR.warning }} aria-hidden />
          {summary.warnings} warnings
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-2 overflow-hidden">
        {findings.slice(0, 6).map((finding, index) => (
          <li key={index} className="flex items-start gap-2 text-[13px] leading-snug">
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full"
              style={{ background: SEVERITY_COLOR[finding.severity] ?? STATUS.good }}
              aria-hidden
            />
            <span className="truncate text-muted-foreground" title={finding.message}>
              <span className="font-mono text-[11px] text-foreground">{finding.code}</span>{" "}
              {finding.message}
            </span>
          </li>
        ))}
        {findings.length === 0 ? (
          <li className="text-sm text-muted-foreground">No lint findings. The graph is tidy.</li>
        ) : null}
      </ul>
      <BlindSpots selfTest={stats.selfTest} />
      <p className="border-t pt-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        Jobs: {jobsPending} pending, {jobsFailed} failed
      </p>
    </div>
  );
}
