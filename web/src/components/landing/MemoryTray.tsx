import { useState } from "react";
import { Riffle } from "@lucasmarkes/hairline/react";

// Riffle reads out "01".."08" for the card under the pointer, "rest" otherwise.
const MEMORIES: Record<string, [fact: string, agent: string]> = {
  "01": ["Use pnpm, not npm", "Claude Code"],
  "02": ["Launch moved to September 12", "Codex"],
  "03": ["Refunds within 14 days", "Cursor"],
  "04": ["Staging deploys need an approval", "Claude Code"],
  "05": ["Dana owns the billing service", "Codex"],
  "06": ["API errors return JSON", "Cursor"],
  "07": ["Tests run against a real database", "Claude Code"],
  "08": ["Prefers short commit messages", "Codex"],
};

/** The hero figure: a tray of cards, each one something an agent learned. */
export function MemoryTray() {
  const [read, setRead] = useState("rest");
  const memory = MEMORIES[read];

  return (
    <figure className="mx-auto w-full max-w-[34rem]">
      <Riffle
        theme="dark"
        play
        intensity={0.6}
        label="A tray of eight memory cards. The card under the pointer stands up."
        onRead={setRead}
        className="memory-tray"
      />
      <figcaption aria-live="polite" className="-mt-4 flex h-12 flex-col items-center justify-center text-center">
        {memory ? (
          <>
            <span className="text-[15px] text-foreground">{memory[0]}</span>
            <span className="text-[13px] text-muted-foreground">Learned in {memory[1]}. Every agent knows it.</span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">Each card is something your agents learned.</span>
        )}
      </figcaption>
    </figure>
  );
}
