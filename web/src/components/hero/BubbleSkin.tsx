import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { createBubbleProgram } from "@/components/hero/bubble-shader";

type BubbleSkinProps = {
  /** Decorrelates the flow pattern so no two bubbles share a film. */
  seed: number;
  /** The bubble is bursting: the film stretches, thins, and flares. */
  popping?: boolean;
};

/** Thickness the film settles at when motion is off — mid-band, fully coloured. */
const STILL_TIME = 12;

/**
 * The bubble's film, rendered as real thin-film interference.
 *
 * This is a skin only: it fills its parent and never handles input. Position,
 * drift, hover and burst all stay with the parent's motion element, so the
 * canvas only ever has to answer "what does this film look like right now".
 */
export function BubbleSkin({ seed, popping = false }: BubbleSkinProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read inside the frame loop so a burst doesn't restart the context.
  const poppingRef = useRef(popping);
  poppingRef.current = popping;

  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return;

    const bubble = createBubbleProgram(gl);
    if (!bubble) return;

    gl.useProgram(bubble.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(bubble.uniforms.uSeed, seed);

    // Cap the backing store: these are ~70-110px on screen and a retina
    // bubble at 3x buys nothing but fill rate.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(bubble.uniforms.uResolution, w, h);
    };

    const draw = (seconds: number) => {
      resize();
      gl.uniform1f(bubble.uniforms.uTime, seconds);
      gl.uniform1f(bubble.uniforms.uPop, poppingRef.current ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // A settled film, drawn once, with no loop running.
    if (reduceMotion) {
      draw(STILL_TIME);
      return;
    }

    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      draw((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    // Only the loop is torn down. Deliberately not WEBGL_lose_context: a canvas
    // hands the same context back to every getContext call, so losing it on
    // StrictMode's throwaway first pass leaves the real one dead on arrival.
    // The context goes with the element when the bubble unmounts.
    return () => cancelAnimationFrame(frame);
  }, [seed, reduceMotion]);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}
