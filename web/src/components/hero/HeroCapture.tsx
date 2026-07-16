import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BubbleField } from "@/components/hero/BubbleField";
import { SessionEnd } from "@/components/hero/SessionEnd";
import { StaggeredHeadline } from "@/components/hero/StaggeredHeadline";
import { WaitlistForm } from "@/components/WaitlistForm";
import { SESSIONS, bubblesFor, memoryById, type MemoryFact } from "@/lib/hero-memories";

type HeroCaptureProps = {
  onJoin: (email?: string) => void;
  onLogin: () => void;
  onConnectKey: () => void;
};

/**
 * The hero: two agent sessions, one memory.
 *
 * Owns what has been captured and which session is open. Sessions come and go;
 * `capturedIds` never resets — that is the whole point being made.
 */
export function HeroCapture({ onJoin, onLogin, onConnectKey }: HeroCaptureProps) {
  const reduceMotion = useReducedMotion();
  const [sessionIndex, setSessionIndex] = useState(0);
  const [capturedIds, setCapturedIds] = useState<string[]>([]);

  const session = SESSIONS[sessionIndex];

  const captured = useMemo(
    () => capturedIds.map(memoryById).filter((m): m is MemoryFact => Boolean(m)),
    [capturedIds],
  );
  const supersededIds = useMemo(
    () => new Set(captured.map((m) => m.supersedes).filter((id): id is string => Boolean(id))),
    [captured],
  );
  const remaining = bubblesFor(session.id).filter((m) => !capturedIds.includes(m.id));

  const spent = remaining.length === 0;
  const isFinal = sessionIndex === SESSIONS.length - 1;
  const live = captured.length - supersededIds.size;

  function capture(memory: MemoryFact) {
    setCapturedIds((current) => (current.includes(memory.id) ? current : [...current, memory.id]));
  }

  return (
    <section className="hero-field relative isolate flex min-h-[calc(100dvh-3.5rem)] flex-col overflow-hidden">
      {/*
       * A band above the copy on small screens, where there are no gutters to
       * drift in, and the full field behind the copy from lg up. The breakpoint is
       * lg, not md: at 768px the copy column leaves ~48px of gutter, which would
       * put bubbles underneath the headline.
       */}
      <div className="relative h-72 shrink-0 lg:absolute lg:inset-0 lg:z-0 lg:h-auto">
        <BubbleField
          remaining={remaining}
          captured={captured}
          supersededIds={supersededIds}
          onCapture={capture}
        />
      </div>

      {/* Keeps the headline readable when a bubble drifts behind it. */}
      <div className="hero-vignette pointer-events-none absolute inset-0 z-10 hidden lg:block" />

      {/*
       * Transparent to clicks, all the way down: this wrapper spans the field, so
       * anything solid here eats the clicks meant for the bubbles behind it. Only
       * the actual controls opt back in.
       */}
      <div className="pointer-events-none relative z-20 mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-6 pb-16 pt-4 lg:px-10 lg:py-12">
        <div className="pointer-events-none mx-auto max-w-xl text-center">
          <StaggeredHeadline lines={["Your agent forgets", "everything tonight.", "Trove doesn't."]} accent="forgets" />

          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.55 }}
            className="mx-auto mt-6 max-w-[30rem] text-base leading-relaxed text-muted-foreground"
          >
            One graph your agents read and write over MCP. Every session builds on the last.
          </motion.p>

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.68 }}
            className="pointer-events-auto mx-auto mt-8 flex w-full max-w-md flex-col items-center"
          >
            <WaitlistForm onJoin={onJoin} idPrefix="hero" />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
              <button
                type="button"
                onClick={onLogin}
                className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Log in
              </button>
              <button
                type="button"
                onClick={onConnectKey}
                className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Use an API key
              </button>
            </div>
          </motion.div>

          {/* Reserved so the line changing never nudges the headline. */}
          <div className="pointer-events-auto mx-auto mt-7 grid min-h-8 place-items-center" aria-live="polite">
            {spent ? (
              <SessionEnd
                message={session.ending}
                onNextSession={isFinal ? undefined : () => setSessionIndex((index) => index + 1)}
                nextSessionId={session.id + 1}
              />
            ) : (
              <p className="font-mono text-[11px] text-muted-foreground">
                {captured.length === 0
                  ? "Pop a bubble — it becomes a memory."
                  : `${live} kept${supersededIds.size ? ` · ${supersededIds.size} superseded` : ""} · persists after this session`}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
