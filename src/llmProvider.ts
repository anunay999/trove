import { usageFrom } from "./tracing.js";
/**
 * One place that decides which LLM endpoint this deployment talks to.
 *
 * There are three LLM callers here — the chat answerer, the recall reranker and
 * the reconcile judge — and each had grown its own copy of the same question,
 * with three different answers. Chat preferred OpenRouter. Reranking and the
 * judge read OPENAI_API_KEY only, so on a deployment whose LLM key is an
 * OpenRouter one they were unconfigurable: enabling either meant either paying
 * OpenAI or inventing a per-caller key, which is how TROVE_RERANK_API_KEY and
 * TROVE_RERANK_BASE_URL briefly existed. Two variables to work around a
 * duplicated four-line resolver is the wrong trade; deleting the duplicate is
 * the right one, and it takes the variables with it.
 *
 * WHY EMBEDDINGS ARE NOT HERE. `OPENAI_API_KEY` is doing two unrelated jobs in
 * this codebase, and only one of them is "an LLM key". The other is the
 * embeddings key, where the provider is not a preference: the vectors already
 * in `embedding` were produced by a specific model at a specific width, and
 * pointing that at a different provider does not switch providers, it corrupts
 * a column. So embeddings keep reading OPENAI_API_KEY directly (src/embeddings.ts)
 * and nothing here should ever be wired into them.
 *
 * PRECEDENCE. OpenRouter wins when its key is present: one key, many cheap
 * models, same chat-completions shape. The exception is a deployment that has
 * named an endpoint on purpose — OPENAI_API_KEY *and* an explicit
 * OPENAI_BASE_URL — which is someone pointing at a specific gateway and must
 * not be silently moved.
 */

export type LlmProvider = {
  apiKey: string;
  /** No trailing slash, so callers can append `/chat/completions` safely. */
  baseUrl: string;
  /**
   * True when the endpoint is OpenRouter. Callers use it to pick a default
   * model id, because a bare "gpt-4o-mini" is an OpenAI id and OpenRouter
   * namespaces the same model as "openai/gpt-4o-mini".
   */
  openRouter: boolean;
};

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENAI_BASE = "https://api.openai.com/v1";

/**
 * The endpoint for LLM calls, or null when this deployment has no LLM key at
 * all. Every caller stays independently opt-in: having a provider is not the
 * same as wanting chat, reranking or the judge, and each keeps its own flag.
 */
export function resolveLlmProvider(): LlmProvider | null {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const explicitBase = process.env.OPENAI_BASE_URL?.trim();

  const useOpenRouter = Boolean(openRouterKey) && (!openAiKey || !explicitBase);
  const apiKey = useOpenRouter ? openRouterKey : openAiKey;
  if (!apiKey) return null;

  const baseUrl = useOpenRouter
    ? explicitBase || OPENROUTER_BASE
    : explicitBase || OPENAI_BASE;
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), openRouter: useOpenRouter };
}

/**
 * The same small utility model, named the way the resolved provider names it.
 *
 * Used as the default for the two JSON-shaped calls — reranking and the judge —
 * which want a cheap, fast, non-reasoning model and are both fail-open, so a
 * provider that does not serve this id degrades to "no reranking" or "heuristic
 * judging" rather than to an error. Override per caller when you want something
 * else.
 */
export function defaultUtilityModel(provider: LlmProvider): string {
  return provider.openRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini";
}

/**
 * POST one chat-completions request and return the response, or throw an error
 * carrying the provider's own words. Every LLM caller goes through here, so a
 * call never leaves without a deadline (a hung provider used to hold a reconcile
 * job, and its lease heartbeat, forever).
 */
export async function llmFetch(
  provider: LlmProvider,
  request: { label: string; model: string; body: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const deadline = AbortSignal.timeout(request.timeoutMs);
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
      // OpenRouter attributes requests to an app when these are present and
      // ignores them otherwise, so they cost nothing to send unconditionally.
      "http-referer": "https://mytrove.in",
      "x-title": "Trove",
    },
    signal: request.signal ? AbortSignal.any([request.signal, deadline]) : deadline,
    body: JSON.stringify({ model: request.model, ...request.body }),
  });
  if (!response.ok) {
    // A bare status is undiagnosable: an OpenRouter 403 is usually a data
    // policy that leaves no endpoint for the chosen model, which reads exactly
    // like a revoked key until you can see the body.
    const detail = providerErrorMessage(await response.text().catch(() => ""));
    throw new Error(`${request.label}: ${request.model} responded ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  return response;
}

/** One non-streaming, JSON-object reply: the shape the reranker and the judge both ask for. */
export async function completeJson(
  provider: LlmProvider,
  request: { label: string; model: string; prompt: string; timeoutMs: number },
): Promise<{ reply: string; usage: { input: number; output: number } | undefined }> {
  const response = await llmFetch(provider, {
    label: request.label,
    model: request.model,
    timeoutMs: request.timeoutMs,
    body: { temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: request.prompt }] },
  });
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { reply: body.choices?.[0]?.message?.content ?? "", usage: usageFrom(body) };
}

/**
 * The human-readable half of a provider's error body, bounded.
 *
 * OpenAI-compatible providers answer failures with `{"error":{"message":...}}`,
 * OpenRouter sometimes nests a second one under `error.metadata.raw`, and a
 * gateway in front of either may return plain text or HTML. Take the most
 * specific string available and cap it: this ends up in a notice a reader sees.
 */
export function providerErrorMessage(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; metadata?: { raw?: unknown } };
      message?: unknown;
    };
    const raw = parsed.error?.metadata?.raw;
    const candidate = [parsed.error?.message, raw, parsed.message]
      .find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof candidate === "string") return truncate(candidate.trim());
  } catch {
    // Not JSON: a gateway's text or HTML. Fall through to the raw body.
  }
  return truncate(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}
