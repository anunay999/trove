/**
 * Graph chat — a recall you can watch.
 *
 * Ask the graph a question and this streams the retrieval as it happens: each
 * search arm's hits as that arm settles, each node the expansion reaches with
 * its hop distance, the candidate order ranking produced, the atoms that
 * survived into the token-budgeted pack, then the answer, token by token, then
 * the citations. The dashboard dims the whole graph on submit and lights those
 * nodes as the events arrive, so a viewer sees the crawl instead of a spinner.
 *
 * THE ONE RULE: every highlight is a thing retrieval really did.
 *
 * There is no scripted walk here and no replay with artificial delays. The
 * events come from `performRecall`'s own trace hook (`RecallTrace` in
 * graphCore.ts), emitted from the lines that do the work, carrying the rows
 * those lines produced. If recall touches four nodes, four nodes light up; if
 * the semantic arm returns nothing, nothing lights up for it. A prettier
 * animation than the truth would make the whole feature a lie, since the point
 * of it is to show that the retrieval is real.
 *
 * Consequences worth knowing:
 *
 * - The arms are `lexical` and `semantic`, because recall's seed pool is the
 *   RRF fusion of exactly those two. There is no grep arm to report; the wire
 *   type has room for one (`SearchArm`) for the day recall grows it.
 * - "Cited" is decided by the model's own words: a node lights as cited when
 *   the answer writes its `[[slug]]`, never merely because it was sent.
 * - Without a model the endpoint still runs the real recall, still streams the
 *   whole traversal, and returns the pack with `finish: "no_model"`. The graph
 *   demonstration is the part that does not need an LLM.
 *
 * Transport is Server-Sent Events: one `data:` frame per event, JSON, with the
 * discriminant inside it. Every event carries `elapsedMs` since the request
 * started, so the client can show the real cadence rather than inventing one.
 */

import { graphChatInputSchema, type GraphChatInput, type GraphNode } from "./contracts.js";
import {
  performRecall,
  type GraphOperationContext,
  type GraphStore,
  type RecallCitation,
  type SearchArm,
} from "./graphCore.js";
import {
  buildChatMessages,
  citedSlugs,
  createGraphChatModelFromEnv,
  type GraphChatModel,
} from "./chatModel.js";

/** The minimum a client needs to find a node in the rendered graph. */
export type ChatNodeRef = {
  id: string;
  slug: string;
  title: string;
  type: GraphNode["type"];
};

export type ChatPackAtom = ChatNodeRef & {
  hops: number;
  score: number;
  tokens: number;
  provenance: "citation" | "agent_inference";
  summary: string | null;
};

/** Why the stream ended. Always present on the terminal `done` event. */
export type GraphChatFinish = "ok" | "no_model" | "no_results" | "error";

export type GraphChatEvent =
  | { type: "start"; query: string; elapsedMs: number }
  /** One retrieval arm settled, with the hits it returned, in its own order. */
  | { type: "seeds"; arm: SearchArm; nodes: ChatNodeRef[]; elapsedMs: number }
  /** The fused seed pool the rest of recall works from (RRF over the arms). */
  | { type: "fused"; nodes: ChatNodeRef[]; elapsedMs: number }
  /** One seed's neighborhood walk, and the candidates it ADDED, with hops. */
  | { type: "expand"; seedNodeId: string; nodes: Array<ChatNodeRef & { hops: number }>; elapsedMs: number }
  /** The candidate order after reranking/diversity/temporal reweight. */
  | { type: "rank"; reranked: boolean; total: number; nodes: Array<{ id: string; score: number }>; elapsedMs: number }
  /** What the token budget actually bought. These are the answer's evidence. */
  | {
    type: "pack";
    atoms: ChatPackAtom[];
    tokenBudget: number;
    spentTokens: number;
    truncated: boolean;
    elapsedMs: number;
  }
  /** Generation begins. `model` is null when none is configured. */
  | { type: "answer_start"; model: string | null; elapsedMs: number }
  | { type: "token"; text: string; elapsedMs: number }
  /** A truthful aside: no model, no results. Never an error. */
  | { type: "notice"; code: "model_not_configured" | "no_results"; message: string; elapsedMs: number }
  | { type: "error"; code: "recall_failed" | "model_failed"; message: string; elapsedMs: number }
  | {
    type: "done";
    finish: GraphChatFinish;
    /** Recall's own provenance: which text unit of which source backs which node. */
    citations: RecallCitation[];
    /** Nodes whose slug the ANSWER cited. Empty without a model. */
    citedNodeIds: string[];
    answer: string;
    elapsedMs: number;
  };

