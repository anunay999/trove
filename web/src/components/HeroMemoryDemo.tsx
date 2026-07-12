import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const DEMO_STATES = [
  {
    label: "Source found",
    command: 'recall("What changed before launch?")',
    title: "Launch moved to Friday",
    summary: "Morgan moved the launch after the design review. The previous Wednesday deadline remains in history.",
  },
  {
    label: "Context linked",
    command: 'neighbors("launch-plan", depth: 1)',
    title: "Three related memories",
    summary: "Design review, launch notes, and the owner decision are connected to the current plan.",
  },
  {
    label: "Evidence ready",
    command: 'read("launch-sync-notes", unit: 18)',
    title: "Exact source attached",
    summary: "The answer keeps a direct path back to the sentence that supports it.",
  },
] as const;

export function HeroMemoryDemo() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => setActive((value) => (value + 1) % DEMO_STATES.length), 4200);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const state = DEMO_STATES[active];

  return (
    <div className="hero-product relative flex h-full min-h-[430px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#181816] text-[#f1f0eb] shadow-[0_32px_90px_rgba(8,8,7,0.28)] md:min-h-[540px]">
      <div className="flex h-11 items-center justify-between border-b border-white/10 px-4">
        <span className="font-mono text-[10px] text-white/45">Trove / launch-memory</span>
        <span className="font-mono text-[10px] text-[#dcaa74]">MCP connected</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[10.5rem_1fr]">
        <aside className="hidden border-r border-white/10 p-3 md:block">
          <p className="px-2 py-2 font-mono text-[9px] uppercase tracking-[0.13em] text-white/35">Workspace memory</p>
          <div className="mt-2 grid gap-1 text-[11px] text-white/52">
            {[
              ["Launch plan", "project"],
              ["Launch sync notes", "source"],
              ["Design review", "decision"],
              ["Morgan", "person"],
            ].map(([name, kind], index) => (
              <button
                key={name}
                type="button"
                onClick={() => setActive(index === 0 ? 1 : index === 1 ? 2 : 0)}
                className={`rounded-md px-2.5 py-2 text-left transition-colors ${index === active + 1 || (active === 0 && index === 0) ? "bg-white/8 text-white/85" : "hover:bg-white/5 hover:text-white/75"}`}
              >
                <span className="block">{name}</span>
                <span className="mt-0.5 block font-mono text-[9px] text-white/28">{kind}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="grid min-h-0 grid-rows-[auto_1fr_auto]">
          <div className="border-b border-white/10 px-5 py-4 md:px-7">
            <div className="flex items-center gap-2 font-mono text-[10px] text-white/35">
              <span>Agent recall</span>
              <span className="h-px flex-1 bg-white/8" />
              <span>1,200 tokens</span>
            </div>
            <AnimatePresence mode="wait">
              <motion.code
                key={state.command}
                initial={reduceMotion ? false : { opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.28 }}
                className="mt-4 block font-mono text-[11px] text-[#dcaa74] md:text-xs"
              >
                {state.command}
              </motion.code>
            </AnimatePresence>
          </div>

          <div className="grid min-h-0 md:grid-cols-[1.08fr_0.92fr]">
            <div className="flex min-h-[230px] flex-col p-5 md:p-7 md:pt-12">
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -7 }}
                  transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
                >
                  <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-[#dcaa74]">{state.label}</p>
                  <h3 className="mt-4 max-w-sm text-2xl font-medium leading-tight tracking-[-0.035em] md:text-3xl">{state.title}</h3>
                  <p className="mt-4 max-w-md text-xs leading-relaxed text-white/50 md:text-[13px]">{state.summary}</p>
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="relative hidden border-l border-white/10 bg-[#141412] p-6 md:flex md:flex-col md:pt-12">
              <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-white/30">Evidence excerpt</p>
              <blockquote className="mt-5 text-sm leading-7 text-white/68">
                “We are moving launch to Friday so the design review can land first. Morgan owns the final call.”
              </blockquote>
              <div className="mt-6 border-l border-[#dcaa74]/70 pl-3">
                <p className="text-[11px] font-medium text-white/72">Launch sync notes</p>
                <p className="mt-1 font-mono text-[9px] text-white/30">July 11 / paragraph 18</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-white/10 px-5 py-3 md:px-7">
            {DEMO_STATES.map((item, index) => (
              <button
                key={item.label}
                type="button"
                aria-label={`Show ${item.label.toLowerCase()}`}
                onClick={() => setActive(index)}
                className={`h-1 rounded-full transition-all ${active === index ? "w-8 bg-[#dcaa74]" : "w-4 bg-white/14 hover:bg-white/28"}`}
              />
            ))}
            <span className="ml-auto font-mono text-[9px] text-white/28">example workspace</span>
          </div>
        </div>
      </div>
    </div>
  );
}
