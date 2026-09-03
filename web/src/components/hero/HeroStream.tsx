import { Suspense, lazy } from "react";
import { motion, useReducedMotion } from "motion/react";
import { StaggeredHeadline } from "@/components/hero/StaggeredHeadline";
import { WaitlistForm } from "@/components/WaitlistForm";

// Three.js is the heaviest thing on the page, and most visitors already have
// what they came for. Split it out; the skeleton holds the card's exact
// heights so nothing jumps when the scene streams in.
const MemoryGraphScene = lazy(() =>
  import("@/components/hero/MemoryGraphScene").then((m) => ({ default: m.MemoryGraphScene })),
);

function GraphSceneSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border bg-[var(--card)]/70">
      <div className="h-11 border-b 2xl:h-12" />
      <div className="h-[23rem] md:h-[25rem] 2xl:h-[31rem]" />
      <div className="h-[3.75rem] border-t" />
    </div>
  );
}

type HeroStreamProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

/**
 * The hero: the claim on the left, the graph running on the right.
 *
 * The scene is not an illustration of the pitch — it is the pitch: the same
 * seed graph the inspectable MiniGraph draws, with one recall pulse at a
 * time tracing evidence toward memory. Copy stays left-aligned and
 * asymmetric; the centred-hero look was the generic one.
 */
export function HeroStream({ onJoin, onLogin, onConnectKey }: HeroStreamProps) {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative isolate flex min-h-[calc(100dvh-3.5rem)] flex-col overflow-hidden">
      {/* Blueprint grid — the only set dressing. */}
      <div className="hero-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto grid w-full max-w-7xl flex-1 items-center gap-14 px-6 pb-20 pt-14 lg:grid-cols-[1.02fr_0.98fr] lg:gap-20 lg:px-10 lg:py-16 2xl:max-w-[88rem]">
        <div className="w-full">
          <motion.p
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
            className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground"
          >
            <span className="live-dot size-1.5 rounded-full bg-[var(--signal)]" />
            Memory infrastructure for agents
          </motion.p>

          <div className="mt-7">
            <StaggeredHeadline lines={["Your agent remembers.", "Its sources", "come with it."]} accent="remembers" />
          </div>

          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.55 }}
            className="mt-7 max-w-[27rem] text-base leading-relaxed text-muted-foreground"
          >
            Trove is an open-source, self-hostable memory layer for persistent AI agents — built to
            preserve context, connect the dots, and make every remembered fact inspectable.
          </motion.p>

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.68 }}
            className="mt-9 flex w-full max-w-md flex-col"
          >
            <WaitlistForm onJoin={onJoin} idPrefix="hero" />
            <div className="mt-4 flex items-center gap-5 text-[13px] text-muted-foreground">
              <button
                type="button"
                onClick={onLogin}
                className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
              >
                Log in
              </button>
              <button
                type="button"
                onClick={onConnectKey}
                className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
              >
                Use an API key
              </button>
            </div>
            <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Source-linked · Self-hostable · History-aware
            </p>
          </motion.div>
        </div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          <Suspense fallback={<GraphSceneSkeleton />}>
            <MemoryGraphScene />
          </Suspense>
        </motion.div>
      </div>
    </section>
  );
}
