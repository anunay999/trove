/**
 * Can the graph still find its own notes?
 *
 * WHY THIS EXISTS. Every other health check here asks about structure — is this
 * note linked, does it carry evidence, is its title unique. None of them ask the
 * only question that decides whether a memory graph is working: when you go
 * looking for something you wrote, does it come back. A note can be perfectly
 * well-formed, richly linked, freshly written, and still be unreachable, because
 * reachability is not a property of the note. It is a property of the note
 * *and everything around it*, and it therefore gets worse as the graph grows —
 * silently, with no defect anywhere to find.
 *
 * The failure has a shape, measured on a real 991-note graph: a general note in
 * a topic cluster absorbs the query and the specific one beside it never
 * surfaces. "How do I run the E2E suite locally" returns the note about how CI
 * runs it. The leaf is not missing, not stale, not orphaned. It is shadowed.
 *
 * THE ANSWER KEY IS ALREADY IN THE GRAPH. This is what makes a continuous check
 * possible rather than a benchmark somebody has to maintain: every note IS the
 * ground truth for the question it answers, so retrieval can be graded with
 * nobody labelling anything. Ask the graph about a note in that note's own
 * words; if the note does not come back, the graph cannot find it.
 *
 * WHAT A RESULT MEANS, EXACTLY. The probe is the note's own summary, so the
 * lexical arm is handed the note's own vocabulary — the easiest question anyone
 * could ask about it. That asymmetry is the point and it runs one way:
 *
 *   - a MISS is strong evidence. If a note cannot be retrieved by its own
 *     summary, no real question phrased in someone else's words will do better.
 *   - a HIT is weak evidence. It clears a floor, not a bar.
 *
 * So this counts blind spots. It does not score retrieval quality, and the
 * found/probed ratio should never be read as an accuracy figure.
 *
 * NO LLM, AND NO WRITES. The probe text is the summary, not a generated
 * question, so a self-test costs one recall per sampled note and nothing else —
 * no judge budget, no key, no provider to be down. It also touches nothing:
 * recall does not bump activation (only `read` does), so measuring the graph
 * cannot alter the signal that ranks it, and running this hourly would not
 * quietly promote whatever it happened to sample.
 */

import type { GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphStore } from "./graphCore.js";

/** One probe: a note, asked about in its own words. */
export type SelfTestProbe = {
  nodeId: string;
  slug: string;
  title: string;
  /** Did the note come back in its own pack? */
  found: boolean;
  /** Where it landed, 0-based; null when it never appeared. */
  rank: number | null;
  /**
   * What came back instead, best first. On a miss these are the notes standing
   * in front of it — usually the hub of its own topic cluster, which is the
   * actionable half of the finding: it names what to merge into, link to, or
   * retitle away from.
   */
  shadowedBy: Array<{ id: string; title: string }>;
};

export type RecallSelfTestResult = {
  /** How many notes were asked about. */
  probed: number;
  /** How many came back. */
  found: number;
  /** The notes the graph could not retrieve in their own words, worst first. */
  blindSpots: SelfTestProbe[];
  /** Notes with too little text to ask about; counted, never guessed at. */
  skipped: number;
};

/** How many of the shadowing notes a miss carries. Enough to name the hub. */
const SHADOW_LIMIT = 3;
/** A pack big enough to be a fair test, small enough to run many of. */
export const SELF_TEST_TOKEN_BUDGET = 1200;
/** Below this a summary is a label, not a description, and cannot be a probe. */
const MIN_PROBE_CHARS = 24;

/**
 * The question to ask about a note: its own summary.
 *
 * Never the title. A title is matched almost verbatim by the lexical arm, so a
 * title probe measures string equality and passes for everything — including
 * the shadowed notes this exists to find. The summary is the shortest text that
 * describes the note rather than naming it.
 */
export function selfTestQuery(node: Pick<GraphNode, "summary">): string | null {
  const summary = node.summary?.trim();
  if (!summary || summary.length < MIN_PROBE_CHARS) return null;
  return summary;
}

/**
 * Which notes to ask about.
 *
 * Never-read first, then round-robin across types. Never-read because a note
 * nothing has ever opened is where an unnoticed blind spot can hide; round-robin
 * because shadowing is a within-cluster failure and sampling one type would
 * measure one cluster's luck.
 *
 * Deterministic for a given graph, on purpose: a health number that resamples
 * every run cannot be compared with last run's, and the first thing anyone will
 * want to know is whether a change helped.
 */
export function pickSelfTestSample(nodes: GraphNode[], limit: number): GraphNode[] {
  if (limit <= 0) return [];
  const byType = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (selfTestQuery(node) === null) continue;
    const bucket = byType.get(node.type);
    if (bucket) bucket.push(node);
    else byType.set(node.type, [node]);
  }
  for (const bucket of byType.values()) {
    bucket.sort((left, right) =>
      left.accessCount - right.accessCount || left.slug.localeCompare(right.slug));
  }
  // Types in a fixed order too, so the sample does not shift when a type's
  // count changes and reorders a Map built by insertion.
  const types = [...byType.keys()].sort();
  const picked: GraphNode[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let tookOne = false;
    for (const type of types) {
      const node = byType.get(type)?.[round];
      if (!node) continue;
      picked.push(node);
      tookOne = true;
      if (picked.length === limit) break;
    }
    if (!tookOne) break;
  }
  return picked;
}

/**
 * Ask the graph about a sample of its own notes and report what it cannot find.
 *
 * One recall per note, sequentially: this is a background health check with no
 * one waiting on it, and a burst of parallel recalls against the same pool is
 * the sort of thing that makes an interactive read slow for a real caller.
 */
export async function runRecallSelfTest(
  store: Pick<GraphStore, "exportGraph" | "recall">,
  options: { sampleSize?: number } = {},
  context?: GraphOperationContext,
): Promise<RecallSelfTestResult> {
  const sampleSize = Math.max(0, Math.trunc(options.sampleSize ?? 20));
  const snapshot = await store.exportGraph(context);
  const probeable = snapshot.nodes.filter((node) => selfTestQuery(node) !== null);
  const sample = pickSelfTestSample(snapshot.nodes, sampleSize);

  const blindSpots: SelfTestProbe[] = [];
  let found = 0;
  for (const node of sample) {
    const query = selfTestQuery(node);
    if (query === null) continue;
    const pack = await store.recall({
      query,
      tokenBudget: SELF_TEST_TOKEN_BUDGET,
      includeEvidence: false,
    }, context);
    const rank = pack.atoms.findIndex((atom) => atom.node.id === node.id);
    if (rank >= 0) {
      found += 1;
      continue;
    }
    blindSpots.push({
      nodeId: node.id,
      slug: node.slug,
      title: node.title,
      found: false,
      rank: null,
      shadowedBy: pack.atoms.slice(0, SHADOW_LIMIT).map((atom) => ({
        id: atom.node.id,
        title: atom.node.title,
      })),
    });
  }

  return {
    probed: sample.length,
    found,
    blindSpots,
    // Everything the sampler could never have picked: a note with no summary
    // cannot be asked about, and saying so is better than reporting a clean
    // result over a graph half of which was never eligible.
    skipped: snapshot.nodes.length - probeable.length,
  };
}
