import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/*
 * The hero scene: one recall, with receipts.
 *
 * No graph metaphor. An agent asks a plain question, Trove hands back the
 * answer with the sentence that justifies it, the related thing the agent
 * didn't ask for but needs, and what the belief used to be. Then the agent
 * acts on it. Three short stories loop; each is the same shape so the
 * pattern reads even if the visitor never reads the words.
 */

type Story = {
  agent: string;
  asked: string;
  remembered: string;
  source: string;
  /** The cited sentence, with the justifying words wrapped in [brackets]. */
  quote: string;
  related: string;
  relatedSource: string;
  before: string;
  beforeWhen: string;
  outcome: string;
  caption: string;
};

const STORIES: Story[] = [
  {
    agent: "claude · session 14",
    asked: "How do I install dependencies in this repo?",
    remembered: "Use pnpm, never npm",
    source: "CONTRIBUTING.md",
    quote: "Always install with [pnpm] — npm rewrites the lockfile.",
    related: "The lockfile is committed. CI fails if it drifts.",
    relatedSource: "ci.yml",
    before: "npm install",
    beforeWhen: "replaced 9 days ago",
    outcome: "Installed with pnpm. Lockfile untouched.",
    caption: "Session 14 cloned the repo cold and never broke the lockfile.",
  },
  {
    agent: "codex",
    asked: "When are we launching?",
    remembered: "Launch is September 12",
    source: "launch-plan.md",
    quote: "Customer research moved the launch to [September 12].",
    related: "The pricing page goes live the day before launch.",
    relatedSource: "launch-checklist.md",
    before: "August 30",
    beforeWhen: "replaced 3 weeks ago",
    outcome: "Drafted the announcement for September 12.",
    caption: "Nobody had to re-explain why the date slipped.",
  },
  {
    agent: "claude · session 17",
    asked: "Why are webhooks firing twice?",
    remembered: "Stripe retries carry the same event ID",
    source: "incident-2026-04-17.md",
    quote: "Stripe retried the webhook; [both deliveries carried the same event ID].",
    related: "Handlers must be idempotent on event ID.",
    relatedSource: "stripe-migration #184",
    before: "Suspected a race in the queue",
    beforeWhen: "ruled out 2 days ago",
    outcome: "Skipped the dead end. Fixed the handler.",
    caption: "Last week's incident is this session's head start.",
  },
];

/* Beats, in order, and when each lands (ms from the story's start). */
const BEATS = ["ask", "remember", "cite", "connect", "history", "act"] as const;
type Beat = (typeof BEATS)[number];
const BEAT_AT: Record<Beat, number> = { ask: 0, remember: 1900, cite: 3100, connect: 4400, history: 5700, act: 6900 };
const STORY_LENGTH = 10800;
const FINAL_BEAT = BEATS.length - 1;

const EASE = [0.16, 1, 0.3, 1] as const;

