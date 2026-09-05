/**
 * Read-time reranking — the candidate generator is not the ranker.
 *
 * `performRecall` fuses a lexical and a semantic arm with RRF, expands from the
 * top seeds, and then orders everything with a linear blend of seven hand-set
 * constants (match rank, alignment, activation, degree, hop, giant penalty).
 * Those constants were never measured. The benchmark says exactly what that
 * costs: `bench/FINDINGS.md` records **Hit@K 100% with precision 23.3%** — the
 * answering evidence is retrieved every single time and the ranking fails to
 * put it near the top. Ranking, not retrieval, is the bottleneck, and a wider
 * seed pool (50 hits, not 10) only makes the ordering matter more.
 *
 * The standard answer is a second, more expensive pass over the small candidate
 * set the cheap pass produced: Zep, Hindsight and Anthropic all rerank. The
 * honest caveat, and the reason this is opt-in rather than assumed: the
 * published gains are plain cross-encoder distillation, not anything clever
 * about time or graphs. This module buys the ordinary version of that win and
 * nothing more.
 *
 * Shape, deliberately the same as the reconcile judge (`src/reconcile.ts`):
 *
 * - PROVIDER INTERFACE. `Reranker` is a function type, injected at the call
 *   site, so tests reorder a known candidate set with zero network.
 * - OPT-IN. `TROVE_RECALL_RERANK=1` plus a key — `TROVE_RERANK_API_KEY` if
 *   reranking should ride a provider of its own, else `OPENAI_API_KEY`. Off
 *   by default,
 *   because switching it on adds an LLM call to the latency of every recall —
 *   the interactive path, not a background job. With the flag unset recall is
 *   byte-identical to what it was before this module existed.
 * - ONE CALL, BATCHED. Every candidate is scored in a single request, and the
 *   text each contributes is capped (RERANK_CANDIDATE_CHARS) so the prompt is
 *   bounded by construction rather than by whatever happens to be in the graph.
 * - FAIL OPEN. `rerankCandidates` never throws and never rejects: an error, a
 *   timeout, a missing key, a malformed or partial reply all return `null`,
 *   which the caller reads as "rank the way you did yesterday". A reranker
 *   failure must never turn a working recall into a failed one.
 */

import type { GraphNode } from "./contracts.js";
import { contentTerms } from "./queryNormalize.js";

/** What the reranker is shown about one candidate. Bounded by construction. */
export type RerankCandidate = {
  id: string;
  title: string;
  summary: string | null;
  content: string | null;
};

/**
 * Score every candidate against the query in ONE call. The returned array is
 * index-aligned with `candidates` and each entry is a relevance score in [0,1]
 * (higher = more relevant). Same batching argument as the reconcile judge: the
 * model grades a candidate far better when it can see what it is competing
 * against.
 */
export type Reranker = (batch: {
  query: string;
  candidates: RerankCandidate[];
}) => Promise<number[]>;

/**
 * Per-candidate body slice sent to the reranker. A cross-encoder decides
 * relevance from the opening of a note; the rest is budget spent to reach the
 * same verdict. 400 chars over 30 candidates keeps the prompt around 4k tokens
 * whatever the graph contains.
 */
export const RERANK_CANDIDATE_CHARS = 400;
/** Per-candidate summary slice — a distilled sentence or two, never a body. */
const RERANK_SUMMARY_CHARS = 240;
/**
 * Candidates sent in one batch. The seed pool is 50 search hits plus graph
 * expansion; scoring all of it would grow the prompt with the graph. The tail
 * of the fused order is where the reranker has least to add anyway — it is
 * ranking's job to promote from the top of the pool, not to rescue its floor.
 */
export const RERANK_MAX_CANDIDATES = 30;

/** Hard ceiling for the rerank call. Recall is interactive; see the module doc. */
const RERANK_TIMEOUT_MS_DEFAULT = 2_000;

export function rerankTimeoutMs(): number {
  const parsed = Number(process.env.TROVE_RECALL_RERANK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : RERANK_TIMEOUT_MS_DEFAULT;
}

/**
 * Opt-in flags accept the forms an operator actually types — same reasoning as
 * `src/reconcile.ts`: a strict `=== "1"` turns `TROVE_RECALL_RERANK=true` into
 * config that reads as enabled and is not.
 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** The bounded view of a node the reranker is allowed to see. */
export function toRerankCandidate(node: GraphNode): RerankCandidate {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary ? node.summary.slice(0, RERANK_SUMMARY_CHARS) : null,
    content: node.content ? node.content.slice(0, RERANK_CANDIDATE_CHARS) : null,
  };
}

function candidateText(candidate: RerankCandidate): string {
  return [candidate.title, candidate.summary ?? "", candidate.content ?? ""]
    .filter(Boolean)
    .join("\n");
}

