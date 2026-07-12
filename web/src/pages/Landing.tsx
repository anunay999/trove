import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AgentLogos } from "@/components/AgentLogos";
import { HeroMemoryDemo } from "@/components/HeroMemoryDemo";
import { MemoryStory } from "@/components/MemoryStory";

type LandingProps = {
  dark: boolean;
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

const reveal = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0 },
};

function WaitlistForm({ onJoin, compact = false }: {
  onJoin: (email?: string) => void;
  compact?: boolean;
}) {
  const [email, setEmail] = useState("");

  return (
    <form
      className={`flex w-full gap-2 ${compact ? "max-w-lg" : "max-w-md"}`}
      onSubmit={(event) => {
        event.preventDefault();
        onJoin(email.trim() || undefined);
      }}
    >
      <label className="sr-only" htmlFor={compact ? "footer-email" : "hero-email"}>
        Work email
      </label>
      <input
        id={compact ? "footer-email" : "hero-email"}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Work email"
        autoComplete="email"
        className="h-12 min-w-0 flex-1 rounded-lg border border-foreground/20 bg-background/75 px-4 text-sm text-foreground shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_5%,transparent)] outline-none backdrop-blur placeholder:text-muted-foreground focus:border-[var(--signal)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--signal)_24%,transparent)]"
      />
      <button
        type="submit"
        className="h-12 shrink-0 whitespace-nowrap rounded-lg bg-[var(--cta-bg)] px-5 text-sm font-semibold text-[var(--cta-fg)] shadow-[0_10px_28px_color-mix(in_srgb,var(--cta-bg)_18%,transparent)] transition-transform hover:-translate-y-0.5 active:translate-y-px"
      >
        Join waitlist
      </button>
    </form>
  );
}

export function Landing({ onJoin, onLogin, onConnectKey }: LandingProps) {
  const reduceMotion = useReducedMotion();

  return (
    <main className="landing-shell relative flex-1 overflow-hidden">
      <section className="relative mx-auto grid min-h-[calc(100dvh-3.5rem)] w-full max-w-7xl grid-cols-1 items-center gap-10 px-6 py-12 md:grid-cols-[0.92fr_1.08fr] md:py-16 lg:gap-16 lg:px-10">
        <motion.div
          initial={reduceMotion ? false : "hidden"}
          animate="visible"
          variants={reveal}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 max-w-xl"
        >
          <h1 className="max-w-[16ch] text-[clamp(3.15rem,5vw,4rem)] font-medium leading-[0.94] tracking-[-0.06em] text-foreground">
            The memory layer for your AI agents.
          </h1>
          <p className="mt-7 max-w-[31rem] text-base leading-relaxed text-muted-foreground md:text-lg">
            Store sourced facts, preserve changes, and recall only what fits the context.
          </p>
          <div className="mt-8">
            <WaitlistForm onJoin={onJoin} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
            <button type="button" onClick={onLogin} className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
              Log in
            </button>
            <button type="button" onClick={onConnectKey} className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
              Use an API key
            </button>
          </div>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98, x: 28 }}
          animate={{ opacity: 1, scale: 1, x: 0 }}
          transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="relative min-h-[430px] md:min-h-[540px]"
        >
          <HeroMemoryDemo />
        </motion.div>
      </section>

      <AgentLogos />

      <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10">
        <div className="max-w-3xl">
          <h2 className="text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
            Chat history is not memory.
          </h2>
          <p className="mt-6 max-w-[40rem] text-base leading-relaxed text-muted-foreground md:text-lg">
            Trove turns scattered notes, sources, and agent discoveries into durable knowledge with proof and history.
          </p>
        </div>
        <div className="mt-16 grid grid-cols-1 gap-12 md:grid-cols-[1.2fr_0.8fr] md:gap-20">
          <div className="border-l-2 border-[var(--signal)] pl-6 md:pl-9">
            <p className="text-2xl font-medium leading-snug tracking-tight md:text-4xl">
              When a fact changes, the old belief stays inspectable. Nothing important disappears behind the latest answer.
            </p>
          </div>
          <div className="grid content-start gap-8">
            {[
              ["Evidence first", "Every memory points back to the source text that earned it."],
              ["Time aware", "Ask what is true now, or what the team believed last Tuesday."],
              ["Agent native", "Claude, Codex, Gemini, scripts, and your own tools share one graph."],
            ].map(([title, body]) => (
              <div key={title}>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-[color-mix(in_srgb,var(--card)_76%,transparent)] backdrop-blur-sm">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10">
          <h2 className="max-w-2xl text-4xl font-medium leading-[1.04] tracking-[-0.045em] md:text-6xl">
            See a memory become useful.
          </h2>
          <p className="mt-5 max-w-[38rem] text-base leading-relaxed text-muted-foreground">
            One simple project update shows the whole system: capture, connect, revise, and recall.
          </p>
          <MemoryStory />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-14 px-6 py-24 md:grid-cols-[0.75fr_1.25fr] md:items-start md:py-32 lg:px-10">
        <div className="md:sticky md:top-24">
          <h2 className="text-4xl font-medium leading-[1.04] tracking-[-0.045em] md:text-5xl">
            Recall that fits the moment.
          </h2>
          <p className="mt-5 max-w-md leading-relaxed text-muted-foreground">
            Trove ranks the graph, keeps the evidence, and returns only what the current context can afford.
          </p>
        </div>
        <div className="overflow-hidden rounded-2xl border bg-[#171716] text-[#f3f1eb] shadow-[0_24px_70px_rgba(15,15,14,0.16)]">
          <div className="border-b border-white/10 px-5 py-4 font-mono text-[11px] text-white/50">agent.ts</div>
          <pre className="overflow-x-auto p-6 font-mono text-[12px] leading-7 md:p-8 md:text-[13px]"><code><span className="text-[#c6a17d]">const</span> context = <span className="text-[#c6a17d]">await</span> trove.recall({`{\n`}  query: <span className="text-[#c7d0b3]">&quot;What changed before launch?&quot;</span>,{`\n`}  token_budget: <span className="text-[#dfb07e]">1200</span>,{`\n`}  include_evidence: <span className="text-[#dfb07e]">true</span>{`\n}`});</code></pre>
          <div className="grid gap-px bg-white/10 md:grid-cols-2">
            <div className="bg-[#1d1d1b] p-6">
              <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-white/40">What returns</span>
              <p className="mt-3 text-sm leading-relaxed text-white/75">The current deadline, its previous value, the decision source, and nearby project context.</p>
            </div>
            <div className="bg-[#1d1d1b] p-6">
              <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-white/40">What stays out</span>
              <p className="mt-3 text-sm leading-relaxed text-white/75">Old chatter and weak matches that would waste the agent’s limited context.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-border px-6 py-24 md:py-32 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-12 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <h2 className="max-w-3xl text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
                Give your agents something worth remembering.
              </h2>
              <p className="mt-5 max-w-xl text-sm leading-relaxed opacity-65 md:text-base">
                Join the early access list. Your graph will be ready when your account opens.
              </p>
            </div>
            <div className="w-full md:w-[30rem]">
              <WaitlistForm onJoin={onJoin} compact />
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
