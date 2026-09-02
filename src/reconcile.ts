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
 * (lexical + semantic search), judges the surviving candidates, and acts:
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
 * Cost shape (backlog #27 — the judge used to be one unconditional LLM call
 * per candidate, up to 5 per write; measured ~1,675 calls and ~25 min over a
 * 335-node corpus):
 *
 * 1. GATE — the semantic arm's cosine distance now rides on every search hit
 *    (SearchResultNode.distance). A candidate farther than
 *    TROVE_RECONCILE_SKIP_DISTANCE (default 0.45) is recorded as
 *    via="distance_gate" and never judged. The threshold is CALIBRATED, not
 *    guessed: on a labelled 48-atom corpus (scripts/calibrateReconcileBands.ts)
 *    every supersede pair measured 0.076-0.408 while 0.40 was already low
 *    enough to lose one, so 0.45 keeps a measured margin. A no-call
 *    "near-certain duplicate" band was measured and REJECTED: duplicate and
 *    supersede pairs occupy the same range (0.050-0.399 vs 0.076-0.408) —
 *    anything close enough to flag blindly is close enough to be a
 *    supersession that must reach the judge.
 * 2. BATCH — surviving candidates are judged in ONE call returning a verdict
 *    array, not N pairwise calls. Seen together, the model can tell which of
 *    two similar atoms is the prior version; judged in isolation it cannot.
 *    Worst case is now 1 call per write, and writes with no near neighbour
 *    make 0.
 * 3. BUDGET — TROVE_RECONCILE_JUDGE_BUDGET caps judge calls per owner per
 *    hour (default 100; 0 disables) as a backstop against pathological write
 *    volume. In-process by design (same precedent as ServedUnitLog): each
 *    process keeps its own window, so multi-process deployments should set
 *    the number with that in mind. Overflow is recorded via="budget" and the
 *    job still succeeds — retrying immediately would just re-hit the budget.
 *
 * The whole pass is idempotent: re-running it re-judges and the edge insert is
 * conflict-guarded by the store's link() dedupe.
 */

import type { GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphStore, SearchResultNode } from "./graphCore.js";

export type ReconcileVerdict = "supersedes" | "duplicate" | "contradicts" | "related" | "distinct";

export type ReconcileJudgment = {
  verdict: ReconcileVerdict;
  /** 0..1 — the actor thresholds below gate on it, so judges must be honest. */
  confidence: number;
  reason: string;
};

/**
 * The judge sees the new node and ALL surviving candidates in one call
 * (verdicts index-aligned with `candidates`). Batching is not only cheaper —
 * the model can only tell which of two similar atoms is the prior version when
 * it sees them together.
 */
export type ReconcileJudge = (batch: {
  newNode: GraphNode;
  candidates: GraphNode[];
}) => Promise<ReconcileJudgment[]>;

export type ReconcileCandidateResult = {
  nodeId: string;
  title: string;
  verdict: ReconcileVerdict;
  confidence: number;
  reason: string;
  /** Cosine distance from the semantic arm, null for lexical-only hits. */
  distance: number | null;
  /** How the verdict was reached — the LLM judge, the no-LLM heuristic, the
   *  distance gate (never judged), or unjudged on a spent budget. */
  via: "judge" | "heuristic" | "distance_gate" | "budget";
};

export type ReconcileResult = {
  nodeId: string;
  status: "reconciled" | "skipped_node_missing";
  judge: string;
  candidates: ReconcileCandidateResult[];
  supersedesEdgesCreated: Array<{ fromNodeId: string; toNodeId: string }>;
  flags: Array<{ code: "contradiction_candidate" | "possible_duplicate" | "judge_budget_exceeded"; nodeId: string; otherNodeId: string; detail: string }>;
  /** LLM judge calls this job made: 0 or 1 under the batched policy. The
   *  number backlog #27 exists to drive down — reported, not assumed. */
  judgeCalls: number;
};

// A pair must clear these bars before anything is written or flagged. The
// supersedes bar is the highest: a wrong edge tells every future recall the
// old fact is dead.
const SUPERSEDE_MIN_CONFIDENCE = 0.8;
const CONTRADICT_MIN_CONFIDENCE = 0.7;
const DUPLICATE_MIN_CONFIDENCE = 0.9;
// Candidates are judged in one batched call, but the candidate set itself is
// still capped so a pathological write cannot fan out into a huge prompt.
const MAX_CANDIDATES = 5;

// CALIBRATED default — see the module doc and scripts/calibrateReconcileBands.ts.
// Lowering this below ~0.42 loses real supersessions on the measured corpus
// (a true pair sat at 0.408); it is not a free dial.
const SKIP_DISTANCE_DEFAULT = 0.45;

