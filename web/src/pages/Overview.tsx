import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/StatTile";
import { BarList } from "@/components/BarList";
import { WritesChart } from "@/components/WritesChart";
import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { RecentActivity } from "@/components/RecentActivity";
import { HealthCard } from "@/components/HealthCard";
import { typeColor, OTHER_LIGHT, OTHER_DARK, formatWhen } from "@/lib/viz";
import type { NodeType, Stats } from "@/lib/api";

// Editorial layout: open sections separated by hairlines, not boxed cards.
function Section({ title, meta, children, className = "" }: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col py-6 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {meta ? <span className="font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
      </div>
      <div className="mt-5 min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function Overview({ stats, dark }: { stats: Stats | null; dark: boolean }) {
  if (!stats) {
    return (
      <div className="flex flex-col gap-8 pt-4">
        <div className="grid gap-6 border-y py-6 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-56" />
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
    <div className="flex flex-col">
      {/* KPI strip: numbers separated by hairlines, no boxes */}
      <div className="grid border-y sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Memories"
          value={stats.totals.nodes}
          meta={`${stats.totals.views} saved view${stats.totals.views === 1 ? "" : "s"}`}
          className="py-6 pr-6 sm:border-r"
        />
        <StatTile
          label="Active beliefs"
          value={stats.totals.edges}
          meta="edges currently held true"
          className="border-t py-6 sm:border-t-0 sm:pl-6 xl:border-r xl:pr-6"
        />
        <StatTile
          label="Sources ingested"
          value={stats.totals.ingests}
          meta="evidence-backed documents"
          className="border-t py-6 pr-6 sm:border-r xl:border-t-0 xl:pl-6"
        />
        <StatTile
          label="Recalls"
          value={stats.totals.totalRecalls}
          meta="reads strengthen activation"
          className="border-t py-6 sm:pl-6 xl:border-t-0"
        />
      </div>

      <div className="grid xl:grid-cols-5">
        <Section title="Memory timeline" meta="by document date" className="xl:col-span-3 xl:pr-8">
          <WritesChart stats={stats} />
        </Section>
        <Section title="Write cadence" meta="last 16 weeks" className="border-t xl:col-span-2 xl:border-l xl:border-t-0 xl:pl-8">
          <ActivityHeatmap stats={stats} dark={dark} />
        </Section>
      </div>

      <div className="grid border-t xl:grid-cols-3">
        <Section title="Composition" meta={`${stats.totals.nodes} nodes`} className="xl:pr-8">
          <BarList rows={composition} neutralColor={neutral} />
        </Section>
        <Section title="Most recalled" meta="by access count" className="border-t xl:border-l xl:border-t-0 xl:px-8">
          {recalled.length > 0 ? (
            <BarList rows={recalled} neutralColor={neutral} />
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              No recalls recorded yet. Once agents call graph.recall or graph.read, the most
              retrieved memories surface here.
            </p>
          )}
        </Section>
        <Section title="Relationship types" meta={`${stats.totals.edges} edges`} className="border-t xl:border-l xl:border-t-0 xl:pl-8">
          <BarList rows={predicates} neutralColor={neutral} />
        </Section>
      </div>

      <div className="grid border-t xl:grid-cols-5">
        <Section title="Recent activity" meta="event log" className="xl:col-span-3 xl:pr-8">
          <RecentActivity stats={stats} />
        </Section>
        <Section title="Graph health" meta="lint" className="border-t xl:col-span-2 xl:border-l xl:border-t-0 xl:pl-8">
          <HealthCard stats={stats} />
        </Section>
      </div>
    </div>
  );
}
