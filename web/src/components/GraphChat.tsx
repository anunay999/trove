import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SVGProps } from "react";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Citation } from "@astryxdesign/core/Citation";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { ResizeHandle, type ResizableProps } from "@astryxdesign/core/Resizable";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { formatDay, typeColor } from "@/lib/viz";
import { streamGraphChat, type ChatPackAtom } from "@/lib/api";
import { gothicTheme } from "@/themes/gothic";
import {
  CHAT_STATE_LABEL,
  highlightInk,
  progressPhrase,
  useRetrievalReplay,
  usePrefersReducedMotion,
  type ChatHighlights,
  type ReplayPromotion,
} from "@/lib/graphChatState";

/**
 * Ask the graph a question and watch it answer.
 *
 * The panel is a thin reader of POST /v1/graph-chat: every node it lights comes
 * from an event the server emitted while retrieval was running. Nothing here
 * schedules a walk, invents an arrival, or fills a gap with a plausible node —
 * if the semantic arm returns nothing, nothing lights up for it, and if a
 * question retrieves four notes, four notes light up. The stage list is the
 * receipt: real arm names, real counts, real elapsed times, in the real order.
 *
 * One thing is staged, and only one: the *pace*. Retrieval finishes faster than
 * the eye, so the events are released through `useRetrievalReplay` on a clock
 * (see lib/graphChatState.ts, which carries the full note). The elapsed times
 * printed beside each stage are never taken from that clock.
 *
 * SHAPE. The graph is the canvas and this is the rail beside it, so the layout
 * follows the kit's `ai-chat` page template with its proportions inverted: the
 * template's chat column is the dominant region and its artifact pane the
 * companion, and here it is the other way round — the artifact is the graph,
 * and the graph is the point. From the template: ChatLayout with a docked
 * ChatComposer over a ChatMessageList of ChatMessage / ChatMessageBubble /
 * ChatMessageMetadata, ChatToolCalls for the machine's own work, Markdown for
 * the assistant's prose, and the ResizeHandle that lets the reader trade rail
 * for canvas. Departures, all of them because the artifact is a live canvas
 * this panel does not own:
 *
 *  - no ArtifactCard/ArtifactBody. The graph is rendered by GraphView on the
 *    old Tailwind system and must stay there; wrapping a force-directed canvas
 *    in an Astryx card would put a second design system in charge of its size.
 *    GraphView keeps the frames and this file fills them.
 *  - the retrieval stages leave the rail entirely on a wide viewport and become
 *    a HUD over the canvas (`RetrievalHud`), because they annotate the thing
 *    happening on the canvas, not the conversation.
 *  - no ChatTokenizedText for citations. It renders tokens as pills, and a pill
 *    mid-sentence breaks the prose apart; Markdown's own citation support gives
 *    a numbered marker that resolves on hover and on click instead.
 *
 * ALIGNMENT. Every block of an assistant turn hangs off one gutter, and that
 * gutter is the bubble's text column: the kit's own way of putting custom
 * content on it is a ghost bubble at `width="100%"` (its
 * ChatMessageBubbleCustomContent block), so everything in the turn is wrapped
 * in one — the answer, the model line, the references, the retrieval. The only
 * indent inside that gutter is a list's own marker column.
 *
 * SCOPE. This is the one surface in the dashboard built on Astryx rather than
 * the Tailwind/shadcn system the rest of it uses, under our copy of the gothic
 * theme, tuned to sit beside its neighbours (src/themes/gothicTheme.ts). The
 * theme, Astryx's reset and every class this file generates are scoped to the
 * subtrees the <Theme> wrappers own; nothing here reaches the canvas behind it,
 * which still draws its dimming and its rings on the old system.
 */

export type Stage = { key: string; label: string; detail: string; elapsedMs: number };

type Finish = "ok" | "no_model" | "no_results" | "error" | "dropped";

