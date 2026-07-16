import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Bubble } from "@/components/hero/Bubble";
import { CaptureReveal, REVEAL_MS } from "@/components/hero/CaptureReveal";
import { GraphEdges } from "@/components/hero/GraphEdges";
import { MemoryNode } from "@/components/hero/MemoryNode";
import type { MemoryFact } from "@/lib/hero-memories";

type BubbleFieldProps = {
  /** Bubbles still to capture in the open session. */
  remaining: MemoryFact[];
  /** Everything in the graph, from every session so far. */
  captured: MemoryFact[];
  /** Ids whose belief a later fact has replaced. */
  supersededIds: Set<string>;
  onCapture: (memory: MemoryFact) => void;
};

/**
 * The field, which is also the graph.
 *
 * A bubble is session context; popping it leaves a node in its place, and edges
 * thread out to whatever it relates to. There is no separate panel to look at —
 * the capture and its consequence are the same pixels.
 */
export function BubbleField({ remaining, captured, supersededIds, onCapture }: BubbleFieldProps) {
  const [reveals, setReveals] = useState<MemoryFact[]>([]);
  const [demoId, setDemoId] = useState<string | null>(null);
  const touched = useRef(false);

  const capture = useCallback(
    (memory: MemoryFact) => {
      setReveals((current) => [...current, memory]);
      window.setTimeout(() => {
        setReveals((current) => current.filter((r) => r.id !== memory.id));
      }, REVEAL_MS);
      onCapture(memory);
    },
    [onCapture],
  );

  const captureByHand = useCallback(
    (memory: MemoryFact) => {
      touched.current = true;
      setDemoId(null);
      capture(memory);
    },
    [capture],
  );

  /**
   * Pop the first one for them.
   *
   * Nothing on the page can explain "these are clickable, and clicking keeps
   * them" as quickly as watching it happen once. It runs only while the visitor
   * hasn't touched anything, and leaves the rest of the session to them.
   */
  const first = remaining[0];
  useEffect(() => {
    if (touched.current || captured.length > 0 || !first) return;
    const cue = window.setTimeout(() => !touched.current && setDemoId(first.id), 2200);
    const pop = window.setTimeout(() => !touched.current && capture(first), 3000);
    return () => {
      window.clearTimeout(cue);
      window.clearTimeout(pop);
    };
  }, [first, captured.length, capture]);

  return (
    <div className="pointer-events-none absolute inset-0">
      <GraphEdges visible={[...captured, ...remaining]} capturedIds={new Set(captured.map((m) => m.id))} />

      {captured.map((memory) => (
        <MemoryNode key={memory.id} memory={memory} superseded={supersededIds.has(memory.id)} />
      ))}

      <AnimatePresence>
        {remaining.map((memory) => (
          <div key={memory.id} className="pointer-events-auto">
            <Bubble memory={memory} slot={memory.slot} onCapture={captureByHand} cued={demoId === memory.id} />
          </div>
        ))}
      </AnimatePresence>

      <AnimatePresence>
        {reveals.map((memory) => (
          <CaptureReveal key={memory.id} memory={memory} slot={memory.slot} />
        ))}
      </AnimatePresence>
    </div>
  );
}
