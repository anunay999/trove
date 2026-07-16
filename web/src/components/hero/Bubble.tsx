import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { MemoryFact, Slot } from "@/lib/hero-memories";

const DROPLETS = 8;
const BURST_MS = 420;

type BubbleProps = {
  memory: MemoryFact;
  slot: Slot;
  /** Called once the burst has played and the fact belongs to the graph. */
  onCapture: (memory: MemoryFact) => void;
  /** About to pop itself to demonstrate. Rings so the eye is already there. */
  cued?: boolean;
};

/**
 * One memory as a soap bubble: session context, still ephemeral.
 *
 * Clicking captures it — the bubble bursts and the fact drops into the graph.
 * The burst is the moment the fact stops being fragile, so it reads as a
 * transfer rather than a loss. Bubbles never reform.
 */
export function Bubble({ memory, slot, onCapture, cued = false }: BubbleProps) {
  const reduceMotion = useReducedMotion();
  const [popping, setPopping] = useState(false);

  function capture() {
    if (popping) return;
    if (reduceMotion) {
      onCapture(memory);
      return;
    }
    setPopping(true);
    window.setTimeout(() => onCapture(memory), BURST_MS);
  }

  return (
    <motion.div
      className="absolute"
      style={{ left: `${slot.x}%`, top: `${slot.y}%`, "--bubble-size": `${slot.size}rem` } as React.CSSProperties}
      initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.6 }}
      animate={
        reduceMotion
          ? { opacity: 1 }
          : {
              opacity: 1,
              scale: 1,
              // A slow rise and sway, unique per bubble so the field never pulses in unison.
              y: [0, -14, 4, -8, 0],
              x: [0, 7, -5, 3, 0],
            }
      }
      transition={
        reduceMotion
          ? { duration: 0.2 }
          : {
              opacity: { duration: 0.7, delay: slot.delay },
              scale: { type: "spring", stiffness: 120, damping: 14, delay: slot.delay },
              y: { duration: slot.drift, repeat: Infinity, ease: "easeInOut", delay: slot.delay },
              x: { duration: slot.drift * 1.4, repeat: Infinity, ease: "easeInOut", delay: slot.delay },
            }
      }
    >
      <motion.button
        type="button"
        onClick={capture}
        aria-label={`Capture memory: ${memory.fact}`}
        animate={popping ? { scale: [1, 1.16, 1.4], opacity: [1, 1, 0] } : { scale: 1, opacity: 1 }}
        transition={popping ? { duration: BURST_MS / 1000, ease: "easeOut", times: [0, 0.3, 1] } : { duration: 0.2 }}
        whileHover={reduceMotion || popping ? undefined : { scale: 1.06 }}
        className="bubble-skin group relative grid -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
        data-popping={popping}
      >
        {/*
         * The origin tag is what makes these read as agent output rather than
         * decoration. Hidden below md, where the bubble is too small to hold it —
         * the capture reveal still names the agent and the source.
         */}
        <span className="pointer-events-none relative z-10 hidden px-2 text-center font-mono text-[9px] leading-tight text-[color-mix(in_srgb,var(--foreground)_72%,transparent)] [text-shadow:0_1px_6px_rgba(0,0,0,0.55)] transition-colors group-hover:text-[var(--foreground)] md:block">
          ● {memory.agent}
        </span>
      </motion.button>

      {/* Sends the eye to the bubble a beat before it demonstrates the pop. */}
      {cued && !reduceMotion && (
        <motion.span
          className="bubble-ring pointer-events-none absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/60"
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.45 }}
          transition={{ duration: 0.9, repeat: Infinity, ease: "easeOut" }}
        />
      )}

      {popping && !reduceMotion && (
        <span className="pointer-events-none absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2">
          {Array.from({ length: DROPLETS }).map((_, i) => {
            const angle = (i / DROPLETS) * Math.PI * 2;
            const throwTo = slot.size * 9;
            return (
              <motion.span
                key={i}
                className="absolute size-1 rounded-full bg-white/80"
                initial={{ opacity: 0.9, x: 0, y: 0, scale: 1 }}
                animate={{
                  opacity: 0,
                  scale: 0.3,
                  x: Math.cos(angle) * throwTo,
                  y: Math.sin(angle) * throwTo,
                }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            );
          })}
        </span>
      )}
    </motion.div>
  );
}
