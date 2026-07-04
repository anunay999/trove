import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDay } from "@/lib/viz";
import type { Stats } from "@/lib/api";

const chartConfig = {
  documents: {
    label: "Documents",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
} satisfies ChartConfig;

// Dated by domain time — the date each document claims for itself (frontmatter
// or filename) — not by when it was imported into the graph.
export function WritesChart({ stats }: { stats: Stats }) {
  const rows = stats.sourcesPerDay;
  const first = rows[0]?.date;
  const spanDays = first
    ? Math.min(
        365,
        Math.max(30, Math.ceil((Date.now() - Date.parse(`${first}T00:00:00`)) / 86_400_000) + 1),
      )
    : 30;

  const byDate = new Map(rows.map((row) => [row.date, row.documents]));
  const data: Array<{ date: string; day: string; documents: number }> = [];
  const today = new Date();
  for (let i = spanDays - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    data.push({ date: key, day: formatDay(key), documents: byDate.get(key) ?? 0 });
  }

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-full min-h-56 w-full">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.4} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={36} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
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
  );
}