export function rerankPrompt(query: string, candidates: RerankCandidate[]): string {
  return [
    "You rank memory atoms from a personal knowledge graph by how directly each one helps ANSWER the QUERY.",
    "",
    "Score each candidate independently in [0,1]:",
    "- 1.0 — contains the answer, or the specific fact the query asks for.",
    "- 0.5 — same subject, useful background, does not answer it.",
    "- 0.0 — unrelated, or merely shares vocabulary with the query.",
    "",
    "Topical overlap is not relevance: a catalog page that mentions the subject scores below a note that states the fact.",
    "",
    `Reply with JSON only: {"scores":[{"index":1,"score":0.0},...]} — exactly one entry per candidate, 1-based, in any order, no other keys.`,
    "",
    `QUERY: ${query}`,
    "",
    ...candidates.map((candidate, index) => `[${index + 1}]\n${candidateText(candidate)}`),
  ].join("\n");
}

/**
 * Parse a reranker reply into `count` scores, or `null` when the reply cannot
 * be trusted.
 *
 * A PARTIAL reply is rejected outright rather than patched with a neutral fill.
 * Half a ranking is not a ranking: whatever value the fill takes, unscored
 * candidates either float above scored ones or sink below them, and the caller
 * cannot tell that ordering apart from a real judgement. Today's blend is a
 * known quantity; a half-parsed one is not.
 */
export function parseRerankScores(reply: string, count: number): number[] | null {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return null;
  let parsed: { scores?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { scores?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.scores)) return null;

  const scores: Array<number | undefined> = Array.from({ length: count });
  for (const entry of parsed.scores) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const index = Number(record.index);
    if (!Number.isInteger(index) || index < 1 || index > count) continue;
    const score = Number(record.score);
    if (!Number.isFinite(score)) continue;
    scores[index - 1] = Math.max(0, Math.min(1, score));
  }

  const complete: number[] = [];
  for (const score of scores) {
    if (score === undefined) return null;
    complete.push(score);
  }
  return complete;
}

/**
 * Build the LLM reranker from the environment, or return null when it is not
 * configured. The model defaults to gpt-4o-mini and is overridable via
 * TROVE_RECALL_RERANK_MODEL.
 *
 * OPT-IN — `TROVE_RECALL_RERANK=1` is required. Unlike reconcile, which pays
 * its LLM call in a background job, this one sits inside an interactive read.
 * It stays off until the latency has production mileage on it.
 *
 * CREDENTIALS OF ITS OWN, and this is the point of TROVE_RERANK_API_KEY.
 * `OPENAI_API_KEY` is doing two unrelated jobs in this codebase: it is the
 * embeddings key, where it must be OpenAI proper because that is who serves the
 * embedding model, and it is the fallback LLM key. Chat already escaped that by
 * preferring OPENROUTER_API_KEY (src/chatModel.ts), for cost. Reranking runs on
 * EVERY recall, so it is the most price-sensitive LLM call in the product and
 * the one that most wants the cheap provider — but it could not have it, because
 * the only lever was OPENAI_BASE_URL, which is shared with embeddings and would
 * point them somewhere that does not serve them.
 *
 * So: an optional key and base URL that belong to reranking alone. Set neither
 * and behaviour is exactly what it was — OPENAI_API_KEY at OPENAI_BASE_URL.
 * Set both to an OpenAI-compatible provider (OpenRouter, or anything else) and
 * only the reranker moves; embeddings, the reconcile judge and chat are
 * untouched. Name the model explicitly when you do: the gpt-4o-mini default is
 * an OpenAI id, and a provider that does not serve it will 404 rather than
 * quietly picking something else.
 */
