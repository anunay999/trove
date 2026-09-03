import { useCallback, useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSkillBody, type Stats } from "@/lib/api";
import { STATUS } from "@/lib/viz";

// Where agents live, read top to bottom in the order a person actually does
// things: connect an agent, teach it the discipline, then keep the graph
// healthy. The cleanup prompt is what returning visitors come for, so the
// tailored version is short and the full procedure (skills/trove-curate/
// SKILL.md, served by the API) sits behind an expander. The slash command,
// the installed skill, and this page all read the same file, so they never
// disagree.

const MCP_URL = `${window.location.protocol}//${window.location.host.replace(/^app\./, "")}/mcp`;
const SKILLS_URL = `${window.location.protocol}//${window.location.host.replace(/^app\./, "")}/skills.md`;
const CURATE_SKILL_URL = `${window.location.protocol}//${window.location.host.replace(/^app\./, "")}/skills/trove-curate.md`;

const SKILLS_INSTALL = "npx skills add anunay999/trove -g";

const LINT_LABEL: Record<string, string> = {
  duplicate_title: "possible duplicates",
  orphan_node: "orphan notes",
  missing_evidence: "notes without evidence",
  weak_evidence: "notes with weak evidence",
  dangling_edge: "dangling edges",
  reconcile_duplicate: "judged duplicates",
  reconcile_contradiction: "judged contradictions",
};

const CLIENTS = ["Claude Code", "Any MCP client"] as const;
type Client = (typeof CLIENTS)[number];