type Notice = { code: "model_not_configured" | "no_results"; message: string };

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const arrive = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(2px)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  /* The rail fills whatever frame the graph view docks it into. */
  panel: {
    backgroundColor: "var(--color-background-surface)",
    color: "var(--color-text-primary)",
    fontFamily: "var(--font-family-body)",
    // The canvas pans and zooms alongside; nothing inside may spill onto it.
    overflow: "hidden",
    position: "relative",
  },
  /* ChatLayout wants to fill its container with flex:1, so give it one. */
  fill: { display: "flex", flexDirection: "column", minHeight: 0 },
  /* Node-type ink, straight off the function the canvas paints nodes with. */
  ink: (color: string) => ({ color }),
  /*
   * EmptyState stacks its title and its description in one flex column with no
   * gap between them, and that column is not reachable from here — `xstyle`
   * lands on the outer container and StyleX has no descendant selectors. So the
   * description is not handed to the component at all: the title stays on it
   * for the semantic heading, and the description moves into `actions`, above
   * the legend, where the spacing is ours. The container's own gap is what now
   * separates the heading from the body, so it is tightened to a text-group gap.
   */
  idle: {
    gap: "var(--spacing-1)",
    // EmptyState reserves --spacing-8 above and below itself. On a wide
    // viewport that is invisible — the state floats in a tall empty rail — and
    // at 375, where the panel is the bottom 62% of the screen, it was 64px the
    // title needed to stay on screen.
    paddingBlock: "var(--spacing-4)",
  },
  /*
   * The rail is 40% of the viewport, so a one-line description would otherwise
   * run its whole width. 360px is EmptyState's own cap on its text group, kept
   * here so the sentence measures what it measured inside the component.
   */
  idleDescription: { maxInlineSize: "22.5rem" },
  /*
   * The legend is the whole point of this panel before a question is asked, so
   * it gets room to breathe rather than the compact rail treatment: the rail is
   * 40% of the viewport and the empty state was a small block adrift in it.
   */
  legend: { textAlign: "start" },
  legendRow: { marginBlockStart: "var(--spacing-2)" },
  /*
   * The model line is metadata about the answer, not its last line. The bubble
   * pulls its metadata slot up by --spacing-1-5 so a timestamp sits tight under
   * the prose; here that left "gpt-5.6-luna" touching the final bullet and
   * reading as part of it. Overriding the slot's own margin gives it air.
   */
  modelLine: { marginBlockStart: "var(--spacing-4)" },
  /*
   * The rhythm of the turn. ChatMessage stacks its children 2px apart at
   * compact density, which is right for consecutive bubbles from one speaker
   * and too tight for the four different things this turn stacks: the answer,
   * the model that wrote it, the references, and the retrieval behind them.
   * Every block after the answer gets the same step, so the model line reads as
   * the answer's footer rather than the references' heading.
   */
  turnBlock: { marginBlockStart: "var(--spacing-4)" },
  /*
   * One gutter for the assistant turn, and Item's own padding inside it.
   *
   * Item carries `padding-inline: --spacing-2` and exposes no prop for it, so
   * everything built on it — a reference row, a stage row — started 8px right
   * of every other block in the turn. This is Astryx's own answer to that,
   * lifted from ChatToolCalls' list: keep the padding, so a row's hover
   * background still overhangs its text, and pull the row back over it with a
   * matching negative margin so the content starts on the gutter. The bubble's
   * inline padding absorbs the overhang. Symmetric, so the stage table
   * translates rather than stretching and moving its three columns apart.
   */
  gutterPull: { marginInline: "calc(-1 * var(--spacing-2))" },
  arrival: {
    animationName: arrive,
    animationDuration: "var(--duration-medium)",
    animationTimingFunction: "var(--ease-standard)",
    animationFillMode: "both",
  },
  /*
   * The HUD's own surface. A force graph moves underneath it, so the readout
   * gets an opaque card and a shadow rather than bare text over the canvas —
   * a scrim would still leave a node drifting through the middle of a row.
   */
  hud: {
    backgroundColor: "var(--color-background-popover)",
    color: "var(--color-text-primary)",
    fontFamily: "var(--font-family-body)",
    borderRadius: "var(--radius-container)",
    borderWidth: "var(--border-width)",
    borderStyle: "solid",
    borderColor: "var(--color-border)",
    boxShadow: "var(--shadow-high)",
    width: "23rem",
    maxWidth: "100%",
  },
  /* The stage table: hairline-ruled, so the rows read as one block. */
  stages: {
    borderBlockStartWidth: "var(--border-width)",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: "var(--color-border)",
    paddingBlockStart: "var(--spacing-1)",
  },
  /* One fixed column so every label, detail and time lines up down the list. */
  stageLabel: { width: "7.25rem", flexShrink: 0 },
  stageDetail: { minWidth: 0, flexGrow: 1 },
  stageElapsed: { flexShrink: 0 },
  citation: { cursor: "pointer" },
  /*
   * The freshness strip: a bare time axis, one tick per memory the answer was
   * built from. No card, no grid, no y-axis — there is nothing to measure
   * against, only where the marks fall and how tightly they cluster.
   */
  strip: { position: "relative", height: "1.5rem", width: "100%" },
  stripRule: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: "50%",
    height: "var(--border-width)",
    backgroundColor: "var(--color-border)",
  },
  tickBase: {
    position: "absolute",
    width: "2px",
    borderRadius: "1px",
    transform: "translateX(-50%)",
  },
  /* Cited marks stand full height; the rest of the pack sits inside them. */
  tickCited: { insetBlockStart: "0.125rem", height: "1.25rem", opacity: 1 },
  tickPacked: { insetBlockStart: "0.4375rem", height: "0.625rem", opacity: 0.45 },
  tick: (offset: number, color: string) => ({
    insetInlineStart: `${offset * 100}%`,
    backgroundColor: color,
  }),
});

