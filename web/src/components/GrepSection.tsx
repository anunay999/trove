import { motion, useReducedMotion } from "motion/react";

const ROUTES = [
  {
    tool: "grep",
    when: "You know the string",
    call: [
      { text: "grep", accent: true },
      { text: '({ pattern: "ECONNRESET", scope: "all" })' },
    ],
    lead: "Exact match or regex, straight at the text.",
    body: "One database query — no embedding call, no model in the loop. It reads your notes and the raw sources behind them, and hands back excerpts with ids so the agent can read the full note only if it needs to.",
    notes: ["Searches notes and sources", "Case-sensitive when you ask", "Invalid regex falls back to a literal scan"],
  },
  {
    tool: "recall",
    when: "You have a question",
    call: [
      { text: "recall", accent: true },
      { text: '({ query: "why did we move off Fly?" })' },
    ],
    lead: "Ranked meaning, packed to a budget.",
    body: "Lexical and semantic search together, then one hop out through the graph to pull in what the answer depends on — packed into the token budget you set, with evidence attached.",
    notes: ["Hybrid lexical + semantic", "One-hop graph expansion", "Returns a brief, not the whole note"],
  },
];

/**
 * Read routing: the two tools an agent picks between, and why.
 *
 * The distinction the docs push is query shape, not speed — an id or an error
 * string wants grep; an open question wants recall. Copy stays on that ground:
 * the repo has no grep benchmark, so the only honest speed claim is the one the
 * code makes structurally — grep never calls the embedding provider.
 */
export function GrepSection() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--signal)]">Read routing</p>
        <h2 className="mt-5 text-4xl font-medium leading-[1.02] tracking-[-0.045em] md:text-6xl">
          Your agent already knows
          <br />
          what it&apos;s looking for.
        </h2>
        <p className="mt-6 max-w-[38rem] text-base leading-relaxed text-muted-foreground md:text-lg">
          Agents have reached for grep since the first one shipped. When the string is known — a ticket id, an error, a
          config key — searching by meaning is the long way round.
        </p>
      </div>

      <div className="mt-14 grid overflow-hidden rounded-2xl border md:grid-cols-2">
        {ROUTES.map((route, index) => (
          <motion.div
            key={route.tool}
            initial={reduceMotion ? false : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, delay: index * 0.1, ease: [0.16, 1, 0.3, 1] }}
            className={`bg-[var(--card)] p-6 md:p-9 ${index === 0 ? "border-b md:border-b-0 md:border-r" : ""}`}
          >
            <div className="flex items-baseline justify-between gap-4">
              <p className="font-mono text-lg font-medium tracking-tight text-foreground">{route.tool}</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{route.when}</p>
            </div>

            <pre className="mt-5 overflow-x-auto rounded-lg border bg-[var(--background)] p-4 font-mono text-[11px] leading-relaxed md:text-[12px]">
              <code>
                {route.call.map((part) => (
                  <span key={part.text} className={part.accent ? "text-[var(--signal)]" : "text-foreground/70"}>
                    {part.text}
                  </span>
                ))}
              </code>
            </pre>

            <p className="mt-6 text-lg font-medium tracking-tight">{route.lead}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{route.body}</p>

            <ul className="mt-6 grid gap-2 border-t pt-5">
              {route.notes.map((note) => (
                <li key={note} className="flex items-baseline gap-2.5 font-mono text-[10px] text-muted-foreground">
                  <span className="size-1 shrink-0 rounded-full bg-[var(--signal)]" />
                  {note}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>

      <p className="mt-8 max-w-[42rem] text-sm leading-relaxed text-muted-foreground">
        Both run against your own private graph, scoped to your credential. Nothing is shared between accounts.
      </p>
    </section>
  );
}
