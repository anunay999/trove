import { motion, useReducedMotion } from "motion/react";

type StaggeredHeadlineProps = {
  /** Each string is one rendered line. */
  lines: string[];
  /** This word is set in the serif italic. */
  accent: string;
};

/**
 * The headline reveal, word by word, tipping up out of the page.
 *
 * Adapted from shadcnblocks hero218. The accent word carries the serif italic —
 * on this page that word is "forgets", so the fleeting idea gets the delicate face.
 */
export function StaggeredHeadline({ lines, accent }: StaggeredHeadlineProps) {
  const reduceMotion = useReducedMotion();
  let wordIndex = 0;

  return (
    <h1
      className="text-[clamp(2.6rem,5.8vw,5.25rem)] font-medium leading-[0.99] tracking-[-0.055em] text-foreground"
      style={{ transformStyle: "preserve-3d", perspective: "600px" }}
    >
      {lines.map((line) => (
        // `overflow-hidden` masks each word before it rises, but the tight leading
        // puts the box edge above the descenders and shears the tails off every
        // "g". Pad the box below the baseline, then pull the next line back up by
        // the same amount so the leading is unchanged.
        <span key={line} className="-mb-[0.16em] block overflow-hidden pb-[0.16em]">
          {line.split(" ").map((word) => {
            const delay = wordIndex++ * 0.08 + 0.1;
            const isAccent = word.replace(/[^a-zA-Z']/g, "") === accent;
            return (
              <motion.span
                key={`${line}-${word}-${wordIndex}`}
                className="relative inline-block px-[0.1em] leading-none"
                initial={reduceMotion ? false : { opacity: 0, y: "70%", rotateX: "-28deg" }}
                animate={{ opacity: 1, y: "0%", rotateX: "0deg" }}
                transition={{ delay: reduceMotion ? 0 : delay, duration: 0.8, ease: [0.215, 0.61, 0.355, 1] }}
              >
                {isAccent ? <span className="font-serif italic">{word}</span> : word}
              </motion.span>
            );
          })}
        </span>
      ))}
    </h1>
  );
}
