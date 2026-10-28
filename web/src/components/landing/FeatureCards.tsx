import { useRef, useState, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

const PICK = { duration: 0.7, ease: [0.32, 0.72, 0, 1] } as const;
const AGENTS = ["Claude", "Codex", "Cursor"];

/** Each card plays once when it scrolls in, and again on hover. The resting state is fully readable. */
function Card({ title, body, badge, children }: { title: string; body: string; badge?: string; children: (on: boolean) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.6 });
  const [hover, setHover] = useState(false);
  const [left, setLeft] = useState(false);
  const reduceMotion = useReducedMotion();
  // Plays once on scroll-in; after the first hover, leaving resets and entering replays.
  const on = !!reduceMotion || hover || (seen && !left);

  return (
    <div
      ref={ref}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setLeft(true);
      }}
      className="flex min-w-0 flex-col rounded-2xl border border-border bg-[var(--card)] p-6"
    >
      <div className="grid h-40 place-items-center">{children(on)}</div>
      <div className="mt-6 flex items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {badge && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{badge}</span>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

const pill = "rounded-full border px-3 py-1 text-[13px] whitespace-nowrap";

function LearnOnce({ on }: { on: boolean }) {
  return (
    <div className="flex gap-3">
      {AGENTS.map((agent, i) => (
        <div key={agent} className="flex w-20 flex-col items-center gap-3 sm:w-24">
          <span className="text-[13px] text-muted-foreground">{agent}</span>
          <motion.span
            initial={false}
            animate={{ opacity: i === 0 || on ? 1 : 0.18, y: i === 0 || on ? 0 : 4 }}
            transition={{ ...PICK, delay: on ? i * 0.12 : 0 }}
            className={`${pill} ${i === 0 ? "border-[var(--signal)] text-foreground" : "border-border text-foreground"}`}
          >
            pnpm
          </motion.span>
        </div>
      ))}
    </div>
  );
}

function StaysCurrent({ on }: { on: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <motion.span
        initial={false}
        animate={{ opacity: on ? 0.4 : 1 }}
        transition={PICK}
        className={`${pill} border-border text-foreground ${on ? "line-through" : ""}`}
      >
        Launch: September 5
      </motion.span>
      <motion.span
        initial={false}
        animate={{ opacity: on ? 1 : 0, y: on ? 0 : -8 }}
        transition={{ ...PICK, delay: on ? 0.15 : 0 }}
        className={`${pill} border-[var(--signal)] text-foreground`}
      >
        Launch: September 12
      </motion.span>
    </div>
  );
}

function ShowsSource({ on }: { on: boolean }) {
  return (
    <div className="flex w-full max-w-64 flex-col items-center">
      <span className={`${pill} border-border text-foreground`}>Refunds within 14 days</span>
      <motion.div
        initial={false}
        animate={{ opacity: on ? 1 : 0, y: on ? 0 : -6, borderColor: on ? "var(--signal)" : "var(--border)" }}
        transition={PICK}
        className="mt-3 w-full rounded-lg border bg-[var(--background)] px-3 py-2.5 text-left"
      >
        <p className="font-mono text-[11px] text-muted-foreground">refund-policy.md</p>
        <p className="mt-1 text-[13px] text-foreground/85">&ldquo;Refunds are accepted within 14 days.&rdquo;</p>
      </motion.div>
    </div>
  );
}

function SharedWithTeam({ on }: { on: boolean }) {
  return (
    <div className="grid w-full max-w-80 grid-cols-2 gap-3">
      {["Mine", "Team"].map((col) => (
        <div key={col} className="flex h-28 flex-col items-center gap-3 rounded-lg border border-dashed border-border pt-3">
          <span className="text-[12px] text-muted-foreground">{col}</span>
          {(col === "Team") === on && (
            <motion.span
              layoutId="team-fact"
              transition={PICK}
              className={`${pill} ${on ? "border-[var(--signal)]" : "border-border"} text-foreground`}
            >
              Billing: Dana
            </motion.span>
          )}
        </div>
      ))}
    </div>
  );
}

export function FeatureCards() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Learn once" body="What one agent learns, the others know.">
        {(on) => <LearnOnce on={on} />}
      </Card>
      <Card title="Always current" body="A newer fact replaces the old one.">
        {(on) => <StaysCurrent on={on} />}
      </Card>
      <Card title="Shows its source" body="Every fact points to where it came from.">
        {(on) => <ShowsSource on={on} />}
      </Card>
      <Card title="Shared with your team" badge="Soon" body="Facts about shared work reach your teammates.">
        {(on) => <SharedWithTeam on={on} />}
      </Card>
    </div>
  );
}
