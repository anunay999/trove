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
  memories: {
    label: "Memories",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
  documents: {
    label: "Documents",
    theme: { light: "#94a3b8", dark: "#7c8899" },
  },
} satisfies ChartConfig;

/**
 * When the graph grew, and on what.
 *
 * This chart used to plot documents alone, under the title "Memory timeline".
 * Documents are the rarest thing anyone does here — you write atoms daily and
 * ingest a transcript once a month — so it read 0 or 1 on almost every day
 * while the graph beside it held fifteen hundred atoms. It looked broken, and
 * it was measuring the wrong noun. Memories lead now; documents stay as the
 * quieter second line, because "did I add raw material or distil it" is a real
 * question, just not the headline one.
 *
 * Memories carry one date each, the day they were first written, so they need
 * no mode. Documents carry two that disagree by months on an imported vault,
 * which is what the pills are for.
 */
type Mode = "added" | "dated";

const MODES = [
  {
    id: "added" as const,
    label: "Added",
    help: "Memories by the day you wrote them; documents by the day you added them.",
  },
  {
    id: "dated" as const,
    label: "Dated",
    help: "Memories by the day you wrote them; documents by the date they are about — frontmatter or filename.",
  },
];

const EMPTY_HELP =
  "Nothing landed in this window. Widen the range, or switch how documents are dated.";

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

function Key({ series, children }: { series: "memories" | "documents"; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-2 rounded-[2px]"
        style={{ background: `var(--color-${series})` }}
      />
      {children}
    </span>
  );
}

export function WritesChart({ stats }: { stats: Stats }) {
  const [mode, setMode] = useState<Mode>("added");
  const [rangeId, setRangeId] = useState("90d");

  const active = MODES.find((option) => option.id === mode)!;
  const range = RANGES.find((option) => option.id === rangeId)!;

  const { data, memories, documents, spanDays, oldest } = useMemo(() => {
    const documentRows = mode === "added" ? stats.sourcesIngestedPerDay : stats.sourcesPerDay;
    const memoryRows = stats.memoriesPerDay;
    // The axis has to reach back to whichever series starts first, or "All"
    // would crop the older one out of its own history.
    const first = [memoryRows[0]?.date, documentRows[0]?.date]
      .filter((date): date is string => Boolean(date))
      .sort()[0];
    const sinceFirst = first
      ? Math.ceil((Date.now() - Date.parse(`${first}T00:00:00`)) / DAY_MS) + 1
      : 30;
    const span = range.days ?? Math.min(MAX_SPAN_DAYS, Math.max(30, sinceFirst));

    const memoriesByDate = new Map(memoryRows.map((row) => [row.date, row.memories]));
    const documentsByDate = new Map(documentRows.map((row) => [row.date, row.documents]));
    const points: Array<{ date: string; memories: number; documents: number }> = [];
    let memoryTotal = 0;
    let documentTotal = 0;
    for (let i = span - 1; i >= 0; i -= 1) {
      const key = dayKey(i);
      const written = memoriesByDate.get(key) ?? 0;
      const added = documentsByDate.get(key) ?? 0;
      memoryTotal += written;
      documentTotal += added;
      points.push({ date: key, memories: written, documents: added });
    }
    return {
      data: points,
      memories: memoryTotal,
      documents: documentTotal,
      spanDays: span,
      oldest: first,
    };
  }, [stats, mode, range]);

  // Say what the axis actually covers. "All" names the first day it holds
  // rather than pretending to a round number of days.
  const windowLabel = range.days
    ? range.window
    : oldest
      ? `Since ${formatFull(data[0]?.date ?? oldest)}`
      : range.window;
  const withYear = spanDays > 200;
  const empty = memories === 0 && documents === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Pills
          label="Date documents by"
          value={mode}
          onChange={setMode}
          options={MODES.map((option) => ({
            id: option.id,
            label: option.label,
            hint: option.id === "added"
              ? "Date documents by when they were added"
              : "Date documents by the date they are about",
          }))}
        />
        <Pills label="Time range" value={rangeId} onChange={setRangeId} options={RANGES} />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {empty ? EMPTY_HELP : active.help}{" "}
        <span className="text-foreground/70">
          {windowLabel} ·{" "}
          <Key series="memories">
            {`${memories} ${memories === 1 ? "memory" : "memories"}`}
          </Key>{" "}
          ·{" "}
          <Key series="documents">
            {`${documents} document${documents === 1 ? "" : "s"}`}
          </Key>
        </span>
      </p>

      {empty ? (
        <div className="mt-4 flex min-h-48 flex-1 items-center">
          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            Nothing to plot yet. Write a memory and it lands here the same day.
          </p>
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
              dataKey="memories"
              type="monotone"
              fill="var(--color-memories)"
              fillOpacity={0.18}
              stroke="var(--color-memories)"
              strokeWidth={2}
            />
            {/* Stroke only, and thinner: documents are the context, not the
                subject, and a second fill would read as a stacked total. */}
            <Area
              dataKey="documents"
              type="monotone"
              fill="var(--color-documents)"
              fillOpacity={0}
              stroke="var(--color-documents)"
              strokeWidth={1.5}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}
