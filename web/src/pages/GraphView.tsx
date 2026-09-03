import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide, forceX, forceY } from "d3-force-3d";
import { useResizable } from "@astryxdesign/core/Resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { GraphChat, RetrievalHud, type Stage } from "@/components/GraphChat";
import {
  highlightInk,
  usePrefersReducedMotion,
  type ChatHighlights,
} from "@/lib/graphChatState";
import { plainText, renderDocument } from "@/lib/markdown";
import { typeColor } from "@/lib/viz";
import {
  fetchDocument,
  fetchNode,
  fetchSource,
  type GraphSnapshot,
  type NodeDetail,
  type NodeType,
  type SourceDocument,
} from "@/lib/api";

type VizNode = {
  id: string;
  title: string;
  type: NodeType;
  slug: string;
  accessCount: number;
  degree: number;
  x?: number;
  y?: number;
};

type VizLink = {
  source: string | VizNode;
  target: string | VizNode;
  predicate: string;
};

/** Click-to-copy node id, shown in the node card and document reader. */
function NodeIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy node id"
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="mt-1.5 flex max-w-full items-center gap-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="shrink-0 uppercase tracking-[0.08em]">id</span>
      <span className="truncate">{id}</span>
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </button>
  );
}

export function GraphView({ snapshot, dark }: { snapshot: GraphSnapshot | null; dark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const didFitRef = useRef(false);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusType, setFocusType] = useState<NodeType | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // null: the chat is not driving the graph. A Map (even an empty one): it is,
  // so every node NOT in it is dimmed and every node in it wears its state.
  const [highlights, setHighlights] = useState<ChatHighlights>(null);
  // The retrieval stages live in the chat but are drawn over the canvas, so
  // they come back up here on their way to the HUD.
  const [chatStages, setChatStages] = useState<Stage[]>([]);
  const reducedMotion = usePrefersReducedMotion();

  /**
   * The chat rail. The graph is the canvas and this is the companion beside it,
   * so it starts narrow and the reader can trade one for the other; the width
   * it settles on is what the canvas is sized against and what the camera
   * subtracts when it centres a pack.
   */
  const rail = useResizable({
    defaultSize: 380,
    minSizePx: 320,
    maxSizePx: 560,
    autoSaveId: "trove:graph-chat-rail",
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        if (query) setQuery("");
        else if (selectedId) setSelectedId(null);
        else if (chatOpen) setChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, selectedId, chatOpen]);

  const data = useMemo(() => {
    if (!snapshot) return { nodes: [] as VizNode[], links: [] as VizLink[] };
    const degree = new Map<string, number>();
    for (const edge of snapshot.edges) {
      degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
      degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
    }
    return {
      nodes: snapshot.nodes.map((node): VizNode => ({
        id: node.id,
        title: node.title,
        type: node.type,
        slug: node.slug,
        accessCount: node.accessCount,
        degree: degree.get(node.id) ?? 0,
      })),
      links: snapshot.edges.map((edge) => ({
        source: edge.fromNodeId,
        target: edge.toNodeId,
        predicate: edge.predicate,
      })),
    };
  }, [snapshot]);

  // Obsidian-style balance. The library's default forces give a stringy,
  // unevenly-clumped sprawl: hubs fling their leaves into long tendrils and
  // nothing keeps orphans from drifting off. We reshape the simulation into a
  // contained, evenly-spaced disc with four changes — a capped-range charge so
  // repulsion stays local, loose link springs, a collision force for even
  // spacing (the core of the look), and gentle gravity toward the origin so
  // tendrils and orphans stay in the frame.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || data.nodes.length === 0) return;
    const radiusOf = (node: VizNode) => 2.5 + Math.sqrt((node.degree ?? 0) + 1) * 1.3;

    graph
      .d3Force("charge")
      ?.strength((node: VizNode) => -(40 + (node.degree ?? 0) * 5))
      .distanceMax(300)
      .theta(0.9);
    graph.d3Force("link")?.distance(42).strength(0.4);
    graph.d3Force(
      "collide",
      forceCollide().radius((node: VizNode) => radiusOf(node) + 6).strength(0.9).iterations(2),
    );
    graph.d3Force("x", forceX(0).strength(0.05));
    graph.d3Force("y", forceY(0).strength(0.05));

    // Re-shape from the new forces, and let onEngineStop refit to the result.
    didFitRef.current = false;
    graph.d3ReheatSimulation();
  }, [data]);

  // Opening or closing the chat changes the canvas box, and whatever the camera
  // was framing before is now half off the edge. Re-fit the connected core so
  // the graph still reads; the pack's own fit takes over from there.
  const didMountChat = useRef(false);
  useEffect(() => {
    if (!didMountChat.current) {
      didMountChat.current = true;
      return;
    }
    const graph = graphRef.current;
    if (!graph || data.nodes.length === 0) return;
    const timer = window.setTimeout(
      () => graph.zoomToFit(reducedMotion ? 0 : 400, 60, (node: VizNode) => node.degree > 0),
      60,
    );
    return () => window.clearTimeout(timer);
  // Deliberately keyed on chatOpen alone: a data change has its own fit path
  // (didFitRef + onEngineStop), and adding it here would fire this one before
  // the simulation has laid anything out.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  const nodeById = useMemo(() => new Map(data.nodes.map((node) => [node.id, node])), [data]);
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  useEffect(() => {
    setDetail(null);
    setDocument(null);
    setDocOpen(false);
    if (!selectedId) return;
    let cancelled = false;
    fetchNode(selectedId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        // Newest evidence wins: after a rename/re-import the latest annotation
        // points at the current document, older ones at historical snapshots.
        const sourceId =
          [...result.node.annotations].reverse().find((annotation) => annotation.sourceId)?.sourceId ??
          result.node.evidence.flatMap((item) => ("sourceId" in item ? [item.sourceId] : [])).at(-1) ??
          null;
        if (sourceId) {
          fetchSource(sourceId)
            .then(async (doc) => {
              // A source can be one episode of a logical file, or a stale
              // whole-file snapshot; /v1/document returns the freshest
              // reconstruction either way (episodes first, snapshot fallback).
              const episodeOf = doc.metadata?.episodeOf;
              const logicalUri = typeof episodeOf === "string" ? episodeOf : doc.uri;
              if (logicalUri) {
                try {
                  const full = await fetchDocument(logicalUri);
                  if (!cancelled) {
                    setDocument({ ...doc, uri: full.uri, contentText: full.contentText });
                  }
                  return;
                } catch {
                  // fall through to the raw source
                }
              }
              if (!cancelled) setDocument(doc);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedEdges = useMemo(() => {
    if (!snapshot || !selectedId) return [];
    return snapshot.edges
      .filter((edge) => edge.fromNodeId === selectedId || edge.toNodeId === selectedId)
      .map((edge) => {
        const otherId = edge.fromNodeId === selectedId ? edge.toNodeId : edge.fromNodeId;
        return {
          id: edge.id,
          predicate: edge.predicate,
          outbound: edge.fromNodeId === selectedId,
          other: nodeById.get(otherId) ?? null,
        };
      })
      .filter((row) => row.other !== null);
  }, [snapshot, selectedId, nodeById]);

  const neighborIds = useMemo(
    () => new Set(selectedEdges.map((edge) => edge.other!.id)),
    [selectedEdges],
  );

  const typeCounts = useMemo(() => {
    const counts = new Map<NodeType, number>();
    for (const node of data.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [data]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return data.nodes
      .filter((node) => node.title.toLowerCase().includes(needle) || node.slug.includes(needle))
      .sort((left, right) => right.degree - left.degree)
      .slice(0, 8);
  }, [query, data]);

  useEffect(() => setActiveMatch(0), [query]);

  const focusNode = useCallback(
    (node: VizNode) => {
      setSelectedId(node.id);
      setQuery("");
      searchRef.current?.blur();
      const live = nodeById.get(node.id);
      if (graphRef.current && live && live.x !== undefined && live.y !== undefined) {
        graphRef.current.centerAt(live.x, live.y, 600);
        graphRef.current.zoom(3.2, 600);
      }
    },
    [nodeById],
  );

  const onSearchKey = (event: React.KeyboardEvent) => {
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveMatch((current) => (current + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveMatch((current) => (current - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const match = matches[activeMatch];
      if (match) focusNode(match);
    }
  };

  const ink = dark ? "#f5f5f2" : "#111111";
  const linkInk = dark ? "rgba(255,255,255,0.14)" : "rgba(17,17,17,0.12)";
  // While the chat drives the graph, edges between two lit nodes stay drawn and
  // the rest recede: the traversal's own path is the thing worth seeing.
  const litLinkInk = dark ? "rgba(255,255,255,0.34)" : "rgba(17,17,17,0.30)";
  const coldLinkInk = dark ? "rgba(255,255,255,0.05)" : "rgba(17,17,17,0.04)";
  const chatting = highlights !== null;
  // A container query in spirit: the chat docks to the side when there is room
  // for a graph beside it, and to the bottom when there is not.
  const narrow = size.width < 720;
  /** What the rail is currently taking from the canvas, or nothing when closed. */
  const railPx = chatOpen && !narrow ? rail.size : 0;
  /**
   * How much of the canvas the HUD covers from the bottom edge. The camera
   * frames the pack in the band above it, so the readout never lands on the
   * cluster it is describing. Roughly `styles.hud` at eight stages.
   */
  const HUD_HEIGHT_PX = 300;
  const hudOpen = chatOpen && !narrow && chatStages.length > 0;
  /**
   * Ceiling for the post-pack camera. Close enough to read the labels, far
   * enough that the dark graph around the lit nodes is still on screen.
   */
  const MAX_PACK_ZOOM = 1.6;
  // How long a newly-lit node keeps its arrival ring. Long enough to notice on
  // a fast local recall, short enough that a 30-node pack is not a light show.
  const PULSE_MS = 900;
  const detailNode = detail?.node;
  const summary = detailNode?.summary ?? snapshot?.nodes.find((n) => n.id === selectedId)?.summary ?? null;
  const evidenceTexts = (detailNode?.evidence ?? [])
    .flatMap((item) => ("text" in item ? [item.text] : []))
    .filter((text) => text.trim().length > 3 && !/^-+$/.test(text.trim()));

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {snapshot ? (
        <ForceGraph2D
          ref={graphRef}
          // The chat takes real estate rather than floating over it. Handing
          // the canvas the reduced box is what makes zoomToFit land the lit
          // nodes where they can be seen instead of centring them under the
          // panel — and it keeps hit-testing honest at the same time.
          width={Math.max(240, size.width - railPx)}
          height={chatOpen && narrow ? Math.round(size.height * 0.38) : size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={() => ""}
          linkLabel={(link: VizLink) => link.predicate}
          linkColor={(link: VizLink) => {
            if (!highlights) return linkInk;
            const from = typeof link.source === "string" ? link.source : link.source.id;
            const to = typeof link.target === "string" ? link.target : link.target.id;
            return highlights.has(from) && highlights.has(to) ? litLinkInk : coldLinkInk;
          }}
          linkWidth={1}
          linkDirectionalArrowLength={2.5}
          linkDirectionalArrowRelPos={1}
          d3VelocityDecay={0.45}
          cooldownTicks={140}
          onEngineStop={() => {
            if (!didFitRef.current && graphRef.current) {
              didFitRef.current = true;
              // Fit the connected core; disconnected orphans drift far out and
              // would otherwise shrink the whole graph to a dot.
              graphRef.current.zoomToFit(500, 60, (node: VizNode) => node.degree > 0);
            }
          }}
          onNodeClick={(node) => focusNode(node as VizNode)}
          onNodeHover={(node) => setHoverId(node ? (node as VizNode).id : null)}
          onBackgroundClick={() => setSelectedId(null)}
          nodeCanvasObject={(rawNode, ctx, globalScale) => {
            const node = rawNode as VizNode;
            const radius = 2.5 + Math.sqrt(node.degree + 1) * 1.3;
            const isSelected = node.id === selectedId;
            const isNeighbor = neighborIds.has(node.id);
            // A chat turn dims everything retrieval has not touched. It layers
            // on top of the existing type-focus and selection dimming rather
            // than replacing either.
            const lit = highlights?.get(node.id);
            const dimmed =
              (focusType !== null && node.type !== focusType) ||
              (selectedId !== null && !isSelected && !isNeighbor) ||
              (chatting && !lit);
            ctx.globalAlpha = dimmed ? (chatting && !lit ? 0.07 : 0.12) : 1;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
            ctx.fillStyle = typeColor(node.type, dark);
            ctx.fill();
            if (lit && !dimmed) {
              // The ring carries the retrieval state; the fill keeps carrying
              // the node's type, so the graph never stops being itself.
              const stateInk = highlightInk(lit.state, dark);
              if (lit.state === "cited") {
                // A ring alone cannot mark a cited node: the accent collides
                // with the amber the "pattern" type already owns. The halo is
                // a shape difference, legible over any fill.
                ctx.globalAlpha = 0.22;
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, radius + 6 / globalScale, 0, 2 * Math.PI);
                ctx.fillStyle = stateInk;
                ctx.fill();
                ctx.globalAlpha = 1;
              }
              ctx.lineWidth = (lit.state === "cited" ? 2.4 : lit.state === "packed" ? 1.8 : 1.2) / globalScale;
              ctx.strokeStyle = stateInk;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius + 2 / globalScale, 0, 2 * Math.PI);
              ctx.stroke();
              // The arrival pulse marks WHEN this node was touched. Reduced
              // motion drops the animation; the state colour still changes.
              const age = performance.now() - lit.at;
              if (!reducedMotion && age < PULSE_MS) {
                const progress = age / PULSE_MS;
                ctx.globalAlpha = (1 - progress) * 0.55;
                ctx.lineWidth = 1.4 / globalScale;
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, radius + (2 + progress * 9) / globalScale, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.globalAlpha = 1;
              }
            }
            if (isSelected) {
              ctx.lineWidth = 1.5 / globalScale;
              ctx.strokeStyle = ink;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
              ctx.stroke();
            }
            const showLabel =
              !dimmed &&
              (isSelected ||
                node.id === hoverId ||
                // Anything the answer leaned on is named without a hover: the
                // point of the run is to read which notes were used.
                (lit?.state === "cited" || lit?.state === "packed") ||
                (isNeighbor && globalScale > 1.2) ||
                globalScale > 2.4 ||
                (node.degree >= 12 && globalScale > 1.1));
            if (showLabel) {
              const label = node.title.length > 34 ? `${node.title.slice(0, 32)}…` : node.title;
              ctx.font = `${11 / globalScale}px "SF Pro Display", system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = ink;
              ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + radius + 2 / globalScale);
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(rawNode, color, ctx) => {
            const node = rawNode as VizNode;
            const radius = 2.5 + Math.sqrt(node.degree + 1) * 1.3;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius + 3, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading graph…
        </div>
      )}

      {/* At 375px the chat takes the bottom two thirds; the floating search
          card would then cover most of what is left of the graph. */}
      <div className={`absolute left-4 top-4 w-80 ${chatOpen && narrow ? "hidden" : ""}`}>
        <div className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 px-3">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search memories"
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground">
              ⌘K
            </kbd>
          </div>
          {matches.length > 0 ? (
            <div className="border-t p-1.5">
              {matches.map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => focusNode(node)}
                  onMouseEnter={() => setActiveMatch(index)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${
                    index === activeMatch ? "bg-muted" : ""
                  }`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: typeColor(node.type, dark) }}
                    aria-hidden
                  />
                  <span className="truncate text-[13px]">{node.title}</span>
                  <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground">
                    {node.type}
                  </span>
                </button>
              ))}
              <p className="border-t px-2 pb-1 pt-1.5 font-mono text-[10px] text-muted-foreground">
                {matches.length} of {data.nodes.length} · Enter to open
              </p>
            </div>
          ) : query.trim().length >= 2 ? (
            <p className="border-t px-3 py-2 text-[13px] text-muted-foreground">No matches.</p>
          ) : null}
        </div>
        {chatOpen ? null : (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="mt-2 flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted"
          >
            <span>Ask the graph</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              watch it retrieve →
            </span>
          </button>
        )}
      </div>

      {hudOpen ? (
        // The metrics, over the canvas rather than in the rail: they describe
        // what is happening on the graph, so they belong on the graph. Pinned
        // bottom-right — top-left is the search, top-right the node card,
        // bottom-left the type legend — and the camera above keeps the lit
        // cluster out from under it.
        <div
          className="pointer-events-none absolute bottom-4 z-30"
          style={{ right: railPx + 16 }}
        >
          <RetrievalHud
            stages={chatStages}
            // The receipt is closed when the `done` row lands, so that is when
            // the HUD stops saying it is still working.
            running={!chatStages.some((stage) => stage.key === "done")}
            dark={dark}
          />
        </div>
      ) : null}

      {chatOpen ? (
        <aside
          aria-label="Ask the graph"
          // The panel's frame is the canvas's business, not the panel's: it is
          // the canvas that is giving up the room. A narrow rail beside the
          // canvas where there is width for both, and a sheet stacked under a
          // shortened canvas where there is not. Everything inside the aside is
          // Astryx; the aside itself is not.
          className={
            narrow
              ? "absolute inset-x-0 bottom-0 z-20 h-[62%] border-t"
              : "absolute inset-y-0 right-0 z-20 border-l"
          }
          style={narrow ? undefined : { width: rail.size }}
        >
          <GraphChat
            dark={dark}
            narrow={narrow}
            resizable={rail.props}
            onStages={setChatStages}
            onHighlights={setHighlights}
            onFocusNode={(nodeId) => {
              const node = nodeById.get(nodeId);
              if (node) focusNode(node);
            }}
            onPacked={(nodeIds) => {
              // Bring the crawl into frame once the pack is settled. Without it
              // the lit nodes sit wherever the layout put them — often off-screen
              // once the panel takes a third of a wide viewport, and nearly
              // always so at 375px. One move per turn; pan and zoom stay the
              // viewer's from here on.
              //
              // Not zoomToFit: fitting six nodes fills the canvas with six nodes
              // and the dimmed graph they were pulled out of disappears, which is
              // the context that makes the demonstration mean anything. Centre on
              // them, and clamp how close the camera is allowed to get.
              const graph = graphRef.current;
              if (!graph || nodeIds.length === 0) return;
              const packed = new Set(nodeIds);
              const placed = data.nodes.filter(
                (node) => packed.has(node.id) && node.x !== undefined && node.y !== undefined,
              );
              if (placed.length === 0) return;
              const xs = placed.map((node) => node.x as number);
              const ys = placed.map((node) => node.y as number);
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const minY = Math.min(...ys);
              const maxY = Math.max(...ys);
              const canvasWidth = Math.max(240, size.width - railPx);
              const canvasHeight = chatOpen && narrow ? Math.round(size.height * 0.38) : size.height;
              // The HUD sits in the bottom-right corner of the canvas, so the
              // pack is framed in the band above it and then lifted by half
              // that band — the readout never lands on the cluster it reads.
              const hudInset = hudOpen ? HUD_HEIGHT_PX : 0;
              const usableHeight = Math.max(160, canvasHeight - hudInset);
              const pad = 80;
              const zoom = Math.min(
                MAX_PACK_ZOOM,
                Math.max(0.2, (canvasWidth - pad * 2) / Math.max(40, maxX - minX)),
                Math.max(0.2, (usableHeight - pad * 2) / Math.max(40, maxY - minY)),
              );
              const ms = reducedMotion ? 0 : 600;
              graph.centerAt((minX + maxX) / 2, (minY + maxY) / 2 + hudInset / 2 / zoom, ms);
              graph.zoom(zoom, ms);
            }}
            onClose={() => {
              setChatOpen(false);
              setHighlights(null);
              setChatStages([]);
            }}
          />
        </aside>
      ) : null}

      <div
        className={`absolute bottom-4 left-4 rounded-lg border bg-card p-3 ${
          chatOpen && narrow ? "hidden" : ""
        }`}
      >
        <p className="pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Node types
        </p>
        <div className="flex flex-col gap-0.5">
          {typeCounts.map(([type, count]) => (
            <button
              key={type}
              type="button"
              onClick={() => setFocusType(focusType === type ? null : type)}
              className={`flex items-center gap-2 rounded-sm px-1 py-0.5 text-left text-xs transition-opacity hover:bg-muted ${
                focusType !== null && focusType !== type ? "opacity-40" : ""
              }`}
            >
              <span className="size-2 rounded-full" style={{ background: typeColor(type, dark) }} aria-hidden />
              <span className="text-foreground">{type}</span>
              <span className="ml-auto pl-4 font-mono tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {selected && !docOpen ? (
        <div
          className="absolute top-4 flex max-h-[calc(100%-2rem)] w-80 flex-col rounded-lg border bg-card p-4"
          // The chat docks to the right edge on a wide viewport, so the node
          // card steps aside rather than hiding under it.
          style={{ right: railPx > 0 ? railPx + 16 : 16 }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              <span
                className="size-2 rounded-full"
                style={{ background: typeColor(selected.type, dark) }}
                aria-hidden
              />
              {selected.type}
            </p>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="Close panel"
              className="rounded-md px-1.5 text-lg leading-none text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
          <h2 className="mt-1 font-serif text-lg leading-snug">{selected.title}</h2>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            {selected.degree} connections · recalled{" "}
            {detailNode ? detailNode.accessCount : selected.accessCount}x
          </p>
          <NodeIdChip id={selected.id} />
          {!detail ? (
            <div className="mt-3 flex flex-col gap-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          ) : summary ? (
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{plainText(summary)}</p>
          ) : evidenceTexts[0] ? (
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              {plainText(evidenceTexts[0]).slice(0, 280)}
            </p>
          ) : null}
          {document ? (
            <button
              type="button"
              onClick={() => setDocOpen(true)}
              className="mt-3 w-full rounded-md border px-3 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
            >
              Open document
              <span className="float-right font-mono text-[10px] text-muted-foreground">
                {Math.max(1, Math.round(document.contentText.length / 1000))}k chars
              </span>
            </button>
          ) : null}
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
            {selectedEdges.map((edge) => (
              <button
                key={edge.id}
                type="button"
                onClick={() => edge.other && focusNode(edge.other as VizNode)}
                className="flex w-full items-baseline gap-2 rounded-sm px-1 py-1 text-left hover:bg-muted"
                title={edge.other?.title}
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {edge.outbound ? "→" : "←"} {edge.predicate}
                </span>
                <span className="truncate text-[13px]">{edge.other?.title}</span>
              </button>
            ))}
            {selectedEdges.length === 0 ? (
              <p className="px-1 py-1 text-[13px] text-muted-foreground">No connections yet.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {selected && docOpen && document ? (
        <aside className="absolute inset-y-0 right-0 flex w-[28rem] max-w-full flex-col border-l bg-card">
          <header className="border-b px-5 pb-4 pt-4">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setDocOpen(false)}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Close panel"
                className="rounded-md px-1.5 text-lg leading-none text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </div>
            <h2 className="mt-2 font-serif text-xl leading-snug">{selected.title}</h2>
            {document.uri ? (
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{document.uri}</p>
            ) : null}
            <NodeIdChip id={selected.id} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div
              className="doc-prose"
              dangerouslySetInnerHTML={{ __html: renderDocument(document.contentText) }}
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
