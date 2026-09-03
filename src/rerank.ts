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
 * - OPT-IN. `TROVE_RECALL_RERANK=1` plus an `OPENAI_API_KEY`. Off by default,
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
 * configured. Uses the OpenAI chat API directly, the same key and base URL as
 * embeddings and the reconcile judge; the model defaults to gpt-4o-mini and is
 * overridable via TROVE_RECALL_RERANK_MODEL.
 *
 * OPT-IN — `TROVE_RECALL_RERANK=1` is required. Unlike reconcile, which pays
 * its LLM call in a background job, this one sits inside an interactive read.
 * It stays off until the latency has production mileage on it.
 */
export function createRecallRerankerFromEnv(): Reranker | null {
  if (!isEnabled(process.env.TROVE_RECALL_RERANK)) return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.TROVE_RECALL_RERANK_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

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
    // A pending timer must not hold the process open — a recall that already
    // answered should not keep a server (or a test run) alive.
    timer.unref?.();
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
