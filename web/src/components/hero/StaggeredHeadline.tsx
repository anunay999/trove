import { motion, useReducedMotion } from "motion/react";

type StaggeredHeadlineProps = {
  /** Each string is one rendered line. */
  lines: string[];
  /** This word is set in the serif italic. */
  accent: string;
};

function Word({
  word,
  accent,
  delay,
  reduceMotion,
}: {
  word: string;
  accent: string;
  delay: number;
  reduceMotion: boolean | null;
}) {
  const isAccent = word.replace(/[^a-zA-Z']/g, "") === accent;
  return (
    <motion.span
      className="relative inline-block px-[0.08em] leading-none"
      initial={reduceMotion ? false : { opacity: 0, y: "70%", rotateX: "-28deg" }}
      animate={{ opacity: 1, y: "0%", rotateX: "0deg" }}
      transition={{ delay: reduceMotion ? 0 : delay, duration: 0.8, ease: [0.215, 0.61, 0.355, 1] }}
    >
      {isAccent ? <span className="font-serif italic">{word}</span> : word}
    </motion.span>
  );
}

/**
 * The headline reveal, word by word, tipping up out of the page.
 *
 * On md+ each line is a masked box the words rise out of. Below md the fixed
 * line splits would wrap inside their masks and tear the ragged boxes you
 * get when selecting text — so small screens render the same words flowing
 * naturally, staggered but unmasked.
 */
export function StaggeredHeadline({ lines, accent }: StaggeredHeadlineProps) {
  const reduceMotion = useReducedMotion();
  let wordIndex = 0;

  const words = (line: string) =>
    line.split(" ").map((word) => {
      const delay = wordIndex++ * 0.08 + 0.1;
      return (
        <Word key={`${line}-${word}`} word={word} accent={accent} delay={delay} reduceMotion={reduceMotion} />
      );
    });

  return (
    <h1
      className="text-[clamp(2.6rem,5.8vw,5.25rem)] font-medium leading-[0.99] tracking-[-0.055em] text-foreground lg:text-[clamp(3rem,4.6vw,5.25rem)]"
      style={{ transformStyle: "preserve-3d", perspective: "600px" }}
    >
      {/* Small screens: flowing text, no masks — nothing to tear. */}
      <span className="block md:hidden">{lines.flatMap((line) => words(line))}</span>

      {/* md and up: masked lines, words tipping up out of the page. */}
      <span className="hidden md:block">
        {lines.map((line) => (
          // `overflow-hidden` masks each word before it rises, but the tight leading
          // puts the box edge above the descenders and shears the tails off every
          // "g". Pad the box below the baseline, then pull the next line back up by
          // the same amount so the leading is unchanged.
          <span key={line} className="-mb-[0.16em] block overflow-hidden pb-[0.16em]">
            {words(line)}
          </span>
        ))}
      </span>
    </h1>
  );
}
