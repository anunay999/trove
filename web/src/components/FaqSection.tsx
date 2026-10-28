const FAQS = [
  {
    q: "Which agents can use Trove?",
    a: "Anything that speaks MCP: Claude Code, Codex, Cursor, or claude.ai through the connector. Every key you create reads and writes the same memory, so a fact one agent saves is there for the others.",
  },
  {
    q: "What happens when a fact changes?",
    a: "The new version replaces the old one in recall. The old one is kept, so you can still read what your agents believed on any earlier date.",
  },
  {
    q: "Can I see what my agents wrote?",
    a: "Yes. The dashboard shows every fact your agents wrote, with the source behind it, and a graph of how the facts connect. Nothing an agent writes is hidden from you.",
  },
  {
    q: "Do I have to use the hosted version?",
    a: "No. Trove is open source under AGPL-3.0. Run it yourself with Node and Docker, and export everything to Obsidian whenever you like.",
  },
];

export function FaqSection() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 md:py-32 lg:px-10 2xl:max-w-[88rem]">
      <h2 className="text-3xl font-medium tracking-[-0.035em] md:text-4xl">Questions</h2>
      <div className="mt-10 border-t border-border">
        {FAQS.map((item) => (
          <div key={item.q} className="grid gap-3 border-b border-border py-7 md:grid-cols-[0.9fr_1.1fr] md:gap-12">
            <h3 className="text-base font-medium md:text-lg">{item.q}</h3>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{item.a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
