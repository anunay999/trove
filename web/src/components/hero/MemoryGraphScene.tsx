import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as THREE from "three";
import { LINKS, SEEDS, degreeOf } from "@/lib/seed-graph";
import { typeColor } from "@/lib/viz";

/**
 * The hero's right column: the memory lifecycle, run by the agents themselves.
 *
 * Three claude sessions and a codex orbit one shared graph, and the loop they
 * run is Trove's whole argument — a session adds what it learned, another
 * consumes it cold, an edit supersedes a belief without erasing it, noise
 * gets pruned on the record. Then the loop turns again. The graph is never
 * finished: it is maintained, and the maintenance is visible.
 *
 * Layout is hand-placed — hub in the middle, decisions around it, sources on
 * the rim — so the structure reads at a glance. Perf contract mirrors the
 * rest of the page: frames stop when the hero leaves the viewport or the tab
 * hides, prefers-reduced-motion freezes the scene, DPR is capped.
 */

const SIGNAL = "#f2c46b"; // the signal amber, brightened for WebGL
const EDGE = "#edebe4";

/* ------------------------------------------------------------------ */
/* Layout: hand-placed clusters so the structure reads at a glance —    */
/* launch (top right), repo rules (top left), Stripe migration (bottom  */
/* right), hosting + learned rules (bottom left), acme at the hub.      */
/* ------------------------------------------------------------------ */

const HAND_LAYOUT: Record<string, [number, number, number]> = {
  acme: [0, 0.2, 0],

  // Launch cluster, top right.
  "launch-date-current": [1.9, 1.5, 0.1],
  "launch-date-old": [3.0, 2.1, -0.1],
  "onboarding-friction": [2.6, 0.7, 0.05],
  research: [3.5, 1.2, -0.15],
  "launch-plan": [2.9, 2.6, 0.1],
  "pricing-update": [1.35, 2.45, -0.05],
  priya: [0.5, 2.95, 0.05],

  // Repository rules, top left.
  "repo-rules": [-2.2, 2.2, 0],
  pnpm: [-3.3, 2.6, 0.05],
  "no-legacy": [-3.6, 1.6, -0.1],
  playwright: [-2.95, 3.3, 0.05],
  contributing: [-4.0, 2.3, -0.15],
  "agents-md": [-2.2, 3.35, 0.1],

  // Stripe migration, bottom right — with the session handoff.
  "stripe-migration": [2.0, -1.4, 0],
  "duplicate-event": [3.1, -1.9, 0.1],
  incident: [3.6, -2.7, -0.1],
  "webhook-fix": [2.4, -2.6, 0.05],
  staging: [1.3, -3.0, -0.1],
  "previous-agent": [0.7, -0.9, 0.1],
  "current-agent": [3.2, -0.8, -0.05],
  "scratch-note": [1.05, -2.15, 0.1],

  // Hosting + personal rules, bottom left.
  heroku: [-2.0, -1.5, 0.05],
  vercel: [-1.1, -2.3, -0.1],
  anunay: [-3.3, -1.2, 0.1],
  "concise-slack": [-3.9, -2.1, -0.05],
  "no-auto-push": [-2.9, -2.9, 0.1],

  // The learning arc, center bottom.
  "agent-failure": [-0.6, -1.6, 0.1],
  "agent-runs": [-1.5, -3.0, 0.05],
  "routing-rule": [0.4, -2.4, -0.05],
  "tool-order": [-0.5, -3.1, -0.1],
};

const LAYOUT = new Map(Object.entries(HAND_LAYOUT).map(([id, [x, y, z]]) => [id, new THREE.Vector3(x, y, z)]));
const NODE_INDEX = new Map(SEEDS.map((s, i) => [s.id, i]));

/* ------------------------------------------------------------------ */
/* The agents: three claude sessions and a codex, one shared graph      */
/* ------------------------------------------------------------------ */

const AGENTS = [
  { id: "s12", label: "claude · s12", color: "#e0784f", pos: new THREE.Vector3(-4.15, 0.5, 0.1), side: "left" as const },
  { id: "s14", label: "claude · s14", color: "#e0784f", pos: new THREE.Vector3(-4.05, -1.0, -0.1), side: "left" as const },
  { id: "s17", label: "claude · s17", color: "#e0784f", pos: new THREE.Vector3(4.15, 0.3, 0.15), side: "right" as const },
  { id: "codex", label: "codex", color: "#3fa87c", pos: new THREE.Vector3(4.05, -1.6, -0.05), side: "right" as const },
];

