import { useCallback, useEffect, useState } from "react";
import { createKey, fetchKeys, revokeKey, type ApiKeySummary, type ServiceTokenSummary } from "@/lib/api";

const SCOPE_OPTIONS = [
  { scope: "graph:read", label: "Read", hint: "search, recall, dashboard" },
  { scope: "graph:write", label: "Write", hint: "capture, ingest, link, update" },
  { scope: "graph:export", label: "Export", hint: "Obsidian / markdown projections" },
];

const MCP_TOOLS = ["Claude Code", "Codex", "Cursor"] as const;
type McpTool = (typeof MCP_TOOLS)[number];

function mcpSnippet(tool: McpTool, key: string): { text: string; hint: string } {
  const url = `${window.location.origin}/mcp`;
  if (tool === "Claude Code") {
    return {
      text: `claude mcp add trove --transport http ${url} --header "Authorization: Bearer ${key}"`,
      hint: "Run in any terminal. Tools like remember, recall, and grep appear in every Claude Code session.",
    };
  }
  if (tool === "Codex") {
    return {
      text: `[mcp_servers.trove]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer ${key}"]`,
      hint: "Add to ~/.codex/config.toml. mcp-remote bridges Codex's stdio MCP to the hosted endpoint.",
    };
  }
  return {
    text: `{\n  "mcpServers": {\n    "trove": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${key}" }\n    }\n  }\n}`,
    hint: "Add to ~/.cursor/mcp.json (or via Cursor Settings → MCP → Add server).",
  };
}

const SKILLS_INSTALL = "npx skills add anunay999/trove -g";

