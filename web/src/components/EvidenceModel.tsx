import { motion, useReducedMotion } from "motion/react";

const CAPABILITIES = [
  { title: "Keyword search", body: "Exact strings and regex, straight at your notes and the raw sources behind them." },
  { title: "Semantic retrieval", body: "Ask in plain language. Results are ranked by meaning and packed to the token budget you set." },
  { title: "Relationship expansion", body: "One hop out through the graph pulls in what the answer depends on." },
  { title: "Historical tracking", body: "Beliefs are superseded, never deleted. Ask what was true then, not only now." },
];

const RESULTS = [
  { n: "01", name: "memory / deployment-patterns", scope: "repo: atlas", links: 2, updated: "updated 4m ago" },
  { n: "02", name: "memory / customer-constraints", scope: "notes: discovery", links: 3, updated: "updated 2d ago" },
  { n: "03", name: "memory / api-contract-v2", scope: "docs: internal", links: 4, updated: "updated 11d ago" },
];

/**
 * The evidence model: what a memory carries, and what a retrieval hands back.
 *
 * Left, the four ways in. Right, one recall on the example workspace — each
 * result keeps its scope and provenance, which is the whole point.
 */
export function EvidenceModel() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10 2xl:max-w-[88rem]">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">Evidence model</p>
        <h2 className="mt-5 text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
          Memory that can answer:
          <br />
          <span className="font-serif italic">&ldquo;why do we believe this?&rdquo;</span>
        </h2>
        <p className="mt-6 max-w-[38rem] text-base leading-relaxed text-muted-foreground md:text-lg">
          Trove treats context as a living record. Each node can carry citations, relationships, access scope, and a
          timeline — so retrieval brings back evidence, not a black box.
        </p>
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <ul className="border-t">
          {CAPABILITIES.map((item, i) => (
            <motion.li
              key={item.title}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.5, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-baseline gap-4 border-b py-5"
            >
              <span className="size-1.5 shrink-0 translate-y-[-0.2em] rounded-full bg-[var(--signal)]" />
              <div>
                <p className="text-lg font-medium tracking-tight">{item.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            </motion.li>
          ))}
        </ul>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="self-start overflow-hidden rounded-2xl border bg-[var(--card)]"
        >
          <div className="flex items-center justify-between border-b px-5 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              retrieval / related memories
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">indexed</span>
          </div>

          <pre className="overflow-x-auto border-b bg-[var(--background)] px-5 py-4 font-mono text-[11px] leading-relaxed md:text-[12px]">
            <code>
              <span className="text-[var(--signal)]">recall</span>
              <span className="text-foreground/70">{'({ query: "deployment constraints" })'}</span>
            </code>
          </pre>

          <ol>
            {RESULTS.map((result, index) => (
              <li
                key={result.n}
                className={`grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-1 px-5 py-4 ${index < RESULTS.length - 1 ? "border-b" : ""}`}
              >
                <span className="tnum font-mono text-sm text-[var(--signal)]">{result.n}</span>
                <div className="min-w-0">
                  <p className="truncate font-mono text-[13px] text-foreground">{result.name}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>{result.scope}</span>
                    <span>
                      <span className="tnum text-foreground/80">{result.links}</span> linked memories
                    </span>
                    <span>{result.updated}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <p className="border-t px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Every result keeps its scope and provenance.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