const AGENT_INDEX = new Map(AGENTS.map((a, i) => [a.id, i]));

/* ------------------------------------------------------------------ */
/* The moments: the lifecycle loop — add, consume, edit, remove         */
/* ------------------------------------------------------------------ */

type Moment = {
  kind: "add" | "consume" | "edit" | "remove";
  agent: string;
  node: string;
  /** For consumes: the evidence that travels with the memory. */
  evidence?: string;
  agentName: string;
  text: string;
  source: string;
  kicker: string;
  /** Marks the consume half of an add→consume pair across sessions. */
  collab?: boolean;
};

const MOMENTS: Moment[] = [
  {
    kind: "add",
    agent: "s12",
    node: "launch-date-current",
    agentName: "claude · s12",
    text: "Launch on September 12",
    source: "launch-plan.md",
    kicker: "Customer research moved the date. The graph gets the decision with its source attached.",
  },
  {
    kind: "edit",
    agent: "codex",
    node: "launch-date-old",
    agentName: "codex",
    text: "Launch on August 30 — retired by September 12",
    source: "launch-plan-v1.md",
    kicker: "The old date stays queryable — 'why did it slip?' always has an answer.",
  },
  {
    kind: "consume",
    agent: "s14",
    node: "pnpm",
    evidence: "contributing",
    agentName: "claude · s14",
    text: "Use pnpm, never npm",
    source: "CONTRIBUTING.md",
    kicker: "Session 14 cloned the repo cold and never broke the lockfile.",
  },
  {
    kind: "consume",
    agent: "codex",
    node: "duplicate-event",
    evidence: "incident",
    agentName: "codex",
    text: "Duplicate webhook event IDs",
    source: "incident-2026-04-17.md",
    kicker: "The previous session's incident is this session's head start.",
  },
  {
    kind: "add",
    agent: "s17",
    node: "webhook-fix",
    agentName: "claude · s17",
    text: "Webhook idempotency fix",
    source: "github.com/acme/stripe-migration/issues/184",
    kicker: "The fix lands citing the exact issue that demanded it.",
  },
  {
    kind: "remove",
    agent: "s14",
    node: "scratch-note",
    agentName: "claude · s14",
    text: "'Try restarting the server' — scratch",
    source: "session-12.md",
    kicker: "Noise gets pruned on the record — the removal is itself a memory.",
  },
  {
    kind: "consume",
    agent: "codex",
    node: "staging",
    agentName: "codex",
    text: "Fix deployed to staging",
    source: "deployment-2026-04-18.md",
    collab: true,
    kicker: "Session 17 landed it an hour ago. Codex walks into a solved problem.",
  },
];

/* Nodes that enter the graph during the loop (they start at scale 0 and grow
   when a session writes them); the pruned one shrinks away and stays gone
   until the loop turns. */
const ADDED_DURING_LOOP = new Set(["launch-date-current", "webhook-fix"]);

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type SceneProps = {
  onMoment: (moment: Moment, index: number) => void;
  labelFromRef: React.RefObject<HTMLDivElement | null>;
  labelToRef: React.RefObject<HTMLDivElement | null>;
  agentLabelRefs: React.RefObject<(HTMLDivElement | null)[]>;
  reduced: boolean;
};

