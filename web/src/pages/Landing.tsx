import { useState } from "react";
import { AgentLogos } from "@/components/AgentLogos";
import { MemoryStory } from "@/components/MemoryStory";

// Layout adapted from shadcnblocks hero146 (masked grid backdrop, gradient
// headline, metallic CTA) and waitlist3 (badge + inline email join form),
// recomposed for Trove's warm monochrome theme with the live graph canvas
// standing in for stock media.
export function Landing({ dark, onJoin, onLogin, onConnectKey }: {
  dark: boolean;
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
}) {
  const [email, setEmail] = useState("");

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(${dark ? "rgba(220,214,204,0.05)" : "rgba(47,52,55,0.045)"} 1px, transparent 1px), linear-gradient(90deg, ${dark ? "rgba(220,214,204,0.05)" : "rgba(47,52,55,0.045)"} 1px, transparent 1px)`,
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 92% 78% at 50% 28%, #000 32%, transparent 76%)",
          WebkitMaskImage: "radial-gradient(ellipse 92% 78% at 50% 28%, #000 32%, transparent 76%)",
        }}
      />

      <section className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-6 pt-20 md:pt-28">
        <span className="rounded-full border px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Early access
        </span>

        <h1 className="mt-6 max-w-[46rem] bg-gradient-to-br from-foreground via-foreground/85 to-foreground/60 bg-clip-text text-center text-4xl font-semibold leading-[1.08] tracking-tighter text-transparent md:text-6xl">
          Memory your agents keep, so you don't have to
        </h1>

        <p className="mt-5 max-w-[32rem] text-center text-base leading-relaxed text-muted-foreground md:text-lg">
          The memory layer for your AI agents. Every fact keeps its source.
          Every change stays on the record. Recall arrives sized to the context window.
        </p>

        <form
          className="mt-8 flex w-full max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(email.trim() || undefined);
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@domain.com"
            className="h-11 flex-1 rounded-md border-2 border-foreground/25 bg-background px-4 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus:border-foreground/60"
          />
          <button
            type="submit"
            className="h-11 shrink-0 rounded-md border border-foreground/20 bg-gradient-to-b from-foreground/90 via-foreground to-foreground px-5 text-sm font-medium text-background transition-transform active:scale-[0.98]"
          >
            Join the waitlist
          </button>
        </form>

        <p className="mt-4 text-[13px] text-muted-foreground">
          Already have access?{" "}
          <button type="button" onClick={onLogin} className="font-medium text-foreground underline-offset-4 hover:underline">
            Log in
          </button>
          {"  ·  "}
          <button type="button" onClick={onConnectKey} className="font-medium text-foreground underline-offset-4 hover:underline">
            Connect with an API key
          </button>
        </p>

        <MemoryStory />

        <AgentLogos />

        <div className="mb-20 mt-14 grid w-full max-w-4xl grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3">
          {[
            {
              title: "Recall, budgeted",
              body: "One call returns the most relevant memories packed to a token budget, ranked by how often they earn their place.",
            },
            {
              title: "Beliefs with history",
              body: "Facts carry validity intervals. Updates supersede, never overwrite — ask what was believed at any point in time.",
            },
            {
              title: "Wired for agents",
              body: "MCP-native: Claude, Codex, and scripts read and write the same graph with scoped keys you control.",
            },
          ].map((feature) => (
            <div key={feature.title} className="bg-background p-6">
              <h3 className="text-sm font-semibold">{feature.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