function reconcileSkipDistance(): number {
  const raw = process.env.TROVE_RECONCILE_SKIP_DISTANCE;
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : SKIP_DISTANCE_DEFAULT;
}

/**
 * Split finalist candidates into those worth judging and those the distance
 * gate excuses. A lexical-only hit has distance undefined: a renamed fact is
 * exactly the supersession embeddings can miss, so "unknown" is never treated
 * as "far" — undefined always reaches the judge.
 */
export function partitionReconcileCandidates<T extends { distance: number | undefined }>(
  finalists: T[],
  threshold: number,
): { toJudge: T[]; skipped: T[] } {
  const toJudge: T[] = [];
  const skipped: T[] = [];
  for (const finalist of finalists) {
    if (finalist.distance !== undefined && finalist.distance > threshold) skipped.push(finalist);
    else toJudge.push(finalist);
  }
  return { toJudge, skipped };
}

// ---------------------------------------------------------------------------
// Per-owner judge budget: a sliding window of call timestamps, in-process.
// ---------------------------------------------------------------------------

const JUDGE_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const judgeCallLog = new Map<string, number[]>();

function judgeBudgetLimit(): number {
  const raw = process.env.TROVE_RECONCILE_JUDGE_BUDGET;
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 100;
}

/** True and one call consumed when the owner is inside budget; false when spent. */
function consumeJudgeBudget(ownerKey: string): boolean {
  const limit = judgeBudgetLimit();
  if (limit === 0) return true; // 0 disables the budget entirely
  const now = Date.now();
  const calls = (judgeCallLog.get(ownerKey) ?? []).filter((at) => now - at < JUDGE_BUDGET_WINDOW_MS);
  // Every owner that ever wrote used to keep an entry here for the life of the
  // process, even once its window emptied. The array is windowed; the map was
  // not. Sweeping owners whose windows have gone quiet keeps it proportional to
  // *active* writers instead of to every writer ever seen.
  if (calls.length === 0) judgeCallLog.delete(ownerKey);
  for (const [key, at] of judgeCallLog) {
    if (key !== ownerKey && at[at.length - 1] !== undefined && now - at[at.length - 1]! >= JUDGE_BUDGET_WINDOW_MS) {
      judgeCallLog.delete(key);
    }
  }
  if (calls.length >= limit) {
    judgeCallLog.set(ownerKey, calls);
    return false;
  }
  calls.push(now);
  judgeCallLog.set(ownerKey, calls);
  return true;
}

const VERDICTS: ReadonlySet<string> = new Set(["supersedes", "duplicate", "contradicts", "related", "distinct"]);

function toJudgment(parsed: Record<string, unknown>): ReconcileJudgment {
  const verdict = typeof parsed.verdict === "string" && VERDICTS.has(parsed.verdict)
    ? (parsed.verdict as ReconcileVerdict)
    : "related";
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "";
  return { verdict, confidence, reason };
}

const SAFE_DEFAULT: ReconcileJudgment = { verdict: "related", confidence: 0, reason: "unparseable judge reply" };

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
      return toJudgment(JSON.parse(match[0]) as Record<string, unknown>);
    } catch {
      // fall through to the safe default
    }
  }
  return { ...SAFE_DEFAULT };
}

/**
 * Parse a BATCHED judge reply into `count` judgments. Expects
 * {"verdicts":[{"index":1,"title":"...","verdict":"...","confidence":0..1,"reason":"..."}]}
 * with 1-based indices. Missing or malformed entries degrade to the safe
 * default — one bad entry never poisons the batch, and an absent verdict can
 * never mutate the graph.
 *
 * When `candidates` is given, each entry's echoed `title` is cross-checked
 * against the candidate it claims to describe. Small models sometimes copy a
 * strong verdict onto an unrelated candidate (observed live: gpt-4o-mini
 * marked banana bread "supersedes" of a volleyball record, reason and all) —
 * the echo makes that misalignment DETECTABLE, and the entry degrades to the
 * safe default instead of writing a phantom edge.
 */
