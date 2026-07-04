import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: "ink" | "accent";
};

/**
 * Ambient force-graph animation: drifting nodes, proximity edges.
 * Used behind the login drawer and the landing hero. Pure canvas —
 * transform/opacity only, honors prefers-reduced-motion.
 */
export function GraphAnimation({ dark, density = 42, className }: {
  dark: boolean;
  density?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let raf = 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    };
    resize();

    const particles: Particle[] = Array.from({ length: density }, (_, index) => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.18 * dpr,
      vy: (Math.random() - 0.5) * 0.18 * dpr,
      r: (Math.random() * 1.6 + 1.1) * dpr,
      hue: index % 9 === 0 ? "accent" : "ink",
    }));

    const ink = dark ? "220, 214, 204" : "47, 52, 55";
    const accent = dark ? "196, 154, 108" : "154, 106, 60";
    const linkDistance = 130 * dpr;

    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      }

      context.lineWidth = 0.6 * dpr;
      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < linkDistance) {
            const alpha = (1 - dist / linkDistance) * 0.22;
            context.strokeStyle = `rgba(${ink}, ${alpha})`;
            context.beginPath();
            context.moveTo(a.x, a.y);
            context.lineTo(b.x, b.y);
            context.stroke();
          }
        }
      }

      for (const p of particles) {
        context.fillStyle = p.hue === "accent" ? `rgba(${accent}, 0.75)` : `rgba(${ink}, 0.45)`;
        context.beginPath();
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fill();
      }

      frame += 1;
      if (!reduceMotion) raf = requestAnimationFrame(draw);
    };

    draw();
    if (reduceMotion && frame === 1) {
      // single static frame is enough
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [dark, density]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