/** A filled dot at 1em — the node-type swatch, coloured by `styles.ink`. */
function DotGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 8 8" {...props}>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

/** A hollow ring at 1em — the legend swatch, matching the canvas's rings. */
function RingGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 8 8" {...props}>
      <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * How current the answer's footing is.
 *
 * The canvas already says WHERE in the graph an answer came from — nodes light
 * up in place. It says nothing about WHEN, and "when" is the failure a reader
 * cannot otherwise see: an answer assembled entirely out of notes nobody has
 * touched since spring reads exactly like one assembled this morning.
 *
 * So: a bare time axis, oldest to newest, one tick per memory in the pack.
 * Cited marks stand full height in the canvas's own cited amber; the rest of
 * the pack sits inside them, faint, in the packed ink. A tight cluster on the
 * right is a fresh answer; a long tail to the left is one worth checking.
 *
 * The axis is `updatedAt` — when a memory was last written, not when it was
 * first written. A March note revised last week IS current, and this strip
 * exists to answer "is this still true", not "how long have I known it".
 *
 * It is a readout and nothing more. Nothing in recall ranks on this: the only
 * always-on time signal in the blend is activation, which decays on
 * lastAccessedAt — how recently a note was READ, not how recently it was
 * true — and the query-side temporal scope only wakes up when the question
 * itself names a time. So a stale pack is not something retrieval will correct
 * on its own, which is exactly why it is worth showing.
 */
function ProvenanceStrip({
  atoms,
  citedIds,
  lastWritten,
  dark,
}: {
  atoms: ChatPackAtom[];
  citedIds: Set<string>;
  lastWritten: Map<string, string>;
  dark: boolean;
}) {
  const axis = useMemo(() => {
    const dated = atoms
      .map((atom) => ({ atom, at: lastWritten.get(atom.id) ?? null }))
      .flatMap((row) => {
        const ms = row.at ? Date.parse(row.at) : Number.NaN;
        return row.at && Number.isFinite(ms) ? [{ atom: row.atom, at: row.at, ms }] : [];
      })
      .sort((left, right) => left.ms - right.ms);
    const oldest = dated[0];
    const newest = dated.at(-1);
    if (!oldest || !newest) return null;
    const span = newest.ms - oldest.ms;
    return {
      oldest: oldest.at.slice(0, 10),
      newest: newest.at.slice(0, 10),
      /* One day for every memory collapses the axis; centre the marks on it. */
      sameDay: span === 0,
      ticks: dated.map((row) => ({
        id: row.atom.id,
        title: row.atom.title,
        at: row.at,
        cited: citedIds.has(row.atom.id),
        offset: span === 0 ? 0.5 : (row.ms - oldest.ms) / span,
      })),
    };
  }, [atoms, citedIds, lastWritten]);

  if (!axis) return null;
  const citedInk = highlightInk("cited", dark);
  const packedInk = highlightInk("packed", dark);

  return (
    <VStack gap={0.5}>
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="code" size="xsm" color="secondary">
          Last written
        </Text>
        <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
          {axis.ticks.length} {axis.ticks.length === 1 ? "memory" : "memories"}
        </Text>
      </HStack>
      <div {...stylex.props(styles.strip)}>
        <span {...stylex.props(styles.stripRule)} />
        {axis.ticks.map((tick) => (
          <span
            key={tick.id}
            title={`${tick.title} — ${formatDay(tick.at.slice(0, 10))}${tick.cited ? " · cited" : ""}`}
            {...stylex.props(
              styles.tickBase,
              tick.cited ? styles.tickCited : styles.tickPacked,
              styles.tick(tick.offset, tick.cited ? citedInk : packedInk),
            )}
          />
        ))}
      </div>
      {axis.sameDay ? (
        <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
          All on {formatDay(axis.oldest)}
        </Text>
      ) : (
        <HStack gap={2} hAlign="between" vAlign="center">
          <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
            {formatDay(axis.oldest)}
          </Text>
          <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
            {formatDay(axis.newest)}
          </Text>
        </HStack>
      )}
    </VStack>
  );
}