function McpSetup({ keySecret }: { keySecret: string | null }) {
  const [tool, setTool] = useState<McpTool>("Claude Code");
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedSkills, setCopiedSkills] = useState(false);
  const key = keySecret ?? "<your-api-key>";
  const snippet = mcpSnippet(tool, key);

  return (
    <div className="mt-10">
      <h3 className="text-sm font-semibold">Connect an agent</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {keySecret
          ? "Snippets below use your most recent active key."
          : "Create a key above first; snippets will fill it in automatically."}
      </p>
      <div className="mt-3 flex gap-2">
        {MCP_TOOLS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => { setTool(candidate); setCopiedSnippet(false); }}
            className={`rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
              tool === candidate ? "border-foreground/40 bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>
      <div className="mt-3 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {tool === "Claude Code" ? "terminal" : tool === "Codex" ? "~/.codex/config.toml" : "~/.cursor/mcp.json"}
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(snippet.text).then(() => {
                setCopiedSnippet(true);
                window.setTimeout(() => setCopiedSnippet(false), 1600);
              });
            }}
            className="rounded-md border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {copiedSnippet ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed">{snippet.text}</pre>
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">{snippet.hint}</p>

      <p className="mt-5 text-[13px] leading-relaxed text-muted-foreground">
        Optional: install the companion skills so your agent uses the tools well — recall before re-deriving, cite evidence, supersede instead of delete.
      </p>
      <div className="mt-2 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">skills</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(SKILLS_INSTALL).then(() => {
                setCopiedSkills(true);
                window.setTimeout(() => setCopiedSkills(false), 1600);
              });
            }}
            className="rounded-md border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {copiedSkills ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed">{SKILLS_INSTALL}</pre>
      </div>
    </div>
  );
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [serviceTokens, setServiceTokens] = useState<ServiceTokenSummary[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["graph:read"]);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchKeys();
      setKeys(result.keys);
      setServiceTokens(result.serviceTokens ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load keys.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScope = (scope: string) => {
    setScopes((current) => current.includes(scope)
      ? current.filter((candidate) => candidate !== scope)
      : [...current, scope]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createKey(name.trim(), scopes);
      setFreshSecret(result.secret);
      setName("");
      setCopied(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create key.");
    } finally {
      setBusy(false);
    }
  };

  const active = (keys ?? []).filter((key) => !key.revokedAt);
  const revoked = (keys ?? []).filter((key) => key.revokedAt);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="font-serif text-2xl tracking-tight">API keys</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Keys authenticate agents and scripts against your Trove. The secret is shown once at creation; only a hash is stored.
      </p>

      <form onSubmit={submit} className="mt-6 rounded-lg border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. laptop-agent"
              className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim() || scopes.length === 0}
            className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <fieldset className="mt-4 flex flex-wrap gap-2">
          <legend className="mb-1.5 w-full font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Permissions</legend>
          {SCOPE_OPTIONS.map((option) => {
            const checked = scopes.includes(option.scope);
            return (
              <button
                key={option.scope}
                type="button"
                onClick={() => toggleScope(option.scope)}
                aria-pressed={checked}
                className={`rounded-md border px-3 py-1.5 text-left text-[13px] transition-colors ${
                  checked ? "border-foreground/40 bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="font-medium">{option.label}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </fieldset>
      </form>

      {freshSecret && (
        <div className="mt-4 rounded-lg border border-amber-600/30 bg-amber-500/5 p-4">
          <p className="text-[13px] font-medium">Copy this key now — it will not be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-[12px]">{freshSecret}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(freshSecret).then(() => setCopied(true));
              }}
              className="h-8 shrink-0 rounded-md border px-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setFreshSecret(null)}
              className="h-8 shrink-0 rounded-md border px-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-8">
        {keys === null ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No active keys yet. Create one above to connect an agent.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {active.map((key) => (
              <li key={key.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {key.keyPrefix}…  ·  {key.scopes.join(", ")}  ·  created {key.createdAt.slice(0, 10)}
                    {key.lastUsedAt ? `  ·  last used ${key.lastUsedAt.slice(0, 10)}` : "  ·  never used"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!key.secret}
                  title={key.secret ? "Copy key" : "Created before keys were retrievable; recreate to copy"}
                  onClick={() => {
                    if (!key.secret) return;
                    void navigator.clipboard.writeText(key.secret).then(() => {
                      setCopiedKeyId(key.id);
                      window.setTimeout(() => setCopiedKeyId((current) => (current === key.id ? null : current)), 1600);
                    });
                  }}
                  aria-label={`Copy ${key.name} key`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copiedKeyId === key.id ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Revoke "${key.name}"? Agents using it will lose access immediately.`)) {
                      void revokeKey(key.id).then(load);
                    }
                  }}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-red-600/40 hover:text-red-600 dark:hover:text-red-400"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 && (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            {revoked.length} revoked key{revoked.length === 1 ? "" : "s"} retained for audit.
          </p>
        )}
      </div>

      <McpSetup keySecret={active.find((key) => key.secret)?.secret ?? null} />

      {serviceTokens.length > 0 && (
        <div className="mt-10">
          <h3 className="text-sm font-semibold">Service tokens</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Environment-configured agent credentials (MCP, scripts). Managed via <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">TROVE_SERVICE_TOKENS</code>, not from this page.
          </p>
          <ul className="mt-3 divide-y rounded-lg border bg-card">
            {serviceTokens.map((token) => (
              <li key={token.actorId} className="flex items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{token.actorId}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {token.tokenPreview}  ·  {token.scopes.join(", ")}
                  </p>
                </div>
                <button
                  type="button"
                  title="Copy token"
                  aria-label={`Copy ${token.actorId} token`}
                  onClick={() => {
                    void navigator.clipboard.writeText(token.token).then(() => {
                      setCopiedKeyId(`svc-${token.actorId}`);
                      window.setTimeout(() => setCopiedKeyId((current) => (current === `svc-${token.actorId}` ? null : current)), 1600);
                    });
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-foreground"
                >
                  {copiedKeyId === `svc-${token.actorId}` ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  )}
                </button>
                <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
                  env
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
