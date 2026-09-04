import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { Stats } from "@/lib/api";

const chartConfig = {
  documents: {
    label: "Documents",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
} satisfies ChartConfig;

/**
 * A document carries two dates and they disagree by months on an imported
 * vault: the day it was added, and the day it says it is from (frontmatter, or
 * a date in its path or title). The chart used to plot only the second, so a
 * note imported this morning landed last April and the recent weeks read as a
 * flat zero — which looks like a broken chart, not a fact about the data.
 * "Added" is the default because that is what a person means by an activity
 * chart; "Dated" is one click away.
 */
type Mode = "added" | "dated";

const MODES = [
  {
    id: "added" as const,
    label: "Added",
    help: "Counted by when it was added to your graph.",
    empty: "No documents were added in this window. Widen the range, or switch to the date each document is about.",
  },
  {
    id: "dated" as const,
    label: "Dated",
    help: "Counted by the date the document is about — its frontmatter or filename.",
    empty: "No documents are dated in this window — many carry no date of their own. Widen the range, or switch to when they were added.",
  },
];

/**
 * Ninety days by default: a month is too tight to show a cadence when a quiet
 * week is normal, and the old open-ended window let one four-month-old
 * document stretch the axis until everything recent flattened out. The whole
 * history is still one click away under "All".
 */
const RANGES = [
  { id: "30d", label: "30d", days: 30, window: "Last 30 days" },
  { id: "90d", label: "90d", days: 90, window: "Last 90 days" },
  { id: "1y", label: "1y", days: 365, window: "Last 12 months" },
  { id: "all", label: "All", days: null, window: "All time" },
];

const MAX_SPAN_DAYS = 3650;
const DAY_MS = 86_400_000;

function dayKey(offsetFromToday: number): string {
  const day = new Date();
  day.setDate(day.getDate() - offsetFromToday);
  return day.toISOString().slice(0, 10);
}

function formatAxis(date: string, withYear: boolean): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(
    undefined,
    withYear ? { month: "short", year: "numeric" } : { month: "short", day: "numeric" },
  );
}

function formatFull(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Pills<T extends string>({ options, value, onChange, label }: {
  options: ReadonlyArray<{ id: T; label: string; hint?: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          aria-label={option.hint}
          onClick={() => onChange(option.id)}
          className={`rounded-md border px-2.5 py-1 text-[12px] leading-none transition-colors focus-visible:border-ring focus-visible:outline-none ${
            option.id === value
              ? "border-foreground/40 bg-secondary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function WritesChart({ stats }: { stats: Stats }) {
  const [mode, setMode] = useState<Mode>("added");
  const [rangeId, setRangeId] = useState("90d");

  const active = MODES.find((option) => option.id === mode)!;
  const range = RANGES.find((option) => option.id === rangeId)!;

  const { data, total, spanDays, oldest } = useMemo(() => {
    const rows = mode === "added" ? stats.sourcesIngestedPerDay : stats.sourcesPerDay;
    const first = rows[0]?.date;
    const sinceFirst = first
      ? Math.ceil((Date.now() - Date.parse(`${first}T00:00:00`)) / DAY_MS) + 1
      : 30;
    const span = range.days ?? Math.min(MAX_SPAN_DAYS, Math.max(30, sinceFirst));

    const byDate = new Map(rows.map((row) => [row.date, row.documents]));
    const points: Array<{ date: string; documents: number }> = [];
    let sum = 0;
    for (let i = span - 1; i >= 0; i -= 1) {
      const key = dayKey(i);
      const documents = byDate.get(key) ?? 0;
      sum += documents;
      points.push({ date: key, documents });
    }
    return { data: points, total: sum, spanDays: span, oldest: first };
  }, [stats, mode, range]);

  // Say what the axis actually covers. "All" names the first day it holds
  // rather than pretending to a round number of days.
  const windowLabel = range.days
    ? range.window
    : oldest
      ? `Since ${formatFull(data[0]?.date ?? oldest)}`
      : range.window;
  const withYear = spanDays > 200;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Pills
          label="Date each document by"
          value={mode}
          onChange={setMode}
          options={MODES.map((option) => ({
            id: option.id,
            label: option.label,
            hint: option.id === "added" ? "When it was added" : "The date the document is about",
          }))}
        />
        <Pills label="Time range" value={rangeId} onChange={setRangeId} options={RANGES} />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {active.help}{" "}
        <span className="text-foreground/70">
          {windowLabel} · {total} document{total === 1 ? "" : "s"}
        </span>
      </p>

      {total === 0 ? (
        <div className="mt-4 flex min-h-48 flex-1 items-center">
          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{active.empty}</p>
        </div>
      ) : (
        <ChartContainer config={chartConfig} className="mt-3 aspect-auto h-full min-h-48 w-full">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeOpacity={0.4} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={36}
              tickMargin={8}
              tickFormatter={(value: string) => formatAxis(value, withYear)}
            />
            <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(_value, payload) =>
                    formatFull(String(payload?.[0]?.payload?.date ?? ""))
                  }
                />
              }
            />
            <Area
              dataKey="documents"
              type="monotone"
              fill="var(--color-documents)"
              fillOpacity={0.18}
              stroke="var(--color-documents)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}
