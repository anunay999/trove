import { motion, useReducedMotion } from "motion/react";
import { AgentLogos } from "@/components/AgentLogos";
import { DashboardProof } from "@/components/DashboardProof";
import { GrepSection } from "@/components/GrepSection";
import { HeroCapture } from "@/components/hero/HeroCapture";
import { WaitlistForm } from "@/components/WaitlistForm";

type LandingProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

export function Landing({ onJoin, onLogin, onConnectKey }: LandingProps) {
  const reduceMotion = useReducedMotion();

  return (
    <main className="landing-shell relative flex-1 overflow-hidden">
      <HeroCapture onJoin={onJoin} onLogin={onLogin} onConnectKey={onConnectKey} />

      <AgentLogos />

      <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10">
        <div className="max-w-4xl">
          <h2 className="text-4xl font-medium leading-[1.02] tracking-[-0.05em] md:text-7xl">
            Chat history expires.<br />Memory compounds.
          </h2>
          <p className="mt-7 max-w-[40rem] text-base leading-relaxed text-muted-foreground md:text-lg">
            Trove turns sources, notes, and agent discoveries into durable knowledge with proof and history.
          </p>
        </div>

        <div className="mt-20 grid gap-14 md:grid-cols-[1.25fr_0.75fr] md:gap-20">
          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 22 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
            className="border-l-2 border-[var(--signal)] pl-6 text-2xl font-medium leading-snug tracking-tight md:pl-9 md:text-4xl"
          >
            When a fact changes, the old belief stays inspectable. The latest answer never erases how you got there.
          </motion.p>
          <div className="grid content-start gap-8">
            {[
              ["Evidence first", "Every memory points back to the source text that earned it."],
              ["Time aware", "Ask what is true now, or what the graph believed before."],
              ["Agent native", "Claude, Codex, Gemini, scripts, and your tools share one graph."],
            ].map(([title, body], index) => (
              <motion.div key={title} initial={reduceMotion ? false : { opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.6 }} transition={{ duration: 0.55, delay: index * 0.07 }}>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <GrepSection />

      <DashboardProof />

      <section className="border-t border-border px-6 py-24 md:py-32 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-12 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <h2 className="max-w-3xl text-4xl font-medium leading-[1.02] tracking-[-0.05em] md:text-6xl">
                Give your agents something worth remembering.
              </h2>
              <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
                Join early access. Your private graph will be ready when your account opens.
              </p>
            </div>
            <div className="w-full md:w-[31rem]">
              <WaitlistForm onJoin={onJoin} idPrefix="footer" />
            </div>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-10">
        <span>Trove. Evidence-backed memory for agents.</span>
        <a href="https://github.com/anunay999/trove" target="_blank" rel="noreferrer noopener" className="font-medium text-foreground hover:underline">
          View source on GitHub
        </a>
      </footer>
    </main>
  );
}
