import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  BufferAttribute, BufferGeometry, Color, FogExp2, GridHelper,
  LineBasicMaterial, LineSegments, PerspectiveCamera, Points, Scene,
  ShaderMaterial, Vector3, WebGLRenderer,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";
import { type GraphSnapshot, type NodeType } from "@/lib/api";
import { CHAT_STATE_LABEL, type ChatHighlights } from "@/lib/graphChatState";
import { easeTravel, flightDuration, RetrievalTravel } from "@/lib/graph3DTravel";
import { typeColor } from "@/lib/viz";

type Node3D = { id: string; title: string; type: NodeType; degree: number; x: number; y: number; z: number };
export type Graph3DHandle = { focus: (id: string) => void; fit: (ids?: string[]) => void };
type Props = {
  snapshot: GraphSnapshot; dark: boolean; width: number; height: number;
  selectedId: string | null; neighborIds: Set<string>; focusType: NodeType | null;
  highlights: ChatHighlights; reducedMotion: boolean;
  onSelect: (id: string | null) => void; onFailure: () => void; ref?: Ref<Graph3DHandle>;
};
type Runtime = Graph3DHandle & { resize: (w: number, h: number) => void; update: () => void };

// Screen-space marks keep the graph legible without turning nearby nodes into balls.
const nodeVertex = `
attribute vec3 color;
attribute float emphasis;
attribute float radius;
varying vec3 vColor;
varying float vEmphasis;
varying float vDepth;
varying float vWorldRadius;
uniform float pixelRatio;
uniform float projectionScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  vColor = color;
  vEmphasis = emphasis;
  gl_Position = projectionMatrix * mv;
  float projected = radius * projectionScale / max(1.0, -mv.z);
  float diameter = max(3.5, 54.0 * (1.0 - exp(-projected / 54.0)));
  gl_PointSize = diameter * pixelRatio;
  vWorldRadius = diameter * max(1.0, -mv.z) / projectionScale * 0.5;
}`;
const nodeFragment = `
uniform float cameraNear;
uniform float cameraFar;
varying vec3 vColor;
varying float vEmphasis;
varying float vDepth;
varying float vWorldRadius;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.88, 1.0, r);
  vec2 uv = (gl_PointCoord - 0.5) * 2.0;
  float z = sqrt(max(0.0, 1.0 - dot(uv, uv)));
  // Write the visible sphere surface, rather than the flat point-center plane.
  // This keeps edges behind the molecular body and gives correct node occlusion.
  float surfaceDepth = max(cameraNear, vDepth - z * vWorldRadius);
  float ndcDepth = (cameraFar + cameraNear) / (cameraFar - cameraNear)
    - (2.0 * cameraFar * cameraNear) / ((cameraFar - cameraNear) * surfaceDepth);
  gl_FragDepth = ndcDepth * 0.5 + 0.5;
  float shade = 0.78 + 0.22 * max(0.0, dot(vec3(uv.x, -uv.y, z), normalize(vec3(-0.4, 0.5, 1.0))));
  float rim = smoothstep(vEmphasis > 2.5 ? 0.68 : 0.78, 0.86, r) * min(1.0, vEmphasis);
  vec3 border = vEmphasis > 2.5 ? vec3(0.08, 0.29, 0.22) : vColor * 0.44;
  vec3 ink = mix(vColor * shade, border, rim);
  gl_FragColor = vec4(ink, core);
  #include <colorspace_fragment>
}`;

