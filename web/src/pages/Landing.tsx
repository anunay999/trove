import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { AgentLogos } from "@/components/AgentLogos";
import { DashboardProof } from "@/components/DashboardProof";
import { FaqSection } from "@/components/FaqSection";
import { GrepSection } from "@/components/GrepSection";
import { HeroStream } from "@/components/hero/HeroStream";
import { HowItWorks } from "@/components/HowItWorks";
import { WaitlistForm } from "@/components/WaitlistForm";

type LandingProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

const PRIMITIVES: Array<[string, string, string]> = [
  ["01", "Recall you can trust", "Every memory cites the exact source span that justifies it — or is visibly marked as agent inference. Audit any fact down to its quote."],
  ["02", "History that never rewrites itself", "Beliefs change by supersession, never deletion. Ask what's true now — or what the graph believed last March."],
  ["03", "Five minutes to first recall", "One MCP endpoint for Claude, Codex, Cursor, and your scripts. Scoped keys per agent, a private graph per account, nothing else to wire up."],
];

/** One word of a scroll-driven reveal: opacity tied to its slice of the scroll range. */
function RevealWord({ progress, range, children }: { progress: MotionValue<number>; range: [number, number]; children: string }) {
  const opacity = useTransform(progress, range, [0.13, 1]);
  return (
    <motion.span style={{ opacity }} className="mr-[0.26em] inline-block">
      {children}
    </motion.span>
  );
}

/**
 * A statement that materialises as you scroll through it — the reader assembles
 * the sentence, which lands harder than a fade-in ever does.
 */
function RevealText({ text, className }: { text: string; className?: string }) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.88", "end 0.42"] });
  const words = text.split(" ");

  if (reduceMotion) return <span className={className}>{text}</span>;

  return (
    <span ref={ref} className={className}>
      {words.map((word, index) => (
        <RevealWord
          key={`${word}-${index}`}
          progress={scrollYProgress}
          range={[index / words.length, (index + 1) / words.length]}
        >
          {word}
        </RevealWord>
      ))}
    </span>
  );
}

export function Landing({ onJoin, onLogin, onConnectKey }: LandingProps) {
  const reduceMotion = useReducedMotion();

  return (
    <main className="landing-shell relative flex-1 overflow-hidden">
      <div className="grain-overlay" aria-hidden="true" />

      <HeroStream onJoin={onJoin} onLogin={onLogin} onConnectKey={onConnectKey} />

      <AgentLogos />

      {/* The thesis, assembled by the reader's own scroll. */}
      <section className="mx-auto w-full max-w-7xl px-6 py-28 md:py-40 lg:px-10 2xl:max-w-[88rem]">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">The problem</p>
        <h2 className="mt-8 max-w-5xl text-[clamp(2.4rem,5.6vw,4.75rem)] font-medium leading-[1.04] tracking-[-0.045em]">
          <RevealText text="Chat history expires." className="text-muted-foreground" />
          <br />
          <RevealText text="Memory compounds." />
        </h2>
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
          className="mt-10 max-w-[38rem] text-base leading-relaxed text-muted-foreground md:text-lg"
        >
          Trove turns sources, notes, and agent discoveries into durable knowledge with proof and
          history. And every recall strengthens the memories it touches — so the graph gets more
          useful the longer your agents work.
        </motion.p>

        <p className="mt-16 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">What that buys you</p>
        <div className="mt-6 border-t">
          {PRIMITIVES.map(([index, title, body], i) => (
            <motion.div
              key={index}
              initial={reduceMotion ? false : { opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.55, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="grid gap-2 border-b py-8 md:grid-cols-[4.5rem_0.8fr_1.2fr] md:items-baseline md:gap-8 md:py-10"
            >
              <span className="tnum font-mono text-sm text-[var(--signal)]">{index}</span>
              <h3 className="text-xl font-medium tracking-tight md:text-2xl">{title}</h3>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground md:justify-self-end">{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <HowItWorks />

      <GrepSection />

      <DashboardProof />

      <FaqSection />

      {/* Closer: one claim, one action, nothing else. */}
      <section className="border-t border-border px-6 py-28 md:py-40 lg:px-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <h2 className="text-[clamp(2.2rem,4.8vw,3.9rem)] font-medium leading-[1.05] tracking-[-0.045em]">
            Give your agents something worth remembering.
          </h2>
          <p className="mt-6 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
            Join early access. Your private graph will be ready when your account opens.
          </p>
          <div className="mt-10 w-full max-w-md">
            <WaitlistForm onJoin={onJoin} idPrefix="footer" />
          </div>
          <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Open source (AGPL-3.0) · Self-host anytime · Export to Obsidian
          </p>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-10 2xl:max-w-[88rem]">
        <span>Trove. Evidence-backed memory for agents.</span>
        <a href="https://github.com/anunay999/trove" target="_blank" rel="noreferrer noopener" className="font-medium text-foreground transition-colors hover:text-[var(--signal)]">
          View source on GitHub
        </a>
      </footer>
    </main>
  );
}
