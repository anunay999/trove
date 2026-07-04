type StatTileProps = {
  label: string;
  value: number;
  meta?: string;
  className?: string;
};

export function StatTile({ label, value, meta, className }: StatTileProps) {
  return (
    <div className={className}>
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-4xl font-medium leading-none text-foreground">{value.toLocaleString()}</p>
      {meta ? <p className="mt-2 text-xs text-muted-foreground">{meta}</p> : null}
    </div>
  );
}
