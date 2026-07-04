import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import ForceGraph2D from "react-force-graph-2d";
import { Skeleton } from "@/components/ui/skeleton";
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

// Imported summaries carry raw markdown; render them as clean prose.
function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ?? target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// Render a vault document the way Obsidian would: frontmatter stripped,
// wikilinks flattened to their labels, markdown to sanitized HTML.
function renderDocument(markdown: string): string {
  const withoutFrontmatter = markdown.startsWith("---\n")
    ? markdown.slice(markdown.indexOf("\n---", 4) + 4)
    : markdown;
  const withLinks = withoutFrontmatter.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target, alias) => alias ?? target,
  );
  const html = marked.parse(withLinks, { async: false }) as string;
  return DOMPurify.sanitize(html);
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
        else setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query]);

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
        const sourceId =
          result.node.annotations.find((annotation) => annotation.sourceId)?.sourceId ??
          result.node.evidence.flatMap((item) => ("sourceId" in item ? [item.sourceId] : []))[0] ??
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
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={() => ""}
          linkLabel={(link: VizLink) => link.predicate}
          linkColor={() => linkInk}
          linkWidth={1}
          linkDirectionalArrowLength={2.5}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={120}
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
            const dimmed =
              (focusType !== null && node.type !== focusType) ||
              (selectedId !== null && !isSelected && !isNeighbor);
            ctx.globalAlpha = dimmed ? 0.12 : 1;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
            ctx.fillStyle = typeColor(node.type, dark);
            ctx.fill();
            if (isSelected) {
              ctx.lineWidth = 1.5 / globalScale;
              ctx.strokeStyle = ink;
              ctx.stroke();
            }
            const showLabel =
              !dimmed &&
              (isSelected ||
                node.id === hoverId ||
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

      <div className="absolute left-4 top-4 w-80">
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
      </div>

      <div className="absolute bottom-4 left-4 rounded-lg border bg-card p-3">
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
        <div className="absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-80 flex-col rounded-lg border bg-card p-4">
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
