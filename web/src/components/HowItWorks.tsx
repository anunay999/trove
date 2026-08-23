import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const CONNECT_CMD =
  'claude mcp add trove --transport http https://mytrove.in/mcp \\\n  --header "Authorization: Bearer trove_…"';

const STEPS = [
  {
    n: "01",
    title: "Connect",
    body: "One command points your agent at your graph. Any MCP client works — Claude Code, Codex, Cursor, or your own scripts.",
  },
  {
    n: "02",
    title: "Let it remember",
    body: "As your agents work, they distill what they learn into small nodes — each citing the exact source text that justifies it.",
  },
  {
    n: "03",
    title: "Recall anywhere",
    body: "Next session, next project, next machine. Recall packs the relevant memories, evidence attached, into the token budget you set.",
  },
];

/** Three steps from zero to first recall, anchored on the real connect command. */
export function HowItWorks() {
  const reduceMotion = useReducedMotion();
  const [copied, setCopied] = useState(false);

  const copyCmd = () => {
    void navigator.clipboard.writeText(CONNECT_CMD.replaceAll("\\\n  ", "")).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10 2xl:max-w-[88rem]">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">How it works</p>
        <h2 className="mt-5 text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
          Live in one command.
        </h2>
        <p className="mt-6 max-w-[38rem] text-base leading-relaxed text-muted-foreground md:text-lg">
          No SDK to adopt, no prompts to rewrite. If your agent speaks MCP, it already knows how to use Trove.
        </p>
      </div>

      <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-3">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.n}
            initial={reduceMotion ? false : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.55, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="bg-[var(--card)] p-6 md:p-8"
          >
            <p className="tnum font-mono text-sm text-[var(--signal)]">{step.n}</p>
            <h3 className="mt-5 text-xl font-medium tracking-tight">{step.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="relative mt-6 overflow-hidden rounded-xl border bg-[var(--background)]"
      >
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">terminal</span>
          <button
            type="button"
            onClick={copyCmd}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-[var(--signal)]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground md:p-5 md:text-[12px]">
          <code>
            <span className="text-[var(--signal)]">$ </span>
            {CONNECT_CMD}
          </code>
        </pre>
      </motion.div>
    </section>
  );
}
