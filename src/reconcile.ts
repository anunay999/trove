/**
 * Write-time reconciliation — "the compaction of meaning"
 * (docs/memory-db-design.md §3).
 *
 * Supersession exists in Trove as a *capability* (supersedes edges, edge
 * invalidation, validity intervals) but nothing detected conflicts and invoked
 * it: an agent had to notice the contradiction itself, which in practice it
 * never does. This module closes that loop. On every capture and
 * content-changing update the store enqueues a `reconcile_node` job; performing
 * it candidate-matches the written node against its owner's existing nodes
 * (lexical + semantic search), judges each candidate pair, and acts:
 *
 * - "supersedes" (same fact, newer value), LLM-confident → a `supersedes` edge
 *   from the newer node to the older one. Non-destructive and replayable —
 *   recall marks the superseded atom instead of deleting anything.
 * - "contradicts" / "duplicate" → flags in the job result for an agent or
 *   operator to resolve. Auto-invalidation of a genuine contradiction needs a
 *   temporal judgement we deliberately do not automate.
 * - Without a configured judge (the default — see createReconcileJudgeFromEnv;
 *   the LLM judge is opt-in via TROVE_RECONCILE_JUDGE=1)
 *   a conservative heuristic runs instead: it only flags near-identical titles
 *   as possible duplicates and never mutates the graph.
 *
 * The whole pass is idempotent: re-running it re-judges and the edge insert is
 * conflict-guarded by the store's link() dedupe.
 */

import type { GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphStore } from "./graphCore.js";

export type ReconcileVerdict = "supersedes" | "duplicate" | "contradicts" | "related" | "distinct";

export type ReconcileJudgment = {
  verdict: ReconcileVerdict;
  /** 0..1 — the actor thresholds below gate on it, so judges must be honest. */
  confidence: number;
  reason: string;
};

export type ReconcileJudge = (pair: {
  newNode: GraphNode;
  candidate: GraphNode;
}) => Promise<ReconcileJudgment>;

export type ReconcileCandidateResult = {
  nodeId: string;
  title: string;
  verdict: ReconcileVerdict;
  confidence: number;
  reason: string;
};

export type ReconcileResult = {
  nodeId: string;
  status: "reconciled" | "skipped_node_missing";
  judge: string;
  candidates: ReconcileCandidateResult[];
  supersedesEdgesCreated: Array<{ fromNodeId: string; toNodeId: string }>;
  flags: Array<{ code: "contradiction_candidate" | "possible_duplicate"; nodeId: string; otherNodeId: string; detail: string }>;
};

// A pair must clear these bars before anything is written or flagged. The
// supersedes bar is the highest: a wrong edge tells every future recall the
// old fact is dead.
const SUPERSEDE_MIN_CONFIDENCE = 0.8;
const CONTRADICT_MIN_CONFIDENCE = 0.7;
const DUPLICATE_MIN_CONFIDENCE = 0.9;
// Judging is one LLM call per pair; cap pairs so a pathological write cannot
// fan out into unbounded spend.
const MAX_CANDIDATES = 5;

const VERDICTS: ReadonlySet<string> = new Set(["supersedes", "duplicate", "contradicts", "related", "distinct"]);

/**
 * Parse a judge's free-text reply into a structured judgment. Accepts the
 * first {...} block anywhere in the reply; anything unparseable degrades to a
 * low-confidence "related", which triggers no action — a malformed judge can
 * never mutate the graph.
 */
export function parseReconcileJudgment(reply: string): ReconcileJudgment {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const verdict = typeof parsed.verdict === "string" && VERDICTS.has(parsed.verdict)
        ? (parsed.verdict as ReconcileVerdict)
        : "related";
      const rawConfidence = Number(parsed.confidence);
      const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
      const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "";
      return { verdict, confidence, reason };
    } catch {
      // fall through to the safe default
    }
  }
  return { verdict: "related", confidence: 0, reason: "unparseable judge reply" };
}

function nodeText(node: GraphNode): string {
  return [node.title, node.summary ?? "", (node.content ?? "").slice(0, 2000)].filter(Boolean).join("\n");
}

function judgePrompt(newNode: GraphNode, candidate: GraphNode): string {
  return [
    "You reconcile memory atoms in a personal knowledge graph. Given a NEW atom and an EXISTING atom, classify their relationship.",
    "",
    '- "supersedes": both state the same fact about the same subject, and the NEW atom carries the newer value (an update or correction). Example: "volleyball record is 4-2" vs "volleyball record is 5-2".',
    '- "duplicate": the same fact restated with no newer information.',
    '- "contradicts": they cannot both be true and neither is clearly newer.',
    '- "related": same subject or topic, different facts.',
    '- "distinct": unrelated.',
    "",
    'Reply with JSON only: {"verdict":"...","confidence":0..1,"reason":"..."}. Use "supersedes" only when the SAME attribute of the SAME subject changed; prefer "related" when unsure.',
    "",
    `NEW (${newNode.updatedAt}):\n${nodeText(newNode)}`,
    "",
    `EXISTING (${candidate.updatedAt}):\n${nodeText(candidate)}`,
  ].join("\n");
}

