import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const MOMENTS = [
  {
    label: "Capture the source",
    command: 'remember("Launch moved to Friday", source)',
    detail: "The update enters Trove with the exact note that supports it.",
  },
  {
    label: "Connect the meaning",
    command: "connect(launch, design_review)",
    detail: "The fact joins the people, work, and decisions it affects.",
  },
  {
    label: "Keep the history",
    command: 'supersede("Wednesday", "Friday")',
    detail: "The new belief becomes current. The previous one stays inspectable.",
  },
  {
    label: "Recall the answer",
    command: 'recall("What changed before launch?")',
    detail: "The agent gets the current answer, nearby context, and its proof.",
  },
] as const;

const points = {
  note: { x: 16, y: 23 },
  launch: { x: 46, y: 43 },
  design: { x: 77, y: 23 },
  oldDate: { x: 30, y: 76 },
  newDate: { x: 71, y: 76 },
};

function path(from: { x: number; y: number }, to: { x: number; y: number }) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function GraphNode({ x, y, title, meta, active = false, muted = false }: {
  x: number;
  y: number;
  title: string;
  meta: string;
  active?: boolean;
  muted?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: muted ? 0.48 : 1, scale: active ? 1.04 : 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      <div className={`min-w-28 rounded-lg border px-3 py-2.5 shadow-sm backdrop-blur md:min-w-36 ${active ? "border-[var(--signal)] bg-[color-mix(in_srgb,var(--signal)_10%,var(--background))]" : "bg-background/90"}`}>
        <p className={`text-xs font-semibold ${muted ? "line-through" : ""}`}>{title}</p>
        <p className="mt-1 font-mono text-[9px] text-muted-foreground md:text-[10px]">{meta}</p>
      </div>
    </motion.div>
  );
}

export function MemoryStory() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState(reduceMotion ? 3 : 0);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % MOMENTS.length), 3800);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const hasConnections = active >= 1;
  const hasRevision = active >= 2;

  return (
    <div className="mt-14 grid overflow-hidden rounded-2xl border bg-background shadow-[0_24px_80px_color-mix(in_srgb,var(--foreground)_8%,transparent)] md:grid-cols-[0.72fr_1.28fr]">
      <div className="border-b p-5 md:border-b-0 md:border-r md:p-7">
        <div className="font-mono text-[11px] text-muted-foreground">trove / memory flow</div>
        <div className="mt-7 grid gap-2" role="tablist" aria-label="Memory flow">
          {MOMENTS.map((moment, index) => (
            <button
              key={moment.label}
              type="button"
              role="tab"
              aria-selected={active === index}
              onClick={() => setActive(index)}
              className={`rounded-lg px-4 py-3 text-left transition-colors ${active === index ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/55 hover:text-foreground"}`}
            >
              <span className="block text-sm font-semibold">{moment.label}</span>
              <span className="mt-1 block text-xs leading-relaxed opacity-75">{moment.detail}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-[480px] overflow-hidden md:min-h-[610px]">
        <div className="absolute inset-0 landing-dot-field opacity-60" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <motion.path d={path(points.note, points.launch)} className="stroke-muted-foreground/40" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="4 4" fill="none" />
          <motion.path
            d={path(points.launch, points.design)}
            initial={false}
            animate={{ pathLength: hasConnections ? 1 : 0, opacity: hasConnections ? 1 : 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="stroke-foreground/55"
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          <motion.path
            d={path(points.launch, points.oldDate)}
            initial={false}
            animate={{ pathLength: hasConnections ? 1 : 0, opacity: hasRevision ? 0.25 : hasConnections ? 1 : 0 }}
            transition={{ duration: 0.7 }}
            className="stroke-foreground/50"
            strokeWidth="1.25"
            strokeDasharray={hasRevision ? "4 4" : undefined}
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          <motion.path
            d={path(points.launch, points.newDate)}
            initial={false}
            animate={{ pathLength: hasRevision ? 1 : 0, opacity: hasRevision ? 1 : 0 }}
            transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
            className="stroke-[var(--signal)]"
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        </svg>

        <GraphNode {...points.note} title="Launch sync notes" meta="source / July 11" active={active === 0} />
        <GraphNode {...points.launch} title="Launch plan" meta="project" active={active === 1 || active === 3} />
        {hasConnections && <GraphNode {...points.design} title="Design review" meta="depends on launch" />}
        {hasConnections && <GraphNode {...points.oldDate} title="Wednesday" meta="previous deadline" muted={hasRevision} />}
        {hasRevision && <GraphNode {...points.newDate} title="Friday" meta="current deadline" active={active >= 2} />}

        <div className="absolute inset-x-5 bottom-5 rounded-xl border bg-background/92 p-4 shadow-lg backdrop-blur md:inset-x-8 md:bottom-8 md:p-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={reduceMotion ? false : { opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.28 }}
            >
              <p className="font-mono text-[11px] leading-relaxed text-[var(--signal-strong)]">{MOMENTS[active].command}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{MOMENTS[active].detail}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
