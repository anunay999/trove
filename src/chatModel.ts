/**
 * The answering model for graph chat — the small, cheap half of the feature.
 *
 * Graph chat exists to SHOW retrieval: a question dims the graph and the nodes
 * light up in the order recall actually touches them. The model that turns the
 * resulting pack into a sentence is the least interesting part of that, and it
 * is deliberately built to be the most disposable:
 *
 * - PROVIDER INTERFACE. `GraphChatModel` is a tiny object with a name and a
 *   token stream, injected at the call site, so tests answer questions with
 *   zero network (tests/graph-chat.test.ts).
 * - OPT-IN. `TROVE_GRAPH_CHAT=1` plus an `OPENAI_API_KEY`. Off by default: no
 *   deployment starts spending on an LLM because someone opened the graph.
 * - FAIL VISIBLE, NOT FAIL OPEN. Unlike the reranker, a missing model here is
 *   not something to paper over — the endpoint still runs the real recall,
 *   still streams the whole traversal, and still returns the pack, and says in
 *   so many words that no model is configured. The graph demonstration works
 *   without a model; only the prose is missing.
 * - CHEAP BY INTENT. Set `OPENROUTER_API_KEY` alone and that is the whole
 *   configuration: one key for many cheap models, the same chat-completions
 *   shape, and the base URL and model both default to OpenRouter's. Any other
 *   OpenAI-compatible endpoint works the same way — point `OPENAI_BASE_URL` at
 *   the provider and name the model in `TROVE_CHAT_MODEL` (see .env.example).
 *   Without OpenRouter the default is `gpt-4o-mini` in the classic body shape:
 *   cheap, resolves against the DEFAULT base URL, and the shape DeepSeek and
 *   GLM speak. A provider-specific default would 404 for anyone who set only
 *   `OPENAI_API_KEY`, and a reasoning-shaped default would 400 against the very
 *   providers this feature is aimed at.
 * - BOUNDED PROMPT. The model sees the recall pack and nothing else: no graph
 *   dump, no second retrieval, no chat history. The pack is already
 *   token-budgeted by `performRecall`, and CHAT_PACK_CHARS is a backstop for a
 *   caller that raised that budget.
 */

import type { RecallResult } from "./graphCore.js";

export type ChatMessage = { role: "system" | "user"; content: string };

/**
 * A streaming answerer. `name` is surfaced to the viewer so the page can say
 * which model spoke; `stream` yields answer text as it arrives and must stop
 * promptly when `signal` aborts.
 */
export type GraphChatModel = {
  readonly name: string;
  stream(input: { messages: ChatMessage[]; signal: AbortSignal }): AsyncIterable<string>;
};

/** Hard ceiling on the grounding text, whatever token budget recall was given. */
export const CHAT_PACK_CHARS = 24_000;
/** The answer is a paragraph or two over a small pack; nothing needs more. */
const CHAT_MAX_OUTPUT_TOKENS = 700;
/** Whole-answer deadline. Generous next to the reranker's 2s: this one streams. */
const CHAT_TIMEOUT_MS_DEFAULT = 45_000;

export function chatTimeoutMs(): number {
  const parsed = Number(process.env.TROVE_CHAT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : CHAT_TIMEOUT_MS_DEFAULT;
}

/** Same tolerant reading of opt-in flags as reconcile.ts and rerank.ts. */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Reasoning models and the older chat models disagree about the request body,
 * and the disagreement is a hard 400 rather than something to discover in
 * production: a reasoning model rejects `max_tokens` ("use
 * max_completion_tokens instead") and rejects `temperature` outright, while
 * DeepSeek, GLM and every other OpenAI-compatible endpoint built against the
 * older shape only understand `max_tokens`.
 *
 * So it is configuration, not detection — a model-name prefix test would be
 * wrong the first time a provider named something differently.
 * TROVE_CHAT_REASONING_EFFORT defaults to "none" — the classic
 * `max_tokens` + `temperature` body that DeepSeek, GLM and gpt-4o-mini all
 * accept. Set it to minimal|low|medium|high when pointing at a reasoning
 * model, which then gets `max_completion_tokens` + `reasoning_effort`.
 */
export function chatReasoningEffort(): "minimal" | "low" | "medium" | "high" | null {
  const raw = (process.env.TROVE_CHAT_REASONING_EFFORT ?? "none").trim().toLowerCase();
  if (raw === "none" || raw === "off" || raw === "") return null;
  return ["minimal", "low", "medium", "high"].includes(raw)
    ? (raw as "minimal" | "low" | "medium" | "high")
    : "low";
}

const SYSTEM_PROMPT = [
  "You answer questions from a personal memory graph.",
  "",
  "The CONTEXT below is everything you know. It was retrieved for this question and nothing else was.",
  "Rules:",
  "- Answer ONLY from the context. Never add facts from your own knowledge.",
  "- Cite every claim with the slug of the note it came from, written as [[slug]], inline.",
  "- If the context does not answer the question, say so plainly and name what it does cover.",
  "- Be brief: a short paragraph, or a few lines. No preamble, no restating the question.",
].join("\n");

/**
 * The citation index. The rendered pack heads each atom with its title and
 * slug, but a model told to "cite the notes you used" cites far more reliably
 * from an explicit list of the exact tokens it is allowed to write.
 */
export function citationIndex(recall: RecallResult): string {
  return recall.atoms.map((atom) => `[[${atom.node.slug}]] — ${atom.node.title}`).join("\n");
}

export function buildChatMessages(question: string, recall: RecallResult): ChatMessage[] {
  const pack = recall.context.length > CHAT_PACK_CHARS
    ? `${recall.context.slice(0, CHAT_PACK_CHARS)}\n…`
    : recall.context;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `QUESTION: ${question}`,
        "",
        "NOTES YOU MAY CITE:",
        citationIndex(recall) || "(none)",
        "",
        "CONTEXT:",
        pack,
      ].join("\n"),
    },
  ];
}

