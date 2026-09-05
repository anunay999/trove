/**
 * Langfuse tracing, as one seam the rest of the codebase talks to.
 *
 * WHAT A TRACE IS HERE. One self-contained unit of work, per Langfuse's own
 * guidance: a chat turn, a recall, one background job. Not a process, not a
 * request batch, and emphatically not "everything that happened" in one span —
 * a flat trace tells you something was slow without telling you which step.
 *
 * The three units, and what hangs under each:
 *
 *   graph-chat            (span)       one panel question
 *     recall              (retriever)  the whole retrieval
 *       embed-query       (embedding)  the semantic arm's vector call
 *       search-lexical    (retriever)  the tsquery arm, raced against it
 *       expand            (span)       graph traversal from the fused seeds
 *       rerank            (generation) reorders the head, when configured
 *       pack              (span)       budgeting into the token budget
 *     answer              (generation) the model call that writes the prose
 *
 *   recall                (retriever)  the same subtree, rooted, when an agent
 *                                      calls recall over MCP rather than chat
 *
 *   job:<kind>            (span)       one background job
 *     reconcile-judge     (generation) or embed-batch (embedding), per kind
 *
 * Nesting is by OpenTelemetry context, not by threading objects through call
 * signatures: `observe` opens an ACTIVE observation, so anything traced deeper
 * in the call stack attaches itself without recall, search and rerank having to
 * know they are being watched. That is what keeps the store's signatures clean
 * and the trace tree honest — the shape of the tree is the shape of the calls.
 *
 * OFF IS THE DEFAULT AND COSTS NOTHING. With no LANGFUSE_* credentials, nothing
 * is imported, no exporter starts, no timer holds the process open, and every
 * helper here is a straight pass-through to the function it wraps. Tests run in
 * exactly that state, so tracing can never change what a test observes.
 *
 * NOTHING HERE MAY THROW. An observability layer that can fail a request is
 * worse than no observability layer. Every entry point swallows its own errors.
 */

import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";

/**
 * Observation types this codebase uses. Deliberately the specific ones rather
 * than a generic span everywhere: Langfuse's analytics and agent graph key off
 * the type, so a retrieval typed as a bare span stops being a retrieval in
 * every dashboard downstream.
 */
export type ObservationType = "span" | "generation" | "embedding" | "retriever" | "tool" | "agent";

/** What a call site can attach while its observation is open. */
export type Recorder = {
  update(fields: Record<string, unknown>): void;
};

const NOOP: Recorder = { update() {} };

let active = false;
let shutdown: (() => Promise<void>) | null = null;

/** Credentials decide. Public key alone is not enough to send anything. */
function configured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

export function tracingEnabled(): boolean {
  return active;
}

/**
 * Start the exporter, once, if credentials are present.
 *
 * Dynamically imported so a deployment without Langfuse never loads the
 * OpenTelemetry SDK at all — and so this module stays importable from anywhere
 * without dragging a tracer provider into a unit test.
 */
export async function startTracing(): Promise<void> {
  if (active || !configured()) return;
  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
    ]);
    const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
    shutdown = async () => { await sdk.shutdown(); };
    active = true;
  } catch {
    // A misconfigured exporter must not stop the server booting.
    active = false;
  }
}

/**
 * Drain the exporter. Traces are batched, so a process that exits without this
 * loses whatever is still buffered — which is most of a short job run.
 */
export async function flushTracing(): Promise<void> {
  if (!active || !shutdown) return;
  try {
    await shutdown();
  } catch {
    // Nothing useful to do while exiting.
  } finally {
    active = false;
    shutdown = null;
  }
}

export type TraceAttributes = {
  /** The owning account, so cost and quality can be read per user. */
  userId?: string | undefined;
  /** Which surface asked: `graph-chat`, `recall`, `job`. Drives dashboards. */
  tags?: string[];
  metadata?: Record<string, string | number | boolean | undefined>;
};

/**
 * Attach trace-level attributes to everything opened inside `run`.
 *
 * Applied at the root of each unit of work rather than per observation: they
 * are properties of the whole trace, and repeating them on children is how a
 * trace ends up with three different opinions about who the user was.
 */
export function withTraceAttributes<T>(attributes: TraceAttributes, run: () => T): T {
  if (!active) return run();
  // exactOptionalPropertyTypes: an absent attribute must be absent, not
  // present-and-undefined, or the SDK records the key with a null value.
  const params: { userId?: string; tags?: string[]; metadata?: Record<string, string> } = {};
  if (attributes.userId !== undefined) params.userId = attributes.userId;
  if (attributes.tags !== undefined) params.tags = attributes.tags;
  if (attributes.metadata !== undefined) {
    // Trace metadata is a flat string map upstream. Coerce here rather than at
    // every call site, and drop absent values instead of writing "undefined".
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes.metadata)) {
      if (value !== undefined && value !== null) flat[key] = String(value);
    }
    params.metadata = flat;
  }
  try {
    return propagateAttributes(params, run) as T;
  } catch {
    return run();
  }
}

type ActiveObservation = { update: (fields: Record<string, unknown>) => unknown };

/**
 * Run `work` inside an observation that ends when it does — including when it
 * throws, so a failed step is visible as a failed step rather than as a gap.
 *
 * `input` is set explicitly by every caller. Never "all the arguments": that is
 * how an API key or a whole graph snapshot ends up in a trace.
 */
export async function observe<T>(
  name: string,
  options: { asType?: ObservationType; input?: unknown; metadata?: Record<string, unknown> },
  work: (recorder: Recorder) => Promise<T>,
): Promise<T> {
  if (!active) return work(NOOP);
  const { asType = "span", ...opening } = options;
  const start = startActiveObservation as unknown as (
    observationName: string,
    fn: (observation: ActiveObservation) => Promise<T>,
    opts: { asType: ObservationType },
  ) => Promise<T>;
  try {
    return await start(name, async (observation) => {
      if (opening.input !== undefined || opening.metadata !== undefined) {
        safeUpdate(observation, opening);
      }
      const recorder: Recorder = { update: (fields) => safeUpdate(observation, fields) };
      try {
        return await work(recorder);
      } catch (cause) {
        safeUpdate(observation, {
          level: "ERROR",
          statusMessage: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    }, { asType });
  } catch (cause) {
    // Distinguish "the traced work threw" (rethrow — the caller owns it) from
    // "tracing itself threw" (swallow, and still do the work).
    if (cause instanceof TracingSetupError) return work(NOOP);
    throw cause;
  }
}

class TracingSetupError extends Error {}

function safeUpdate(observation: ActiveObservation, fields: Record<string, unknown>): void {
  try {
    observation.update(fields);
  } catch {
    // An unserialisable field is not worth failing a request over.
  }
}

/**
 * Token usage in the shape Langfuse costs from, or undefined when the provider
 * did not report any. Guessing usage would produce a confident wrong bill.
 */
export function usageFrom(body: unknown): { input: number; output: number } | undefined {
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })?.usage;
  const input = Number(usage?.prompt_tokens);
  const output = Number(usage?.completion_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { input, output };
}
