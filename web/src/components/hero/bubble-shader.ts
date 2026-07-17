/**
 * Thin-film interference shader for the hero bubbles.
 *
 * A soap bubble has no colour of its own. Light reflects off both walls of the
 * film, and the two reflections travel different distances — so for each
 * wavelength they either reinforce or cancel depending on how thick the film is
 * at that spot. That is the entire effect: the magentas and cyans are an
 * interference pattern, not a palette.
 *
 * Three things follow from the physics and they are what sell it:
 *   - The film drains downward, so the crown thins toward black and the belly
 *     pools thick and colourful.
 *   - Reflectance obeys Fresnel, so the middle is nearly a window and the
 *     silhouette blazes. On a dark field that reads as a glowing ring.
 *   - The film is a fluid, so the bands crawl and swirl instead of sitting still.
 */

export const VERTEX_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAGMENT_SRC = `
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform float uSeed;
/** 0..1 as the bubble is about to burst — the film stretches and flares. */
uniform float uPop;

const float PI  = 3.14159265359;
/** Refractive index of soapy water. */
const float IOR = 1.33;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

/*
 * CIE 1931 colour matching functions — how much a given wavelength excites
 * each of the eye's three cone types. Multi-lobe Gaussian fits from Wyman,
 * Sloan & Shirley, "Simple Analytic Approximations to the CIE XYZ Color
 * Matching Functions" (JCGT 2013).
 */
float xFit(float w) {
  float t1 = (w - 442.0) * ((w < 442.0) ? 0.0624 : 0.0374);
  float t2 = (w - 599.8) * ((w < 599.8) ? 0.0264 : 0.0323);
  float t3 = (w - 501.1) * ((w < 501.1) ? 0.0490 : 0.0382);
  return 0.362 * exp(-0.5 * t1 * t1) + 1.056 * exp(-0.5 * t2 * t2) - 0.065 * exp(-0.5 * t3 * t3);
}

float yFit(float w) {
  float t1 = (w - 568.8) * ((w < 568.8) ? 0.0213 : 0.0247);
  float t2 = (w - 530.9) * ((w < 530.9) ? 0.0613 : 0.0322);
  return 0.821 * exp(-0.5 * t1 * t1) + 0.286 * exp(-0.5 * t2 * t2);
}

float zFit(float w) {
  float t1 = (w - 437.0) * ((w < 437.0) ? 0.0845 : 0.0278);
  float t2 = (w - 459.0) * ((w < 459.0) ? 0.0385 : 0.0725);
  return 1.217 * exp(-0.5 * t1 * t1) + 0.681 * exp(-0.5 * t2 * t2);
}

/* Columns, since GLSL mat3 is column-major. Linear sRGB primaries. */
const mat3 XYZ_TO_RGB = mat3(
   3.2406, -0.9689,  0.0557,
  -1.5372,  1.8758, -0.2040,
  -0.4986,  0.0415,  1.0570
);

/*
 * The colour of a film with a given optical path difference, under white light.
 *
 * Sampling three wavelengths and calling them R/G/B is the tempting shortcut and
 * it is what makes CG bubbles look like oil slicks: each channel swings over its
 * full range independently and lands on saturated primaries. Daylight is a
 * continuum, so the eye integrates the interference across the whole visible
 * band — neighbouring wavelengths reinforce and cancel out of step and largely
 * average out. What survives is soap's pale gold, silver and magenta.
 */
vec3 filmColor(float opd) {
  vec3 xyz = vec3(0.0);
  float norm = 0.0;
  for (int i = 0; i < 20; i++) {
    float w = 400.0 + (float(i) + 0.5) * 15.0;
    float I = sin(PI * opd / w);
    I *= I;
    vec3 cmf = vec3(xFit(w), yFit(w), zFit(w));
    xyz += I * cmf;
    norm += cmf.y;
  }
  return max(XYZ_TO_RGB * (xyz / norm), 0.0);
}

/*
 * The room the bubble hangs in.
 *
 * A bubble is a mirror ball seeing a full 180°, so a highlight is an *image of
 * the light source* — which is why, as Glassner put it, it seems to be a law
 * that every bubble photograph reflects a window. A Blinn-Phong lobe cannot
 * produce that: it can only ever return a round dot, which is exactly what a
 * highlight never is.
 *
 * So this is a small HDR environment instead: dim sky over dark ground with a
 * hard horizon, plus a soft-edged window panel a couple of hundred times
 * brighter than the sky. The huge sky/window ratio is the whole trick — the
 * film reflects only ~2% face-on, so nothing but a genuinely bright source
 * leaves a mark, and the panel's shape and mullions come through in the
 * reflection the way they do in a photograph.
 */
vec3 env(vec3 dir) {
  // The room is lit well above the page it sits on. That is a cheat, but the
  // necessary one: the film returns ~2% face-on, so lighting this room to
  // match the near-black background would leave nothing but the window
  // reflections and a hairline rim. Every CG bubble fakes an environment; the
  // ratios within it are what have to stay honest.
  vec3 sky = mix(vec3(0.95, 1.08, 1.38), vec3(1.9, 2.1, 2.6), smoothstep(0.0, 0.8, dir.y));
  vec3 c = mix(vec3(0.10, 0.10, 0.14), sky, smoothstep(-0.05, 0.05, dir.y));

  // The key light, up and behind the camera's left shoulder.
  //
  // A softbox, not a mullioned window. Glazing bars are the more photographic
  // choice and they were the first thing tried — but four bright panes with a
  // cross through them, tinted by the film, are unmistakably the Windows logo.
  // A softbox is just as true to how bubbles are actually shot and reads as
  // nothing but a light. Tilted off-axis for the same reason: an upright
  // rounded rectangle looks like a UI element.
  vec3 W = normalize(vec3(-0.5, 0.55, 0.67));
  float dw = dot(dir, W);
  if (dw > 0.0) {
    vec3 wu = normalize(cross(vec3(0.0, 1.0, 0.0), W));
    vec3 wv = cross(W, wu);
    // Gnomonic projection onto the softbox's plane.
    vec2 p = vec2(dot(dir, wu), dot(dir, wv)) / max(dw, 0.001);
    float ca = cos(-0.38);
    float sa = sin(-0.38);
    p = mat2(ca, -sa, sa, ca) * p;
    vec2 q = abs(p) - vec2(0.13, 0.28);
    float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    // Generously feathered — a hard edge reads as a decal, and a real diffuser
    // falls off toward its borders anyway.
    float panel = 1.0 - smoothstep(-0.05, 0.2, box);
    c += vec3(46.0, 45.5, 43.0) * panel * panel;
  }
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  // Feather the silhouette by one pixel so the edge is not stair-stepped.
  float px = 2.0 / uResolution.y;
  float edge = 1.0 - smoothstep(1.0 - px * 1.5, 1.0, r);

  // Surface normal of the sphere we are looking at, orthographically.
  vec3 N = vec3(uv, sqrt(max(1.0 - r * r, 0.0)));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float cosI = clamp(dot(N, V), 0.0, 1.0);

  // Snell: the ray bends on the way into the film, and the optical path
  // depends on that interior angle, not the incident one.
  float sinT = min(r, 1.0) / IOR;
  float cosT = sqrt(max(1.0 - sinT * sinT, 0.0));

  float t = uTime;

  // --- film thickness, in nanometres ---------------------------------------
  // Gravity drains the film: thick at the bottom, thinning to a black cap on
  // top. Under ~80nm every wavelength cancels at once and the film goes black
  // just before it fails. N.y is height on the sphere.
  //
  // The span is deliberately held to roughly one interference order. Let it
  // run the full 100-900nm and every hue in the spectrum shows at once, which
  // is a rainbow, not a bubble — and at ~80px the fringes would alias anyway.
  float d = mix(540.0, 190.0, smoothstep(-0.95, 1.0, N.y));

  // The film is a fluid. Domain-warped noise, dragged downward, gives the
  // slow turbulent crawl that a still gradient can never fake.
  vec3 q = vec3(N.xy * 2.1, uSeed);
  float warp = fbm(q * 1.7 + vec3(0.0, -t * 0.06, t * 0.03));
  float flow = fbm(q + vec3(warp * 0.9, -t * 0.11 + warp * 0.5, t * 0.05));
  d += (flow - 0.5) * 230.0;

  // Stretching thins the film everywhere, which is why a bubble flashes
  // through its colours right before it goes.
  d *= 1.0 - uPop * 0.45;
  d = max(d, 25.0);

  // --- interference ---------------------------------------------------------
  // Optical path difference between the two wall reflections. The front
  // reflection also flips phase by half a wave, so a path of half a
  // wavelength is what reinforces — hence sin(), not cos(), inside filmColor.
  float opd = 2.0 * IOR * d * cosT;
  vec3 irid = filmColor(opd);

  // --- how much light comes back at all ------------------------------------
  // Schlick, with water's F0. A single wall returns ~2% face-on, so the graph
  // shows straight through the middle; at the silhouette it goes to 1. That
  // ~50x range is why the rim is the dominant feature of a real bubble.
  float F = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);

  // Interference between the film's two walls can push that up by up to 4x,
  // and it is wavelength-dependent — so the *reflectance itself* is coloured.
  // The colour therefore lives in the highlights, which is why a real bubble's
  // hotspots are iridescent rather than white.
  vec3 filmRefl = 4.0 * F * irid;

  // The film is a parallel slab, so it does not refract — a bubble is a hollow
  // mirror shell, not a lens. That means the room arrives twice: upright off
  // the near wall, and inverted off the far wall, which lands at the antipodal
  // point (negate both lateral components of the reflection). The far image is
  // only slightly dimmer, having passed through the near film twice. This
  // doubling is the thing that reads as "bubble" and no lobe can fake it.
  vec3 Rf = reflect(-V, N);
  vec3 Rb = vec3(-Rf.x, -Rf.y, Rf.z);
  vec3 room = env(Rf) + env(Rb) * 0.88;

  vec3 col = room * filmRefl;

  // Stretching thins the film and the whole thing flares just before it fails.
  col *= 1.0 + uPop * 2.2;

  // Straight (un-premultiplied) alpha: the film is visible exactly where it
  // reflects, and transparent where it doesn't.
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  col /= max(a, 0.001);

  // Two-beam interference between perfectly smooth walls is the idealisation.
  // A real film reflects many times internally, is read through its own far
  // wall, and is lit from a whole room rather than one point — all of which
  // average neighbouring hues together. Skipping this is what leaves CG
  // bubbles looking like petrol.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, 0.5);

  // Everything above is linear light; the framebuffer wants sRGB.
  col = pow(col, vec3(1.0 / 2.2));

  gl_FragColor = vec4(col, a * edge);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export type BubbleProgram = {
  program: WebGLProgram;
  uniforms: {
    uResolution: WebGLUniformLocation | null;
    uTime: WebGLUniformLocation | null;
    uSeed: WebGLUniformLocation | null;
    uPop: WebGLUniformLocation | null;
  };
};

/** Compiles the shader and binds a full-viewport triangle pair to draw it on. */
export function createBubbleProgram(gl: WebGLRenderingContext): BubbleProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return null;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  return {
    program,
    uniforms: {
      uResolution: gl.getUniformLocation(program, "uResolution"),
      uTime: gl.getUniformLocation(program, "uTime"),
      uSeed: gl.getUniformLocation(program, "uSeed"),
      uPop: gl.getUniformLocation(program, "uPop"),
    },
  };
}