export function parseReconcileJudgments(
  reply: string,
  count: number,
  candidates?: Array<{ title: string }>,
): ReconcileJudgment[] {
  const judgments: ReconcileJudgment[] = Array.from({ length: count }, () => ({ ...SAFE_DEFAULT }));
  const match = /\{[\s\S]*\}/.exec(reply);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { verdicts?: unknown };
      if (Array.isArray(parsed.verdicts)) {
        for (const entry of parsed.verdicts) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const index = Number(record.index);
          if (!Number.isInteger(index) || index < 1 || index > count) continue;
          const expectedTitle = candidates?.[index - 1]?.title;
          if (expectedTitle !== undefined) {
            const echoed = typeof record.title === "string" ? record.title.trim().toLowerCase() : null;
            if (echoed !== expectedTitle.trim().toLowerCase()) {
              judgments[index - 1] = {
                verdict: "related",
                confidence: 0,
                reason: `judge reply unverifiable (echoed title ${echoed === null ? "missing" : `"${String(record.title).slice(0, 120)}"`})`,
              };
              continue;
            }
          }
          judgments[index - 1] = toJudgment(record);
        }
      }
    } catch {
      // safe defaults already in place
    }
  }
  return judgments;
}

function nodeText(node: GraphNode): string {
  // The Title label matters: the judge is asked to echo each candidate's title
  // verbatim as a grounding check — without the label it echoes the first
  // content line instead, and the check rejects everything (observed live).
  return [`Title: ${node.title}`, node.summary ?? "", (node.content ?? "").slice(0, 2000)].filter(Boolean).join("\n");
}

