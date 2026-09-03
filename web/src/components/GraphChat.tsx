import { useCallback, useEffect, useRef, useState } from "react";
import { typeColor } from "@/lib/viz";
import { streamGraphChat, type ChatPackAtom } from "@/lib/api";
import {
  CHAT_STATE_LABEL,
  CHAT_STATE_RANK,
  highlightInk,
  usePrefersReducedMotion,
  type ChatHighlight,
  type ChatHighlights,
  type ChatHighlightState,
} from "@/lib/graphChatState";

/**
 * Ask the graph a question and watch it answer.
 *
 * The panel is a thin reader of POST /v1/graph-chat: every node it lights comes
 * from an event the server emitted while retrieval was running. Nothing here
 * schedules a walk, staggers an arrival, or fills a gap with a plausible node —
 * if the semantic arm returns nothing, nothing lights up for it, and if a
 * question retrieves four notes, four notes light up. The stage list under the
 * input is the receipt: real counts, real elapsed times, in the real order.
 */

type Stage = { key: string; label: string; detail: string; elapsedMs: number };

type Finish = "ok" | "no_model" | "no_results" | "error" | "dropped";

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render the answer with its citations as buttons.
 *
 * A `[[slug]]` the pack never carried is printed as the literal text the model
 * wrote. Styling an invented citation like a real one would be the one lie this
 * whole feature exists to avoid.
 */
function AnswerBody({
  text,
  slugs,
  onCitation,
  dark,
}: {
  text: string;
  slugs: Map<string, ChatPackAtom>;
  onCitation: (nodeId: string) => void;
  dark: boolean;
}) {
  const parts = text.split(/(\[\[[^\]\n]{1,200}\]\])/g);
  return (
    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
      {parts.map((part, index) => {
        const match = /^\[\[([^\]\n]{1,200})\]\]$/.exec(part);
        const atom = match ? slugs.get(match[1]!.trim()) : undefined;
        if (!atom) return <span key={index}>{part}</span>;
        return (
          <button
            key={index}
            type="button"
            onClick={() => onCitation(atom.id)}
            title={atom.title}
            className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-sm border px-1 py-px align-baseline text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: typeColor(atom.type, dark) }}
              aria-hidden
            />
            <span className="truncate">{atom.title}</span>
          </button>
        );
      })}
    </p>
  );
}