/**
 * The retrieval receipt: what ran, what it found, how long it took.
 *
 * Three columns, monospace, ruled — the same table the panel has always shown,
 * because the alignment is what makes eight stages scannable in one glance.
 * Rows arrive one beat at a time, in step with the nodes lighting on the canvas.
 */
function StageTable({
  stages,
  arrival,
  xstyle,
}: {
  stages: Stage[];
  arrival: stylex.StyleXStyles;
  /** Set by the rail, where the table has to line up with the turn's gutter. */
  xstyle?: stylex.StyleXStyles;
}) {
  return (
    <VStack as="ol" gap={0} xstyle={[styles.stages, xstyle]}>
      {stages.map((stage) => (
        <Item
          key={stage.key}
          as="li"
          density="compact"
          xstyle={arrival}
          label={
            <HStack gap={2} vAlign="center">
              <Text type="code" size="xsm" xstyle={styles.stageLabel} maxLines={1}>
                {stage.label}
              </Text>
              <Text
                type="code"
                size="xsm"
                color="secondary"
                maxLines={1}
                xstyle={styles.stageDetail}
              >
                {stage.detail}
              </Text>
              <Text
                type="code"
                size="xsm"
                color="secondary"
                hasTabularNumbers
                xstyle={styles.stageElapsed}
              >
                {formatMs(stage.elapsedMs)}
              </Text>
            </HStack>
          }
        />
      ))}
    </VStack>
  );
}

/**
 * The stage table as a heads-up display over the graph.
 *
 * GraphView pins it to a corner of the canvas and keeps the camera's centring
 * box clear of it, so the readout never sits on top of the cluster it is
 * describing. Its own <Theme> wrapper, because it lives outside the rail.
 */