/** Text that types itself in, one character at a time. */
function Typed({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(active ? 0 : text.length);

  useEffect(() => {
    if (!active) return;
    setShown(0);
    const id = window.setInterval(() => {
      setShown((n) => {
        if (n >= text.length) {
          window.clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, 28);
    return () => window.clearInterval(id);
  }, [text, active]);

  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="ml-px inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-[var(--signal)]" />}
    </>
  );
}

/** The cited sentence with the justifying words lit in the accent colour. */
function Quote({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("[") ? (
          <mark key={i} className="rounded-sm bg-[var(--signal)]/15 px-0.5 text-foreground">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Label({ children }: { children: string }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{children}</p>;
}

function Rise({ show, children, className, delay = 0 }: { show: boolean; children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      initial={false}
      animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.55, delay: show ? delay : 0, ease: EASE }}
      className={className}
      aria-hidden={!show}
    >
      {children}
    </motion.div>
  );
}

function StoryFrame({ story, beat, animate }: { story: Story; beat: number; animate: boolean }) {
  const at = (name: Beat) => beat >= BEATS.indexOf(name);

  return (
    <div className="flex h-full flex-col">
      {/* The ask. */}
      <div className="flex items-center gap-2.5">
        <span className="rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{story.agent}</span>
        <Label>asked</Label>
      </div>
      <p className="mt-2.5 text-[15px] leading-snug text-foreground md:text-base">
        <Typed text={story.asked} active={animate} />
      </p>

      {/* The thread from the question down to what came back. */}
      <div className="relative ml-2 mt-3 flex-1 pl-5 md:ml-3 md:pl-6">
        <motion.span
          initial={false}
          animate={{ scaleY: at("remember") ? 1 : 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="absolute left-0 top-0 h-full w-px origin-top bg-[var(--signal)]/50"
          aria-hidden="true"
        />

        {/* What Trove remembered, with its receipt. */}
        <Rise show={at("remember")} className="relative rounded-xl border bg-[var(--background)]/80 p-4 md:p-5">
          <span className="absolute -left-5 top-6 h-px w-5 bg-[var(--signal)]/50 md:-left-6 md:w-6" aria-hidden="true" />
          <span className="absolute -left-[3px] top-[21px] size-1.5 rounded-full bg-[var(--signal)]" aria-hidden="true" />
          <Label>remembered</Label>
          <p className="mt-1.5 text-lg font-medium leading-tight tracking-tight md:text-xl">{story.remembered}</p>

          <Rise show={at("cite")} className="mt-3.5 border-t pt-3">
            <p className="font-mono text-[10px] text-muted-foreground">
              <span className="uppercase tracking-[0.14em]">from</span>
              <span className="ml-2 text-foreground/80">{story.source}</span>
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              &ldquo;<Quote text={story.quote} />&rdquo;
            </p>
          </Rise>

          <Rise show={at("history")} className="mt-3 flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-muted-foreground">
            <span className="uppercase tracking-[0.14em]">before this</span>
            <span className="line-through decoration-muted-foreground/60">{story.before}</span>
            <span>· {story.beforeWhen}</span>
          </Rise>
        </Rise>

        {/* The related thing the agent didn't ask for. */}
        <Rise show={at("connect")} className="relative ml-5 md:ml-6">
          <div className="flex items-center gap-2 py-2">
            <motion.span
              initial={false}
              animate={{ scaleY: at("connect") ? 1 : 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="ml-3 h-4 w-px origin-top bg-[var(--signal)]/50"
              aria-hidden="true"
            />
            <Label>also worth knowing</Label>
          </div>
          <div className="rounded-xl border bg-[var(--background)]/60 px-4 py-3">
            <p className="text-[13px] leading-snug text-foreground md:text-sm">{story.related}</p>
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              <span className="uppercase tracking-[0.14em]">from</span>
              <span className="ml-2 text-foreground/70">{story.relatedSource}</span>
            </p>
          </div>
        </Rise>
      </div>

      {/* The agent acts on it. */}
      <Rise show={at("act")} className="mt-3 flex items-center gap-2.5 text-sm text-foreground">
        <span className="flex size-4 items-center justify-center rounded-full bg-[var(--signal)] text-[10px] font-bold text-[var(--cta-fg)]">✓</span>
        {story.outcome}
      </Rise>
    </div>
  );
}

export function RecallScene() {
  const reduceMotion = useReducedMotion();
  const [storyIndex, setStoryIndex] = useState(0);
  const [beat, setBeat] = useState(reduceMotion ? FINAL_BEAT : 0);
  const [paused, setPaused] = useState(false);

  // Drive the beats. Pausing (hover) cancels the pending step; resuming
  // re-arms it from the current beat, so nothing is skipped.
  useEffect(() => {
    if (reduceMotion || paused) return;
    const current = BEATS[beat];
    const next = beat + 1;
    const wait = next < BEATS.length ? BEAT_AT[BEATS[next]] - BEAT_AT[current] : STORY_LENGTH - BEAT_AT[current];
    const id = window.setTimeout(() => {
      if (next < BEATS.length) {
        setBeat(next);
      } else {
        setStoryIndex((i) => (i + 1) % STORIES.length);
        setBeat(0);
      }
    }, wait);
    return () => window.clearTimeout(id);
  }, [beat, paused, reduceMotion]);

  const story = STORIES[storyIndex];
  const showCaption = beat >= FINAL_BEAT;

  return (
    <div
      className="overflow-hidden rounded-2xl border bg-[var(--card)]/70 backdrop-blur-sm"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex h-11 items-center justify-between border-b px-4 2xl:h-12">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">trove · one recall</span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="live-dot size-1.5 rounded-full bg-[var(--signal)]" />
          live
        </span>
      </div>

      <div className="h-[28rem] p-4 md:h-[27rem] md:p-6 2xl:h-[31rem]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={storyIndex}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.35 } }}
            transition={{ duration: 0.4 }}
            className="h-full"
          >
            <StoryFrame story={story} beat={beat} animate={!reduceMotion} />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex h-[3.75rem] items-center border-t px-4 md:px-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={showCaption ? storyIndex : "quiet"}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            transition={{ duration: 0.5, ease: EASE }}
            className="text-sm leading-snug text-muted-foreground"
          >
            {showCaption ? story.caption : "The next session starts with what the last one learned."}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
