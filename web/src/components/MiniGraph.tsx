import { useEffect, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { typeColor } from "@/lib/viz";
import type { NodeType } from "@/lib/api";

type Seed = { id: string; title: string; type: NodeType };

/**
 * A slice of the graph the hero just built, as the dashboard would draw it.
 *
 * Same decisions, now with the evidence and infrastructure hanging off them, so
 * the section shows the real explorer rather than an illustration of one.
 */
const SEEDS: Seed[] = [
  { id: "trove", title: "trove", type: "project" },
  { id: "postgres", title: "Postgres 16 + pgvector", type: "infrastructure" },
  { id: "railway", title: "Moved to Railway", type: "decision" },
  { id: "fly", title: "Deploys go to Fly.io", type: "decision" },
  { id: "node-test", title: "Moved to node:test", type: "decision" },
  { id: "vitest", title: "Tests run on Vitest", type: "decision" },
  { id: "clerk", title: "Clerk owns auth", type: "decision" },
  { id: "keys", title: "Keys in .env, never in git", type: "pattern" },
  { id: "hnsw", title: "HNSW index still off", type: "claim" },
  { id: "recall", title: "recall falls back to lexical", type: "claim" },
  { id: "railway-json", title: "railway.json", type: "entity" },
  { id: "schema-sql", title: "db/schema.sql", type: "entity" },
  { id: "adr-003", title: "adr-003.md", type: "entity" },
  { id: "pr-12", title: "pr-12.md", type: "entity" },
  { id: "anunay", title: "Anunay", type: "person" },
];

const LINKS: { source: string; target: string; predicate: string }[] = [
  { source: "postgres", target: "trove", predicate: "runs on" },
  { source: "railway", target: "trove", predicate: "decides" },
  { source: "railway", target: "fly", predicate: "supersedes" },
  { source: "railway", target: "postgres", predicate: "because of" },
  { source: "railway-json", target: "railway", predicate: "evidence for" },
  { source: "node-test", target: "vitest", predicate: "supersedes" },
  { source: "node-test", target: "trove", predicate: "decides" },
  { source: "pr-12", target: "node-test", predicate: "evidence for" },
  { source: "clerk", target: "trove", predicate: "decides" },
  { source: "adr-003", target: "clerk", predicate: "evidence for" },
  { source: "keys", target: "clerk", predicate: "relates to" },
  { source: "hnsw", target: "postgres", predicate: "about" },
  { source: "schema-sql", target: "hnsw", predicate: "evidence for" },
  { source: "recall", target: "hnsw", predicate: "caused by" },
  { source: "anunay", target: "trove", predicate: "owns" },
  { source: "anunay", target: "railway", predicate: "decided" },
];

const degreeOf = (id: string) => LINKS.filter((l) => l.source === id || l.target === id).length;

/**
 * The dashboard's own force graph, on seeded data.
 *
 * Deliberately the same renderer as the explorer — `ForceGraph2D` with the shared
 * `typeColor` scale and degree-scaled radii — so what the page shows is what the
 * product draws. It is lazy-loaded: the library is far too heavy to sit in the
 * landing's initial bundle.
 */
export default function MiniGraph({ className = "" }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Matches GraphView: the library's exposed methods aren't usefully typed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const fitted = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const data = {
    nodes: SEEDS.map((seed) => ({ ...seed, degree: degreeOf(seed.id) })),
    links: LINKS.map((link) => ({ ...link })),
  };

  return (
    <div ref={containerRef} className={`h-full w-full ${className}`}>
      {size.width > 0 && (
        <ForceGraph2D
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={() => ""}
          linkLabel={(link: { predicate: string }) => link.predicate}
          linkColor={() => "rgba(237, 235, 228, 0.16)"}
          linkWidth={1}
          linkDirectionalArrowLength={2.5}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={90}
          enableZoomInteraction={false}
          onEngineStop={() => {
            if (fitted.current || !graphRef.current) return;
            fitted.current = true;
            graphRef.current.zoomToFit(600, 48);
          }}
          nodeCanvasObject={(rawNode, ctx, globalScale) => {
            const node = rawNode as Seed & { degree: number; x?: number; y?: number };
            const radius = 2.5 + Math.sqrt(node.degree + 1) * 1.3;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
            ctx.fillStyle = typeColor(node.type, true);
            ctx.fill();

            const label = node.title.length > 26 ? `${node.title.slice(0, 24)}…` : node.title;
            ctx.font = `${10 / globalScale}px "SF Pro Display", system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(237, 235, 228, 0.72)";
            ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + radius + 2.5 / globalScale);
          }}
        />
      )}
    </div>
  );
}