export function GraphChat({
  onHighlights,
  onFocusNode,
  onPacked,
  onClose,
  dark,
  narrow,
}: {
  onHighlights: (highlights: ChatHighlights) => void;
  onFocusNode: (nodeId: string) => void;
  /** The pack landed: these are the nodes the answer was actually built from. */
  onPacked: (nodeIds: string[]) => void;
  onClose: () => void;
  dark: boolean;
  /** True on a narrow viewport: the panel docks to the bottom, not the side. */
  narrow: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [pack, setPack] = useState<ChatPackAtom[] | null>(null);
  const [citedIds, setCitedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [finish, setFinish] = useState<Finish | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAsked(null);
    setRunning(false);
    setStages([]);
    setAnswer("");
    setModel(null);
    setPack(null);
    setCitedIds(new Set());
    setNotice(null);
    setFailure(null);
    setFinish(null);
    onHighlights(null);
    inputRef.current?.focus();
  }, [onHighlights]);

  const ask = useCallback(async () => {
    const query = question.trim();
    if (!query || running) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Everything dims the moment the question is sent; nodes earn their way
    // back out of the dark as the server reports touching them.
    const lit = new Map<string, ChatHighlight>();
    onHighlights(new Map(lit));
    setAsked(query);
    setRunning(true);
    setStages([]);
    setAnswer("");
    setModel(null);
    setPack(null);
    setCitedIds(new Set());
    setNotice(null);
    setFailure(null);
    setFinish(null);

    const promote = (
      id: string,
      state: ChatHighlightState,
      extra: { hops?: number; arm?: ChatHighlight["arm"] } = {},
    ): void => {
      const current = lit.get(id);
      if (current && CHAT_STATE_RANK[current.state] >= CHAT_STATE_RANK[state]) return;
      lit.set(id, {
        state,
        hops: extra.hops ?? current?.hops ?? 0,
        ...(extra.arm ?? current?.arm ? { arm: extra.arm ?? current?.arm } : {}),
        at: performance.now(),
      });
    };
    const publish = () => onHighlights(new Map(lit));

    const addStage = (stage: Stage) =>
      setStages((current) => [...current.filter((row) => row.key !== stage.key), stage]);

    let sawDone = false;
    let expandedWalks = 0;
    let expandedNodes = 0;
    try {
      for await (const event of streamGraphChat(query, controller.signal)) {
        switch (event.type) {
          case "start":
            break;
          case "seeds": {
            for (const node of event.nodes) promote(node.id, "seed", { hops: 0, arm: event.arm });
            publish();
            addStage({
              key: `arm:${event.arm}`,
              label: `${event.arm} search`,
              detail: `${event.nodes.length} hit${event.nodes.length === 1 ? "" : "s"}`,
              elapsedMs: event.elapsedMs,
            });
            break;
          }
          case "fused": {
            for (const node of event.nodes) promote(node.id, "seed", { hops: 0 });
            publish();
            addStage({
              key: "fused",
              label: "fused seed pool",
              detail: `${event.nodes.length} candidate${event.nodes.length === 1 ? "" : "s"}`,
              elapsedMs: event.elapsedMs,
            });
            break;
          }
          case "expand": {
            expandedWalks += 1;
            expandedNodes += event.nodes.length;
            for (const node of event.nodes) promote(node.id, "expanded", { hops: node.hops });
            publish();
            addStage({
              key: "expand",
              label: "graph expansion",
              detail: `${expandedWalks} walk${expandedWalks === 1 ? "" : "s"} · +${expandedNodes} node${expandedNodes === 1 ? "" : "s"}`,
              elapsedMs: event.elapsedMs,
            });
            break;
          }
          case "rank":
            addStage({
              key: "rank",
              label: event.reranked ? "ranked (reranked)" : "ranked",
              detail: `${event.total} candidate${event.total === 1 ? "" : "s"}`,
              elapsedMs: event.elapsedMs,
            });
            break;
          case "pack": {
            for (const atom of event.atoms) promote(atom.id, "packed", { hops: atom.hops });
            publish();
            setPack(event.atoms);
            onPacked(event.atoms.map((atom) => atom.id));
            addStage({
              key: "pack",
              label: event.truncated ? "packed (budget hit)" : "packed",
              detail: `${event.atoms.length} atom${event.atoms.length === 1 ? "" : "s"} · ${event.spentTokens.toLocaleString()}/${event.tokenBudget.toLocaleString()} tok`,
              elapsedMs: event.elapsedMs,
            });
            break;
          }
          case "answer_start":
            setModel(event.model);
            addStage({
              key: "answer",
              label: "answering",
              detail: event.model ?? "no model configured",
              elapsedMs: event.elapsedMs,
            });
            break;
          case "token":
            setAnswer((current) => current + event.text);
            break;
          case "notice":
            setNotice(event.message);
            break;
          case "error":
            setFailure(event.message);
            break;
          case "done": {
            sawDone = true;
            for (const id of event.citedNodeIds) promote(id, "cited");
            publish();
            setCitedIds(new Set(event.citedNodeIds));
            setFinish(event.finish);
            addStage({
              key: "done",
              label: "done",
              detail: `${event.citedNodeIds.length} citation${event.citedNodeIds.length === 1 ? "" : "s"}`,
              elapsedMs: event.elapsedMs,
            });
            break;
          }
        }
      }
      if (!sawDone && !controller.signal.aborted) {
        // The body ended without a terminal event: a proxy timeout, a dropped
        // connection, a restarted server. Say that, rather than presenting a
        // half-answer as finished.
        setFinish("dropped");
        setFailure("The connection closed before the answer finished. What you see above is everything that arrived.");
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setFinish("error");
        setFailure(cause instanceof Error ? cause.message : "Graph chat failed.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }, [question, running, onHighlights, onPacked]);

  const packBySlug = new Map((pack ?? []).map((atom) => [atom.slug, atom]));
  const shell = narrow
    ? "absolute inset-x-0 bottom-0 z-20 flex h-[62%] flex-col border-t bg-card"
    : "absolute inset-y-0 right-0 z-20 flex w-[25rem] flex-col border-l bg-card";
  const motion = reduced ? "" : "transition-opacity duration-300";

  return (
    <aside className={shell} aria-label="Ask the graph">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Ask the graph
        </p>
        <div className="flex items-center gap-1">
          {finish || running ? (
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="rounded-md px-1.5 text-lg leading-none text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>
      </header>

      <form
        className="flex items-center gap-2 border-b px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input
          ref={inputRef}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What does this graph know about…"
          className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          disabled={running || question.trim().length === 0}
          className="shrink-0 rounded-md border px-2.5 py-1 text-[12px] transition-colors hover:bg-muted disabled:opacity-40"
        >
          {running ? "…" : "Ask"}
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!asked ? (
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            <p>
              Every node dims, then lights up as retrieval touches it: search hits first, then
              whatever graph traversal reaches from them, then the notes that fit the answer's
              token budget.
            </p>
            <ul className="mt-3 flex flex-col gap-1.5 font-mono text-[11px]">
              {(["seed", "expanded", "packed", "cited"] as const).map((state) => (
                <li key={state} className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full border-2"
                    style={{ borderColor: highlightInk(state, dark) }}
                    aria-hidden
                  />
                  <span>{CHAT_STATE_LABEL[state]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="font-serif text-[15px] leading-snug">{asked}</p>

            {stages.length > 0 ? (
              <ol className="flex flex-col gap-0.5 border-y py-1.5 font-mono text-[10.5px] text-muted-foreground">
                {stages.map((stage) => (
                  <li key={stage.key} className={`flex items-baseline gap-2 ${motion}`}>
                    <span className="w-[6.75rem] shrink-0 truncate text-foreground">{stage.label}</span>
                    <span className="truncate">{stage.detail}</span>
                    <span className="ml-auto shrink-0 pl-2 tabular-nums">{formatMs(stage.elapsedMs)}</span>
                  </li>
                ))}
              </ol>
            ) : null}

            {answer ? (
              <AnswerBody text={answer} slugs={packBySlug} onCitation={onFocusNode} dark={dark} />
            ) : running && model ? (
              <p className="text-[13px] text-muted-foreground">Answering with {model}…</p>
            ) : null}

            {notice ? (
              <p className="rounded-md border border-dashed px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
                {notice}
              </p>
            ) : null}

            {failure ? (
              <p className="rounded-md border px-3 py-2 text-[12px] leading-relaxed text-destructive">
                {failure}
              </p>
            ) : null}

            {pack && pack.length > 0 ? (
              <div>
                <p className="pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  Retrieved · {pack.length}
                </p>
                <div className="flex flex-col">
                  {pack.map((atom) => (
                    <button
                      key={atom.id}
                      type="button"
                      onClick={() => onFocusNode(atom.id)}
                      title={atom.summary ?? atom.title}
                      className="flex items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-muted"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: typeColor(atom.type, dark) }}
                        aria-hidden
                      />
                      <span className="truncate text-[12.5px]">{atom.title}</span>
                      <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground">
                        {citedIds.has(atom.id) ? "cited · " : ""}
                        {atom.hops === 0 ? "hit" : `${atom.hops} hop`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {finish === "no_results" && pack?.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                The graph stayed dark because retrieval returned nothing — no node in it matched,
                lexically or semantically.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