export default function Graph3D({ ref: forwardedRef, ...props }: Props) {
  const host = useRef<HTMLElement>(null);
  const current = useRef(props);
  useEffect(() => { current.current = props; });
  const runtime = useRef<Runtime | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [travelLabel, setTravelLabel] = useState<string | null>(null);
  useImperativeHandle(forwardedRef, () => ({
    focus: (id) => runtime.current?.focus(id),
    fit: (ids) => runtime.current?.fit(ids),
  }));

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" }); }
    catch { current.current.onFailure(); return; }
    const scene = new Scene();
    const background = new Color(current.current.dark ? "#09110f" : "#f7f7f5");
    scene.background = background;
    scene.fog = new FogExp2(background, 0.0018);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-label", "3D memory graph. Drag to orbit, scroll to zoom; use search to select a memory.");
    const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(100, 65, 360);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 45;
    controls.maxDistance = 1800;
    controls.maxPolarAngle = Math.PI * 0.93;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.7;

    const degree = new Map<string, number>();
    for (const edge of props.snapshot.edges) {
      degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
      degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
    }
    const nodes: Node3D[] = props.snapshot.nodes.map((node) => ({
      id: node.id, title: node.title, type: node.type, degree: degree.get(node.id) ?? 0,
      x: NaN, y: NaN, z: NaN,
    }));
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const knownIds = new Set(index.keys());
    const edges = props.snapshot.edges.filter((edge) => index.has(edge.fromNodeId) && index.has(edge.toNodeId));
    const links = edges.map((edge) => ({ source: edge.fromNodeId, target: edge.toNodeId }));
    const simulation = forceSimulation(nodes, 3)
      .force("link", forceLink(links).id((node: Node3D) => node.id).distance(18).strength(0.75))
      .force("charge", forceManyBody().strength(-10))
      .force("collide", forceCollide(7).strength(0.8))
      .force("x", forceX(0).strength(0.015))
      .force("y", forceY(0).strength(0.015))
      .force("z", forceZ(0).strength(0.015)).stop();
    // Only a small warm-up blocks mounting; the rest is budgeted across frames.
    simulation.tick(12);
    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const radii = new Float32Array(nodes.length);
    const emphasis = new Float32Array(nodes.length);
    const nodeGeometry = new BufferGeometry();
    nodeGeometry.setAttribute("position", new BufferAttribute(positions, 3));
    nodeGeometry.setAttribute("color", new BufferAttribute(colors, 3));
    nodeGeometry.setAttribute("radius", new BufferAttribute(radii, 1));
    nodeGeometry.setAttribute("emphasis", new BufferAttribute(emphasis, 1));
    const nodeMaterial = new ShaderMaterial({
      vertexShader: nodeVertex, fragmentShader: nodeFragment, transparent: true,
      depthWrite: true, uniforms: { pixelRatio: { value: renderer.getPixelRatio() }, projectionScale: { value: 900 }, cameraNear: { value: camera.near }, cameraFar: { value: camera.far } },
    });
    const points = new Points(nodeGeometry, nodeMaterial);
    points.frustumCulled = false;
    scene.add(points);
    const edgePositions = new Float32Array(edges.length * 6);
    const edgeColors = new Float32Array(edges.length * 6);
    const edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute("position", new BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new BufferAttribute(edgeColors, 3));
    const edgeMaterial = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    const edgeLines = new LineSegments(edgeGeometry, edgeMaterial);
    edgeLines.frustumCulled = false;
    scene.add(edgeLines);
    // WebGL's basic lines are one physical pixel; wide-line geometry makes the
    // retrieved connections consistently readable in CSS pixels on every screen.
    const activePositions = new Float32Array(Math.max(1, edges.length) * 6);
    const activeGeometry = new LineSegmentsGeometry();
    activeGeometry.setPositions(activePositions);
    activeGeometry.instanceCount = 0;
    const activeMaterial = new LineMaterial({ color: "#257e62", linewidth: 2.2, transparent: false, depthWrite: false, fog: false });
    const activeLines = new LineSegments2(activeGeometry, activeMaterial);
    activeLines.frustumCulled = false;
    scene.add(activeLines);


    // A single quiet plane is a depth/orientation reference, not decorative stars.
    const grid = new GridHelper(1000, 40, "#25443d", "#152823");
    grid.position.y = -150;
    grid.material.transparent = true;
    grid.material.opacity = current.current.dark ? 0.075 : 0.045;
    scene.add(grid);

    // Moving signals only occupy real snapshot edges whose endpoints were retrieved.
    const signalPositions = new Float32Array(edges.length * 3);
    const signalGeometry = new BufferGeometry();
    signalGeometry.setAttribute("position", new BufferAttribute(signalPositions, 3));
    signalGeometry.setDrawRange(0, 0);
    const signalMaterial = new ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { pixelRatio: { value: renderer.getPixelRatio() }, ink: { value: new Color("#145d47") } },
      vertexShader: `uniform float pixelRatio; void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=7.0*pixelRatio; }`,
      fragmentShader: `uniform vec3 ink; void main(){ float r=length(gl_PointCoord-0.5)*2.0; if(r>1.0)discard; gl_FragColor=vec4(mix(vec3(1.0),ink,smoothstep(0.2,0.55,r)),1.0-smoothstep(0.8,1.0,r)); }`,
    });
    const signals = new Points(signalGeometry, signalMaterial);
    signals.frustumCulled = false;
    scene.add(signals);

    const travel = new RetrievalTravel();
    let flight: { from: Vector3; to: Vector3; lookFrom: Vector3; lookTo: Vector3; start: number; duration: number } | null = null;
    let packed: string[] | undefined;
    let lastHighlight: ChatHighlights | undefined;
    let lastPromotion = 0;
    let hoveredId: string | null = null;
    let travelNodeId: string | null = null;
    let ticks = 12;
    let fitted = false;
    let frame = 0;
    let alive = true;
    let styleDirty = true;
    const activeEdges: number[] = [];
    const point = new Vector3();
    const ink = new Color();
    const direction = new Vector3();

    const move = (lookTo: Vector3, distance: number, automatic = false) => {
      if (automatic && (travel.interrupted || current.current.reducedMotion)) return;
      direction.copy(camera.position).sub(controls.target).normalize();
      if (!Number.isFinite(direction.x) || direction.lengthSq() === 0) direction.set(0.25, 0.15, 1).normalize();
      const to = lookTo.clone().addScaledVector(direction, distance);
      if (current.current.reducedMotion) {
        camera.position.copy(to); controls.target.copy(lookTo); flight = null; return;
      }
      flight = { from: camera.position.clone(), to, lookFrom: controls.target.clone(), lookTo,
        start: performance.now(), duration: automatic ? flightDuration(camera.position.distanceTo(to)) : 700 };
    };
    const fit = (ids?: string[], automatic = false) => {
      const included = ids ? new Set(ids) : null;
      const chosen = included ? nodes.filter((node) => included.has(node.id)) : nodes;
      if (!chosen.length) return;
      const center = new Vector3();
      for (const node of chosen) center.add(point.set(node.x, node.y, node.z));
      center.multiplyScalar(1 / chosen.length);
      let radius = 20;
      for (const node of chosen) radius = Math.max(radius, center.distanceTo(point.set(node.x, node.y, node.z)));
      const vertical = camera.fov * Math.PI / 360;
      const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
      move(center, Math.max(ids ? 150 : 180, radius / Math.sin(angle) * 1.12), automatic);
    };
    const interrupt = () => {
      travel.interrupt(); flight = null; packed = undefined; fitted = true;
      travelNodeId = null; styleDirty = true;
      setTravelLabel(current.current.highlights ? "Exploring freely" : null);
    };
    const update = () => {
      styleDirty = true;
      background.set(current.current.dark ? "#09110f" : "#f7f7f5");
      scene.fog?.color.copy(background);
      grid.material.opacity = current.current.dark ? 0.075 : 0.045;
      const highlights = current.current.highlights;
      if (lastHighlight !== highlights) {
        lastHighlight = highlights;
        travel.ingest(highlights, knownIds);
        lastPromotion = performance.now();
        if (!highlights || highlights.size === 0) {
          flight = null; packed = undefined; travelNodeId = null;
          setTravelLabel(highlights ? "Listening for retrieval" : null);
        }
      }
      if (current.current.reducedMotion) { flight = null; travel.interrupt(); }
    };
    runtime.current = {
      focus(id) {
        const i = index.get(id);
        if (i === undefined) return;
        interrupt();
        const node = nodes[i];
        move(new Vector3(node.x, node.y, node.z), 190);
      },
      fit(ids) {
        if (ids && current.current.highlights !== null) { packed = ids; return; }
        // Panel resize may reframe, but does not take over an active user orbit.
        if (!travel.interrupted) fit(ids);
      },
      resize(w, h) {
        container.style.width = `${Math.max(1, w)}px`;
        container.style.height = `${Math.max(1, h)}px`;
        renderer.setSize(Math.max(1, w), Math.max(1, h));
        camera.aspect = Math.max(1, w) / Math.max(1, h);
        camera.updateProjectionMatrix();
        nodeMaterial.uniforms.projectionScale.value = Math.max(1, h) / (2 * Math.tan(camera.fov * Math.PI / 360));
        activeMaterial.resolution.set(Math.max(1, w), Math.max(1, h));
      }, update,
    };
    runtime.current.resize(current.current.width, current.current.height);
    update();

    const drawPositions = () => {
      nodes.forEach((node, i) => { positions[i * 3] = node.x; positions[i * 3 + 1] = node.y; positions[i * 3 + 2] = node.z; });
      edges.forEach((edge, i) => {
        const a = nodes[index.get(edge.fromNodeId)!], b = nodes[index.get(edge.toNodeId)!];
        edgePositions[i * 6] = a.x; edgePositions[i * 6 + 1] = a.y; edgePositions[i * 6 + 2] = a.z;
        edgePositions[i * 6 + 3] = b.x; edgePositions[i * 6 + 4] = b.y; edgePositions[i * 6 + 5] = b.z;
      });
      nodeGeometry.attributes.position.needsUpdate = true;
      edgeGeometry.attributes.position.needsUpdate = true;
      nodeGeometry.computeBoundingSphere();
    };
    const drawStyles = () => {
      const state = current.current;
      activeEdges.length = 0;
      activeMaterial.color.set(state.dark ? "#68d2a9" : "#257e62");
      signalMaterial.uniforms.ink.value.set(state.dark ? "#9bf1cd" : "#145d47");
      nodes.forEach((node, i) => {
        const lit = state.highlights?.get(node.id);
        const dimmed = (state.focusType !== null && state.focusType !== node.type) ||
          (state.selectedId !== null && node.id !== state.selectedId && !state.neighborIds.has(node.id)) ||
          (state.highlights !== null && !lit);
        ink.set(typeColor(node.type, state.dark)).lerp(new Color(state.dark ? "#8baaa1" : "#82908a"), 0.2);
        if (lit?.state === "cited") ink.lerp(new Color(state.dark ? "#e4b264" : "#c99430"), 0.22);
        if (dimmed) ink.lerp(background, 0.6);
        colors.set([ink.r, ink.g, ink.b], i * 3);
        radii[i] = 5.8 + Math.min(1.6, Math.sqrt(node.degree) * 0.4) + (lit ? 0.7 : 0) + (node.id === state.selectedId || node.id === travelNodeId ? 1.5 : node.id === hoveredId ? 0.7 : 0);
        emphasis[i] = node.id === state.selectedId || node.id === travelNodeId ? 4 : lit?.state === "cited" ? 3 : lit?.state === "packed" ? 2 : lit || node.id === hoveredId ? 1 : 0;
      });
      edges.forEach((edge, i) => {
        const lit = state.highlights?.has(edge.fromNodeId) && state.highlights.has(edge.toNodeId);
        if (lit) activeEdges.push(i);
        ink.set(lit ? (state.dark ? "#6dccaa" : "#318b70") : (state.dark ? "#567e70" : "#899e95"));
        if (state.highlights !== null && !lit) ink.lerp(background, 0.75);
        edgeColors.set([ink.r, ink.g, ink.b, ink.r, ink.g, ink.b], i * 6);
      });
      for (const attribute of ["color", "radius", "emphasis"]) nodeGeometry.attributes[attribute].needsUpdate = true;
      edgeGeometry.attributes.color.needsUpdate = true;
      activeEdges.forEach((edgeIndex, i) => {
        for (let axis = 0; axis < 6; axis++) activePositions[i * 6 + axis] = edgePositions[edgeIndex * 6 + axis];
      });
      activeGeometry.instanceCount = activeEdges.length;
      activeGeometry.attributes.instanceStart.needsUpdate = true;
      activeGeometry.attributes.instanceEnd.needsUpdate = true;
      styleDirty = false;
    };
    const pick = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      let hit: string | null = null;
      let nearest = Infinity;
      nodes.forEach((node, i) => {
        point.set(node.x, node.y, node.z).applyMatrix4(camera.matrixWorldInverse);
        const depth = -point.z;
        if (depth <= 0) return;
        const projected = radii[i] * nodeMaterial.uniforms.projectionScale.value / Math.max(1, depth);
        const radius = Math.max(3.5, 54 * (1 - Math.exp(-projected / 54))) / 2;
        point.applyMatrix4(camera.projectionMatrix);
        if (point.z < -1 || point.z > 1) return;
        const dx = (point.x + 1) * rect.width / 2 - x;
        const dy = (1 - point.y) * rect.height / 2 - y;
        // Match the rendered circle, including a small pointer affordance.
        if (dx * dx + dy * dy <= (radius + 2) ** 2 && depth < nearest) {
          hit = node.id; nearest = depth;
        }
      });
      return hit;
    };
    let press: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => { press = { x: event.clientX, y: event.clientY }; interrupt(); };
    const over = (event: PointerEvent) => {
      if (event.buttons) return;
      const id = pick(event);
      if (id !== hoveredId) {
        hoveredId = id; styleDirty = true;
        const node = id ? nodes[index.get(id)!] : null;
        setHovered(node?.title ?? null);
        renderer.domElement.style.cursor = id ? "pointer" : "grab";
      }
    };
    const up = (event: PointerEvent) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) current.current.onSelect(pick(event));
      press = null;
    };
    const leave = () => { hoveredId = null; setHovered(null); styleDirty = true; };
    const lost = (event: Event) => { event.preventDefault(); alive = false; current.current.onFailure(); };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", over);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointerleave", leave);
    renderer.domElement.addEventListener("wheel", interrupt, { passive: true });
    renderer.domElement.addEventListener("webglcontextlost", lost);
    controls.addEventListener("start", interrupt);

    const animate = (now: number) => {
      if (!alive) return;
      frame = requestAnimationFrame(animate);
      if (ticks < 180) {
        // A large graph gets one tick/frame; small graphs settle sooner.
        const batch = nodes.length > 1000 ? 1 : 3;
        simulation.tick(batch); ticks += batch; drawPositions(); styleDirty = true;
      }
      if (!fitted && ticks >= 90 && !travel.active) { fitted = true; fit(); }
      if (styleDirty) drawStyles();
      if (!flight && !current.current.reducedMotion && !travel.interrupted) {
        const id = travel.next();
        if (id) {
          const node = nodes[index.get(id)!];
          travelNodeId = id; styleDirty = true;
          const highlight = current.current.highlights?.get(id);
          setTravelLabel(`${highlight ? CHAT_STATE_LABEL[highlight.state] : "Retrieved"} · ${node.title}`);
          move(new Vector3(node.x, node.y, node.z), 135, true);
        } else if (packed && now - lastPromotion > 650) {
          fit(packed, true); packed = undefined;
          setTravelLabel("Answer context in view");
        }
      }
      if (flight) {
        const progress = Math.min(1, (now - flight.start) / flight.duration);
        const t = easeTravel(progress);
        camera.position.lerpVectors(flight.from, flight.to, t);
        controls.target.lerpVectors(flight.lookFrom, flight.lookTo, t);
        if (progress >= 1) flight = null;
      }
      controls.update();
      const moving = !current.current.reducedMotion && now - lastPromotion < 7000;
      signalGeometry.setDrawRange(0, moving ? activeEdges.length : 0);
      if (moving) {
        activeEdges.forEach((edgeIndex, i) => {
          const edge = edges[edgeIndex];
          const a = nodes[index.get(edge.fromNodeId)!], b = nodes[index.get(edge.toNodeId)!];
          const t = (now / 1600 + edgeIndex * 0.17) % 1;
          signalPositions[i * 3] = a.x + (b.x - a.x) * t;
          signalPositions[i * 3 + 1] = a.y + (b.y - a.y) * t;
          signalPositions[i * 3 + 2] = a.z + (b.z - a.z) * t;
        });
        signalGeometry.attributes.position.needsUpdate = true;
      }
      try { renderer.render(scene, camera); }
      catch { alive = false; cancelAnimationFrame(frame); current.current.onFailure(); }
    };
    drawPositions();
    frame = requestAnimationFrame(animate);
    return () => {
      alive = false; cancelAnimationFrame(frame); simulation.stop();
      runtime.current = null;
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", over);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("wheel", interrupt);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      controls.removeEventListener("start", interrupt); controls.dispose();
      for (const geometry of [nodeGeometry, edgeGeometry, activeGeometry, signalGeometry, grid.geometry]) geometry.dispose();
      for (const material of [nodeMaterial, edgeMaterial, activeMaterial, signalMaterial, grid.material]) material.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [props.snapshot]);

  useEffect(() => { runtime.current?.resize(props.width, props.height); }, [props.width, props.height]);
  useEffect(() => { runtime.current?.update(); }, [props.selectedId, props.neighborIds, props.focusType, props.highlights, props.reducedMotion, props.dark]);
  return <section ref={host} className="relative h-full w-full overflow-hidden" aria-label="3D graph explorer">
    {hovered ? <p className="pointer-events-none absolute left-1/2 top-4 z-10 max-w-sm -translate-x-1/2 rounded-lg bg-card px-3 py-2 text-xs text-foreground shadow-sm">{hovered}</p> : null}
    {travelLabel ? <p role="status" aria-live="off" className="pointer-events-none absolute right-4 top-4 z-10 max-w-48 rounded-lg bg-card px-3 py-2 text-right text-xs text-muted-foreground sm:max-w-xs">{travelLabel}</p> : null}
  </section>;
}
