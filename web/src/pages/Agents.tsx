import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSkillBody, type Stats } from "@/lib/api";
import { STATUS } from "@/lib/viz";

// Where agents live: how to connect, what to install, and the one thing most
// people come here for — a cleanup prompt that already knows what their graph
// needs. The prompt body is skills/trove-curate/SKILL.md served by the API, so
// this page, the MCP slash command, and the installed skill never disagree.

const MCP_URL = `${window.location.protocol}//${window.location.host.replace(/^app\./, "")}/mcp`;
const SKILLS_URL = `${window.location.protocol}//${window.location.host.replace(/^app\./, "")}/skills.md`;

const LINT_LABEL: Record<string, string> = {
  duplicate_title: "possible duplicates",
  orphan_node: "orphan notes",
  missing_evidence: "notes without evidence",
  weak_evidence: "notes with weak evidence",
  dangling_edge: "dangling edges",
};

function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col border-t py-8 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {meta ? <span className="font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
      </div>
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
      className="h-8 shrink-0 rounded-md border px-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </button>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-card p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed">{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

export function Agents({ stats }: { stats: Stats | null }) {
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

  const prompt = procedure ? `${situation}\n\n${procedure}` : situation;

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
      <Section title="Clean up your graph" meta={stats ? `${findings} open findings` : undefined}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-medium leading-none">{stats ? findings : "–"}</span>
              <span className="text-sm text-muted-foreground">open findings</span>
            </div>
            <ul className="flex flex-col gap-2">
              {counts.map((row) => (
                <li key={row.code} className="flex items-center gap-2 text-[13px]">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: row.code === "dangling_edge" ? STATUS.critical : STATUS.warning }}
                    aria-hidden
                  />
                  <span className="text-foreground">{row.count}</span>
                  <span className="text-muted-foreground">{row.label}</span>
                </li>
              ))}
              {stats && counts.length === 0 ? (
                <li className="text-sm text-muted-foreground">Nothing open. The graph is tidy.</li>
              ) : null}
            </ul>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Your agent does the cleanup with the tools it already has. Paste the prompt into any session
              connected to Trove, or in Claude Code run{" "}
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[12px] text-foreground">/mcp__trove__trove-curate</code>.
              It merges duplicates, records supersession, links orphans, and proposes anything destructive
              instead of doing it.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                Prompt, tailored to this graph
              </span>
              <CopyButton text={prompt} label="Copy prompt" />
            </div>
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border bg-card p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {procedureError ? `${situation}\n\n(${procedureError})` : prompt || "Loading…"}
            </pre>
          </div>
        </div>
      </Section>

      <Section title="Connect an agent" meta={MCP_URL}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Claude Code</span>
            <Snippet code={claudeMcpAdd} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Any MCP client</span>
            <Snippet code={jsonConfig} />
          </div>
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Keys are minted on the API keys tab. One key per agent keeps the audit log honest.
        </p>
      </Section>

      <Section title="Skills" meta="optional, Claude Code">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          The tools work on their own. Skills teach an agent the discipline: recall before re-deriving,
          cite evidence, supersede instead of delete, and how to curate.
        </p>
        <div className="mt-3">
          <Snippet code="npx skills add anunay999/trove -g" />
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Every skill is also readable by URL, so any agent can be told to read one and follow it:{" "}
          <a href={SKILLS_URL} target="_blank" rel="noreferrer noopener" className="font-mono text-[12px] text-foreground underline-offset-4 hover:underline">
            {SKILLS_URL.replace(/^https?:\/\//, "")}
          </a>
        </p>
      </Section>
    </div>
  );
}