function GraphScene({ onMoment, labelFromRef, labelToRef, agentLabelRefs, reduced }: SceneProps) {
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
  const agentGlow = useRef<number[]>(AGENTS.map(() => 0));
  const focus = useRef<number[]>(SEEDS.map(() => 1));
  /** Lifecycle scale: 0 until written, 0 once pruned. */
  const nodeScale = useRef<number[]>(
    SEEDS.map((s) => (ADDED_DURING_LOOP.has(s.id) ? 0 : 1)),
  );
  const pruned = useRef<Set<string>>(new Set());

  const agentMats = useMemo(
    () =>
      AGENTS.map(
        (a) =>
          new THREE.MeshStandardMaterial({
            color: a.color,
            emissive: a.color,
            emissiveIntensity: 0.22,
            roughness: 0.35,
            metalness: 0.05,
          }),
      ),
    [],
  );
  useEffect(() => () => agentMats.forEach((m) => m.dispose()), [agentMats]);

  const nodeRadius = useMemo(
    () => SEEDS.map((s) => (0.07 + Math.sqrt(degreeOf(s.id)) * 0.034) * 1.05),
    [],
  );

  const normalLinks = useMemo(() => LINKS.filter((l) => l.predicate !== "superseded by"), []);
  const superLinks = useMemo(() => LINKS.filter((l) => l.predicate === "superseded by"), []);

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
      const r = 7.5 + rand() * 6;
      pos.set([v.x * r, v.y * r, v.z * r - 3], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  useEffect(() => () => starGeo.dispose(), [starGeo]);

  useEffect(() => {
    if (reduced || !matchMedia("(pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      pointer.current.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [reduced]);

  const journey = useRef({ phase: "dwell" as "dwell" | "travel", timer: 0.9, index: -1, t: 0 });
  const lastMoment = useRef(-1);
  const labelAlpha = useRef(0);

  const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  const toScreen = useMemo(() => {
    const v = new THREE.Vector3();
    return (world: THREE.Vector3) => {
      v.copy(world).applyMatrix4(root.current?.matrixWorld ?? new THREE.Matrix4());
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
      };
    };
  }, [camera, size]);

  /** Writes go from the agent into the graph; consumes and prunes come out. */
  const route = (m: Moment) => {
    const node = LAYOUT.get(m.node)!;
    const agent = AGENTS[AGENT_INDEX.get(m.agent)!].pos;
    return m.kind === "add" ? { a: agent, b: node } : { a: node, b: agent };
  };

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    clock.current += delta;
    const t = clock.current;

    const p = pointer.current;
    p.x += (p.tx - p.x) * Math.min(1, delta * 2.5);
    p.y += (p.ty - p.y) * Math.min(1, delta * 2.5);

    if (root.current) {
      root.current.rotation.y = Math.sin(t * 0.13) * 0.12 + p.x * 0.14;
      root.current.rotation.x = -p.y * 0.1 + Math.sin(t * 0.11) * 0.03;
    }
    if (stars.current) stars.current.rotation.y = t * 0.006;

    if (reduced) {
      if (pulse.current) pulse.current.visible = false;
      if (halo.current) halo.current.visible = false;
      return;
    }

    const j = journey.current;
    const moment = j.index >= 0 ? MOMENTS[j.index] : null;
    const nodeIdx = moment ? (NODE_INDEX.get(moment.node) ?? 0) : 0;

    /* Lifecycle scales ease toward their targets: added nodes grow in,
       pruned nodes shrink away. */
    const mesh = field.current;
    if (mesh) {
      let dirty = false;
      for (let i = 0; i < nodeCount; i++) {
        const seed = SEEDS[i];
        const target = pruned.current.has(seed.id) ? 0 : 1;
        nodeScale.current[i] += (target - nodeScale.current[i]) * Math.min(1, delta * 5);
        const focused =
          !moment || i === nodeIdx || i === (moment.evidence ? (NODE_INDEX.get(moment.evidence) ?? 0) : -1)
            ? 1
            : 0.32;
        focus.current[i] += (focused - focus.current[i]) * Math.min(1, delta * 7);
        if (glow.current[i] > 0) glow.current[i] = Math.max(0, glow.current[i] - delta * 1.3);
        const s = nodeRadius[i] * nodeScale.current[i];
        dummy.position.copy(LAYOUT.get(seed.id)!);
        dummy.scale.setScalar(Math.max(0.001, s));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tmp.copy(baseColors[i]).multiplyScalar(0.35 + 0.65 * focus.current[i]);
        tmp.lerp(signal, glow.current[i]);
        mesh.setColorAt(i, tmp);
        dirty = true;
      }
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    /* Agents breathe; the acting one flashes on arrival. */
    agentMats.forEach((mat, i) => {
      if (agentGlow.current[i] > 0) agentGlow.current[i] = Math.max(0, agentGlow.current[i] - delta * 1.3);
      const idle = 0.18 + Math.sin(t * 1.6 + i * 1.7) * 0.06;
      mat.emissiveIntensity = idle + agentGlow.current[i] * 1.1;
    });

    /* Edge dimming; edges touching absent nodes fade to almost nothing. */
    const colorAttr = edgeGeo.getAttribute("color") as THREE.BufferAttribute;
    if (colorAttr) {
      const arr = colorAttr.array as Float32Array;
      for (let e = 0; e < normalLinks.length; e++) {
        const link = normalLinks[e];
        const aIdx = NODE_INDEX.get(link.source) ?? 0;
        const bIdx = NODE_INDEX.get(link.target) ?? 0;
        const absent = nodeScale.current[aIdx] < 0.5 || nodeScale.current[bIdx] < 0.5;
        const lit = absent ? 0.06 : !moment || link.source === moment.node || link.target === moment.node ? 1 : 0.32;
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
      const target = moment?.kind === "edit" ? 0.95 : 0.22;
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
        if (j.index === 0) {
          /* The loop turns: reset the lifecycle for the next pass. */
          pruned.current.clear();
        }
        if (lastMoment.current !== j.index) {
          lastMoment.current = j.index;
          onMoment(m, j.index);
        }
        if (m.kind === "add") glow.current[NODE_INDEX.get(m.node) ?? 0] = 0.5;
        /* Point the active-edge overlay at this moment's edge. */
        const attr = activeGeo.getAttribute("position") as THREE.BufferAttribute;
        const r = route(m);
        attr.set([r.a.x, r.a.y, r.a.z, r.b.x, r.b.y, r.b.z]);
        attr.needsUpdate = true;
      }
    } else {
      j.t += delta / 0.95;
      const m = MOMENTS[j.index];
      const r = route(m);
      const e = easeInOut(Math.min(1, j.t));
      const envelope = Math.min(1, j.t / 0.16, (1 - j.t) / 0.16);
      if (pulse.current) {
        pulse.current.visible = true;
        pulse.current.position.lerpVectors(r.a, r.b, e);
        pulse.current.scale.setScalar(Math.max(0.02, 0.075 * envelope));
      }
      if (halo.current) {
        halo.current.visible = true;
        halo.current.position.copy(pulse.current?.position ?? r.a);
        halo.current.scale.setScalar(Math.max(0.02, 0.19 * envelope));
        const hmat = halo.current.material as THREE.MeshBasicMaterial;
        hmat.opacity = 0.22 * envelope;
      }
      const lineMat = activeLine.current?.material as THREE.LineBasicMaterial | null;
      if (lineMat) lineMat.opacity = 0.85 * Math.min(1, j.t / 0.12, (1 - j.t) / 0.12 + 0.4);
      if (j.t >= 1) {
        j.phase = "dwell";
        j.timer = 0.85 + Math.random() * 0.45;
        if (m.kind === "consume") agentGlow.current[AGENT_INDEX.get(m.agent) ?? 0] = 1;
        if (m.kind === "add") glow.current[NODE_INDEX.get(m.node) ?? 0] = 1;
        if (m.kind === "remove") pruned.current.add(m.node);
      }
    }

    /* Labels: the acting node, its evidence, and every agent. Labels flip
       to the left of their node when they would cross the card edge —
       measured, not guessed, because label lengths vary a lot. */
    const placeLabel = (
      el: HTMLDivElement | null,
      x: number,
      y: number,
      alpha: number,
    ) => {
      if (!el) return;
      const w = el.offsetWidth || 180;
      const pastRight = x + 14 + w > size.width - 10;
      el.style.opacity = String(alpha);
      el.style.transform = pastRight
        ? `translate(calc(${x - 14}px - 100%), ${y}px)`
        : `translate(${x + 14}px, ${y}px)`;
    };
    if (moment) {
      labelAlpha.current = Math.min(1, labelAlpha.current + delta * 4);
      const to = toScreen(LAYOUT.get(moment.node)!);
      placeLabel(labelToRef.current, to.x, to.y - 26, labelAlpha.current * 0.95);
      if (moment.evidence) {
        const from = toScreen(LAYOUT.get(moment.evidence)!);
        placeLabel(labelFromRef.current, from.x, from.y + 8, labelAlpha.current * 0.95);
      } else if (labelFromRef.current) {
        labelFromRef.current.style.opacity = "0";
      }
    }
    AGENTS.forEach((agent, i) => {
      const el = agentLabelRefs.current[i];
      if (!el) return;
      const s = toScreen(agent.pos);
      const shift = agent.side === "left" ? 13 : -13;
      el.style.transform =
        agent.side === "left"
          ? `translate(${s.x + shift}px, ${s.y - 7}px)`
          : `translate(calc(${s.x + shift}px - 100%), ${s.y - 7}px)`;
    });
  });

  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[3, 5, 6]} intensity={1.1} color="#fff6e8" />
      <directionalLight position={[-4, -2, -5]} intensity={0.4} color="#dfe8ff" />

      <group ref={root}>
        <lineSegments geometry={edgeGeo}>
          <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} />
        </lineSegments>

        {/* Supersede edges: dashed signal — edits are visible, not silent. */}
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

        <lineSegments ref={activeLine} geometry={activeGeo}>
          <lineBasicMaterial color={SIGNAL} transparent opacity={0} depthWrite={false} />
        </lineSegments>

        <instancedMesh ref={field} args={[undefined, undefined, nodeCount]} frustumCulled={false}>
          <sphereGeometry args={[1, 20, 20]} />
          <meshStandardMaterial roughness={0.38} metalness={0.08} />
        </instancedMesh>

        {/* The agents: three claude sessions and a codex, one shared graph. */}
        {AGENTS.map((agent, i) => (
          <mesh
            key={agent.id}
            material={agentMats[i]}
            position={agent.pos}
          >
            <sphereGeometry args={[0.17, 20, 20]} />
          </mesh>
        ))}

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
  const agentLabelRefs = useRef<(HTMLDivElement | null)[]>([]);

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
    moment?.m.kind === "edit" || moment?.m.kind === "remove"
      ? "text-[var(--signal)]"
      : moment?.m.kind === "add"
        ? "text-foreground/80"
        : "text-muted-foreground";
  const opLabel =
    moment?.m.kind === "add"
      ? "remember"
      : moment?.m.kind === "consume"
        ? "recall"
        : moment?.m.kind === "edit"
          ? "supersede"
          : "remove";

  const labelBase =
    "pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-0 will-change-transform";
  const agentLabelBase =
    "pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-full border bg-[var(--card)]/90 px-2 py-0.5 font-mono text-[9px] leading-none text-muted-foreground";

  return (
    <div ref={wrap} className={`overflow-hidden rounded-2xl border bg-[var(--card)]/70 backdrop-blur ${className}`}>
      <div className="flex h-11 items-center justify-between border-b px-5 2xl:h-12">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          trove · memory lifecycle
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
            camera={{ fov: 40, position: [0, 0.15, 10.4] }}
          >
            <GraphScene
              reduced={!!reduceMotion}
              onMoment={(m, key) => setMoment({ m, key })}
              labelFromRef={labelFromRef}
              labelToRef={labelToRef}
              agentLabelRefs={agentLabelRefs}
            />
          </Canvas>
        ) : null}

        {AGENTS.map((agent, i) => (
          <div
            key={agent.id}
            ref={(el) => {
              agentLabelRefs.current[i] = el;
            }}
            className={agentLabelBase}
          >
            <span
              className="mr-1.5 inline-block size-1.5 rounded-full align-middle"
              style={{ background: agent.color }}
            />
            {agent.label}
          </div>
        ))}

        <div ref={labelFromRef} className={`${labelBase} bg-[var(--card)]/90 text-muted-foreground`}>
          <span className="text-[var(--signal)]">← </span>
          {moment?.m.evidence ? seedTitle(moment.m.evidence) : ""}
        </div>
        <div ref={labelToRef} className={`${labelBase} bg-[var(--card)]/90 text-foreground`}>
          <span
            className={
              moment?.m.kind === "edit" || moment?.m.kind === "remove" ? "superseded-line" : undefined
            }
          >
            {moment ? seedTitle(moment.m.node) : ""}
          </span>
          {moment?.m.kind === "edit" && <span className="ml-1.5 text-[var(--signal)]">retired</span>}
          {moment?.m.kind === "remove" && <span className="ml-1.5 text-[var(--signal)]">pruned</span>}
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

      {/* The citation line plus the moment's argument: which session did what,
          and why a maintained graph beats a store that only accumulates. */}
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
                {moment.m.collab && (
                  <>
                    <span className="text-[var(--signal)]">parallel sessions</span>
                    <span className="mx-2 text-border">·</span>
                  </>
                )}
                <span className="tnum">{moment.m.agentName}</span>
                <span className="mx-2 text-border">·</span>
                <span className={opClass}>{opLabel}</span>
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
