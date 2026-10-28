import { motion, useReducedMotion } from "motion/react";
import { AgentLogos } from "@/components/AgentLogos";
import { WaitlistForm } from "@/components/WaitlistForm";
import { FeatureCards } from "@/components/landing/FeatureCards";
import { MemoryTray } from "@/components/landing/MemoryTray";

type LandingProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

const EASE = [0.22, 1, 0.36, 1] as const;

export function Landing({ onJoin, onLogin, onConnectKey }: LandingProps) {
  const reduceMotion = useReducedMotion();
  const enter = (i: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 10, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.6, delay: 0.08 * i, ease: EASE },
  });

  return (
    <main className="landing-shell relative flex-1 overflow-hidden">
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pt-20 text-center md:pt-28">
        <motion.span
          {...enter(0)}
          className="flex items-center gap-2.5 rounded-full border border-border px-3 py-1.5 text-[13px] text-muted-foreground"
        >
          <AgentLogos />
          Works with your agents
        </motion.span>
        <motion.h1
          {...enter(1)}
          className="mt-7 text-balance text-[clamp(2.5rem,6vw,4.5rem)] font-medium leading-[1.02] tracking-[-0.04em]"
        >
          Context that keeps
          <br />
          getting better.
        </motion.h1>
        <motion.p {...enter(2)} className="mt-5 max-w-md text-pretty text-base text-muted-foreground md:text-lg">
          Use Claude alone or every agent you have. Trove keeps what they learn, shows where it came from, and replaces what goes stale.
        </motion.p>
        <motion.div {...enter(3)} className="mt-8 w-full max-w-md">
          <WaitlistForm onJoin={onJoin} idPrefix="hero" />
        </motion.div>
      </section>

      <motion.section {...enter(4)} className="mx-auto mt-10 w-full max-w-3xl px-6">
        <MemoryTray />
      </motion.section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-24 pt-20 md:pb-32">
        <FeatureCards />
      </section>

      <section className="border-t border-border px-6 py-24 md:py-32">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <h2 className="text-balance text-3xl font-medium tracking-[-0.035em] md:text-4xl">One memory. Every agent.</h2>
          <div className="mt-8 w-full">
            <WaitlistForm onJoin={onJoin} idPrefix="footer" />
          </div>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>Trove &middot; open source</span>
        <span className="flex items-center gap-5">
          <button type="button" onClick={onLogin} className="transition-colors hover:text-foreground">
            Log in
          </button>
          <button type="button" onClick={onConnectKey} className="transition-colors hover:text-foreground">
            Use an API key
          </button>
          <a href="https://github.com/anunay999/trove" target="_blank" rel="noreferrer noopener" className="transition-colors hover:text-foreground">
            GitHub
          </a>
        </span>
      </footer>
    </main>
  );
}