function judgePrompt(newNode: GraphNode, candidates: GraphNode[]): string {
  return [
    "You reconcile memory atoms in a personal knowledge graph. Given a NEW atom and several EXISTING atoms, classify EACH relationship.",
    "",
    '- "supersedes": both state the same fact about the same subject, and the NEW atom carries the newer value (an update or correction). Example: "team retro is on Mondays" vs "team retro moved to Fridays".',
    '- "duplicate": the same fact restated with no newer information.',
    '- "contradicts": they cannot both be true and neither is clearly newer.',
    '- "related": same subject or topic, different facts.',
    '- "distinct": unrelated.',
    "",
    "You see all candidates at once: when several look like versions of the same fact, mark only the one the NEW atom most directly updates as \"supersedes\".",
    "",
    "Classify each EXISTING atom INDEPENDENTLY, against the NEW atom alone. Most candidates are \"related\" or \"distinct\" — an unrelated candidate is never \"supersedes\", no matter how confident another entry is. Each reason must describe the relationship with THAT candidate specifically; never carry a verdict or reason across entries.",
    "",
    'Reply with JSON only: {"verdicts":[{"index":1,"title":"<the Title line of that EXISTING atom, verbatim>","verdict":"...","confidence":0..1,"reason":"..."}, ...]} — one entry per EXISTING atom, 1-based, and copy that atom\'s Title line exactly so each entry is grounded in the candidate it describes. Use "supersedes" only when the SAME attribute of the SAME subject changed; prefer "related" when unsure.',
    "",
    `NEW (${newNode.updatedAt}):\n${nodeText(newNode)}`,
    "",
    ...candidates.map((candidate, i) => `EXISTING [${i + 1}] (${candidate.updatedAt}):\n${nodeText(candidate)}`),
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
 * write volume and with no ceiling. The cost is now bounded by construction
 * (see the module doc): a distance gate excuses far candidates, survivors are
 * judged in ONE batched call, and a per-owner hourly budget is the backstop.
 * The flag stays opt-in until that bound has production mileage on it.
 */
export function createReconcileJudgeFromEnv(): ReconcileJudge | null {
  if (!isEnabled(process.env.TROVE_RECONCILE_JUDGE)) return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.TROVE_RECONCILE_JUDGE_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  return async ({ newNode, candidates }) => {
    if (candidates.length === 0) return [];
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: judgePrompt(newNode, candidates) }],
      }),
    });
    if (!response.ok) throw new Error(`reconcile judge: OpenAI ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseReconcileJudgments(body.choices?.[0]?.message?.content ?? "", candidates.length, candidates);
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
 * Candidate-match, gate, judge (batched), and act for one written node.
 * Shared by both drivers: the judge is injectable so tests never touch the
 * network, and `null` selects the heuristic.
 */
export async function performReconcileNode(
  store: GraphStore,
  input: { nodeId: string; ownerId?: string | null },
  judge: ReconcileJudge | null,
): Promise<ReconcileResult> {
  const context: GraphOperationContext | undefined = input.ownerId ? { ownerId: input.ownerId } : undefined;
  const node = await store.read({ nodeId: input.nodeId }, context, { trackAccess: false });
  if (!node) {
    return { nodeId: input.nodeId, status: "skipped_node_missing", judge: judge ? "llm" : "heuristic", candidates: [], supersedesEdgesCreated: [], flags: [], judgeCalls: 0 };
  }

  // Candidate-match per the design doc — lexical on the title, semantic on
  // title+summary. The semantic arm silently contributes nothing when no
  // embedding provider is configured; the lexical arm always works. Semantic
  // hits carry the cosine distance the gate below consumes; a hit found by
  // both arms keeps its distance.
  const [lexical, semantic] = await Promise.all([
    store.search({ query: node.title, mode: "lexical", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
    store.search({ query: `${node.title}\n${node.summary ?? ""}`, mode: "semantic", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
  ]);
  const candidates = new Map<string, { node: SearchResultNode; distance: number | undefined }>();
  for (const hit of [...lexical.nodes, ...semantic.nodes]) {
    if (hit.id === node.id) continue;
    const existing = candidates.get(hit.id);
    candidates.set(hit.id, { node: hit, distance: existing?.distance ?? hit.distance });
  }
  const finalists = [...candidates.values()].slice(0, MAX_CANDIDATES);

  const result: ReconcileResult = {
    nodeId: node.id,
    status: "reconciled",
    judge: judge ? "llm" : "heuristic",
    candidates: [],
    supersedesEdgesCreated: [],
    flags: [],
    judgeCalls: 0,
  };

  const threshold = reconcileSkipDistance();
  const { toJudge, skipped } = partitionReconcileCandidates(finalists, threshold);

  // The gate's skips are recorded, not dropped silently: the job result is the
  // audit trail for why a candidate was never judged.
  for (const entry of skipped) {
    result.candidates.push({
      nodeId: entry.node.id,
      title: entry.node.title,
      verdict: "distinct",
      confidence: 1,
      reason: `distance gate: cosine ${entry.distance?.toFixed(3)} > ${threshold}`,
      distance: entry.distance ?? null,
      via: "distance_gate",
    });
  }

  const record = (entry: { node: SearchResultNode; distance: number | undefined }, judgment: ReconcileJudgment, via: ReconcileCandidateResult["via"]): void => {
    result.candidates.push({ nodeId: entry.node.id, title: entry.node.title, ...judgment, distance: entry.distance ?? null, via });
  };

  const applyActions = async (entry: { node: SearchResultNode }, judgment: ReconcileJudgment): Promise<void> => {
    if (judgment.verdict === "supersedes" && judgment.confidence >= SUPERSEDE_MIN_CONFIDENCE) {
      // The non-destructive resolution: an edge recording that this newer node
      // supersedes the older one. link() dedupes on (from, to, predicate), so
      // re-running the job cannot stack duplicates.
      const edge = await store.link({ fromNodeId: node.id, toSlug: entry.node.slug, predicate: "supersedes", weight: 1 }, context);
      if (edge) result.supersedesEdgesCreated.push({ fromNodeId: node.id, toNodeId: entry.node.id });
    } else if (judgment.verdict === "contradicts" && judgment.confidence >= CONTRADICT_MIN_CONFIDENCE) {
      result.flags.push({ code: "contradiction_candidate", nodeId: node.id, otherNodeId: entry.node.id, detail: judgment.reason });
    } else if (judgment.verdict === "duplicate" && judgment.confidence >= DUPLICATE_MIN_CONFIDENCE) {
      result.flags.push({ code: "possible_duplicate", nodeId: node.id, otherNodeId: entry.node.id, detail: judgment.reason });
    }
  };

  if (toJudge.length > 0) {
    if (judge) {
      const ownerKey = input.ownerId ?? "global";
      if (consumeJudgeBudget(ownerKey)) {
        const judgments = await judge({ newNode: node, candidates: toJudge.map((entry) => entry.node) });
        result.judgeCalls = 1;
        for (const [i, entry] of toJudge.entries()) {
          const judgment = judgments[i] ?? { ...SAFE_DEFAULT };
          record(entry, judgment, "judge");
          await applyActions(entry, judgment);
        }
      } else {
        // Budget spent: nothing is judged, and the result says so plainly.
        // Retrying immediately would re-hit the same window, so the job
        // succeeds rather than staying pending; the flag is the signal.
        for (const entry of toJudge) {
          record(entry, { verdict: "related", confidence: 0, reason: "judge budget exhausted for this owner this hour" }, "budget");
        }
        result.flags.push({
          code: "judge_budget_exceeded",
          nodeId: node.id,
          otherNodeId: node.id,
          detail: `${toJudge.length} candidate(s) left unjudged; TROVE_RECONCILE_JUDGE_BUDGET=${judgeBudgetLimit()}/h`,
        });
      }
    } else {
      for (const entry of toJudge) {
        const judgment = heuristicJudgment(node, entry.node);
        record(entry, judgment, "heuristic");
        await applyActions(entry, judgment);
      }
    }
  }

  return result;
}
