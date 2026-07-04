import { useRef, useState } from "react";
import { seqColor, formatDay } from "@/lib/viz";
import type { Stats } from "@/lib/api";

const WEEKS = 16;
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

type HoverCell = { date: string; count: number; left: number; top: number };

// GitHub-style cadence heatmap: one sequential hue, light -> dark.
export function ActivityHeatmap({ stats, dark }: { stats: Stats; dark: boolean }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverCell | null>(null);
  const byDate = new Map(stats.eventsPerDay.map((row) => [row.date, row.total]));
  const max = Math.max(1, ...stats.eventsPerDay.map((row) => row.total));

  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + ((7 - end.getDay()) % 7)); // pad to Sunday
  const cells: Array<Array<{ date: string; count: number; future: boolean }>> = [];
  for (let week = WEEKS - 1; week >= 0; week -= 1) {
    const column: Array<{ date: string; count: number; future: boolean }> = [];
    for (let day = 0; day < 7; day += 1) {
      const cellDate = new Date(end);
      cellDate.setDate(end.getDate() - week * 7 - (6 - day));
      const key = cellDate.toISOString().slice(0, 10);
      column.push({ date: key, count: byDate.get(key) ?? 0, future: cellDate > today });
    }
    cells.push(column);
  }

  const showTooltip = (event: React.MouseEvent, cell: { date: string; count: number }) => {
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const cellRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setHover({
      date: cell.date,
      count: cell.count,
      left: cellRect.left - gridRect.left + cellRect.width / 2,
      top: cellRect.top - gridRect.top,
    });
  };

  return (
    <div className="flex h-full flex-col justify-center">
      <div ref={gridRef} className="relative flex gap-2">
        <div className="grid grid-rows-7 gap-1 pt-0.5">
          {DAY_LABELS.map((label, index) => (
            <span key={index} className="h-3 font-mono text-[9px] leading-3 text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
        <div className="flex flex-1 justify-between gap-1" onMouseLeave={() => setHover(null)}>
          {cells.map((column, columnIndex) => (
            <div key={columnIndex} className="grid grid-rows-7 gap-1">
              {column.map((cell) => (
                <span
                  key={cell.date}
                  onMouseEnter={(event) => (cell.future ? setHover(null) : showTooltip(event, cell))}
                  className="size-3 rounded-[2px] ring-border hover:ring-1"
                  style={{
                    background: cell.future
                      ? "transparent"
                      : cell.count === 0
                        ? "var(--muted)"
                        : seqColor(cell.count, max, dark),
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-popover px-2 py-1 shadow-none"
            style={{ left: hover.left, top: hover.top - 6 }}
          >
            <span className="text-xs text-foreground">{formatDay(hover.date)}</span>{" "}
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {hover.count.toLocaleString()} event{hover.count === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}
      </div>

    </div>
  );
}