export function RetrievalHud({
  stages,
  running,
  dark,
}: {
  stages: Stage[];
  running: boolean;
  dark: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  return (
    <Theme theme={gothicTheme} mode={dark ? "dark" : "light"}>
      <VStack gap={1} padding={3} xstyle={styles.hud}>
        <HStack gap={1.5} vAlign="center">
          {/*
            A spinner while it runs, a dot once it has stopped. A pulsing dot
            reads as decoration next to a table of numbers that is still
            growing; a spinner is the one shape everyone already reads as
            "not finished". Reduced motion keeps the dot, which does not spin.
          */}
          {running && !reduced ? (
            <Spinner size="sm" shade="inherit" aria-label="Retrieving" />
          ) : (
            <StatusDot
              variant={running ? "accent" : "neutral"}
              label={running ? "Retrieving" : "Retrieval finished"}
            />
          )}
          <Text type="code" size="xsm" color="secondary">
            RETRIEVAL
          </Text>
        </HStack>
        <StageTable stages={stages} arrival={reduced ? null : styles.arrival} />
      </VStack>
    </Theme>
  );
}

/**
 * Before the first question: what is about to happen, and how to read it.
 *
 * The description rides in `actions` rather than on the `description` prop —
 * see `styles.idle`. Everything the component would have rendered is still
 * rendered, in the same order, with a gap between the heading and the sentence
 * under it.
 */
function IdleState({ dark, narrow }: { dark: boolean; narrow: boolean }) {
  return (
    <EmptyState
      title="Watch it retrieve"
      xstyle={styles.idle}
      actions={
        <VStack gap={narrow ? 3 : 5} hAlign="center">
          <Text color="secondary" xstyle={styles.idleDescription}>
            Ask a question. The graph dims, then lights up in the order retrieval touches it.
          </Text>
          {/*
            * The legend gets the room on a rail 40% of a monitor wide, and
            * closes up where the panel is the bottom 62% of a phone: spacious
            * rows there pushed the title off the top of the sheet.
            */}
          <List density={narrow ? "balanced" : "spacious"} xstyle={styles.legend}>
            {(["seed", "expanded", "packed", "cited"] as const).map((state) => (
              <ListItem
                key={state}
                label={CHAT_STATE_LABEL[state]}
                xstyle={narrow ? null : styles.legendRow}
                startContent={
                  <Icon icon={RingGlyph} size="sm" xstyle={styles.ink(highlightInk(state, dark))} />
                }
              />
            ))}
          </List>
        </VStack>
      }
    />
  );
}

export function GraphChat({
  onHighlights,
  onFocusNode,
  onPacked,
  onStages,
  onClose,
  dark,
  narrow,
  resizable,
  lastWritten,
}: {
  onHighlights: (highlights: ChatHighlights) => void;
  onFocusNode: (nodeId: string) => void;
  /** The pack landed: these are the nodes the answer was actually built from. */
  onPacked: (nodeIds: string[]) => void;
  /** The stage list, for the HUD GraphView draws over the canvas. */
  onStages: (stages: Stage[]) => void;
  onClose: () => void;
  dark: boolean;
  /**
   * When each memory in the graph was last written, keyed by node id. It comes
   * from the snapshot the canvas is already drawing, so the freshness strip
   * costs no request of its own — and a node the pack names is by definition
   * a node the canvas holds.
   */
  lastWritten: Map<string, string>;
  /**
   * True where the canvas has no corner to spare. The stage table then renders
   * in the rail instead of over the graph.
   */
  narrow: boolean;
  /** Drag state for the handle between the rail and the canvas. */
  resizable?: ResizableProps;
}) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [pack, setPack] = useState<ChatPackAtom[] | null>(null);
  const [citedIds, setCitedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [finish, setFinish] = useState<Finish | null>(null);
  /**
   * The retrieved notes start folded and stay folded until the reader opens
   * them; a new question folds them again. Controlled rather than defaulted,
   * because ChatToolCalls keeps its own state across turns and reads
   * `defaultIsExpanded` once, at mount — so the next answer would otherwise
   * arrive with the last answer's list already open.
   */
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reduced = usePrefersReducedMotion();

  const addStage = useCallback(
    (stage: Stage) =>
      setStages((current) => [...current.filter((row) => row.key !== stage.key), stage]),
    [],
  );

  const replay = useRetrievalReplay<Stage>({ onHighlights, onStage: addStage, reduced });
  const { begin, push, cancel } = replay;

  // The HUD lives outside this component, so it is told rather than asked.
  useEffect(() => onStages(stages), [stages, onStages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancel();
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
    setToolsExpanded(false);
    onHighlights(null);
  }, [cancel, onHighlights]);

  /**
   * Stop reading, keep what arrived. Cancelling the reader is what tells the
   * server to abandon the model call, so this is a real cancel, not a hide.
   */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const ask = useCallback(async () => {
    const query = question.trim();
    if (!query || running) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Everything dims the moment the question is sent, and any replay still
    // running from the last question is dropped where it stands.
    begin();
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
    setToolsExpanded(false);

    let sawDone = false;
    let expandedWalks = 0;
    let expandedNodes = 0;
    try {
      for await (const event of streamGraphChat(query, controller.signal)) {
        switch (event.type) {
          case "start":
            break;
          case "seeds": {
            push({
              stage: {
                key: `arm:${event.arm}`,
                label: `${event.arm} search`,
                detail: `${event.nodes.length} hit${event.nodes.length === 1 ? "" : "s"}`,
                elapsedMs: event.elapsedMs,
              },
              nodes: event.nodes.map(
                (node): ReplayPromotion => ({
                  id: node.id,
                  state: "seed",
                  hops: 0,
                  arm: event.arm,
                }),
              ),
            });
            break;
          }
          case "fused": {
            push({
              stage: {
                key: "fused",
                label: "fused seed pool",
                detail: `${event.nodes.length} candidate${event.nodes.length === 1 ? "" : "s"}`,
                elapsedMs: event.elapsedMs,
              },
              nodes: event.nodes.map(
                (node): ReplayPromotion => ({ id: node.id, state: "seed", hops: 0 }),
              ),
            });
            break;
          }
          case "expand": {
            expandedWalks += 1;
            expandedNodes += event.nodes.length;
            push({
              stage: {
                key: "expand",
                label: "graph expansion",
                detail: `${expandedWalks} walk${expandedWalks === 1 ? "" : "s"} · +${expandedNodes} node${expandedNodes === 1 ? "" : "s"}`,
                elapsedMs: event.elapsedMs,
              },
              nodes: event.nodes.map(
                (node): ReplayPromotion => ({ id: node.id, state: "expanded", hops: node.hops }),
              ),
            });
            break;
          }
          case "rank":
            push({
              stage: {
                key: "rank",
                label: event.reranked ? "ranked (reranked)" : "ranked",
                detail: `${event.total} candidate${event.total === 1 ? "" : "s"}`,
                elapsedMs: event.elapsedMs,
              },
              nodes: [],
            });
            break;
          case "pack": {
            setPack(event.atoms);
            onPacked(event.atoms.map((atom) => atom.id));
            push({
              stage: {
                key: "pack",
                label: event.truncated ? "packed (budget hit)" : "packed",
                detail: `${event.atoms.length} atom${event.atoms.length === 1 ? "" : "s"} · ${event.spentTokens.toLocaleString()}/${event.tokenBudget.toLocaleString()} tok`,
                elapsedMs: event.elapsedMs,
              },
              nodes: event.atoms.map(
                (atom): ReplayPromotion => ({ id: atom.id, state: "packed", hops: atom.hops }),
              ),
            });
            break;
          }
          case "answer_start":
            setModel(event.model);
            push({
              stage: {
                key: "answer",
                label: "answering",
                detail: event.model ?? "no model configured",
                elapsedMs: event.elapsedMs,
              },
              nodes: [],
            });
            break;
          case "token":
            setAnswer((current) => current + event.text);
            break;
          case "notice":
            setNotice({ code: event.code, message: event.message });
            break;
          case "error":
            setFailure(event.message);
            break;
          case "done": {
            sawDone = true;
            setCitedIds(new Set(event.citedNodeIds));
            setFinish(event.finish);
            push({
              stage: {
                key: "done",
                label: "done",
                detail: `${event.citedNodeIds.length} citation${event.citedNodeIds.length === 1 ? "" : "s"}`,
                elapsedMs: event.elapsedMs,
              },
              nodes: event.citedNodeIds.map((id): ReplayPromotion => ({ id, state: "cited" })),
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
  }, [question, running, begin, push, onPacked]);

  /**
   * The answer, as prose with references.
   *
   * The model writes `[[slug]]`. Every slug the pack actually carried is
   * rewritten to Markdown's own citation marker and given a source, so it
   * renders as a numbered badge that names its note on hover and focuses it on
   * click. A `[[slug]]` the pack never carried is left exactly as the model
   * wrote it — styling an invented citation like a real one would be the one
   * lie this whole feature exists to avoid.
   */
  const prose = useMemo(() => {
    const bySlug = new Map((pack ?? []).map((atom) => [atom.slug, atom]));
    const sources: Record<string, { title: string; url?: string }> = {};
    const numbers = new Map<string, number>();
    const ordered: ChatPackAtom[] = [];
    const markdown = answer.replace(/\[\[([^\]\n]{1,200})\]\]/g, (whole, raw: string) => {
      const atom = bySlug.get(raw.trim());
      if (!atom) return whole;
      if (!numbers.has(atom.id)) {
        numbers.set(atom.id, numbers.size + 1);
        ordered.push(atom);
        sources[atom.slug] = { title: atom.title, url: `#node/${atom.id}` };
      }
      return `[${atom.slug}]`;
    });
    return { markdown, sources, numbers, ordered };
  }, [answer, pack]);

  /**
   * Markdown numbers citations itself in first-appearance order; so do we, and
   * the reference list under the answer is built from the same map, so a marker
   * and its row can never disagree.
   */
  const CitationMarker = useMemo(
    () =>
      function CitationMarker({
        source,
        number,
      }: {
        source: { title?: string; url?: string };
        number: number;
      }) {
        const nodeId = (source.url ?? "").replace("#node/", "");
        return (
          <Citation
            variant="number"
            number={number}
            source={{ title: source.title }}
            xstyle={styles.citation}
            tabIndex={0}
            onClick={() => nodeId && onFocusNode(nodeId)}
            onKeyDown={(event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (nodeId) onFocusNode(nodeId);
              }
            }}
          />
        );
      },
    [onFocusNode],
  );

  /**
   * The notes the answer cited, as the tool calls they are: what recall reached
   * for, what it cost, and — behind the row — the summary that went into the
   * pack and a way onto the canvas. Folded until the reader opens it: the
   * answer and its references are the reading surface, and eight rows reading
   * "hit" between them and the composer is a wall rather than information. No
   * "cited" pill on the rows: every row in this group is cited, so the pill
   * said the same thing eight times.
   */
  const toolCall = useCallback(
    (atom: ChatPackAtom) => ({
      key: atom.id,
      name: atom.title,
      target: atom.hops === 0 ? "hit" : `${atom.hops} hop`,
      status: "complete" as const,
      resultDetail: (
        <VStack gap={2}>
          <Text type="supporting">{atom.summary ?? atom.title}</Text>
          <HStack gap={2} vAlign="center">
            <Button
              variant="ghost"
              size="sm"
              label="Show on the graph"
              onClick={() => onFocusNode(atom.id)}
            />
            <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
              {atom.tokens.toLocaleString()} tok
            </Text>
          </HStack>
        </VStack>
      ),
    }),
    [onFocusNode],
  );

  const cited = (pack ?? []).filter((atom) => citedIds.has(atom.id));

  /** Honour the OS setting: states still change, the transitions just stop. */
  const arrival = reduced ? null : styles.arrival;
  const busy = running || replay.isReplaying;

  return (
    <Theme theme={gothicTheme} mode={dark ? "dark" : "light"}>
      <VStack height="100%" xstyle={styles.panel}>
        {resizable && !narrow ? (
          <ResizeHandle
            direction="horizontal"
            position="overlay"
            isReversed
            // Discoverable at rest, not on hover: the canvas and the rail share
            // one dark ground, so without a grip and a divider the boundary
            // reads as a painted line rather than something you can pull.
            isAlwaysVisible
            hasDivider
            label="Resize the chat rail"
            resizable={resizable}
          />
        ) : null}

        <HStack paddingInline={3} paddingBlock={2} gap={2} vAlign="center" hAlign="between">
          <HStack gap={1.5} vAlign="center">
            <StatusDot
              variant={busy ? "accent" : "neutral"}
              label={replay.isReplaying ? "Replaying retrieval" : running ? "Retrieving" : "Idle"}
              tooltip={replay.isReplaying ? "Replaying retrieval at a watchable pace" : undefined}
              isPulsing={busy && !reduced}
            />
            <Heading level={3}>Ask the graph</Heading>
          </HStack>
          <HStack gap={0.5} vAlign="center">
            {asked ? <Button variant="ghost" size="sm" label="Clear" onClick={reset} /> : null}
            <IconButton
              variant="ghost"
              size="sm"
              label="Close chat"
              icon={<Icon icon="close" />}
              onClick={onClose}
            />
          </HStack>
        </HStack>
        <Divider />

        <StackItem size="fill" xstyle={styles.fill}>
          <ChatLayout
            emptyState={<IdleState dark={dark} narrow={narrow} />}
            composer={
              <ChatComposer
                density="compact"
                elevation="none"
                value={question}
                onChange={setQuestion}
                onSubmit={() => void ask()}
                placeholder="What does this graph know about…"
                isStopShown={running}
                onStop={stop}
              />
            }
          >
            {asked ? (
              <ChatMessageList density="compact" align="top" gap={2} isStreaming={running}>
                <ChatMessage sender="user">
                  <ChatMessageBubble>{asked}</ChatMessageBubble>
                </ChatMessage>

                <ChatMessage sender="assistant">
                  {/* On a wide viewport these rows are the HUD over the canvas. */}
                  {narrow && stages.length > 0 ? (
                    <ChatMessageBubble variant="ghost" width="100%">
                      <StageTable stages={stages} arrival={arrival} xstyle={styles.gutterPull} />
                    </ChatMessageBubble>
                  ) : null}

                  {answer ? (
                    <ChatMessageBubble
                      variant="ghost"
                      width="100%"
                      xstyle={arrival}
                      metadata={
                        model ? (
                          <ChatMessageMetadata
                            xstyle={styles.modelLine}
                            footer={
                              <Text type="code" size="xsm" color="secondary">
                                {model}
                              </Text>
                            }
                          />
                        ) : undefined
                      }
                    >
                      <Markdown
                        density="compact"
                        isStreaming={running}
                        sources={prose.sources}
                        citationStyle="number"
                        components={{ citation: CitationMarker }}
                      >
                        {prose.markdown}
                      </Markdown>
                    </ChatMessageBubble>
                  ) : busy ? (
                    <ChatMessageBubble variant="ghost" width="100%">
                      <HStack gap={1.5} vAlign="center">
                        <StatusDot variant="accent" label="" isPulsing={!reduced} />
                        <Text color="secondary">{progressPhrase(stages, model)}…</Text>
                      </HStack>
                    </ChatMessageBubble>
                  ) : null}

                  {prose.ordered.length > 0 ? (
                    <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.turnBlock}>
                      <List
                        density="compact"
                        header={
                          <Text type="code" size="xsm" color="secondary">
                            References
                          </Text>
                        }
                      >
                        {prose.ordered.map((atom) => (
                          <ListItem
                            key={atom.id}
                            label={atom.title}
                            onClick={() => onFocusNode(atom.id)}
                            xstyle={styles.gutterPull}
                            /*
                             * The node-type swatch rides in front of the title
                             * it colours. It used to sit in `endContent`, which
                             * pins it to the row's trailing edge — a quarter of
                             * a screen from its own label at this rail width,
                             * where it read as a column of its own rather than
                             * as this note's colour on the canvas.
                             */
                            startContent={
                              <HStack gap={1.5} vAlign="center">
                                <Citation
                                  variant="number"
                                  number={prose.numbers.get(atom.id)!}
                                  source={{ title: atom.title }}
                                />
                                <Icon
                                  icon={DotGlyph}
                                  size="xsm"
                                  xstyle={styles.ink(typeColor(atom.type, dark))}
                                />
                              </HStack>
                            }
                          />
                        ))}
                      </List>
                    </ChatMessageBubble>
                  ) : null}

                  {notice ? (
                    <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.turnBlock}>
                      <Banner
                        status="info"
                        title={
                          notice.code === "model_not_configured"
                            ? "No model configured"
                            : "Nothing retrieved"
                        }
                        description={notice.message}
                      />
                    </ChatMessageBubble>
                  ) : null}

                  {failure ? (
                    <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.turnBlock}>
                      <Banner
                        status="error"
                        title={finish === "dropped" ? "Connection closed" : "Graph chat failed"}
                        description={failure}
                      />
                    </ChatMessageBubble>
                  ) : null}

                  {pack && pack.length > 0 ? (
                    <ChatMessageBubble
                      variant="ghost"
                      width="100%"
                      xstyle={[styles.turnBlock, arrival]}
                    >
                      <ProvenanceStrip
                        atoms={pack}
                        citedIds={citedIds}
                        lastWritten={lastWritten}
                        dark={dark}
                      />
                    </ChatMessageBubble>
                  ) : null}

                  {/*
                    * One group: the notes the answer leaned on. What recall
                    * reached for and did not cite used to sit under it in a
                    * second group, and it is gone — the count of everything
                    * retrieval packed is already in the stage list, as
                    * `packed · N atoms`, and every node retrieval touched is
                    * still lit on the canvas. The caption is ours —
                    * ChatToolCalls accepts a `label` but v0.5.2 destructures it
                    * and never renders it, so the group's own header always
                    * reads "N tool calls". Collapsed, that header is the last
                    * row plus a wrench and the count, which is why the caption
                    * above it carries the count too.
                    */}
                  {cited.length > 0 ? (
                    <ChatMessageBubble
                      variant="ghost"
                      width="100%"
                      xstyle={[styles.turnBlock, arrival]}
                    >
                      <VStack gap={0.5}>
                        <Text type="code" size="xsm" color="secondary">
                          Cited · {cited.length}
                        </Text>
                        <ChatToolCalls
                          calls={cited.map(toolCall)}
                          isExpanded={toolsExpanded}
                          onExpandedChange={setToolsExpanded}
                        />
                      </VStack>
                    </ChatMessageBubble>
                  ) : null}

                  {finish === "no_results" && pack?.length === 0 ? (
                    <ChatMessageBubble variant="ghost" width="100%" xstyle={styles.turnBlock}>
                      <Text color="secondary">
                        The graph stayed dark because retrieval returned nothing — no node in it
                        matched, lexically or semantically.
                      </Text>
                    </ChatMessageBubble>
                  ) : null}
                </ChatMessage>
              </ChatMessageList>
            ) : null}
          </ChatLayout>
        </StackItem>
      </VStack>
    </Theme>
  );
}