export function createRecallRerankerFromEnv(): Reranker | null {
  if (!isEnabled(process.env.TROVE_RECALL_RERANK)) return null;
  const apiKey = process.env.TROVE_RERANK_API_KEY?.trim() || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.TROVE_RECALL_RERANK_MODEL ?? "gpt-4o-mini";
  const baseUrl = (
    process.env.TROVE_RERANK_BASE_URL?.trim()
    || process.env.OPENAI_BASE_URL
    || "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  return async ({ query, candidates }) => {
    if (candidates.length === 0) return [];
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      // The fetch carries its own deadline so the socket is actually released;
      // rerankCandidates races the same budget so a provider that ignores the
      // signal still cannot hold up a recall.
      signal: AbortSignal.timeout(rerankTimeoutMs()),
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: rerankPrompt(query, candidates) }],
      }),
    });
    if (!response.ok) throw new Error(`recall reranker: OpenAI ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const scores = parseRerankScores(body.choices?.[0]?.message?.content ?? "", candidates.length);
    if (!scores) throw new Error("recall reranker: unusable reply");
    return scores;
  };
}

/**
 * Run the reranker over the candidates and return `id -> score`, or `null` when
 * it did not produce a usable ranking.
 *
 * This function is the whole fail-open contract, and it is the only thing
 * `performRecall` calls: it never throws, never rejects, and never resolves
 * later than the timeout. `null` means "rank the way you did yesterday" — no
 * reranker configured, no candidates, an exception, a timeout, or a reply whose
 * shape does not line up with the candidates that were sent.
 */
export async function rerankCandidates(
  reranker: Reranker | null,
  batch: { query: string; candidates: RerankCandidate[] },
  opts: { timeoutMs?: number } = {},
): Promise<Map<string, number> | null> {
  if (!reranker || batch.candidates.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? rerankTimeoutMs();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    // Deliberately NOT unref'd. The timer is the only thing holding the event
    // loop open while a provider hangs, and an unref'd one let the loop drain
    // out from under the race: CI failed the whole reranker and MMR suites with
    // "Promise resolution is still pending but the event loop has already
    // resolved", cancelling every sibling test. It cannot leak — the finally
    // below clears it on every path, and it lives at most timeoutMs anyway.
  });

  let scores: number[] | null;
  try {
    scores = await Promise.race([reranker(batch), deadline]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!Array.isArray(scores) || scores.length !== batch.candidates.length) return null;

  const byId = new Map<string, number>();
  for (const [index, candidate] of batch.candidates.entries()) {
    const score = scores[index];
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    byId.set(candidate.id, Math.max(0, Math.min(1, score)));
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Diversity: maximal marginal relevance over the reranked list.
// ---------------------------------------------------------------------------

/**
 * MMR's relevance/novelty trade-off (Carbonell & Goldstein 1998):
 *
 *   mmr(i) = λ · relevance(i) − (1 − λ) · max similarity(i, already selected)
 *
 * 0.7 leans on relevance. A reranker's top answer must stay the top answer —
 * this pass exists to stop the SECOND, THIRD and FOURTH slots going to
 * restatements of it, not to trade the best atom for a more interesting one.
 * Recall's budget is the reason it matters at all: near-identical atoms cost
 * full price each and buy the reader nothing, and a pack that spends 8k tokens
 * saying one thing four ways is worse than one that says four things.
 *
 * Turned down toward 0 this becomes a novelty sort and the pack stops answering
 * the question; turned up to 1 it is a no-op and the ordering is exactly the
 * reranker's. Anything outside roughly 0.5–0.9 wants a measurement first.
 */
export const MMR_LAMBDA = 0.7;

/**
 * Redundancy between two atoms, as cosine over their content-term bags.
 *
 * Deliberately NOT the atoms' stored embeddings: those live in the `embedding`
 * table (or the memory driver's private cache) and nothing on the GraphStore
 * surface hands them to a caller, so using them here means a new store method
 * and a new query on the recall path — a bigger change than the diversity pass
 * is worth, and one that would fetch vectors recall does not otherwise need.
 * Term overlap is a blunter instrument, but near-duplicate atoms are the case
 * it is best at: two restatements of the same fact share their vocabulary
 * almost exactly. Swap in a vector similarity through `similarity` the day the
 * vectors are on hand.
 */
export function termOverlapSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / Math.sqrt(left.size * right.size);
}

/**
 * Reorder (never drop) `items` by maximal marginal relevance. Dropping is the
 * budgeter's job: everything still comes back, and a demoted near-duplicate
 * simply falls to where the token budget is likely to cut it.
 *
 * Relevance is the caller's score CLAMPED to [0,1], never min-max normalized
 * across the batch. The reranked score is already an absolute relevance on
 * that scale, which is what MMR assumes; rescaling it would stretch the 0.05
 * that separates a good answer from its own restatement into the full range
 * and put the diversity term permanently out of reach.
 *
 * Items are expected in descending score order (the caller has already sorted
 * them), which is why two or fewer are returned untouched: the greedy pass
 * cannot reorder a list whose second element is the only remaining choice.
 */
export function mmrOrder<T>(
  items: T[],
  accessors: { score: (item: T) => number; text: (item: T) => string },
  opts: { lambda?: number; similarity?: (left: Set<string>, right: Set<string>) => number } = {},
): T[] {
  if (items.length <= 2) return [...items];
  const lambda = opts.lambda ?? MMR_LAMBDA;
  const similarity = opts.similarity ?? termOverlapSimilarity;

  const terms = items.map((item) => new Set(contentTerms(accessors.text(item))));
  const relevance = items.map((item) => Math.max(0, Math.min(1, accessors.score(item))));

  const selected: number[] = [];
  const remaining = new Set(items.map((_, index) => index));
  const maxSimilarity = items.map(() => 0);

  while (remaining.size > 0) {
    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const index of remaining) {
      const value = lambda * (relevance[index] ?? 0) - (1 - lambda) * (maxSimilarity[index] ?? 0);
      // Strictly greater keeps the pass stable: a tie leaves the earlier
      // (higher-ranked) candidate in front, so MMR never reshuffles a list it
      // has nothing to say about.
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    }
    if (best < 0) break;
    remaining.delete(best);
    selected.push(best);
    const chosenTerms = terms[best];
    if (chosenTerms) {
      for (const index of remaining) {
        const other = terms[index];
        if (!other) continue;
        maxSimilarity[index] = Math.max(maxSimilarity[index] ?? 0, similarity(chosenTerms, other));
      }
    }
  }

  return selected.map((index) => items[index] as T);
}
