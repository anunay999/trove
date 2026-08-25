import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as THREE from "three";
import { siClaude } from "simple-icons";
import { LINKS, SEEDS, degreeOf } from "@/lib/seed-graph";
import { typeColor } from "@/lib/viz";

/**
 * The hero's right column: the memory lifecycle, run by the agents themselves.
 *
 * Three claude sessions and a codex orbit one shared graph, and the loop they
 * run is Trove's whole argument — a session adds what it learned (the new
 * memory flies in and attaches, edges and all), another consumes it cold, an
 * edit supersedes a belief without erasing it, noise is pruned and the
 * removal flies home. Then the loop turns again. The graph is never
 * finished: it is maintained, and the maintenance is visible.
 *
 * The graph is fully connected — no islands. Layout is hand-placed in themed
 * clusters (launch, repo rules, Stripe migration, hosting, learned rules)
 * around the acme hub. Perf contract: frames stop when the hero leaves the
 * viewport or the tab hides, prefers-reduced-motion freezes the scene, DPR
 * is capped, three.js ships in its own chunk.
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
/* The agents: three claude sessions and a codex, one shared graph.     */
/* Logos instead of bubbles — the claude starburst and the codex        */
/* prompt, billboarded so they always face the camera.                  */
/* ------------------------------------------------------------------ */

const AGENTS = [
  { id: "s12", label: "claude · s12", icon: "claude", color: "#e5926b", pos: new THREE.Vector3(-4.15, 0.5, 0.1), side: "left" as const },
  { id: "s14", label: "claude · s14", icon: "claude", color: "#e5926b", pos: new THREE.Vector3(-4.05, -1.0, -0.1), side: "left" as const },
  { id: "s17", label: "claude · s17", icon: "claude", color: "#e5926b", pos: new THREE.Vector3(4.15, 0.3, 0.15), side: "right" as const },
  { id: "codex", label: "codex", icon: "chatgpt", color: "#e8e8e6", pos: new THREE.Vector3(4.05, -1.6, -0.05), side: "right" as const },
];

const AGENT_INDEX = new Map(AGENTS.map((a, i) => [a.id, i]));

/** Codex has no simple-icons mark (OpenAI was removed upstream), so the
    ChatGPT knot is inlined here. */
const CHATGPT_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

/** One texture per agent: a dark chip with a hairline ring, the mark drawn
    on top. Compositing in the canvas keeps it a single quad in the scene. */
