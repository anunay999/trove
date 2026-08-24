import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as THREE from "three";
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";
import { LINKS, SEEDS, degreeOf } from "@/lib/seed-graph";
import { typeColor } from "@/lib/viz";

/**
 * The hero's right column: the memory graph itself, alive.
 *
 * The same seed data the inspectable MiniGraph draws, laid out once by a
 * frozen force simulation and rendered as a quiet constellation. One amber
 * pulse at a time travels an edge — a recall pulling evidence toward a
 * memory, or a supersede retiring a belief — while the caption below names
 * the act and cites the source. The graph is the product; the pulse is the
 * product's verb.
 *
 * Perf contract mirrors the rest of the page: frames stop when the hero
 * leaves the viewport or the tab hides, prefers-reduced-motion freezes the
 * constellation, DPR is capped.
 */

const SIGNAL = "#f2c46b"; // the signal amber, brightened for WebGL
const EDGE = "#edebe4";

/* ------------------------------------------------------------------ */
/* Layout: one frozen force simulation, deterministic across loads      */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LayoutNode = { id: string; x: number; y: number; z: number };

function computeLayout(): Map<string, THREE.Vector3> {
  const rand = mulberry32(11);
  const nodes: LayoutNode[] = SEEDS.map((seed) => ({
    id: seed.id,
    x: (rand() - 0.5) * 16,
    y: (rand() - 0.5) * 16,
    z: (rand() - 0.5) * 8,
  }));
  const simulation = forceSimulation(nodes, 3)
    .force(
      "link",
      forceLink(LINKS.map((l) => ({ source: l.source, target: l.target })))
        .id((d) => d.id)
        .distance(4.5)
        .strength(0.55),
    )
    .force("charge", forceManyBody().strength(-22))
    .force("x", forceX(0).strength(0.09))
    .force("y", forceY(0).strength(0.09))
    .force("z", forceZ(0).strength(0.09))
    .stop();
  simulation.tick(300);

  const positions = new Map<string, THREE.Vector3>(
    nodes.map((n) => [n.id, new THREE.Vector3(n.x, n.y, n.z)]),
  );
  // Center on the centroid, compress the radial spread (outliers would
  // otherwise define the radius and shrink the bulk), then normalize to a
  // fixed world radius so the constellation always fills the column.
  const centroid = new THREE.Vector3();
  positions.forEach((v) => centroid.add(v));
  centroid.divideScalar(positions.size);
  positions.forEach((v) => v.sub(centroid));
  let maxR = 0;
  positions.forEach((v) => (maxR = Math.max(maxR, v.length())));
  positions.forEach((v) => {
    const r = v.length();
    if (r > 0) v.multiplyScalar(Math.pow(r / maxR, -0.2));
  });
  let newMax = 0;
  positions.forEach((v) => (newMax = Math.max(newMax, v.length())));
  positions.forEach((v) => v.multiplyScalar(3.3 / newMax));
  return positions;
}

const LAYOUT = computeLayout();
const NODE_INDEX = new Map(SEEDS.map((s, i) => [s.id, i]));

/* ------------------------------------------------------------------ */
/* The moments: a curated loop of recalls and one supersede             */
/* ------------------------------------------------------------------ */

type Moment = {
  kind: "recall" | "supersede";
  from: string;
  to: string;
  agent: string;
  text: string;
  source: string;
};

const MOMENTS: Moment[] = [
  { kind: "recall", from: "adr-003", to: "clerk", agent: "claude-code", text: "Clerk owns auth", source: "adr-003.md" },
  { kind: "recall", from: "railway-json", to: "railway", agent: "cursor", text: "Moved to Railway", source: "railway.json" },
  { kind: "supersede", from: "railway", to: "fly", agent: "codex", text: "Deploys go to Fly.io — retired, still on the record", source: "railway.json" },
  { kind: "recall", from: "schema-sql", to: "hnsw", agent: "gemini", text: "HNSW index still off", source: "db/schema.sql" },
  { kind: "recall", from: "pr-12", to: "node-test", agent: "claude-code", text: "Moved to node:test", source: "pr-12.md" },
];

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type SceneProps = {
  onMoment: (moment: Moment, index: number) => void;
  reduced: boolean;
};

