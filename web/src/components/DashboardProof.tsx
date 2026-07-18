import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

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

const ACTIVITY = [18, 30, 24, 44, 36, 58, 48, 69, 61, 82, 74, 92];

export function DashboardProof() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10">
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
              <div className="mt-6 flex h-24 items-end gap-2 border-b pb-px">
                {ACTIVITY.map((height, index) => (
                  <motion.span
                    key={`${height}-${index}`}
                    initial={reduceMotion ? false : { scaleY: 0 }}
                    whileInView={{ scaleY: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.55, delay: index * 0.035, ease: [0.16, 1, 0.3, 1] }}
                    className="flex-1 origin-bottom bg-[var(--signal)] opacity-70"
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* The explorer itself, on seeded data — not a drawing of it. */}
          <div className="relative h-[26rem] bg-[var(--background)] lg:h-[30rem]">
            <Suspense fallback={null}>{near && <MiniGraph />}</Suspense>
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border bg-[var(--card)]/90 px-3 py-2 backdrop-blur">
              <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--signal)]">Evidence attached</p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Every node opens the source text that earned it.
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