/**
 * Which slugs from the pack the answer actually cited.
 *
 * The graph lights a node as "cited" only when its slug appears in the answer
 * text, and only when that slug is in the pack — a model that invents
 * `[[some-note]]` lights nothing, and a slug the pack never carried can never
 * be matched. Highlighting is downstream of the model's own words, never of
 * "these are the atoms we sent it".
 */
export function citedSlugs(answer: string, packSlugs: Iterable<string>): Set<string> {
  const known = new Set(packSlugs);
  const cited = new Set<string>();
  for (const match of answer.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const slug = (match[1] ?? "").trim();
    if (known.has(slug)) cited.add(slug);
  }
  return cited;
}

/**
 * Pull `delta.content` out of one OpenAI-compatible SSE frame. Returns null for
 * `[DONE]`, keepalives, and anything without a text delta — providers differ in
 * what else they put on the wire (reasoning deltas, usage frames), and none of
 * it belongs in the answer.
 */
export function parseChatDelta(frame: string): string | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Build the answering model from the environment, or null when it is not
 * configured. Same key and base URL as embeddings, the reconcile judge and the
 * reranker; the opt-in flag is its own.
 */
export function createGraphChatModelFromEnv(): GraphChatModel | null {
  if (!isEnabled(process.env.TROVE_GRAPH_CHAT)) return null;
  // OpenRouter first when its key is present. It is one key for many cheap
  // models, it speaks the same chat-completions shape, and it is the reason
  // this endpoint exists at all: showing the graph off should not cost much.
  // OPENAI_API_KEY still wins if both are set and OPENAI_BASE_URL is explicit,
  // so a deployment already pointed somewhere does not get moved silently.
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const explicitBase = process.env.OPENAI_BASE_URL;
  const useOpenRouter = Boolean(openRouterKey) && (!process.env.OPENAI_API_KEY || !explicitBase);
  const apiKey = useOpenRouter ? openRouterKey : process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.TROVE_CHAT_MODEL
    ?? (useOpenRouter ? "meta/muse-spark-1.3-contributor" : "gpt-4o-mini");
  const baseUrl = (useOpenRouter ? explicitBase ?? "https://openrouter.ai/api/v1" : explicitBase ?? "https://api.openai.com/v1")
    .replace(/\/$/, "");
  const effort = chatReasoningEffort();

  return {
    name: model,
    async *stream({ messages, signal }) {
      // Two deadlines, one signal: the caller's (the browser hung up) and ours
      // (the provider went quiet). Either one releases the socket below.
      const deadline = AbortSignal.timeout(chatTimeoutMs());
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          // OpenRouter attributes requests to an app when these are present and
          // ignores them otherwise, so they cost nothing to send unconditionally.
          "http-referer": "https://mytrove.in",
          "x-title": "Trove",
        },
        signal: AbortSignal.any([signal, deadline]),
        body: JSON.stringify({
          model,
          stream: true,
          messages,
          // The reasoning budget is spent before the first visible token, so a
          // reasoning model needs headroom above the answer length or it
          // finishes on the cap having written nothing.
          ...(effort
            ? { max_completion_tokens: CHAT_MAX_OUTPUT_TOKENS * 4, reasoning_effort: effort }
            : { max_tokens: CHAT_MAX_OUTPUT_TOKENS, temperature: 0.2 }),
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`graph chat: model responded ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Frames are blank-line delimited; a partial tail stays in the buffer.
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const delta = parseChatDelta(frame);
            if (delta !== null) yield delta;
            split = buffer.indexOf("\n\n");
          }
        }
        const tail = parseChatDelta(buffer);
        if (tail !== null) yield tail;
      } finally {
        // Reached on a normal end AND on generator.return() — the consumer
        // going away must close the upstream connection, not orphan it.
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
