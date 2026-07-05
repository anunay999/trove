import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Borderless hero scene: a four-beat loop that shows Trove doing its job —
 * capture with evidence, linking, supersession on the record, budgeted recall.
 * A dim ambient constellation keeps it reading as a living graph while the
 * story plays out on labeled nodes.
 */

const PHASE_MS = 3200;

const PHASES = [
  { cmd: 'remember("Sarah joined as the designer")', caption: "Agents capture facts, with the source attached" },
  { cmd: "connect(sarah → website-redesign)", caption: "Facts connect into a graph" },
  { cmd: 'remember("deadline moved to Friday")', caption: "Beliefs update on the record. History stays." },
  { cmd: 'recall("where is the redesign at?")', caption: "Recall surfaces the facts that matter, sized to your budget" },
];

// Story nodes, coordinates in a 0-100 field (percent of the scene box).
const N = {
  source: { x: 15, y: 16 },
  sarah: { x: 38, y: 34 },
  redesign: { x: 57, y: 54 },
  wed: { x: 36, y: 76 },
  fri: { x: 78, y: 72 },
};

// Ambient constellation: three loose clusters (like force-layout communities)
// so the backdrop reads as a real knowledge graph, not a wireframe ring.
const BG = [
  // cluster A — top right
  { x: 68, y: 10, r: 1.5 }, { x: 80, y: 18, r: 2 }, { x: 72, y: 26, r: 1.5 },
  { x: 88, y: 10, r: 1 }, { x: 90, y: 26, r: 1.5 },
  // cluster B — mid left
  { x: 8, y: 40, r: 1.5 }, { x: 4, y: 56, r: 1 }, { x: 16, y: 52, r: 2 },
  { x: 12, y: 68, r: 1.5 }, { x: 24, y: 62, r: 1 },
  // cluster C — bottom
  { x: 54, y: 90, r: 1.5 }, { x: 66, y: 84, r: 2 }, { x: 46, y: 96, r: 1 },
  { x: 78, y: 94, r: 1.5 }, { x: 88, y: 84, r: 1 },
];
const BG_EDGES: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
  // cluster A triangles
  [BG[0], BG[1]], [BG[0], BG[2]], [BG[1], BG[2]], [BG[1], BG[3]], [BG[1], BG[4]], [BG[2], BG[4]],
  // cluster B triangles
  [BG[5], BG[6]], [BG[5], BG[7]], [BG[6], BG[7]], [BG[7], BG[8]], [BG[7], BG[9]], [BG[8], BG[9]],
  // cluster C triangles
  [BG[10], BG[11]], [BG[10], BG[12]], [BG[11], BG[13]], [BG[13], BG[14]], [BG[11], BG[14]],
  // bridges into the story
  [BG[7], N.source], [BG[9], N.sarah], [BG[2], N.redesign], [BG[11], N.fri],
  [BG[11], N.redesign], [BG[8], N.wed], [BG[4], N.fri],
];

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }) {
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

function Node({ at, label, kind, visible, pulse, labelSide = "right" }: {
  at: { x: number; y: number };
  label: string;
  kind: "fact" | "source" | "expired";
  visible: boolean;
  pulse: boolean;
  labelSide?: "right" | "left" | "below";
}) {
  const labelClass = labelSide === "left"
    ? "right-4 top-1/2 -translate-y-1/2"
    : labelSide === "below"
      ? "left-1/2 top-4 -translate-x-1/2"
      : "left-4 top-1/2 -translate-y-1/2";
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="absolute"
          style={{ left: `${at.x}%`, top: `${at.y}%` }}
        >
          <div className="relative -translate-x-1/2 -translate-y-1/2">
            <span className="relative flex size-2.5 items-center justify-center">
              {pulse && (
                <motion.span
                  className="absolute inline-flex size-full rounded-full bg-amber-600/50"
                  animate={{ scale: [1, 2.4], opacity: [0.7, 0] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <span
                className={`relative inline-flex size-2.5 rounded-full ${
                  kind === "source" ? "border border-muted-foreground bg-background" :
                  kind === "expired" ? "bg-muted-foreground/40" : "bg-foreground"
                }`}
              />
            </span>
            <span
              className={`absolute whitespace-nowrap font-mono text-[10px] tracking-tight sm:text-[11px] ${labelClass} ${
                kind === "expired" ? "text-muted-foreground/60 line-through" : "text-muted-foreground"
              }`}
            >
              {label}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function MemoryStory() {
  const reduceMotion = useReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState(reduceMotion ? 3 : 0);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      setPhase((current) => {
        if (current === 3) {
          setCycle((c) => c + 1);
          return 0;
        }
        return current + 1;
      });
    }, PHASE_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const superseded = phase >= 2;
  const recalling = phase === 3;

  return (
    <div className="mt-16 w-full max-w-3xl" aria-label="How Trove works, animated walkthrough">
      {/* agent console line */}
      <div className="flex items-baseline justify-center gap-2 px-4">
        <span className="font-mono text-[12px] text-muted-foreground/60">›</span>
        <AnimatePresence mode="wait">
          <motion.code
            key={`${cycle}-${phase}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="truncate font-mono text-[12px] text-foreground/85 sm:text-[13px]"
          >
            {PHASES[phase].cmd}
          </motion.code>
        </AnimatePresence>
      </div>

      {/* scene */}
      <div key={cycle} className="relative mx-auto mt-6 h-[300px] w-full max-w-xl sm:h-[330px]">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {/* ambient constellation */}
          {BG_EDGES.map(([a, b], index) => (
            <path
              key={`bg-${index}`}
              d={edgePath(a, b)}
              className="stroke-muted-foreground/15"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          ))}
          {/* evidence edge: sarah -> source */}
          <motion.path
            d={edgePath(N.sarah, N.source)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.4 }}
            className="stroke-muted-foreground/60"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="4 4"
            fill="none"
          />
          {/* sarah -> redesign */}
          {phase >= 1 && (
            <motion.path
              d={edgePath(N.sarah, N.redesign)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, ease: "easeOut", delay: 0.3 }}
              className="stroke-foreground/70"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
          {/* old belief: redesign -> wednesday, superseded in phase 2 */}
          {phase >= 1 && (
            <motion.path
              d={edgePath(N.redesign, N.wed)}
              initial={{ opacity: 0 }}
              animate={{ opacity: superseded ? 0.3 : 1 }}
              transition={{ duration: 0.5, ease: "easeOut", delay: 0.55 }}
              className="stroke-foreground/70"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
              strokeDasharray={superseded ? "4 4" : undefined}
              fill="none"
            />
          )}
          {/* new belief: redesign -> friday */}
          {phase >= 2 && (
            <motion.path
              d={edgePath(N.redesign, N.fri)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.45 }}
              className="stroke-amber-700/80 dark:stroke-amber-500/80"
              strokeWidth="1.4"
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
        </svg>

        {/* ambient nodes */}
        {BG.map((at, index) => (
          <span
            key={`bgn-${index}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/30"
            style={{ left: `${at.x}%`, top: `${at.y}%`, width: `${at.r * 4}px`, height: `${at.r * 4}px` }}
          />
        ))}

        <Node at={N.source} label="standup notes · mon" kind="source" visible pulse={false} />
        <Node at={N.sarah} label="sarah · designer" kind="fact" visible pulse={recalling} labelSide="left" />
        <Node at={N.redesign} label="website-redesign" kind="fact" visible={phase >= 1} pulse={recalling} />
        <Node at={N.wed} label="deadline · wednesday" kind={superseded ? "expired" : "fact"} visible={phase >= 1} pulse={false} labelSide="below" />
        <Node at={N.fri} label="deadline · friday" kind="fact" visible={phase >= 2} pulse={recalling} labelSide="below" />

        {/* supersession tag */}
        <AnimatePresence>
          {superseded && !recalling && (
            <motion.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, delay: 0.9 }}
              className="absolute -translate-x-1/2 rounded-full border bg-background/80 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground backdrop-blur"
              style={{ left: `${N.wed.x}%`, top: `${N.wed.y + 16}%` }}
            >
              superseded · kept in history
            </motion.span>
          )}
        </AnimatePresence>

      </div>

      {/* caption + progress */}
      <div className="mt-3 flex flex-col items-center gap-3 px-4">
        <AnimatePresence mode="wait">
          <motion.p
            key={`${cycle}-cap-${phase}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="text-center text-[13px] text-muted-foreground"
          >
            {PHASES[phase].caption}
          </motion.p>
        </AnimatePresence>
        <div className="flex gap-1.5" role="presentation">
          {PHASES.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={`Step ${index + 1}`}
              onClick={() => setPhase(index)}
              className={`h-1 rounded-full transition-all duration-300 ${
                index === phase ? "w-6 bg-foreground/70" : "w-2.5 bg-border"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
