import type { AgentResult } from "./agent.js";
import type { Session } from "./scenarios.js";

/** Retrieval tools whose presence in a transcript counts as "retrieved, not re-derived". */
const RETRIEVAL_TOOLS = new Set(["recall", "read", "read_notes"]);

export type SessionScore = {
  scenarioId: number;
  arm: string;
  seed: number;
  n: number;
  kind: Session["score"]["kind"];
  /** Primary check for this session's metric passed (undefined for seed/supersede). */
  pass?: boolean;
  /** fresh-belief only: the answer used the OLD superseded value. */
  staleBelief?: boolean;
  /** memory-dependent session answered without any retrieval tool call. */
  rederived?: boolean;
  answer: string;
  toolNames: string[];
  tokensIn: number;
  latencyMs: number;
};

/** True when the answer contains ANY of the needle(s). */
function containsAny(haystack: string, needle?: string | string[]): boolean {
  if (!needle) return false;
  const hay = haystack.toLowerCase();
  const needles = Array.isArray(needle) ? needle : [needle];
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

/** Deterministic scoring — string/substring checks only, no LLM judge. */
export function scoreSession(
  session: Session,
  result: AgentResult,
  meta: { scenarioId: number; arm: string; seed: number },
): SessionScore {
  const answer = result.finalAnswer ?? "";
  const kind = session.score.kind;
  const expect = session.score.expect;
  const mustNot = session.score.must_not;
  const retrieved = result.toolNames.some((name) => RETRIEVAL_TOOLS.has(name));

  const base: SessionScore = {
    scenarioId: meta.scenarioId,
    arm: meta.arm,
    seed: meta.seed,
    n: session.n,
    kind,
    answer,
    toolNames: result.toolNames,
    tokensIn: result.tokensIn,
    latencyMs: result.latencyMs,
  };

  // Sessions whose answer depends on a fact established earlier in the run.
  const memoryDependent = kind === "recall" || kind === "fresh-belief" || kind === "cite";
  if (memoryDependent) {
    base.rederived = !retrieved;
  }

  switch (kind) {
    case "recall":
    case "cite":
    case "control":
      base.pass = containsAny(answer, expect);
      break;
    case "fresh-belief": {
      const usesNew = containsAny(answer, expect);
      const usesOld = containsAny(answer, mustNot);
      // The answer is correct as long as it asserts the CURRENT value. A
      // contrastive mention of the old value ("now ISO 8601 instead of epoch
      // seconds") is the *better* answer, not a failure — Trove's SUPERSEDED
      // context makes exactly that answer more likely. Stale belief fires only
      // when the answer gives the OLD value INSTEAD of the new one.
      base.staleBelief = usesOld && !usesNew;
      base.pass = usesNew;
      break;
    }
    case "seed":
    case "supersede":
      // Not scored for accuracy; they establish state.
      break;
  }

  return base;
}

export type MetricTable = {
  arm: string;
  sessions: number;
  context_pickup: { value: number | null; n: number };
  rederivation: { value: number | null; n: number };
  stale_belief: { value: number | null; n: number };
  citation: { value: number | null; n: number };
  control_pass: { value: number | null; n: number };
  meanTokensIn: number;
  meanLatencyMs: number;
};

function fraction(hits: number, total: number): { value: number | null; n: number } {
  return { value: total === 0 ? null : hits / total, n: total };
}

/** Aggregate all scored sessions for one arm into the DESIGN metric table. */
export function aggregate(arm: string, scores: SessionScore[]): MetricTable {
  const recall = scores.filter((s) => s.kind === "recall");
  const fresh = scores.filter((s) => s.kind === "fresh-belief");
  const cite = scores.filter((s) => s.kind === "cite");
  const control = scores.filter((s) => s.kind === "control");
  const memoryDependent = scores.filter((s) => s.rederived !== undefined);
  const scored = scores.filter((s) => s.pass !== undefined || s.staleBelief !== undefined || s.rederived !== undefined);

  const meanTokens = scored.length ? scored.reduce((a, s) => a + s.tokensIn, 0) / scored.length : 0;
  const meanLatency = scored.length ? scored.reduce((a, s) => a + s.latencyMs, 0) / scored.length : 0;

  return {
    arm,
    sessions: scores.length,
    context_pickup: fraction(recall.filter((s) => s.pass).length, recall.length),
    rederivation: fraction(memoryDependent.filter((s) => s.rederived).length, memoryDependent.length),
    stale_belief: fraction(fresh.filter((s) => s.staleBelief).length, fresh.length),
    citation: fraction(cite.filter((s) => s.pass).length, cite.length),
    control_pass: fraction(control.filter((s) => s.pass).length, control.length),
    meanTokensIn: meanTokens,
    meanLatencyMs: meanLatency,
  };
}
