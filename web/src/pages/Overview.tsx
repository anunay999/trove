import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/StatTile";
import { BarList } from "@/components/BarList";
import { WritesChart } from "@/components/WritesChart";
import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { RecentActivity } from "@/components/RecentActivity";
import { HealthCard } from "@/components/HealthCard";
import { typeColor, OTHER_LIGHT, OTHER_DARK, formatWhen } from "@/lib/viz";
import type { NodeType, Stats } from "@/lib/api";

function SectionCard({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <Card className="flex h-full flex-col gap-4 rounded-lg border bg-card shadow-none">
      <CardHeader className="flex-row items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {meta ? <span className="font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
      </CardHeader>
      <CardContent className="min-h-0 flex-1">{children}</CardContent>
    </Card>
  );
}

export function Overview({ stats, dark }: { stats: Stats | null; dark: boolean }) {
  if (!stats) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-36 rounded-lg" />
        ))}
      </div>
    );
  }

  const neutral = dark ? OTHER_DARK : OTHER_LIGHT;
  const composition = stats.nodeTypes.map((row) => ({
    label: row.key,
    value: row.count,
    color: typeColor(row.key as NodeType, dark),
  }));
  const predicates = stats.predicates.slice(0, 8).map((row) => ({ label: row.key, value: row.count }));
  const recalled = stats.topAccessed.slice(0, 8).map((row) => ({
    label: row.title,
    value: row.accessCount,
    color: typeColor(row.type, dark),
    hint: `${row.title} — recalled ${row.accessCount}x${row.lastAccessedAt ? `, last ${formatWhen(row.lastAccessedAt)}` : ""}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Memories"
          value={stats.totals.nodes}
          meta={`${stats.totals.views} saved view${stats.totals.views === 1 ? "" : "s"}`}
        />
        <StatTile label="Active beliefs" value={stats.totals.edges} meta="edges currently held true" />
        <StatTile label="Sources ingested" value={stats.totals.ingests} meta="evidence-backed documents" />
        <StatTile
          label="Recalls"
          value={stats.totals.totalRecalls}
          meta="reads strengthen activation"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <SectionCard title="Memory timeline" meta="by document date">
            <WritesChart stats={stats} />
          </SectionCard>
        </div>
        <div className="xl:col-span-2">
          <SectionCard title="Write cadence" meta="last 16 weeks">
            <ActivityHeatmap stats={stats} dark={dark} />
          </SectionCard>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard title="Composition" meta={`${stats.totals.nodes} nodes`}>
          <BarList rows={composition} neutralColor={neutral} />
        </SectionCard>
        <SectionCard title="Most recalled" meta="by access count">
          {recalled.length > 0 ? (
            <BarList rows={recalled} neutralColor={neutral} />
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              No recalls recorded yet. Once agents call graph.recall or graph.read, the most
              retrieved memories surface here.
            </p>
          )}
        </SectionCard>
        <SectionCard title="Relationship types" meta={`${stats.totals.edges} edges`}>
          <BarList rows={predicates} neutralColor={neutral} />
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <SectionCard title="Recent activity" meta="event log">
            <RecentActivity stats={stats} />
          </SectionCard>
        </div>
        <div className="xl:col-span-2">
          <SectionCard title="Graph health" meta="lint">
            <HealthCard stats={stats} />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
