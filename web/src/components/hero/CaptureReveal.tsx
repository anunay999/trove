import { motion, useReducedMotion } from "motion/react";
import type { MemoryFact, Slot } from "@/lib/hero-memories";

export const REVEAL_MS = 2000;

type CaptureRevealProps = {
  memory: MemoryFact;
  slot: Slot;
};

/**
 * What the bubble was holding, shown where the bubble was.
 *
 * The rail sits far below the field, so a fact that went straight there was a
 * capture the reader never saw. This holds the fact at the burst for a beat, then
 * lets it fall toward the graph.
 */
export function CaptureReveal({ memory, slot }: CaptureRevealProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="pointer-events-none absolute z-20 w-[11rem] -translate-x-1/2 -translate-y-1/2 text-center"
      style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={
        reduceMotion
          ? { opacity: [0, 1, 1, 0], scale: 1 }
          : { opacity: [0, 1, 1, 0], scale: [0.9, 1, 1, 0.96], y: [0, -8, -8, 26] }
      }
      transition={{ duration: REVEAL_MS / 1000, times: [0, 0.14, 0.66, 1], ease: "easeOut" }}
    >
      <p className="label-knockout text-[13px] font-medium leading-snug text-foreground">{memory.fact}</p>
      <p className="label-knockout mt-1 font-mono text-[9px] text-[var(--signal)]">
        ↳ {memory.source} · {memory.agent}
      </p>
    </motion.div>
  );
}