/**
 * An event before the emitter stamps it. Distributive on purpose: a bare
 * `Omit<GraphChatEvent, …>` collapses the union into its common keys and every
 * variant's own fields become "unknown property".
 */
type Unstamped<T> = T extends unknown ? Omit<T, "elapsedMs"> : never;

/** Ranked candidates put on the wire. The tail is scored but never packed. */
const RANK_WIRE_LIMIT = 50;

function nodeRef(node: GraphNode): ChatNodeRef {
  return { id: node.id, slug: node.slug, title: node.title, type: node.type };
}

/**
 * A one-writer/one-reader channel: `performRecall` pushes trace events from a
 * synchronous callback deep inside itself, and the generator below yields them
 * as they land. Nothing is buffered on purpose and nothing is dropped — the
 * buffer only ever holds what the reader has not collected yet.
 */
function createEventChannel<T>() {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(item: T): void {
      if (closed) return;
      buffer.push(item);
      const notify = wake;
      wake = null;
      notify?.();
    },
    close(): void {
      closed = true;
      const notify = wake;
      wake = null;
      notify?.();
    },
    async *drain(): AsyncGenerator<T> {
      while (true) {
        while (buffer.length > 0) yield buffer.shift() as T;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * Run one graph-chat turn, yielding events as the work happens.
 *
 * `options.model` defaults to whatever the environment configures; pass an
 * explicit model to inject a fake, or `null` to exercise the unconfigured path
 * with a key present. Abandoning the generator (`break`, `return()`) aborts the
 * model call, so a browser that hangs up mid-answer releases the upstream
 * connection instead of leaving it to run to completion unread.
 */
export async function* runGraphChat(
  store: GraphStore,
  rawInput: GraphChatInput,
  context?: GraphOperationContext,
  options: { model?: GraphChatModel | null; signal?: AbortSignal } = {},
): AsyncGenerator<GraphChatEvent> {
  const input = graphChatInputSchema.parse(rawInput);
  const model = options.model === undefined ? createGraphChatModelFromEnv() : options.model;
  const startedAt = Date.now();
  const abort = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const channel = createEventChannel<GraphChatEvent>();
  // An abort must reach the READER, not just the model: without this the
  // channel sits on its wake promise until the pipeline finishes on its own,
  // and a client that hung up mid-answer would keep the whole turn alive.
  abort.signal.addEventListener("abort", () => channel.close(), { once: true });
  const emit = (event: Unstamped<GraphChatEvent>): void => {
    channel.push({ ...event, elapsedMs: Date.now() - startedAt } as GraphChatEvent);
  };

  const work = (async () => {
    let answer = "";
    let finish: GraphChatFinish = "ok";
    let citations: RecallCitation[] = [];
    let citedNodeIds: string[] = [];
    try {
      emit({ type: "start", query: input.query });

      const recall = await performRecall(store, {
        query: input.query,
        tokenBudget: input.tokenBudget,
        depth: input.depth,
        includeEvidence: true,
      }, context, {
        onTrace: (event) => {
          if (event.stage === "seeds") emit({ type: "seeds", arm: event.arm, nodes: event.nodes.map(nodeRef) });
          else if (event.stage === "fused") emit({ type: "fused", nodes: event.nodes.map(nodeRef) });
          else if (event.stage === "expanded") {
            emit({
              type: "expand",
              seedNodeId: event.seedNodeId,
              nodes: event.nodes.map((reached) => ({ ...nodeRef(reached.node), hops: reached.hops })),
            });
          } else {
            emit({
              type: "rank",
              reranked: event.reranked,
              total: event.nodes.length,
              nodes: event.nodes.slice(0, RANK_WIRE_LIMIT).map((ranked) => ({
                id: ranked.node.id,
                score: Number(ranked.score.toFixed(4)),
              })),
            });
          }
        },
      });

      citations = recall.citations;
      emit({
        type: "pack",
        atoms: recall.atoms.map((atom) => ({
          ...nodeRef(atom.node),
          hops: atom.hops,
          score: Number(atom.score.toFixed(4)),
          tokens: atom.tokens,
          provenance: atom.provenance,
          summary: atom.node.summary,
        })),
        tokenBudget: recall.tokenBudget,
        spentTokens: recall.spentTokens,
        truncated: recall.truncated,
      });

      if (recall.atoms.length === 0) {
        // Nothing was retrieved, so there is nothing to ground an answer in.
        // Asking a model anyway would produce exactly the invention this whole
        // pipeline exists to avoid.
        finish = "no_results";
        emit({
          type: "notice",
          code: "no_results",
          message: "Nothing in this graph matched the question — no nodes were retrieved.",
        });
      } else if (!model) {
        finish = "no_model";
        emit({ type: "answer_start", model: null });
        emit({
          type: "notice",
          code: "model_not_configured",
          message:
            "No answering model is configured (set TROVE_GRAPH_CHAT=1 and OPENAI_API_KEY). " +
            "The retrieval above is real: these are the notes recall found and packed.",
        });
      } else {
        emit({ type: "answer_start", model: model.name });
        try {
          for await (const token of model.stream({
            messages: buildChatMessages(input.query, recall),
            signal: abort.signal,
          })) {
            answer += token;
            emit({ type: "token", text: token });
          }
        } catch (error) {
          // A half-written answer is kept and labelled, not discarded: the
          // viewer should see what arrived and be told it stopped early.
          finish = "error";
          emit({
            type: "error",
            code: "model_failed",
            message: error instanceof Error ? error.message : "The answering model stopped responding.",
          });
        }
        const cited = citedSlugs(answer, recall.atoms.map((atom) => atom.node.slug));
        citedNodeIds = recall.atoms
          .filter((atom) => cited.has(atom.node.slug))
          .map((atom) => atom.node.id);
      }
    } catch (error) {
      finish = "error";
      emit({
        type: "error",
        code: "recall_failed",
        message: error instanceof Error ? error.message : "Recall failed.",
      });
    } finally {
      emit({ type: "done", finish, citations, citedNodeIds, answer });
      channel.close();
    }
  })();

  try {
    yield* channel.drain();
  } finally {
    // Reached when the consumer stops early as well as on a clean end. Aborting
    // here is what closes an in-flight model connection; `work` has no
    // unhandled rejection to leave behind because it catches everything.
    abort.abort();
    await work;
  }
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx and friends buffer text/event-stream by default, which would collect
  // the whole traversal and deliver it at once — the exact fake this feature
  // must not ship.
  "x-accel-buffering": "no",
} as const;

/** Proxies drop an idle stream; recall and a first token can both take seconds. */
const KEEPALIVE_MS = 15_000;

export function encodeChatEvent(event: GraphChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * The HTTP surface: one graph-chat turn as an SSE response.
 *
 * Split from the route so it can be tested without a listening server (the
 * repo's HTTP tests are opt-in end-to-end), and so the route in server.ts is
 * nothing but auth plus this call.
 */
export function graphChatResponse(
  store: GraphStore,
  input: GraphChatInput,
  context?: GraphOperationContext,
  options: { model?: GraphChatModel | null; signal?: AbortSignal } = {},
): Response {
  // The client hanging up is its own abort source, merged with any the caller
  // already had (Hono hands the route `request.signal`).
  const hangup = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, hangup.signal])
    : hangup.signal;
  const events = runGraphChat(store, input, context, { ...options, signal });
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // The stream is already closed; the pump below is unwinding.
        }
      }, KEEPALIVE_MS);
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(encodeChatEvent(event)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearInterval(keepalive);
      }
    },
    async cancel() {
      // The client hung up. Abort first so the pipeline's reader wakes, then
      // return the generator to run its finally (which aborts the model call
      // and waits for the in-flight turn to unwind).
      clearInterval(keepalive);
      hangup.abort();
      await events.return(undefined as never).catch(() => undefined);
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}
