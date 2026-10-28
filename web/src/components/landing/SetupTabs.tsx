import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy } from "lucide-react";

// Commands are copied from README.md and docs/quickstart.md; keep them in sync.
const TABS = [
  {
    id: "claude-code",
    label: "Claude Code",
    code: `claude mcp add trove --transport http https://mytrove.in/mcp \\
  --header "Authorization: Bearer <your trove_ key>"`,
  },
  {
    id: "claude-ai",
    label: "claude.ai",
    note: "Connectors, then Add custom connector. Sign in when asked.",
    code: "https://mytrove.in/mcp",
  },
  {
    id: "any-mcp",
    label: "Any MCP client",
    code: `URL     https://mytrove.in/mcp
Header  Authorization: Bearer <your trove_ key>`,
  },
  {
    id: "self-host",
    label: "Self-host",
    code: `git clone https://github.com/anunay999/trove.git && cd trove
npm install && cp .env.example .env
npm run setup && npm run web:build && npm start`,
  },
] as const;

/** The quickstart, in the hero: pick your agent, copy one block. */
export function SetupTabs() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("claude-code");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(tab.code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard refused (permissions or insecure context): the text stays selectable.
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-[var(--card)]">
      <div role="tablist" aria-label="Connect an agent" className="flex overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === active}
            aria-controls="setup-panel"
            onClick={() => {
              setActive(t.id);
              setCopied(false);
            }}
            className="relative shrink-0 px-4 py-3 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground aria-selected:text-foreground"
          >
            {t.label}
            {t.id === active && (
              <motion.span
                layoutId="setup-tab-underline"
                className="absolute inset-x-3 -bottom-px h-px bg-[var(--signal)]"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        ))}
      </div>

      <div id="setup-panel" role="tabpanel" className="relative">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab.id}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="p-4 pr-14"
          >
            {"note" in tab && <p className="mb-2 text-[13px] text-muted-foreground">{tab.note}</p>}
            <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed text-foreground">
              <code>{tab.code}</code>
            </pre>
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          className="absolute right-3 top-3 grid size-8 place-items-center rounded-md border border-border text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.96]"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={copied ? "check" : "copy"}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.8, filter: "blur(2px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? undefined : { opacity: 0, scale: 0.8, filter: "blur(2px)" }}
              transition={{ duration: 0.15 }}
            >
              {copied ? <Check className="size-3.5 text-[var(--signal)]" /> : <Copy className="size-3.5" />}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    </div>
  );
}
