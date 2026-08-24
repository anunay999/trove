import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
 * frozen force simulation. One moment at a time plays: an amber pulse travels
 * an edge while the rest of the graph dims, labels name the two nodes
 * involved, and the caption below cites the source. A recall pulls evidence
 * toward a memory; a supersede retires a belief without deleting it. The
 * graph is the product; the moment is the product's verb.
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
  /** Why this beats a plain vector store — the moment's argument. */
  kicker: string;
};

const MOMENTS: Moment[] = [
  {
    kind: "recall",
    from: "adr-003",
    to: "clerk",
    agent: "claude-code",
    text: "Clerk owns auth",
    source: "adr-003.md",
    kicker: "Every fact carries its source — audit any recall down to the quote.",
  },
  {
    kind: "recall",
    from: "railway-json",
    to: "railway",
    agent: "cursor",
    text: "Moved to Railway",
    source: "railway.json",
    kicker: "Sources are first-class nodes, not metadata on a chunk.",
  },
  {
    kind: "supersede",
    from: "railway",
    to: "fly",
    agent: "codex",
    text: "Deploys go to Fly.io — retired by Moved to Railway",
    source: "railway.json",
    kicker: "Nothing overwritten. Ask what the graph believed last March.",
  },
  {
    kind: "recall",
    from: "schema-sql",
    to: "hnsw",
    agent: "gemini",
    text: "HNSW index still off",
    source: "db/schema.sql",
    kicker: "Known limitations live in the graph, so no agent re-debugs them.",
  },
  {
    kind: "recall",
    from: "pr-12",
    to: "node-test",
    agent: "claude-code",
    text: "Moved to node:test",
    source: "pr-12.md",
    kicker: "Decisions keep their receipts — no archaeology in old threads.",
  },
];

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type SceneProps = {
  onMoment: (moment: Moment, index: number) => void;
  /** Live label anchors, written per frame in screen space. */
  labelFromRef: React.RefObject<HTMLDivElement | null>;
  labelToRef: React.RefObject<HTMLDivElement | null>;
  reduced: boolean;
};

