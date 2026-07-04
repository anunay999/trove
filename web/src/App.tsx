import { useCallback, useEffect, useState } from "react";
import { Overview } from "@/pages/Overview";
import { GraphView } from "@/pages/GraphView";
import { fetchGraph, fetchStats, type GraphSnapshot, type Stats } from "@/lib/api";

type Tab = "overview" | "graph";

function initialDark(): boolean {
  const saved = window.localStorage.getItem("trove_theme");
  if (saved) return saved === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [dark, setDark] = useState(initialDark);
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("trove_theme", dark ? "dark" : "light");
  }, [dark]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [statsResult, graphResult] = await Promise.all([fetchStats(), fetchGraph()]);
      setStats(statsResult);
      setSnapshot(graphResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load Trove data.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={tab === "graph" ? "flex h-dvh flex-col overflow-hidden" : "flex min-h-screen flex-col"}>
      <header className="sticky top-0 z-20 shrink-0 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
          <h1 className="font-serif text-xl tracking-tight">Trove</h1>
          <nav className="flex items-center gap-1">
            {(["overview", "graph"] as Tab[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setTab(candidate)}
                className={`rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
                  tab === candidate
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {candidate}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => void load()}
              className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setDark((current) => !current)}
              aria-label="Toggle theme"
              className="flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 1.5 A6.5 6.5 0 0 1 8 14.5 Z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="mx-auto mt-16 max-w-md rounded-lg border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            Is the Trove API running on :8787? Set a token in localStorage under
            trove_token if the service requires auth.
          </p>
        </div>
      ) : tab === "overview" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Overview stats={stats} dark={dark} />
        </main>
      ) : (
        <main className="min-h-0 flex-1">
          <GraphView snapshot={snapshot} dark={dark} />
        </main>
      )}
    </div>
  );
}
