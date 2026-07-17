import { motion, useReducedMotion } from "motion/react";
import { REVEAL_MS } from "@/components/hero/CaptureReveal";
import type { MemoryFact } from "@/lib/hero-memories";

type MemoryNodeProps = {
  memory: MemoryFact;
  /** A later fact replaced this belief. It stays on the graph, dimmed. */
  superseded: boolean;
};

/**
 * What the bubble leaves behind: the fact, now durable, in the graph.
 *
 * It lands exactly where the bubble was, so the capture reads as the same object
 * changing state — glass to solid — rather than something new appearing elsewhere.
 * Superseded nodes stay put and go quiet; nothing is removed.
 *
 * Labels sit beside the dot and always point inward, away from the page edge.
 * Centred under each dot they landed at eight unrelated positions and read as
 * scattered text; anchored to a side they line up into two quiet columns.
 */
export function MemoryNode({ memory, superseded }: MemoryNodeProps) {
  const reduceMotion = useReducedMotion();
  const onLeft = memory.slot.x < 50;
  // Nodes in the top of the field open their evidence downward. Opening upward
  // from a slot at y:9 pushed the card past the top of the section, where the
  // field's `overflow-hidden` simply cut it off.
  const openDown = memory.slot.y < 45;

  return (
    // A zero-size anchor sitting exactly on the slot, so the dot lands on the
    // point the edges are drawn to and the label hangs off it.
    //
    // z-30 is load-bearing and belongs here rather than on the tooltip. This is
    // a motion.div, so it carries a transform and opens its own stacking
    // context — a z-30 on the tooltip inside it is measured against its
    // siblings, not against the z-20 copy column, and the evidence card ended up
    // painted under the waitlist and behind the session line. The anchor is the
    // element that has to clear the copy; everything inside it then rides along.
    // Safe because the slots keep the centre column clear for the headline.
    <motion.div
      className="pointer-events-none absolute z-30"
      style={{ left: `${memory.slot.x}%`, top: `${memory.slot.y}%` }}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.3 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 230, damping: 18 }}
    >
      <span
        className={`absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-[var(--background)] transition-colors ${
          superseded ? "bg-muted-foreground" : "bg-[var(--signal)]"
        }`}
      />

      {/*
       * The label waits for the capture reveal to clear. Both land on the same
       * spot, and showing the full sentence and its short label at once read as
       * one cluttered block rather than two beats.
       */}
      <motion.button
        type="button"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.45, delay: reduceMotion ? 0 : REVEAL_MS / 1000 - 0.15 }}
        className={`group pointer-events-auto absolute top-1/2 -translate-y-1/2 cursor-default whitespace-nowrap rounded px-1 py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)] ${
          onLeft ? "left-3" : "right-3"
        }`}
        aria-label={`${memory.fact}. Source: ${memory.source}.${superseded ? " Superseded, still inspectable." : ""}`}
      >
        <span
          className={`label-knockout text-[10px] font-medium transition-colors ${
            superseded ? "text-muted-foreground line-through decoration-1" : "text-foreground"
          }`}
        >
          {memory.short}
        </span>

        {/* The evidence, on demand — the graph stays readable, the receipt stays reachable. */}
        <span
          className={`pointer-events-none absolute z-30 w-[13rem] scale-95 whitespace-normal rounded-lg border border-border bg-[var(--card)] p-2.5 opacity-0 shadow-xl transition-all group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100 ${
            onLeft ? "left-0" : "right-0"
          } ${openDown ? "top-full mt-2" : "bottom-full mb-2"}`}
        >
          <span className="block text-[11px] font-medium leading-snug text-foreground">{memory.fact}</span>
          <span className="mt-1 block font-mono text-[9px] text-[var(--signal)]">
            ↳ {memory.source} · {memory.agent}
          </span>
          {superseded && (
            <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
              superseded · still inspectable
            </span>
          )}
        </span>
      </motion.button>
    </motion.div>
  );
}