function GraphScene({ onMoment, labelFromRef, labelToRef, reduced }: SceneProps) {
  const root = useRef<THREE.Group>(null);
  const field = useRef<THREE.InstancedMesh>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const activeLine = useRef<THREE.LineSegments>(null);
  const stars = useRef<THREE.Points>(null);
  const superLines = useRef<THREE.LineSegments>(null);

  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const signal = useMemo(() => new THREE.Color(SIGNAL), []);
  const edgeBase = useMemo(() => new THREE.Color(EDGE), []);
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
  /** 1 = in focus, 0 = dimmed while another moment plays. */
  const focus = useRef<number[]>(SEEDS.map(() => 1));

  const nodeRadius = useMemo(
    () => SEEDS.map((s) => (0.085 + Math.sqrt(degreeOf(s.id)) * 0.042) * 1.15),
    [],
  );

  /* Ordinary edges, with a vertex-color attribute so the moment can dim
     every edge that isn't playing. */
  const normalLinks = useMemo(() => LINKS.filter((l) => l.predicate !== "supersedes"), []);
  const superLinks = useMemo(() => LINKS.filter((l) => l.predicate === "supersedes"), []);

  const edgeGeo = useMemo(() => {
    const pts: number[] = [];
    for (const l of normalLinks) {
      const a = LAYOUT.get(l.source);
      const b = LAYOUT.get(l.target);
      if (a && b) pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pts.length), 3));
    return g;
  }, [normalLinks]);

  const superGeo = useMemo(() => {
    const pts: number[] = [];
    for (const l of superLinks) {
      const a = LAYOUT.get(l.source);
      const b = LAYOUT.get(l.target);
      if (a && b) pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [superLinks]);

  /* The one edge currently playing, drawn bright above the dimmed rest. */
  const activeGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);

  useEffect(
    () => () => {
      edgeGeo.dispose();
      superGeo.dispose();
      activeGeo.dispose();
    },
    [edgeGeo, superGeo, activeGeo],
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
  const journey = useRef({ phase: "dwell" as "dwell" | "travel", timer: 0.9, index: -1, t: 0 });
  const lastMoment = useRef(-1);
  const labelAlpha = useRef(0);

  const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  /** Project a node's world position to the canvas' screen space. */
  const toScreen = useMemo(() => {
    const v = new THREE.Vector3();
    return (nodeId: string) => {
      const world = LAYOUT.get(nodeId)!;
      v.copy(world).applyMatrix4(root.current?.matrixWorld ?? new THREE.Matrix4());
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
      };
    };
  }, [camera, size]);

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
      if (halo.current) halo.current.visible = false;
      return;
    }

    const j = journey.current;
    const moment = j.index >= 0 ? MOMENTS[j.index] : null;

    /* Focus: nodes and edges of the current moment stay lit, the rest dims. */
    const fromIdx = moment ? (NODE_INDEX.get(moment.from) ?? 0) : 0;
    const toIdx = moment ? (NODE_INDEX.get(moment.to) ?? 0) : 0;
    const mesh = field.current;
    if (mesh) {
      let dirty = false;
      for (let i = 0; i < nodeCount; i++) {
        const focused = !moment || i === fromIdx || i === toIdx ? 1 : 0.3;
        focus.current[i] += (focused - focus.current[i]) * Math.min(1, delta * 7);
        if (glow.current[i] > 0) glow.current[i] = Math.max(0, glow.current[i] - delta * 1.15);
        tmp.copy(baseColors[i]).multiplyScalar(0.35 + 0.65 * focus.current[i]);
        tmp.lerp(signal, glow.current[i]);
        mesh.setColorAt(i, tmp);
        dirty = true;
      }
      if (dirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    /* Edge dimming via vertex colors; the active edge is drawn separately. */
    const colorAttr = edgeGeo.getAttribute("color") as THREE.BufferAttribute;
    if (colorAttr) {
      const activeIsNormal = moment ? LINKS.findIndex((l) => l.source === moment.from && l.target === moment.to) : -1;
      const arr = colorAttr.array as Float32Array;
      for (let e = 0; e < normalLinks.length; e++) {
        const lit = !moment || e === activeIsNormal ? 1 : 0.32;
        const r = edgeBase.r * lit;
        const g = edgeBase.g * lit;
        const b = edgeBase.b * lit;
        const k = e * 6;
        arr[k] += (r - arr[k]) * Math.min(1, delta * 5);
        arr[k + 1] += (g - arr[k + 1]) * Math.min(1, delta * 5);
        arr[k + 2] += (b - arr[k + 2]) * Math.min(1, delta * 5);
        arr[k + 3] = arr[k];
        arr[k + 4] = arr[k + 1];
        arr[k + 5] = arr[k + 2];
      }
      colorAttr.needsUpdate = true;
    }
    if (superLines.current) {
      const mat = superLines.current.material as THREE.LineDashedMaterial;
      const activeIsSuper = moment?.kind === "supersede";
      const target = activeIsSuper ? 0.95 : 0.22;
      mat.opacity += (target - mat.opacity) * Math.min(1, delta * 5);
    }

    /* The moment machine. */
    if (j.phase === "dwell") {
      j.timer -= delta;
      if (j.timer <= 0) {
        j.index = (j.index + 1) % MOMENTS.length;
        j.phase = "travel";
        j.t = 0;
        const m = MOMENTS[j.index];
        if (lastMoment.current !== j.index) {
          lastMoment.current = j.index;
          onMoment(m, j.index);
        }
        glow.current[NODE_INDEX.get(m.from) ?? 0] = Math.max(glow.current[NODE_INDEX.get(m.from) ?? 0], 0.55);
        /* Point the active-edge overlay at this moment's edge. */
        const attr = activeGeo.getAttribute("position") as THREE.BufferAttribute;
        const a = LAYOUT.get(m.from)!;
        const b = LAYOUT.get(m.to)!;
        attr.set([a.x, a.y, a.z, b.x, b.y, b.z]);
        attr.needsUpdate = true;
      }
    } else {
      j.t += delta / 0.95;
      const m = MOMENTS[j.index];
      const a = LAYOUT.get(m.from)!;
      const b = LAYOUT.get(m.to)!;
      const e = easeInOut(Math.min(1, j.t));
      const envelope = Math.min(1, j.t / 0.16, (1 - j.t) / 0.16);
      if (pulse.current) {
        pulse.current.visible = true;
        pulse.current.position.lerpVectors(a, b, e);
        pulse.current.scale.setScalar(Math.max(0.02, 0.075 * envelope));
      }
      if (halo.current) {
        halo.current.visible = true;
        halo.current.position.copy(pulse.current?.position ?? a);
        halo.current.scale.setScalar(Math.max(0.02, 0.19 * envelope));
        const hmat = halo.current.material as THREE.MeshBasicMaterial;
        hmat.opacity = 0.22 * envelope;
      }
      const lineMat = activeLine.current?.material as THREE.LineBasicMaterial | null;
      if (lineMat) lineMat.opacity = 0.85 * Math.min(1, j.t / 0.12, (1 - j.t) / 0.12 + 0.4);
      if (j.t >= 1) {
        j.phase = "dwell";
        j.timer = 0.85 + Math.random() * 0.45;
        glow.current[NODE_INDEX.get(m.to) ?? 0] = 1;
      }
    }

    /* Labels: pinned to their nodes in screen space, fading with the moment. */
    if (moment) {
      labelAlpha.current = Math.min(1, labelAlpha.current + delta * 3);
      const from = toScreen(moment.from);
      const to = toScreen(moment.to);
      if (labelFromRef.current) {
        labelFromRef.current.style.opacity = String(labelAlpha.current * 0.95);
        labelFromRef.current.style.transform = `translate(${from.x + 14}px, ${from.y + 8}px)`;
      }
      if (labelToRef.current) {
        labelToRef.current.style.opacity = String(labelAlpha.current * 0.95);
        labelToRef.current.style.transform = `translate(${to.x + 14}px, ${to.y - 26}px)`;
      }
    } else if (labelAlpha.current > 0) {
      labelAlpha.current = Math.max(0, labelAlpha.current - delta * 3);
      if (labelFromRef.current) labelFromRef.current.style.opacity = String(labelAlpha.current);
      if (labelToRef.current) labelToRef.current.style.opacity = String(labelAlpha.current);
    }
  });

  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[3, 5, 6]} intensity={1.1} color="#fff6e8" />
      <directionalLight position={[-4, -2, -5]} intensity={0.4} color="#dfe8ff" />

      <group ref={root}>
        {/* Ordinary edges: vertex-colored so the moment can dim the rest. */}
        <lineSegments geometry={edgeGeo}>
          <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} />
        </lineSegments>

        {/* Supersede edges: the signal color, dashed — retirement is visible.
            Dashing needs the line distances computed once the geometry lands. */}
        <lineSegments
          ref={superLines}
          geometry={superGeo}
          onUpdate={(self) => {
            self.computeLineDistances();
            if (self.geometry.attributes.lineDistance) self.geometry.attributes.lineDistance.needsUpdate = true;
          }}
        >
          <lineDashedMaterial
            color={SIGNAL}
            transparent
            opacity={0.22}
            dashSize={0.16}
            gapSize={0.1}
            depthWrite={false}
          />
        </lineSegments>

        {/* The edge currently playing, drawn bright above the dimmed rest. */}
        <lineSegments ref={activeLine} geometry={activeGeo}>
          <lineBasicMaterial color={SIGNAL} transparent opacity={0} depthWrite={false} />
        </lineSegments>

        <instancedMesh ref={field} args={[undefined, undefined, nodeCount]} frustumCulled={false}>
          <sphereGeometry args={[1, 20, 20]} />
          <meshStandardMaterial roughness={0.38} metalness={0.08} />
        </instancedMesh>

        {/* The recall signal, with a soft halo so it reads at a glance. */}
        <mesh ref={pulse} visible={false}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={SIGNAL} />
        </mesh>
        <mesh ref={halo} visible={false}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={SIGNAL} transparent opacity={0.2} depthWrite={false} />
        </mesh>
      </group>

      <points ref={stars} geometry={starGeo}>
        <pointsMaterial color="#8a8677" size={0.03} sizeAttenuation transparent opacity={0.26} depthWrite={false} />
      </points>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Wrapper: canvas + labels + the synced citation caption               */
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
  const labelFromRef = useRef<HTMLDivElement>(null);
  const labelToRef = useRef<HTMLDivElement>(null);

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

  const labelBase =
    "pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-0 will-change-transform";

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

      <div aria-hidden="true" className="relative h-[23rem] w-full md:h-[25rem] 2xl:h-[31rem]">
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
              labelFromRef={labelFromRef}
              labelToRef={labelToRef}
            />
          </Canvas>
        ) : null}

        {/* Node labels, pinned per frame to the two nodes in the moment. */}
        <div ref={labelFromRef} className={`${labelBase} bg-[var(--card)]/90 text-muted-foreground`}>
          <span className="text-[var(--signal)]">← </span>
          {moment ? seedTitle(moment.m.from) : ""}
        </div>
        <div ref={labelToRef} className={`${labelBase} bg-[var(--card)]/90 text-foreground`}>
          <span className={moment?.m.kind === "supersede" ? "superseded-line" : undefined}>
            {moment ? seedTitle(moment.m.to) : ""}
          </span>
          {moment?.m.kind === "supersede" && <span className="ml-1.5 text-[var(--signal)]">retired</span>}
        </div>

        {/* The visual grammar, taught in one glance. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80"
        >
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-4 bg-foreground/40" />
            edge
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-px w-4"
              style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--signal) 0 3px, transparent 3px 6px)" }}
            />
            superseded
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 rounded-full bg-[var(--signal)]" />
            recall
          </span>
        </div>
      </div>

      {/* The citation line plus the moment's argument: what happened, and
          why a graph that keeps receipts beats a store that overwrites. */}
      <div className="flex min-h-14 flex-col justify-start border-t px-5 py-2.5 2xl:min-h-16">
        <AnimatePresence mode="wait" initial={false}>
          {moment && (
            <motion.div
              key={moment.key}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                <span className="tnum">{moment.m.agent}</span>
                <span className="mx-2 text-border">·</span>
                <span className={opClass}>{moment.m.kind}</span>
                <span className="mx-2 text-border">·</span>
                <span className="text-foreground/90">{moment.m.text}</span>
                <span className="mx-2 text-border">·</span>
                <span className="text-[var(--signal)]">←</span> {moment.m.source}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-foreground/70">{moment.m.kicker}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function seedTitle(id: string) {
  return SEEDS.find((s) => s.id === id)?.title ?? id;
}
