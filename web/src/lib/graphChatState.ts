import { useEffect, useState } from "react";

/**
 * How the graph view reads a chat turn.
 *
 * The panel (components/GraphChat.tsx) drives these; the canvas
 * (pages/GraphView.tsx) draws them. They live apart from both so neither file
 * has to import the other's rendering.
 */

/** How far a node got. Strictly increasing: a node is never demoted. */
export type ChatHighlightState = "expanded" | "seed" | "packed" | "cited";

export const CHAT_STATE_RANK: Record<ChatHighlightState, number> = {
  expanded: 0,
  seed: 1,
  packed: 2,
  cited: 3,
};

export type ChatHighlight = {
  state: ChatHighlightState;
  /** Graph distance from a seed. 0 for a seed, 1+ for anything traversal reached. */
  hops: number;
  /** Which arm found it, when an arm did. */
  arm?: "lexical" | "semantic" | "grep";
  /** When this node last changed state, for the arrival pulse. */
  at: number;
};

/** `null` means the chat is not driving the graph; a Map means it is. */
export type ChatHighlights = Map<string, ChatHighlight> | null;

export const CHAT_STATE_LABEL: Record<ChatHighlightState, string> = {
  expanded: "reached by traversal",
  seed: "search hit",
  packed: "packed into the answer's context",
  cited: "cited by the answer",
};

/**
 * One accent, four strengths — these are stages of one process, not four
 * categories, so they should read as an escalation rather than a legend. The
 * node keeps its own type colour as its fill; the state lives in the ring.
 */
export function highlightInk(state: ChatHighlightState, dark: boolean): string {
  if (state === "cited") return dark ? "#dda064" : "#e3a15f";
  if (state === "packed") return dark ? "#f5f5f2" : "#111111";
  if (state === "seed") return dark ? "#a3a29b" : "#787774";
  return dark ? "#52514e" : "#c3c2b7";
}

/** Honour the OS setting: states still change, the transitions just stop. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
