import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatDay } from "@/lib/viz";

// The force-graph library is far heavier than the rest of the landing put
// together, so it is split out and only fetched once this section is near.
const MiniGraph = lazy(() => import("@/components/MiniGraph"));

/** True once the element has come within a screen of the viewport. Never flips back. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setNear(true),
      { rootMargin: "600px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);

  return near;
}

const STATS = [
  ["Memories", "1,284"],
  ["Beliefs", "1,102"],
  ["Sources", "317"],
  ["Superseded", "182"],
];

/*
 * Seeded writes for the mock workspace: twelve real week-starts ending today,
 * counts organic — quiet early weeks, a couple of dips, no round numbers.
 */
const WEEKLY_WRITES = [14, 22, 19, 31, 38, 33, 47, 52, 49, 63, 71, 86];

const activityData = WEEKLY_WRITES.map((writes, index) => {
  const week = new Date();
  week.setDate(week.getDate() - (WEEKLY_WRITES.length - 1 - index) * 7);
  const key = week.toISOString().slice(0, 10);
  return { date: key, day: formatDay(key), writes };
});

/* Fixed colour, not a theme pair: the landing is dark regardless of html.dark. */
const activityConfig = {
  writes: { label: "Writes", color: "#f2c46b" },
} satisfies ChartConfig;

export function DashboardProof() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10 2xl:max-w-[88rem]">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">The dashboard</p>
        <h2 className="mt-5 max-w-2xl text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
          Inspect what your agents remember.
        </h2>
        <p className="mt-6 max-w-[37rem] text-base leading-relaxed text-muted-foreground md:text-lg">
          Every memory is browsable, every source is readable, and nothing your agents wrote is hidden from you.
        </p>
      </div>

      <motion.div
        ref={ref}
        initial={reduceMotion ? false : { opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.15 }}
        transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
        className="mt-14 overflow-hidden rounded-2xl border bg-[var(--card)]"
      >
        <div className="flex h-12 items-center gap-7 border-b px-5 md:px-7">
          <span className="font-serif text-base">Trove</span>
          <span className="text-xs text-muted-foreground">Overview</span>
          <span className="text-xs font-medium">Graph</span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">example workspace</span>
        </div>

        <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
          <div className="border-b p-5 md:p-7 lg:border-b-0 lg:border-r">
            <div className="grid grid-cols-2 border-y">
              {STATS.map(([label, value], index) => (
                <div
                  key={label}
                  className={`p-4 ${index % 2 === 0 ? "border-r" : ""} ${index > 1 ? "border-t" : ""}`}
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
                  <p className="tnum mt-2 text-2xl font-medium tracking-tight">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-7">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">Memory activity</p>
                <span className="font-mono text-[10px] text-muted-foreground">writes / week</span>
              </div>
              <ChartContainer config={activityConfig} className="mt-6 aspect-auto h-32 w-full">
                <AreaChart data={activityData} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.35} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={32} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={26} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <Area
                    dataKey="writes"
                    type="monotone"
                    fill="var(--color-writes)"
                    fillOpacity={0.16}
                    stroke="var(--color-writes)"
                    strokeWidth={1.5}
                    isAnimationActive={!reduceMotion}
                  />
                </AreaChart>
              </ChartContainer>
            </div>
          </div>

          {/* The explorer itself, on seeded data — not a drawing of it. Click a node. */}
          <div className="relative h-[26rem] bg-[var(--background)] lg:h-[30rem]">
            <Suspense fallback={null}>{near && <MiniGraph />}</Suspense>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
