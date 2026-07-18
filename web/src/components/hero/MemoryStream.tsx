import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AGENT_LABEL, STREAM, type StreamRow } from "@/lib/stream-events";

/** Rows kept on screen at once; older ones slide out under the fade mask. */
const WINDOW = 6;

const OP_STYLE: Record<string, string> = {
  remember: "text-foreground/80",
  recall: "text-muted-foreground",
  supersede: "text-[var(--signal)]",
};

function Row({ row }: { row: StreamRow }) {
  if ("divider" in row) {
    return (
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] tracking-wide text-muted-foreground">{row.label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return (
    <div className="border-l border-border pl-4">
      <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
        <span className="tnum">{row.at}</span>
        <span className="mx-2 text-border">·</span>
        {AGENT_LABEL[row.agent]}
        <span className="mx-2 text-border">·</span>
        <span className={OP_STYLE[row.op]}>{row.op}</span>
      </p>
      <p className="mt-1 text-[13px] leading-snug text-foreground/90">{row.text}</p>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        <span className="text-[var(--signal)]">←</span> {row.source}
        {row.retires && (
          <>
            <span className="mx-2 text-border">·</span>
            retires <span className="superseded-line">{row.retires}</span>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The product's core loop, running live: agents write, sessions end, the graph
 * keeps everything. Rows enter at the bottom and age upward; they dim rather
 * than vanish, because on this page nothing is thrown away.
 *
 * Loops by resetting `count`; the pause after the last row lets the ending
 * divider sit before the ledger starts over.
 */
export function MemoryStream() {
  const reduceMotion = useReducedMotion();
  const [count, setCount] = useState(reduceMotion ? STREAM.length : 0);

  useEffect(() => {
    if (reduceMotion) return;
    const next = STREAM[count];
    const delay = next == null ? 3600 : "divider" in next ? 2400 : 1500;
    const timer = window.setTimeout(() => setCount((c) => (c >= STREAM.length ? 0 : c + 1)), delay);
    return () => window.clearTimeout(timer);
  }, [count, reduceMotion]);

  const visible = STREAM.slice(Math.max(0, count - WINDOW), count);

  return (
    <div className="overflow-hidden rounded-2xl border bg-[var(--card)]/70 backdrop-blur">
      <div className="flex h-11 items-center justify-between border-b px-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          trove · memory stream
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="live-dot size-1.5 rounded-full bg-[var(--signal)]" />
          live
        </span>
      </div>

      {/* Decorative replay of the pitch, not data — keep it out of the a11y tree. */}
      <div aria-hidden="true" className="stream-mask flex h-[23rem] flex-col justify-end gap-4 overflow-hidden p-5 md:h-[25rem]">
        <AnimatePresence initial={false}>
          {visible.map((row, index) => (
            <motion.div
              key={row.id}
              layout
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.25 } }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            >
              {/* Dimming lives on the inner node so it never fights the enter animation. */}
              <div
                style={{
                  opacity:
                    visible.length === 1 ? 1 : 0.4 + 0.6 * (index / (visible.length - 1)),
                }}
              >
                <Row row={row} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
