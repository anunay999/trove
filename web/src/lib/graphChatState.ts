import { useCallback, useEffect, useRef, useState } from "react";

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

// ---- Paced replay ---------------------------------------------------------

/**
 * Retrieval is faster than the eye.
 *
 * A local recall finishes both search arms, a two-hop walk and the pack inside
 * about a tenth of a second, so publishing each event the moment it lands lights
 * the whole crawl in one frame: the graph blinks, and the thing the panel exists
 * to show never happens on screen. So the highlights are put through a queue and
 * released on a clock.
 *
 * The seam, said plainly, because it is the one place this feature bends:
 *
 *   - the ANIMATION is paced. These three constants are the only numbers on the
 *     screen that were not measured.
 *   - the NUMBERS are not. Every elapsed time in the stage list is the server's
 *     own measurement, carried through untouched; nothing displayed is ever
 *     derived from this clock.
 *   - nothing is invented. The queue only ever replays events the server sent,
 *     in the order it sent them. A node that retrieval did not touch never
 *     lights, however long the replay runs.
 *
 * Under `prefers-reduced-motion: reduce` the queue is bypassed entirely and the
 * final state appears at once.
 */

/** Between two nodes inside one stage. */
export const REPLAY_NODE_MS = 40;
/** Held at a stage boundary, so the stages read as separate moves. */
export const REPLAY_STAGE_MS = 190;
/** Ceiling for the whole replay: a big pack compresses rather than drags. */
export const REPLAY_BUDGET_MS = 1800;
/** However much it compresses, two nodes never land in the same frame. */
const REPLAY_MIN_NODE_MS = 8;

/** One node's promotion, as the panel reads it off a stream event. */
export type ReplayPromotion = {
  id: string;
  state: ChatHighlightState;
  hops?: number;
  arm?: ChatHighlight["arm"];
};

/**
 * One beat of the replay: a stage row and the nodes that stage touched.
 * Either half may be empty — `rank` reports no nodes, and a `seeds` event for
 * an arm that found nothing is a row with no lights, which is the point.
 */
export type ReplayBeat<TStage> = { stage?: TStage; nodes: ReplayPromotion[] };

/**
 * Replay a turn's beats at a watchable pace.
 *
 * `begin` starts a turn (and cancels whatever the last one was still playing,
 * so a second question interrupts cleanly), `push` adds a beat as it arrives
 * off the stream, `cancel` stops without clearing the graph.
 */
export function useRetrievalReplay<TStage>(options: {
  onHighlights: (highlights: ChatHighlights) => void;
  onStage: (stage: TStage) => void;
  reduced: boolean;
}): {
  begin: () => void;
  push: (beat: ReplayBeat<TStage>) => void;
  cancel: () => void;
  isReplaying: boolean;
} {
  const { onHighlights, onStage, reduced } = options;
  const callbacks = useRef({ onHighlights, onStage, reduced });
  callbacks.current = { onHighlights, onStage, reduced };

  const queue = useRef<ReplayBeat<TStage>[]>([]);
  const lit = useRef(new Map<string, ChatHighlight>());
  const timer = useRef<number | null>(null);
  const [isReplaying, setIsReplaying] = useState(false);

  /** Strictly increasing: a node already further along is never walked back. */
  const promote = (node: ReplayPromotion) => {
    const current = lit.current.get(node.id);
    if (current && CHAT_STATE_RANK[current.state] >= CHAT_STATE_RANK[node.state]) return;
    lit.current.set(node.id, {
      state: node.state,
      hops: node.hops ?? current?.hops ?? 0,
      ...(node.arm ?? current?.arm ? { arm: node.arm ?? current?.arm } : {}),
      at: performance.now(),
    });
  };

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const step = useCallback(() => {
    timer.current = null;
    const beat = queue.current[0];
    if (!beat) {
      setIsReplaying(false);
      return;
    }
    if (beat.stage !== undefined) {
      callbacks.current.onStage(beat.stage);
      beat.stage = undefined;
    }
    const node = beat.nodes.shift();
    if (node) {
      promote(node);
      callbacks.current.onHighlights(new Map(lit.current));
    }
    const beatDone = beat.nodes.length === 0;
    if (beatDone) queue.current.shift();
    if (queue.current.length === 0) {
      setIsReplaying(false);
      return;
    }
    // Spend the budget across whatever is still waiting, so a 40-node pack
    // speeds up instead of turning into a slideshow.
    const pending = queue.current.reduce((total, row) => total + row.nodes.length, 0);
    const perNode = Math.max(
      REPLAY_MIN_NODE_MS,
      Math.min(REPLAY_NODE_MS, REPLAY_BUDGET_MS / Math.max(1, pending)),
    );
    timer.current = window.setTimeout(step, beatDone ? REPLAY_STAGE_MS : perNode);
  }, []);

  const begin = useCallback(() => {
    stop();
    queue.current = [];
    lit.current = new Map();
    setIsReplaying(false);
    // Everything dims the moment the question is sent; nodes earn their way
    // back out of the dark as the replay reports the server touching them.
    callbacks.current.onHighlights(new Map());
  }, [stop]);

  const push = useCallback(
    (beat: ReplayBeat<TStage>) => {
      if (callbacks.current.reduced) {
        if (beat.stage !== undefined) callbacks.current.onStage(beat.stage);
        for (const node of beat.nodes) promote(node);
        callbacks.current.onHighlights(new Map(lit.current));
        return;
      }
      queue.current.push({ stage: beat.stage, nodes: [...beat.nodes] });
      setIsReplaying(true);
      if (timer.current === null) step();
    },
    [step],
  );

  const cancel = useCallback(() => {
    stop();
    queue.current = [];
    setIsReplaying(false);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { begin, push, cancel, isReplaying };
}

/** The shape progressPhrase needs; GraphChat's Stage satisfies it. */
export type ProgressStage = { key: string; label: string };

/**
 * What to say while the answer is still on its way.
 *
 * A question takes long enough that silence reads as a hang, so the panel
 * names the phase it is in — the way a chat UI says "Thinking" — and keeps
 * saying it until the first words of the answer render.
 *
 * The phrase is derived from the last stage the SERVER sent (or the last one
 * the paced replay has released, which is the same list), so it can never
 * claim a step that has not happened. An unrecognised label falls back to the
 * label itself rather than to something invented.
 */
export function progressPhrase(stages: ProgressStage[], model: string | null): string {
  const last = stages.at(-1);
  if (!last) return "Retrieving";
  if (last.key.startsWith("seeds:")) return "Searching";
  switch (last.key) {
    case "fused": return "Fusing what search found";
    case "expand": return "Traversing the graph";
    case "rank": return "Ranking what it reached";
    case "pack": return "Packing the answer's context";
    case "answer": return model ? `Answering with ${model}` : "Answering";
    default: return last.label;
  }

}
