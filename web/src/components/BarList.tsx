type BarListRow = {
  label: string;
  value: number;
  color?: string;
  hint?: string;
};

type BarListProps = {
  rows: BarListRow[];
  neutralColor: string;
};

// Flat CSS bar list: thin marks, direct labels, values in tabular figures.
// Identity is carried by the row label (and optional swatch), never color alone.
export function BarList({ rows, neutralColor }: BarListProps) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <div key={row.label} className="group grid grid-cols-[9rem_1fr_3rem] items-center gap-3" title={row.hint ?? `${row.label}: ${row.value}`}>
          <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
            {row.color ? (
              <span className="size-2 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden />
            ) : null}
            <span className="truncate">{row.label}</span>
          </span>
          <span className="relative h-4 overflow-hidden rounded-[3px] bg-muted/60">
            <span
              className="absolute inset-y-0 left-0 rounded-[3px] transition-opacity group-hover:opacity-80"
              style={{ width: `${(row.value / max) * 100}%`, background: row.color ?? neutralColor }}
            />
          </span>
          <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
            {row.value.toLocaleString()}
          </span>
        </div>
      ))}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : null}
    </div>
  );
}