function Section({ step, title, lede, meta, children }: {
  step: string;
  title: string;
  lede: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col border-t py-8 first:border-t-0 first:pt-2">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{step}</span>
          <h3 className="text-sm font-medium">{title}</h3>
          <span className="hidden text-sm text-muted-foreground sm:inline">{lede}</span>
        </div>
        {meta ? <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">{meta}</span> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground sm:hidden">{lede}</p>
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

function CopyButton({ text, label = "Copy", disabled = false }: { text: string; label?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }, [text]);
  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={disabled}
      className="h-8 shrink-0 rounded-md border px-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </button>
  );
}

// The dashboard's code block, as on the API keys tab: a header row carrying
// the label and the copy button, then a pre that scrolls inside its own box.
function CodeBlock({ label, code, copyLabel, wrap = false, children }: {
  label: string;
  code: string;
  copyLabel?: string;
  wrap?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
        <CopyButton text={code} label={copyLabel} disabled={!code} />
      </div>
      <pre
        className={`px-4 py-3 font-mono text-[12px] leading-relaxed ${
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"
        }`}
      >
        {children ?? code}
      </pre>
    </div>
  );
}

// One-liners get the compact row: the command and its copy button, no header.
function Snippet({ code }: { code: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border bg-card py-2 pl-4 pr-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed">{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={option === value}
          onClick={() => onChange(option)}
          className={`rounded-md border px-3 py-1.5 text-[13px] transition-colors focus-visible:border-ring focus-visible:outline-none ${
            option === value ? "border-foreground/40 bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function Agents({ stats, onOpenKeys }: { stats: Stats | null; onOpenKeys?: () => void }) {
  const [client, setClient] = useState<Client>("Claude Code");
  const [procedure, setProcedure] = useState<string | null>(null);
  const [procedureError, setProcedureError] = useState<string | null>(null);

  useEffect(() => {
    fetchSkillBody("trove-curate")
      .then(setProcedure)
      .catch((cause) => setProcedureError(cause instanceof Error ? cause.message : "Could not load the procedure."));
  }, []);

  // Findings grouped by code, in a fixed order so the sentence reads the same each visit.
  const counts = useMemo(() => {
    const byCode = new Map<string, number>();
    for (const finding of stats?.lint.findings ?? []) {
      byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + 1);
    }
    return Object.keys(LINT_LABEL)
      .filter((code) => (byCode.get(code) ?? 0) > 0)
      .map((code) => ({ code, label: LINT_LABEL[code], count: byCode.get(code) ?? 0 }));
  }, [stats]);

  const nodes = stats?.lint.summary.nodes ?? 0;
  const findings = stats?.lint.summary.findings ?? 0;

  const situation = useMemo(() => {
    if (!stats) return "";
    const parts = counts.map((row) => `${row.count} ${row.label}`);
    const report =
      parts.length === 0
        ? `Lint reports no open findings across ${nodes} notes.`
        : `Lint reports ${findings} open findings across ${nodes} notes: ${parts.join(", ")}.`;
    return `Curate my Trove graph (MCP server "trove" at ${MCP_URL}). ${report}`;
  }, [stats, counts, nodes, findings]);

  // The short prompt points at the skill; the full one inlines it for clients
  // that cannot fetch a URL.
  const shortPrompt = situation
    ? `${situation}\n\nFollow the trove-curate skill. If it is not installed, read ${CURATE_SKILL_URL} and follow it.`
    : "";
  const fullPrompt = situation && procedure ? `${situation}\n\n${procedure}` : "";

  const claudeMcpAdd = `claude mcp add --transport http trove ${MCP_URL} --header "Authorization: Bearer trove_your_key_here"`;
  const jsonConfig = `{
  "mcpServers": {
    "trove": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer trove_your_key_here" }
    }
  }
}`;

  return (
    <div className="flex flex-col">
      <Section step="01" title="Connect" lede="Point an agent at your graph." meta={MCP_URL}>
        <div className="flex flex-col gap-3">
          <Segmented options={CLIENTS} value={client} onChange={setClient} label="Client" />
          {client === "Claude Code" ? (
            <CodeBlock label="terminal" code={claudeMcpAdd} />
          ) : (
            <CodeBlock label="mcp.json" code={jsonConfig} />
          )}
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          {onOpenKeys ? (
            <>
              Keys are minted on the{" "}
              <button type="button" onClick={onOpenKeys} className="text-foreground underline-offset-4 hover:underline">
                API keys
              </button>{" "}
              tab.
            </>
          ) : (
            "Keys are minted on the API keys tab once you are signed in."
          )}{" "}
          One key per agent keeps the audit log honest.
        </p>
      </Section>

      <Section step="02" title="Teach" lede="Give it the discipline." meta="optional">
        <p className="max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">
          The tools work on their own. Skills teach an agent to recall before re-deriving, cite evidence,
          supersede instead of delete, and how to curate.
        </p>
        <div className="mt-3 max-w-2xl">
          <Snippet code={SKILLS_INSTALL} />
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          Every skill is also readable at{" "}
          <a
            href={SKILLS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-[12px] text-foreground underline-offset-4 hover:underline"
          >
            {SKILLS_URL.replace(/^https?:\/\//, "")}
          </a>
          , so any agent can be told to read one and follow it.
        </p>
      </Section>

      <Section
        step="03"
        title="Maintain"
        lede="Keep the graph healthy."
        meta={stats ? `lint over ${nodes} notes` : undefined}
      >
        {stats ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <span className="flex items-baseline gap-2">
              <span className="text-2xl font-medium leading-none tabular-nums">{findings}</span>
              <span className="text-sm text-muted-foreground">open {findings === 1 ? "finding" : "findings"}</span>
            </span>
            {counts.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {counts.map((row) => (
                  <li
                    key={row.code}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: row.code === "dangling_edge" ? STATUS.critical : STATUS.warning }}
                      aria-hidden
                    />
                    <span className="tabular-nums text-foreground">{row.count}</span>
                    <span className="text-muted-foreground">{row.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS.good }} aria-hidden />
                The graph is clean. The prompt still runs a pass, for anything lint cannot see.
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-6 w-48" />
          </div>
        )}

        <div className="mt-5 flex flex-col gap-3">
          <CodeBlock label="Prompt for this graph" code={shortPrompt} copyLabel="Copy prompt" wrap>
            {shortPrompt || <span className="text-muted-foreground">Waiting for lint…</span>}
          </CodeBlock>
          <p className="max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">
            Paste it into any session connected to Trove. In Claude Code, skip the paste and run{" "}
            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[12px] text-foreground">/mcp__trove__trove-curate</code>.
            Either way the agent merges duplicates, records supersession, links orphans, and proposes
            anything destructive instead of doing it.
          </p>

          <details className="group min-w-0">
            <summary className="inline-flex cursor-pointer select-none items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <svg width="10" height="10" viewBox="0 0 10 10" className="transition-transform group-open:rotate-90" aria-hidden>
                <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Show the full procedure
            </summary>
            <div className="mt-3">
              <p className="mb-3 max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">
                For clients that cannot fetch a URL: the same prompt with the whole trove-curate skill inlined.
              </p>
              <CodeBlock label="Prompt with trove-curate inlined" code={fullPrompt} copyLabel="Copy prompt" wrap>
                <span className="block max-h-[28rem] overflow-y-auto text-muted-foreground">
                  {procedureError
                    ? `${situation}\n\n(${procedureError})`
                    : fullPrompt || "Loading the procedure…"}
                </span>
              </CodeBlock>
            </div>
          </details>
        </div>
      </Section>
    </div>
  );
}
