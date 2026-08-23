import { motion, useReducedMotion } from "motion/react";

const FAQS = [
  {
    q: "What exactly is an evidence graph?",
    a: "Memories aren't floating chat summaries. Each atom in Trove cites the exact source text that justifies it; conclusions drawn without a source stay visibly marked as agent inference, and a linter flags evidence-free nodes for review.",
  },
  {
    q: "Which agents can use Trove?",
    a: "Anything that speaks MCP — Claude Code, Codex, Cursor, or claude.ai via the OAuth connector. The toolset is small and verb-per-job: remember, recall, grep, read, connect, forget.",
  },
  {
    q: "What happens when a fact changes?",
    a: "Old beliefs are superseded, never overwritten. Edges expire with recorded history, so you can ask what your graph believed at any point in time — and get the answer it would have given then.",
  },
  {
    q: "Can I inspect what my agents wrote?",
    a: "Yes. The dashboard shows memory KPIs, write cadence, and lint health, with a force-directed graph explorer and a full-document reader. Nothing an agent wrote is hidden from you.",
  },
  {
    q: "Do I have to trust the hosted service?",
    a: "No. Trove is AGPL-3.0 open source with a production Dockerfile — deploy your own on Railway plus Supabase Postgres in minutes. You can export the whole graph to Obsidian at any time.",
  },
  {
    q: "Can several agents share one graph safely?",
    a: "Every credential is scoped to its own private graph automatically. Keys are tiered — read-only keys see only recall, grep, and read; write and admin tiers add more — and every call is scope-checked server-side.",
  },
  {
    q: "I already keep notes in Obsidian. Do they matter?",
    a: "Point the importer at your vault and it becomes the seed of the graph. Append-heavy files like log.md are split into per-entry episodes and deduped, so re-imports only store what's new.",
  },
  {
    q: "How does recall stay within my token budget?",
    a: "Hybrid lexical and semantic search seeds a one-hop expansion through the graph; candidates are ranked by relevance plus recency-and-frequency activation, and a greedy packer fills the budget you set.",
  },
];

/** Objection handling as a first-class section, per the conversion playbook. */
export function FaqSection() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10 2xl:max-w-[88rem]">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">FAQ</p>
        <h2 className="mt-5 text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
          Reasonable doubts,
          <br />
          answered.
        </h2>
      </div>

      <div className="mt-14 border-t">
        {FAQS.map((item, i) => (
          <motion.div
            key={item.q}
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.5, delay: Math.min(i * 0.04, 0.2), ease: [0.16, 1, 0.3, 1] }}
            className="grid gap-3 border-b py-8 md:grid-cols-[0.9fr_1.1fr] md:gap-12 md:py-9"
          >
            <h3 className="text-lg font-medium tracking-tight md:text-xl">{item.q}</h3>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{item.a}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
