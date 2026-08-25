import { useMemo, useRef, useState, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { NodeType } from "@/lib/api";
import { typeColor } from "@/lib/viz";
import { LINKS, SEEDS, degreeOf, seedById, type Seed } from "@/lib/seed-graph";

/** Legend labels — "entity" reads as "source" here, because that is the story. */
const TYPE_LABEL: Partial<Record<NodeType, string>> = {
  project: "project",
  infrastructure: "infra",
  decision: "decision",
  pattern: "pattern",
  claim: "claim",
  entity: "source",
  person: "person",
};

const LEGEND_TYPES = ["project", "decision", "claim", "pattern", "source", "person"] as const;
const LEGEND_COLOR: Record<(typeof LEGEND_TYPES)[number], string> = {
  project: typeColor("project", true),
  decision: typeColor("decision", true),
  claim: typeColor("claim", true),
  pattern: typeColor("pattern", true),
  source: typeColor("entity", true),
  person: typeColor("person", true),
};

/**
 * The dashboard's own force graph, on seeded data — now inspectable.
 *
 * Same renderer as the explorer (`ForceGraph2D`, shared `typeColor`, degree-scaled
 * radii), so what the page shows is what the product draws. Click a node and the
 * evidence card opens its source; that interaction is the section's headline
 * made literal. Lazy-loaded: the library is too heavy for the landing bundle.
 */
export default function MiniGraph({ className = "" }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Matches GraphView: the library's exposed methods aren't usefully typed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const fitted = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of LINKS) {
      if (!map.has(link.source)) map.set(link.source, new Set());
      if (!map.has(link.target)) map.set(link.target, new Set());
      map.get(link.source)!.add(link.target);
      map.get(link.target)!.add(link.source);
    }
    return map;
  }, []);

  // Stable identity: a fresh object per render would reheat the simulation on
  // every hover/selection change, and the nodes would jump out from under clicks.
  const data = useMemo(
    () => ({
      nodes: SEEDS.map((seed) => ({ ...seed, degree: degreeOf(seed.id) })),
      links: LINKS.map((link) => ({ ...link })),
    }),
    [],
  );

  const selected = selectedId ? seedById.get(selectedId) : undefined;

  /** Dimming pass: when hovering, only the node and its neighbours stay lit. */
  const nodeAlpha = (id: string, retired: boolean) => {
    const base = retired ? 0.45 : 1;
    if (!hoverId) return base;
    return id === hoverId || neighbors.get(hoverId)?.has(id) ? base : 0.12;
  };

  const linkState = (link: { source: unknown; target: unknown; predicate: string }) => {
    const sourceId = typeof link.source === "object" ? (link.source as Seed).id : String(link.source);
    const targetId = typeof link.target === "object" ? (link.target as Seed).id : String(link.target);
    const connected = hoverId != null && (sourceId === hoverId || targetId === hoverId);
    if (link.predicate === "supersedes") return { color: "rgba(242, 196, 107, 0.55)", width: 1.2, dash: [4, 3] as number[] };
    if (hoverId && !connected) return { color: "rgba(237, 235, 228, 0.04)", width: 1, dash: [] };
    if (connected) return { color: "rgba(237, 235, 228, 0.5)", width: 1.4, dash: [] };
    return { color: "rgba(237, 235, 228, 0.16)", width: 1, dash: [] };
  };

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className}`}>
      {size.width > 0 && (
        <ForceGraph2D
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={(node) => (node as Seed).title}
          linkLabel={(link: { predicate: string }) => link.predicate}
          linkColor={(link) => linkState(link as { source: unknown; target: unknown; predicate: string }).color}
          linkWidth={(link) => linkState(link as { source: unknown; target: unknown; predicate: string }).width}
          linkLineDash={(link) => linkState(link as { source: unknown; target: unknown; predicate: string }).dash}
          linkDirectionalArrowLength={2.5}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={90}
          enableZoomInteraction={false}
          onNodeHover={(node) => {
            setHoverId(node ? (node as Seed).id : null);
            if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "";
          }}
          onNodeClick={(node) => setSelectedId((current) => (current === (node as Seed).id ? null : (node as Seed).id))}
          onBackgroundClick={() => setSelectedId(null)}
          onEngineStop={() => {
            if (fitted.current || !graphRef.current) return;
            fitted.current = true;
            graphRef.current.zoomToFit(600, 48);
          }}
          nodeCanvasObject={(rawNode, ctx, globalScale) => {
            const node = rawNode as Seed & { degree: number; x?: number; y?: number };
            const retired = Boolean(node.retiredBy);
            const alpha = nodeAlpha(node.id, retired);
            const radius = 2.5 + Math.sqrt(node.degree + 1) * 1.3;

            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
            ctx.fillStyle = typeColor(node.type, true);
            ctx.fill();

            if (node.id === selectedId) {
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius + 3 / globalScale, 0, 2 * Math.PI);
              ctx.strokeStyle = "rgba(242, 196, 107, 0.9)";
              ctx.lineWidth = 1 / globalScale;
              ctx.stroke();
            }

            const label = node.title.length > 26 ? `${node.title.slice(0, 24)}…` : node.title;
            const fontSize = 10 / globalScale;
            ctx.font = `${fontSize}px "Geist Variable", system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const labelY = (node.y ?? 0) + radius + 2.5 / globalScale;
            ctx.fillStyle = retired ? "rgba(237, 235, 228, 0.5)" : "rgba(237, 235, 228, 0.72)";
            ctx.fillText(label, node.x ?? 0, labelY);

            if (retired) {
              // Retired, not deleted: the label carries the strike on the record.
              const width = ctx.measureText(label).width;
              const strikeY = labelY + fontSize * 0.55;
              ctx.beginPath();
              ctx.moveTo((node.x ?? 0) - width / 2, strikeY);
              ctx.lineTo((node.x ?? 0) + width / 2, strikeY);
              ctx.strokeStyle = "rgba(242, 196, 107, 0.6)";
              ctx.lineWidth = 0.8 / globalScale;
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }}
        />
      )}

      {/* Type legend — teaches the model without leaving the demo. */}
      <div className="pointer-events-none absolute right-4 top-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {LEGEND_TYPES.map((type) => (
          <span key={type} className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            <span className="size-1.5 rounded-full" style={{ background: LEGEND_COLOR[type] }} />
            {type}
          </span>
        ))}
      </div>

      {/* The evidence card: the section's promise, working. */}
      <div className="absolute bottom-4 left-4 max-w-[17rem] rounded-md border bg-[var(--card)]/90 px-3.5 py-3 backdrop-blur">
        {selected ? (
          <>
            <p className="font-mono text-[9px] uppercase tracking-[0.1em]" style={{ color: typeColor(selected.type, true) }}>
              {TYPE_LABEL[selected.type] ?? selected.type}
              {selected.retiredBy && <span className="text-muted-foreground"> · retired</span>}
            </p>
            <p className={`mt-1.5 text-[13px] font-medium leading-snug ${selected.retiredBy ? "superseded-line" : ""}`}>
              {selected.title}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{selected.detail}</p>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              {selected.source && (
                <>
                  <span className="text-[var(--signal)]">←</span> {selected.source}
                </>
              )}
              {selected.retiredBy && (
                <>
                  {selected.source && <span className="mx-2 text-border">·</span>}
                  superseded by <span className="text-foreground/80">{selected.retiredBy}</span>
                </>
              )}
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--signal)]">Inspect</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Click a node — every memory opens the source text that earned it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
