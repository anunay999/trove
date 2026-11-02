import { useEffect, useRef, useState, type RefObject } from "react";
import { Riffle } from "@lucasmarkes/hairline/react";

// Riffle reads out "01".."08" for the card under the pointer, "rest" otherwise.
const MEMORIES: Record<string, [tab: string, fact: string, agent: string]> = {
  "01": ["Fridays", "Never deploy on Fridays", "Claude Code"],
  "02": ["Launch", "Launch moved to September 12", "Codex"],
  "03": ["Refunds", "Refunds within 14 days", "Cursor"],
  "04": ["Deploys", "Staging deploys need an approval", "Claude Code"],
  "05": ["Billing", "Dana owns the billing service", "Codex"],
  "06": ["Errors", "API errors return JSON", "Cursor"],
  "07": ["Tests", "Tests run against a real database", "Claude Code"],
  "08": ["Commits", "Prefers short commit messages", "Codex"],
};
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Writes a short title on each card's tab, where Riffle punches its number.
 * The figure moves its punch dots by cx/cy, so a MutationObserver keeps each
 * title on its tab and only runs while the figure is moving.
 */
function useTabTitles(host: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const svg = host.current?.querySelector("svg");
    if (!svg) return;
    // Card groups are the ones holding the 8 punch dots; document order is card index.
    const cards = [...svg.querySelectorAll("g")].filter((g) => g.querySelectorAll(":scope > circle").length === 8);
    const titles = cards.map((g, i) => {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("class", "tab-title");
      text.textContent = MEMORIES[String(cards.length - i).padStart(2, "0")]?.[0] ?? "";
      g.append(text);
      return text;
    });

    const update = () => {
      cards.forEach((g, i) => {
        const dots = [...g.querySelectorAll<SVGCircleElement>(":scope > circle")].map((c) => [Number(c.getAttribute("cx")), Number(c.getAttribute("cy"))]);
        const cx = dots.reduce((s, d) => s + d[0], 0) / dots.length;
        const cy = dots.reduce((s, d) => s + d[1], 0) / dots.length;
        // The first row of punches runs along the tab, so it gives the text its angle.
        let angle = (Math.atan2(dots[3][1] - dots[0][1], dots[3][0] - dots[0][0]) * 180) / Math.PI;
        // Keep text upright when a tab faces the other way.
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;
        titles[i].setAttribute("transform", `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) rotate(${angle.toFixed(1)})`);
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(svg, { subtree: true, attributes: true, attributeFilter: ["cx", "cy"] });
    return () => {
      observer.disconnect();
      titles.forEach((t) => t.remove());
    };
  }, [host]);
}

/** The hero figure: a tray of cards, each one something an agent learned. */
export function MemoryTray() {
  const [read, setRead] = useState("rest");
  const host = useRef<HTMLDivElement>(null);
  useTabTitles(host);
  const memory = MEMORIES[read];

  return (
    <figure className="mx-auto w-full max-w-[34rem]">
      <Riffle
        ref={host}
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
            <span className="text-[15px] text-foreground">{memory[1]}</span>
            <span className="text-[13px] text-muted-foreground">Learned in {memory[2]}. Every agent knows it.</span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">Each card is something your agents learned.</span>
        )}
      </figcaption>
    </figure>
  );
}