function GraphScene({ onMoment, reduced }: SceneProps) {
  const root = useRef<THREE.Group>(null);
  const field = useRef<THREE.InstancedMesh>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const stars = useRef<THREE.Points>(null);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const signal = useMemo(() => new THREE.Color(SIGNAL), []);
  const pointer = useRef({ tx: 0, ty: 0, x: 0, y: 0 });
  const clock = useRef(0);

  const nodeCount = SEEDS.length;

  /** Base color per node (retired nodes dimmed), flashed toward amber. */
  const baseColors = useMemo(
    () =>
      SEEDS.map((seed) => {
        const c = new THREE.Color(typeColor(seed.type, true));
        if (seed.retiredBy) c.multiplyScalar(0.5);
        return c;
      }),
    [],
  );
  const glow = useRef<number[]>(SEEDS.map(() => 0));

  const nodeRadius = useMemo(
    () => SEEDS.map((s) => (0.085 + Math.sqrt(degreeOf(s.id)) * 0.042) * 1.15),
    [],
  );

  const edgeGeo = useMemo(() => {
    const pts: number[] = [];
    for (const l of LINKS) {
      if (l.predicate === "supersedes") continue;
      const a = LAYOUT.get(l.source);
      const b = LAYOUT.get(l.target);
      if (a && b) pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  const superGeo = useMemo(() => {
    const pts: number[] = [];
    for (const l of LINKS) {
      if (l.predicate !== "supersedes") continue;
      const a = LAYOUT.get(l.source);
      const b = LAYOUT.get(l.target);
      if (a && b) pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  useEffect(
    () => () => {
      edgeGeo.dispose();
      superGeo.dispose();
    },
    [edgeGeo, superGeo],
  );

  const starGeo = useMemo(() => {
    const n = 220;
    const pos = new Float32Array(n * 3);
    const rand = mulberry32(29);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      const r = 7 + rand() * 6;
      pos.set([v.x * r, v.y * r, v.z * r - 3], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  useEffect(() => () => starGeo.dispose(), [starGeo]);

  /* Static node matrices + colors on mount. */
  useEffect(() => {
    const mesh = field.current;
    if (!mesh) return;
    SEEDS.forEach((seed, i) => {
      const p = LAYOUT.get(seed.id)!;
      dummy.position.copy(p);
      dummy.scale.setScalar(nodeRadius[i]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, baseColors[i]);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [dummy, baseColors, nodeRadius]);

  useEffect(() => {
    if (reduced || !matchMedia("(pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      pointer.current.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [reduced]);

  /* Moment machine: dwell at a node, travel the edge, flash the arrival. */
  const journey = useRef({ phase: "dwell" as "dwell" | "travel", timer: 1.2, index: -1, t: 0 });
  const lastMoment = useRef(-1);

  const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    clock.current += delta;
    const t = clock.current;

    const p = pointer.current;
    p.x += (p.tx - p.x) * Math.min(1, delta * 2.5);
    p.y += (p.ty - p.y) * Math.min(1, delta * 2.5);

    if (root.current) {
      /* Sway around the canonical orientation; the constellation never
         spins away from the shape the 2D explorer draws. */
      root.current.rotation.y = Math.sin(t * 0.13) * 0.16 + p.x * 0.2;
      root.current.rotation.x = -p.y * 0.14 + Math.sin(t * 0.11) * 0.03;
    }
    if (stars.current) stars.current.rotation.y = t * 0.006;

    if (reduced) {
      if (pulse.current) pulse.current.visible = false;
      return;
    }

    /* Node flashes decay toward their base color. */
    const mesh = field.current;
    if (mesh) {
      let dirty = false;
      for (let i = 0; i < nodeCount; i++) {
        if (glow.current[i] <= 0) continue;
        glow.current[i] = Math.max(0, glow.current[i] - delta * 1.15);
        tmp.copy(baseColors[i]).lerp(signal, glow.current[i] * 0.85);
        mesh.setColorAt(i, tmp);
        dirty = true;
      }
      if (dirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    const j = journey.current;
    if (j.phase === "dwell") {
      j.timer -= delta;
      if (pulse.current) pulse.current.visible = false;
      if (j.timer <= 0) {
        j.index = (j.index + 1) % MOMENTS.length;
        j.phase = "travel";
        j.t = 0;
        if (lastMoment.current !== j.index) {
          lastMoment.current = j.index;
          onMoment(MOMENTS[j.index], j.index);
        }
        const m = MOMENTS[j.index];
        glow.current[NODE_INDEX.get(m.from) ?? 0] = Math.max(glow.current[NODE_INDEX.get(m.from) ?? 0], 0.55);
      }
    } else {
      j.t += delta / 1.5;
      const m = MOMENTS[j.index];
      const a = LAYOUT.get(m.from)!;
      const b = LAYOUT.get(m.to)!;
      if (pulse.current) {
        pulse.current.visible = true;
        const e = easeInOut(Math.min(1, j.t));
        pulse.current.position.lerpVectors(a, b, e);
        /* Grows as it leaves, is absorbed as it arrives. */
        const envelope = Math.min(1, j.t / 0.16, (1 - j.t) / 0.16);
        pulse.current.scale.setScalar(Math.max(0.02, 0.06 * envelope));
      }
      if (j.t >= 1) {
        j.phase = "dwell";
        j.timer = 1.5 + Math.random() * 0.7;
        glow.current[NODE_INDEX.get(m.to) ?? 0] = 1;
      }
    }
    if (pulse.current) pulse.current.rotation.y = t * 1.4;
  });

  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[3, 5, 6]} intensity={1.1} color="#fff6e8" />
      <directionalLight position={[-4, -2, -5]} intensity={0.4} color="#dfe8ff" />

      <group ref={root}>
        {/* Ordinary edges: hairlines that stay out of the story. */}
        <lineSegments geometry={edgeGeo}>
          <lineBasicMaterial color={EDGE} transparent opacity={0.22} depthWrite={false} />
        </lineSegments>

        {/* Supersede edges: the signal color, dashed — retirement is visible.
            Dashing needs the line distances computed once the geometry lands. */}
        <lineSegments
          geometry={superGeo}
          onUpdate={(self) => {
            self.computeLineDistances();
            if (self.geometry.attributes.lineDistance) self.geometry.attributes.lineDistance.needsUpdate = true;
          }}
        >
          <lineDashedMaterial
            color={SIGNAL}
            transparent
            opacity={0.6}
            dashSize={0.16}
            gapSize={0.1}
            depthWrite={false}
          />
        </lineSegments>

        <instancedMesh ref={field} args={[undefined, undefined, nodeCount]} frustumCulled={false}>
          <sphereGeometry args={[1, 20, 20]} />
          <meshStandardMaterial roughness={0.38} metalness={0.08} />
        </instancedMesh>

        {/* The recall signal. */}
        <mesh ref={pulse} visible={false}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={SIGNAL} />
        </mesh>
      </group>

      <points ref={stars} geometry={starGeo}>
        <pointsMaterial color="#8a8677" size={0.03} sizeAttenuation transparent opacity={0.26} depthWrite={false} />
      </points>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Wrapper: canvas + the synced citation caption                       */
/* ------------------------------------------------------------------ */

export function MemoryGraphScene({ className = "" }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [moment, setMoment] = useState<{ m: Moment; key: number } | null>(
    reduceMotion ? { m: MOMENTS[0], key: 0 } : null,
  );
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!wrap.current) return;
    const io = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), { threshold: 0 });
    io.observe(wrap.current);
    return () => io.disconnect();
  }, [mounted]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const running = mounted && !hidden && active;
  const opClass =
    moment?.m.kind === "supersede" ? "text-[var(--signal)]" : moment?.m.kind === "recall" ? "text-muted-foreground" : "text-foreground/80";

  return (
    <div ref={wrap} className={`overflow-hidden rounded-2xl border bg-[var(--card)]/70 backdrop-blur ${className}`}>
      <div className="flex h-11 items-center justify-between border-b px-5 2xl:h-12">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          trove · memory graph
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="live-dot size-1.5 rounded-full bg-[var(--signal)]" />
          live
        </span>
      </div>

      <div
        aria-hidden="true"
        className="relative h-[23rem] w-full md:h-[25rem] 2xl:h-[31rem]"
      >
        {mounted ? (
          <Canvas
            frameloop={reduceMotion ? "demand" : running ? "always" : "never"}
            dpr={[1, 1.75]}
            gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
            camera={{ fov: 40, position: [0, 0.15, 9.6] }}
          >
            <GraphScene
              reduced={!!reduceMotion}
              onMoment={(m, key) => setMoment({ m, key })}
            />
          </Canvas>
        ) : null}
      </div>

      {/* The citation line: whatever the pulse is doing, named and sourced. */}
      <div className="flex h-14 items-start border-t px-5 py-3 2xl:h-16">
        <AnimatePresence mode="wait" initial={false}>
          {moment && (
            <motion.p
              key={moment.key}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="font-mono text-[10px] leading-relaxed text-muted-foreground"
            >
              <span className="tnum">{moment.m.agent}</span>
              <span className="mx-2 text-border">·</span>
              <span className={opClass}>{moment.m.kind}</span>
              <span className="mx-2 text-border">·</span>
              <span className="text-foreground/90">{moment.m.text}</span>
              <span className="mx-2 text-border">·</span>
              <span className="text-[var(--signal)]">←</span> {moment.m.source}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