function logoTexture(icon: "claude" | "codex", color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  /* The chip. */
  ctx.fillStyle = "rgba(22, 21, 19, 0.94)";
  ctx.beginPath();
  ctx.arc(128, 128, 116, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(237, 235, 228, 0.14)";
  ctx.lineWidth = 2;
  ctx.stroke();

  /* The mark, centered at ~55% of the chip. */
  ctx.save();
  ctx.translate(128 - 70, 128 - 70);
  ctx.scale(140 / 24, 140 / 24);
  if (icon === "claude") {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(siClaude.path));
  } else {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(CHATGPT_PATH));
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

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

/* Nodes that enter the graph during the loop (they start at scale 0 and fly
   in when a session writes them); the pruned one detaches and flies home. */
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
  const agentPlanes = useRef<(THREE.Mesh | null)[]>([]);

  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const signal = useMemo(() => new THREE.Color(SIGNAL), []);
  const edgeBase = useMemo(() => new THREE.Color(EDGE), []);
  const pointer = useRef({ tx: 0, ty: 0, x: 0, y: 0 });
  const clock = useRef(0);

  const nodeCount = SEEDS.length;

  /** Base color per node: type-tinted but pulled toward the page's warm
      monochrome — the amber pulse stays the only loud color in the room.
      Retired nodes sit dimmer. */
  const baseColors = useMemo(
    () =>
      SEEDS.map((seed) => {
        const c = new THREE.Color(typeColor(seed.type, true));
        c.lerp(new THREE.Color("#8a8677"), 0.55);
        c.multiplyScalar(0.92);
        if (seed.retiredBy) c.multiplyScalar(0.55);
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

  const agentTextures = useMemo(
    () => AGENTS.map((a) => logoTexture(a.icon as "claude" | "codex", a.color)),
    [],
  );
  useEffect(() => () => agentTextures.forEach((t) => t.dispose()), [agentTextures]);

  const agentBaseColors = useMemo(() => AGENTS.map((a) => new THREE.Color(a.color)), []);

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
  /** The node currently flying to/from its agent, in root-local space. */
  const flying = useRef<{ id: string; index: number; from: THREE.Vector3; to: THREE.Vector3 } | null>(null);
  const flyingPos = useMemo(() => new THREE.Vector3(), []);

  const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  const toScreen = useMemo(() => {
    const v = new THREE.Vector3();
    return (world: THREE.Vector3) => {
      v.copy(world).project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
      };
    };
  }, [camera, size]);

  const nodeToScreen = useMemo(() => {
    const v = new THREE.Vector3();
    return (local: THREE.Vector3) => {
      v.copy(local).applyMatrix4(root.current?.matrixWorld ?? new THREE.Matrix4());
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
      };
    };
  }, [camera, size]);

  /** Writes fly from the agent into the graph; prunes fly home; consumes and
      edits send the signal pulse instead. */
  const route = (m: Moment) => {
    const node = LAYOUT.get(m.node)!;
    const agent = AGENTS[AGENT_INDEX.get(m.agent)!].pos;
    if (m.kind === "add") return { a: agent, b: node };
    if (m.kind === "remove") return { a: node, b: agent };
    if (m.kind === "edit") return { a: agent, b: node };
    return { a: node, b: agent };
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
    const flyingNode = flying.current && j.phase === "travel" && (moment?.kind === "add" || moment?.kind === "remove");

    /* Node lifecycle scales ease toward their targets; the flying node is
       driven by the journey below instead. */
    const mesh = field.current;
    if (mesh) {
      let dirty = false;
      for (let i = 0; i < nodeCount; i++) {
        const seed = SEEDS[i];
        const target = pruned.current.has(seed.id) ? 0 : 1;
        if (!(flyingNode && seed.id === flying.current!.id)) {
          nodeScale.current[i] += (target - nodeScale.current[i]) * Math.min(1, delta * 5);
        }
        const focused =
          !moment || i === nodeIdx || i === (moment.evidence ? (NODE_INDEX.get(moment.evidence) ?? 0) : -1)
            ? 1
            : 0.32;
        focus.current[i] += (focused - focus.current[i]) * Math.min(1, delta * 7);
        if (glow.current[i] > 0) glow.current[i] = Math.max(0, glow.current[i] - delta * 1.3);
        const s = nodeRadius[i] * nodeScale.current[i];
        const pos = flyingNode && seed.id === flying.current!.id ? flyingPos : LAYOUT.get(seed.id)!;
        dummy.position.copy(pos);
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

    /* Agent logos billboard toward the camera; the acting one pops. */
    agentPlanes.current.forEach((plane, i) => {
      if (!plane) return;
      plane.quaternion.copy(camera.quaternion);
      if (agentGlow.current[i] > 0) agentGlow.current[i] = Math.max(0, agentGlow.current[i] - delta * 1.3);
      const pop = 1 + agentGlow.current[i] * 0.3;
      plane.scale.setScalar(pop);
      const mat = plane.material as THREE.MeshBasicMaterial;
      mat.color.copy(agentBaseColors[i]).lerp(tmp.set("#ffffff"), agentGlow.current[i] * 0.55);
    });

    /* Edge dimming; edges touching absent nodes fade to almost nothing, and
       edges touching the flying node follow it so the attach reads. */
    const colorAttr = edgeGeo.getAttribute("color") as THREE.BufferAttribute;
    const posAttr = edgeGeo.getAttribute("position") as THREE.BufferAttribute;
    if (colorAttr) {
      const arr = colorAttr.array as Float32Array;
      for (let e = 0; e < normalLinks.length; e++) {
        const link = normalLinks[e];
        const aIdx = NODE_INDEX.get(link.source) ?? 0;
        const bIdx = NODE_INDEX.get(link.target) ?? 0;
        const absent = nodeScale.current[aIdx] < 0.5 || nodeScale.current[bIdx] < 0.5;
        const lit = absent ? 0.05 : !moment || link.source === moment.node || link.target === moment.node ? 0.8 : 0.16;
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
    if (flyingNode && flying.current && posAttr) {
      const arr = posAttr.array as Float32Array;
      const fid = flying.current.id;
      for (let e = 0; e < normalLinks.length; e++) {
        const link = normalLinks[e];
        const isSource = link.source === fid;
        if (!isSource && link.target !== fid) continue;
        const k = e * 6;
        const offset = isSource ? 0 : 3;
        arr[k + offset] = flyingPos.x;
        arr[k + offset + 1] = flyingPos.y;
        arr[k + offset + 2] = flyingPos.z;
      }
      posAttr.needsUpdate = true;
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
        if (m.kind === "add" || m.kind === "remove") {
          /* The node itself makes the trip. */
          const agentWorld = AGENTS[AGENT_INDEX.get(m.agent)!].pos;
          const localAgent =
            m.kind === "add"
              ? root.current
                ? root.current.worldToLocal(agentWorld.clone())
                : agentWorld.clone()
              : LAYOUT.get(m.node)!;
          const localNode =
            m.kind === "add" ? LAYOUT.get(m.node)! : LAYOUT.get(m.node)!;
          flying.current = {
            id: m.node,
            index: NODE_INDEX.get(m.node) ?? 0,
            from: m.kind === "add" ? localAgent : localNode,
            to: m.kind === "add" ? localNode : localAgent,
          };
        } else {
          flying.current = null;
        }
        if (m.kind === "add") glow.current[NODE_INDEX.get(m.node) ?? 0] = 0.4;
        /* Point the active-edge overlay at this moment's path. */
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

      if (flyingNode && flying.current) {
        /* The memory itself makes the trip, growing or shrinking as it goes. */
        flyingPos.lerpVectors(flying.current.from, flying.current.to, e);
        const idx = flying.current.index;
        if (m.kind === "add") nodeScale.current[idx] = e;
        else nodeScale.current[idx] = 1 - e;
      } else if (pulse.current && halo.current) {
        /* Consumes and edits send the signal pulse instead. */
        pulse.current.visible = true;
        pulse.current.position.lerpVectors(r.a, r.b, e);
        pulse.current.scale.setScalar(Math.max(0.02, 0.075 * envelope));
        halo.current.visible = true;
        halo.current.position.copy(pulse.current.position);
        halo.current.scale.setScalar(Math.max(0.02, 0.19 * envelope));
        const hmat = halo.current.material as THREE.MeshBasicMaterial;
        hmat.opacity = 0.22 * envelope;
      }
      const lineMat = activeLine.current?.material as THREE.LineBasicMaterial | null;
      if (lineMat) lineMat.opacity = 0.85 * Math.min(1, j.t / 0.12, (1 - j.t) / 0.12 + 0.4);
      if (j.t >= 1) {
        j.phase = "dwell";
        j.timer = 0.85 + Math.random() * 0.45;
        flying.current = null;
        if (m.kind === "consume") agentGlow.current[AGENT_INDEX.get(m.agent) ?? 0] = 1;
        if (m.kind === "add") glow.current[NODE_INDEX.get(m.node) ?? 0] = 1;
        if (m.kind === "remove") pruned.current.add(m.node);
      }
    }

    /* Labels: the acting node, its evidence, and every agent. Labels flip
       to the left of their node when they would cross the card edge —
       measured against the label's real width. */
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
      const nodeLocal = flyingNode && flying.current ? flyingPos : LAYOUT.get(moment.node)!;
      const to = nodeToScreen(nodeLocal);
      placeLabel(labelToRef.current, to.x, to.y - 26, labelAlpha.current * 0.95);
      if (moment.evidence) {
        const from = nodeToScreen(LAYOUT.get(moment.evidence)!);
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
      <directionalLight position={[3, 5, 6]} intensity={0.9} color="#fff6e8" />
      <directionalLight position={[-4, -2, -5]} intensity={0.3} color="#dfe8ff" />

      <group ref={root}>
        <lineSegments geometry={edgeGeo}>
          <lineBasicMaterial vertexColors transparent opacity={0.6} depthWrite={false} />
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

        {/* The signal in flight for consumes/edits. Adds and prunes send the
            memory itself instead. */}
        <mesh ref={pulse} visible={false}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={SIGNAL} />
        </mesh>
        <mesh ref={halo} visible={false}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={SIGNAL} transparent opacity={0.2} depthWrite={false} />
        </mesh>
      </group>

      {/* The agents live outside the swaying graph: fixed anchors, always
          billboarded, logo-first. */}
      {AGENTS.map((agent, i) => (
        <mesh
          key={agent.id}
          ref={(m) => {
            agentPlanes.current[i] = m;
          }}
          position={agent.pos}
        >
          <planeGeometry args={[0.72, 0.72]} />
          <meshBasicMaterial
            map={agentTextures[i]}
            transparent
            depthWrite={false}
          />
        </mesh>
      ))}

      <points ref={stars} geometry={starGeo}>
        <pointsMaterial color="#8a8677" size={0.03} sizeAttenuation transparent opacity={0.13} depthWrite={false} />
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
            gl={{
              antialias: true,
              alpha: true,
              powerPreference: "high-performance",
              /* Flat UI colors (the clay claude, the signal amber) must not
                 be pushed through a filmic curve — ACES is what made the
                 claude mark read as red. */
              toneMapping: THREE.NoToneMapping,
            }}
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
