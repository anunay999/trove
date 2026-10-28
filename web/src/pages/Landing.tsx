import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { AgentLogos } from "@/components/AgentLogos";
import { FaqSection } from "@/components/FaqSection";
import { WaitlistForm } from "@/components/WaitlistForm";
import { RecallExample } from "@/components/landing/RecallExample";
import { SetupTabs } from "@/components/landing/SetupTabs";

type LandingProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

const CONTAINER = "mx-auto w-full max-w-7xl px-6 lg:px-10 2xl:max-w-[88rem]";
const EASE = [0.22, 1, 0.36, 1] as const;

// Real instruction files each agent reads today; the second row is the stale one.
const MEMORY_FILES = [
  { agent: "Claude Code", file: "CLAUDE.md", says: "Use pnpm. npm rewrites the lockfile.", age: "edited Tuesday" },
  { agent: "Codex", file: "AGENTS.md", says: "Install with npm.", age: "from June", stale: true },
  { agent: "Cursor", file: ".cursor/rules", says: "Nothing about installing.", age: "" },
];

// Descriptions follow src/toolDefinitions.ts.
const TOOLS = [
  ["remember", "Save a short fact, decision or how-to. Saving the same title again revises it."],
  ["recall", "Ask an open question and get a short brief, with citations."],
  ["grep", "Find an exact string: an error message, a ticket id, a config key."],
  ["read", "Open one note in full, or as it was on an earlier date."],
  ["connect", "Link two notes, like a decision to the project it belongs to."],
  ["forget", "Retire a fact that is no longer true. Its history is kept."],
] as const;

