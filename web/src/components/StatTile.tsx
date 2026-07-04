import { Card } from "@/components/ui/card";

type StatTileProps = {
  label: string;
  value: number;
  meta?: string;
};

export function StatTile({ label, value, meta }: StatTileProps) {
  return (
    <Card className="gap-2 rounded-lg border bg-card p-6 shadow-none">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="text-4xl font-medium leading-none text-foreground">{value.toLocaleString()}</p>
      {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}
