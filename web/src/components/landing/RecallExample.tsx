import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

const WRITES = [
  {
    when: "Jun 3",
    agent: "Codex",
    summary: "Run npm install.",
    source: "README.md",
    note: "first version",
  },
  {
    when: "Oct 21",
    agent: "Claude Code",
    summary: "Use pnpm. npm rewrites the lockfile.",
    source: "CONTRIBUTING.md, line 12",
    note: "revises the June note",
  },
] as const;

/**
 * One fact, written by two agents months apart, recalled by a third.
 * Every line is a real tool call shape (remember / recall); nothing here is an
 * illustration of the product, it is the product's output.
 */
export function RecallExample() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const show = reduceMotion || inView;

  const step = (i: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 8 },
    animate: show ? { opacity: 1, y: 0 } : undefined,
    // The read step waits for the recall card to light up (1.5s + 0.7s).
    transition: { duration: 0.5, delay: i < 3 ? i * 0.6 : 2.4, ease: EASE },
  });

  return (
    <div ref={ref} className="overflow-hidden rounded-xl border border-border bg-[var(--card)] font-mono text-[12.5px] leading-relaxed">
      {WRITES.map((w, i) => (
        <motion.div key={w.when} {...step(i)} className="border-b border-border p-4">
          <p className="tnum text-muted-foreground">
            {w.when} &middot; {w.agent}
          </p>
          <p className="mt-1.5 text-foreground">
            <span className="font-medium text-foreground">remember</span> &ldquo;Install dependencies&rdquo;
          </p>
          <p className="text-foreground">{w.summary}</p>
          <p className="mt-1 text-muted-foreground">
            source {w.source} &middot; {w.note}
          </p>
        </motion.div>
      ))}

      <motion.div {...step(2)} className="p-4">
        <p className="tnum text-muted-foreground">Oct 28 &middot; Cursor</p>
        <p className="mt-1.5 text-foreground">
          <span className="font-medium text-foreground">recall</span> &ldquo;how do I install dependencies?&rdquo;
        </p>

        <motion.div
          initial={reduceMotion ? false : { borderColor: "var(--border)" }}
          animate={show ? { borderColor: "var(--signal)" } : undefined}
          transition={{ duration: 0.7, delay: reduceMotion ? 0 : 1.5, ease: [0.32, 0.72, 0, 1] }}
          className="mt-3 rounded-lg border border-border bg-[var(--background)] p-3 font-sans text-sm"
        >
          <p className="font-medium text-foreground">Install dependencies</p>
          <p className="mt-0.5 text-foreground">Use pnpm. npm rewrites the lockfile.</p>
          <blockquote className="mt-3 border-t border-border pt-3 text-[13px] text-muted-foreground">
            <span className="font-mono text-[12px]">CONTRIBUTING.md, line 12</span>
            <span className="mt-1 block text-foreground/85">&ldquo;Always install with pnpm. npm rewrites the lockfile.&rdquo;</span>
          </blockquote>
        </motion.div>
      </motion.div>

      <motion.div {...step(3)} className="border-t border-border p-4">
        <p className="text-foreground">
          <span className="font-medium text-foreground">read</span> &ldquo;Install dependencies&rdquo; asOf Jun 3
        </p>
        <p className="text-muted-foreground">
          <span className="line-through decoration-muted-foreground/70">Run npm install.</span> Replaced, not deleted.
        </p>
      </motion.div>
    </div>
  );
}