/**
 * Opt-in flags accept the forms an operator actually types. A strict `=== "1"`
 * turns `TROVE_RECONCILE_JUDGE=true` into a silent no-op — config that reads as
 * enabled and is not — which is the same silent-failure class as dropping an
 * unresolvable citation (#9). Anything unrecognised stays OFF, because the
 * expensive direction should never be reached by accident.
 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Build the LLM judge from the environment, or return null when unconfigured.
 * Uses the OpenAI chat API directly (same key as embeddings); the model
 * defaults to gpt-4o-mini and is overridable via TROVE_RECONCILE_JUDGE_MODEL.
 *
 * OPT-IN — `TROVE_RECONCILE_JUDGE=1` is required. It was originally opt-OUT,
 * which meant any deployment with an OPENAI_API_KEY (i.e. any deployment with
 * semantic search) silently took up to 5 LLM calls per write, proportional to
 * write volume and with no ceiling. Measured: a 335-node corpus cost ~25
 * minutes and ~1,675 judge calls, which was enough to break benchmark runs.
 *
 * The judge is also being asked a question it should not need to answer — "are
 * these two atoms even related?" is already answered numerically, for free, by
 * the embedding distance that `SearchResult` currently discards. Until backlog
 * #27 gates on that distance and batches the survivors, the honest default is
 * off: the heuristic below still flags near-identical titles and never mutates
 * the graph, so nothing is silently lost by leaving it off.
 */
export function createReconcileJudgeFromEnv(): ReconcileJudge | null {
  if (!isEnabled(process.env.TROVE_RECONCILE_JUDGE)) return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.TROVE_RECONCILE_JUDGE_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  return async ({ newNode, candidate }) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: judgePrompt(newNode, candidate) }],
      }),
    });
    if (!response.ok) throw new Error(`reconcile judge: OpenAI ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseReconcileJudgment(body.choices?.[0]?.message?.content ?? "");
  };
}

/**
 * Conservative no-LLM fallback: flags only near-identical titles (token
 * Jaccard ≥ 0.8) as possible duplicates, and never concludes "supersedes" —
 * value-update detection is a judgement call heuristics get wrong.
 */
export function heuristicJudgment(newNode: GraphNode, candidate: GraphNode): ReconcileJudgment {
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const a = tokens(newNode.title);
  const b = tokens(candidate.title);
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  if (jaccard >= 0.8) {
    return { verdict: "duplicate", confidence: jaccard, reason: `title token overlap ${jaccard.toFixed(2)}` };
  }
  return { verdict: "related", confidence: 1 - jaccard, reason: `title token overlap ${jaccard.toFixed(2)}` };
}

/**
 * Candidate-match, judge, and act for one written node. Shared by both
 * drivers: the judge is injectable so tests never touch the network, and
 * `null` selects the heuristic.
 */
export async function performReconcileNode(
  store: GraphStore,
  input: { nodeId: string; ownerId?: string | null },
  judge: ReconcileJudge | null,
): Promise<ReconcileResult> {
  const context: GraphOperationContext | undefined = input.ownerId ? { ownerId: input.ownerId } : undefined;
  const node = await store.read({ nodeId: input.nodeId }, context, { trackAccess: false });
  if (!node) {
    return { nodeId: input.nodeId, status: "skipped_node_missing", judge: judge ? "llm" : "heuristic", candidates: [], supersedesEdgesCreated: [], flags: [] };
  }

  // Candidate-match per the design doc — lexical on the title, semantic on
  // title+summary. The semantic arm silently contributes nothing when no
  // embedding provider is configured; the lexical arm always works.
  const [lexical, semantic] = await Promise.all([
    store.search({ query: node.title, mode: "lexical", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
    store.search({ query: `${node.title}\n${node.summary ?? ""}`, mode: "semantic", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
  ]);
  const candidates = new Map<string, GraphNode>();
  for (const hit of [...lexical.nodes, ...semantic.nodes]) {
    if (hit.id !== node.id) candidates.set(hit.id, hit);
  }

  const result: ReconcileResult = {
    nodeId: node.id,
    status: "reconciled",
    judge: judge ? "llm" : "heuristic",
    candidates: [],
    supersedesEdgesCreated: [],
    flags: [],
  };

  for (const candidate of [...candidates.values()].slice(0, MAX_CANDIDATES)) {
    const judgment = judge
      ? await judge({ newNode: node, candidate })
      : heuristicJudgment(node, candidate);
    result.candidates.push({ nodeId: candidate.id, title: candidate.title, ...judgment });

    if (judgment.verdict === "supersedes" && judgment.confidence >= SUPERSEDE_MIN_CONFIDENCE) {
      // The non-destructive resolution: an edge recording that this newer node
      // supersedes the older one. link() dedupes on (from, to, predicate), so
      // re-running the job cannot stack duplicates.
      const edge = await store.link({ fromNodeId: node.id, toSlug: candidate.slug, predicate: "supersedes", weight: 1 }, context);
      if (edge) result.supersedesEdgesCreated.push({ fromNodeId: node.id, toNodeId: candidate.id });
    } else if (judgment.verdict === "contradicts" && judgment.confidence >= CONTRADICT_MIN_CONFIDENCE) {
      result.flags.push({ code: "contradiction_candidate", nodeId: node.id, otherNodeId: candidate.id, detail: judgment.reason });
    } else if (judgment.verdict === "duplicate" && judgment.confidence >= DUPLICATE_MIN_CONFIDENCE) {
      result.flags.push({ code: "possible_duplicate", nodeId: node.id, otherNodeId: candidate.id, detail: judgment.reason });
    }
  }

  return result;
}