function Hero({ onJoin, onLogin, onConnectKey }: LandingProps) {
  const reduceMotion = useReducedMotion();
  const enter = (i: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 10, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.6, delay: 0.08 * i, ease: EASE },
  });

  return (
    <section className={`${CONTAINER} pb-20 pt-16 md:pb-28 md:pt-24`}>
      <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
        <div>
          <motion.h1
            {...enter(0)}
            className="max-w-[14ch] text-balance text-[clamp(2.6rem,5.4vw,4.5rem)] font-medium leading-[1.02] tracking-[-0.04em]"
          >
            One memory for every agent you run.
          </motion.h1>
          <motion.p {...enter(1)} className="mt-6 max-w-[34rem] text-pretty text-base leading-relaxed text-muted-foreground md:text-lg">
            What Claude Code learns, Codex and Cursor can recall. Every fact cites the file it came from, and when a
            fact changes, the newer version replaces it for every agent at once.
          </motion.p>
          <motion.div {...enter(2)} className="mt-9 max-w-md">
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
          </motion.div>
        </div>

        <motion.div {...enter(3)} className="lg:pt-3">
          <SetupTabs />
          <div className="mt-5">
            <AgentLogos />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Problem() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const show = reduceMotion || inView;

  return (
    <section className={`${CONTAINER} border-t border-border py-24 md:py-32`}>
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <h2 className="max-w-[18ch] text-balance text-3xl font-medium leading-[1.08] tracking-[-0.035em] md:text-[2.75rem]">
            Your agents each remember something different.
          </h2>
          <p className="mt-5 max-w-[30rem] text-pretty leading-relaxed text-muted-foreground">
            Every agent keeps its own memory file. Change a rule in one and the others never hear about it, and none of
            them can tell you where a rule came from.
          </p>
        </div>

        <div ref={ref} className="border-t border-border font-mono text-[13px]">
          {MEMORY_FILES.map((row, i) => (
            <motion.div
              key={row.file}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={show ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.5, delay: i * 0.04, ease: EASE }}
              className="grid grid-cols-[7.5rem_1fr] gap-x-4 gap-y-1 border-b border-border py-4 sm:grid-cols-[7.5rem_1fr_auto]"
            >
              <span className="text-muted-foreground">{row.file}</span>
              <span className="relative w-fit text-foreground">
                {row.says}
                {"stale" in row && (
                  <motion.span
                    aria-hidden="true"
                    initial={reduceMotion ? false : { scaleX: 0 }}
                    animate={show ? { scaleX: 1 } : undefined}
                    transition={{ duration: 0.7, delay: 0.5, ease: [0.32, 0.72, 0, 1] }}
                    className="absolute -bottom-1 left-0 h-px w-full origin-left bg-[var(--signal)]"
                  />
                )}
              </span>
              <span className="col-start-2 text-muted-foreground sm:col-start-auto">
                {row.agent}
                {row.age && <> &middot; {row.age}</>}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Example() {
  return (
    <section className={`${CONTAINER} border-t border-border py-24 md:py-32`}>
      <div className="grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div className="lg:sticky lg:top-24">
          <h2 className="max-w-[18ch] text-balance text-3xl font-medium leading-[1.08] tracking-[-0.035em] md:text-[2.75rem]">
            Ask any agent. Get the current answer and where it came from.
          </h2>
          <p className="mt-5 max-w-[30rem] text-pretty leading-relaxed text-muted-foreground">
            Codex saved a rule in June. Claude Code corrected it in October and cited the file. Today Cursor asks, and
            gets the corrected rule with the line that backs it. The June version is kept, not deleted.
          </p>
        </div>
        <RecallExample />
      </div>
    </section>
  );
}

function Tools() {
  return (
    <section className={`${CONTAINER} border-t border-border py-24 md:py-32`}>
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <h2 className="max-w-[16ch] text-balance text-3xl font-medium leading-[1.08] tracking-[-0.035em] md:text-[2.75rem]">
          Six tools. Your agent learns them in one read.
        </h2>
        <dl className="border-t border-border">
          {TOOLS.map(([name, body]) => (
            <div key={name} className="grid grid-cols-[6.5rem_1fr] gap-4 border-b border-border py-4">
              <dt className="font-mono text-[13px] text-foreground">{name}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Teams() {
  return (
    <section className={`${CONTAINER} border-t border-border py-24 md:py-32`}>
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <p className="text-[13px] text-muted-foreground">Coming soon</p>
          <h2 className="mt-3 max-w-[18ch] text-balance text-3xl font-medium leading-[1.08] tracking-[-0.035em] md:text-[2.75rem]">
            Bring your team when you are ready.
          </h2>
          <p className="mt-5 max-w-[30rem] text-pretty leading-relaxed text-muted-foreground">
            With a team active, what your agent learns about the shared work goes to the team by default, with its
            source, and your teammates&rsquo; agents can recall it. Facts about you, like your preferences, stay
            private. Credentials never reach the team.
          </p>
        </div>
        <div className="grid content-start gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--signal)] bg-[var(--card)] p-4 text-sm">
            <p className="text-foreground">Stripe retries carry the same event ID</p>
            <p className="mt-3 font-mono text-[12px] text-muted-foreground">Team &middot; incident-2026-04-17.md</p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--card)] p-4 text-sm">
            <p className="text-foreground">Prefers terse commit messages</p>
            <p className="mt-3 font-mono text-[12px] text-muted-foreground">Mine</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Hosting() {
  return (
    <section className={`${CONTAINER} border-t border-border py-24 md:py-32`}>
      <h2 className="max-w-[20ch] text-balance text-3xl font-medium leading-[1.08] tracking-[-0.035em] md:text-[2.75rem]">
        Hosted, or on your own machine.
      </h2>
      <div className="mt-10 grid border-t border-border md:grid-cols-3">
        {[
          ["Hosted", "Sign in at mytrove.in, create a key, paste one command."],
          ["Self-hosted", "Node 22 and Docker. The dashboard ships with the server."],
          ["Yours to take", "Open source under AGPL-3.0. Export everything to Obsidian at any time."],
        ].map(([title, body]) => (
          <div key={title} className="border-b border-border py-6 md:border-b-0 md:pr-8 md:pt-6 md:[&:not(:first-child)]:border-l md:[&:not(:first-child)]:pl-8">
            <h3 className="font-medium">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Landing({ onJoin, onLogin, onConnectKey }: LandingProps) {
  return (
    <main className="landing-shell relative flex-1 overflow-hidden">
      <Hero onJoin={onJoin} onLogin={onLogin} onConnectKey={onConnectKey} />
      <Problem />
      <Example />
      <Tools />
      <Teams />
      <Hosting />
      <FaqSection />

      <section className="border-t border-border px-6 py-24 md:py-32 lg:px-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.04em]">
            Every agent you run, working from the same facts.
          </h2>
          <div className="mt-10 w-full max-w-md">
            <WaitlistForm onJoin={onJoin} idPrefix="footer" />
          </div>
        </div>
      </section>

      <footer className={`${CONTAINER} flex flex-col gap-3 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between`}>
        <span>Trove. One memory for your agents.</span>
        <a
          href="https://github.com/anunay999/trove"
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-foreground transition-colors hover:text-[var(--signal)]"
        >
          View source on GitHub
        </a>
      </footer>
    </main>
  );
}
