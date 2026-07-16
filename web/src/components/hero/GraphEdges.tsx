import { motion, useReducedMotion } from "motion/react";
import { memoryById, type MemoryFact } from "@/lib/hero-memories";

type GraphEdgesProps = {
  /** Everything in the field right now — bubbles and captured nodes alike. */
  visible: MemoryFact[];
  capturedIds: Set<string>;
};

type Edge = {
  key: string;
  from: MemoryFact;
  to: MemoryFact;
  /** Both ends captured: the link is real and holds. */
  live: boolean;
  /** This edge retires its target rather than merely relating to it. */
  supersede: boolean;
};

/**
 * The threads between facts.
 *
 * Drawn from the start, faint, while the facts are still bubbles — the shape of
 * the graph is there before anything is kept, which is what makes the field read
 * as a graph rather than as loose decoration. An edge firms up once both of its
 * ends have been captured. A superseding edge is dashed: the relationship is
 * "replaces", and the old belief is still sitting at the other end of it.
 *
 * Endpoints anchor to slot centres. Bubbles drift by less than their own radius,
 * so the line always meets the bubble body.
 */
export function GraphEdges({ visible, capturedIds }: GraphEdgesProps) {
  const reduceMotion = useReducedMotion();
  const shown = new Set(visible.map((m) => m.id));

  const edges: Edge[] = [];
  for (const memory of visible) {
    for (const targetId of memory.links) {
      if (!shown.has(targetId)) continue;
      const to = memoryById(targetId);
      if (!to) continue;
      const live = capturedIds.has(memory.id) && capturedIds.has(targetId);
      edges.push({
        key: `${memory.id}->${targetId}`,
        from: memory,
        to,
        live,
        supersede: live && memory.supersedes === targetId,
      });
    }
  }

  return (
    // Percentage coordinates, not a `viewBox`: a 100x100 box stretched to the
    // field would scale x and y differently, which shears dashes and the
    // dash-based pathLength draw into fragments.
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      {edges.map((edge) => (
        <motion.line
          key={edge.key}
          x1={`${edge.from.slot.x}%`}
          y1={`${edge.from.slot.y}%`}
          x2={`${edge.to.slot.x}%`}
          y2={`${edge.to.slot.y}%`}
          strokeDasharray={edge.supersede ? "5 5" : undefined}
          initial={reduceMotion ? false : { pathLength: 0 }}
          animate={{
            pathLength: 1,
            stroke: edge.live ? "var(--signal)" : "#ffffff",
            // Fine but legible while still glass — silk, not a hint. It firms up
            // and turns gold once both ends are kept.
            strokeOpacity: edge.live ? (edge.supersede ? 0.34 : 0.55) : 0.3,
            strokeWidth: edge.live ? 1 : 0.7,
          }}
          transition={{
            pathLength: { duration: 1.1, ease: [0.16, 1, 0.3, 1] },
            default: { duration: 0.5 },
          }}
        />
      ))}
    </svg>
  );
}
