import { motion, useReducedMotion } from "motion/react";

type SessionEndProps = {
  message: string;
  /** Absent on the last session, where there is nothing further to open. */
  onNextSession?: () => void;
  nextSessionId?: number;
};

/**
 * The beat between sessions: the session is spent, the graph is not.
 *
 * Sits in the flow directly above the rail rather than floating in the field —
 * the rail grows as facts are captured, and an absolutely positioned prompt got
 * pushed off-screen exactly when it became the next thing to do.
 */
export function SessionEnd({ message, onNextSession, nextSessionId }: SessionEndProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.2 }}
      className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
    >
      <p className="font-mono text-[11px] text-muted-foreground">{message}</p>
      {onNextSession && (
        <button
          type="button"
          onClick={onNextSession}
          className="rounded-full border border-[var(--signal)]/45 px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--signal)] transition-colors hover:bg-[color-mix(in_srgb,var(--signal)_12%,transparent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)]"
        >
          Start session {nextSessionId} →
        </button>
      )}
    </motion.div>
  );
}
