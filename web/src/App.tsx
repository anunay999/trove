import { useCallback, useEffect, useState } from "react";
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import { Overview } from "@/pages/Overview";
import { GraphView } from "@/pages/GraphView";
import { Landing } from "@/pages/Landing";
import { ApiKeys } from "@/pages/ApiKeys";
import { Admin } from "@/pages/Admin";
import { WaitlistGate } from "@/pages/WaitlistGate";
import { AuthControls } from "@/components/AuthControls";
import { LoginDrawer } from "@/components/LoginDrawer";
import { fetchGraph, fetchMe, fetchStats, type GraphSnapshot, type Me, type Stats } from "@/lib/api";

type Tab = "overview" | "graph" | "keys" | "admin";

const clerkEnabled = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

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
  const [me, setMe] = useState<Me | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [drawer, setDrawer] = useState<{ open: boolean; mode: "sign-in" | "sign-up"; email?: string }>({ open: false, mode: "sign-in" });
  const [signedOutView, setSignedOutView] = useState<"landing" | "connect">("landing");
  // OAuth providers bounce back to #/sso-callback after the drawer has
  // unmounted; a mounted Clerk callback component must finish the handshake.
  const [ssoCallback] = useState(() => window.location.hash.includes("sso-callback"));
  // Until Clerk finishes restoring the session, showing the landing would
  // flash it at every signed-in reload; hold a quiet splash instead.
  const [clerkLoaded, setClerkLoaded] = useState(!clerkEnabled);

  useEffect(() => {
    // If Clerk can't initialize (outage, wrong domain), don't brick the page.
    const fallback = window.setTimeout(() => setClerkLoaded(true), 4000);
    return () => window.clearTimeout(fallback);
  }, []);
  // With Clerk enabled, a stored API key no longer auto-opens the dashboard —
  // the landing is the front door; the key path is an explicit choice.
  const [tokenDashboard, setTokenDashboard] = useState(false);

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

  const onSessionChange = useCallback((isSignedIn: boolean, loaded: boolean) => {
    setClerkLoaded(loaded);
    setSignedIn(isSignedIn);
    if (isSignedIn) {
      setDrawer((current) => ({ ...current, open: false }));
      void fetchMe().then(setMe).catch(() => setMe(null));
      void load();
    } else {
      setMe(null);
    }
  }, [load]);

  const identity = me?.identity ?? null;
  const isWaitlisted = signedIn && identity != null && identity.status !== "active";
  const isAdmin = identity?.role === "admin" && identity.status === "active";
  const hasApiToken = !!window.localStorage.getItem("trove_token");
  const tokenMode = !signedIn && hasApiToken && (tokenDashboard || !clerkEnabled);
  const dashboardReady = !error && (signedIn ? !isWaitlisted : tokenMode);
  const clerkSettling = clerkEnabled && !clerkLoaded;
  const showLanding = clerkEnabled && clerkLoaded && !signedIn && !tokenMode && signedOutView === "landing";
  const showConnect = !signedIn && !dashboardReady && signedOutView === "connect";

  const disconnectKey = useCallback(() => {
    window.localStorage.removeItem("trove_token");
    setTokenDashboard(false);
    setSignedOutView("landing");
    setStats(null);
    setSnapshot(null);
    setError(null);
  }, []);

  const tabs: Tab[] = signedIn && identity?.status === "active"
    ? (isAdmin ? ["overview", "graph", "keys", "admin"] : ["overview", "graph", "keys"])
    : ["overview", "graph"];
  const activeTab: Tab = tabs.includes(tab) ? tab : "overview";

  const openLogin = useCallback(() => setDrawer({ open: true, mode: "sign-in" }), []);
  const openSignUp = useCallback((email?: string) => setDrawer({ open: true, mode: "sign-up", email }), []);

  return (
    <div className={activeTab === "graph" && dashboardReady ? "flex h-dvh flex-col overflow-hidden" : "flex min-h-screen flex-col"}>
      <header className="sticky top-0 z-20 shrink-0 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
          <h1 className="font-serif text-xl tracking-tight">Trove</h1>
          {dashboardReady && (
            <nav className="flex items-center gap-1">
              {tabs.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setTab(candidate)}
                  className={`rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
                    activeTab === candidate
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {candidate === "keys" ? "API keys" : candidate}
                </button>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            {dashboardReady && (
              <button
                type="button"
                onClick={() => void load()}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Refresh
              </button>
            )}
            {showLanding && hasApiToken && (
              <button
                type="button"
                onClick={() => setTokenDashboard(true)}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Dashboard
              </button>
            )}
            {tokenMode && (
              <button
                type="button"
                onClick={disconnectKey}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Disconnect
              </button>
            )}
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
            {clerkEnabled && <AuthControls onOpenLogin={openLogin} onSessionChange={onSessionChange} dark={dark} />}
          </div>
        </div>
      </header>

      {clerkSettling ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Loading…</p>
        </div>
      ) : isWaitlisted ? (
        <WaitlistGate email={identity?.email ?? null} dark={dark} />
      ) : showLanding ? (
        <Landing
          dark={dark}
          onJoin={(email) => openSignUp(email)}
          onLogin={openLogin}
          onConnectKey={() => setSignedOutView("connect")}
        />
      ) : showConnect || (error && error.includes("401")) ? (
        <div className="mx-auto mt-24 w-full max-w-sm rounded-lg border bg-card p-8">
          <h2 className="font-serif text-xl">Connect to Trove</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Enter your API key to open the dashboard.
          </p>
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("token");
              if (typeof value === "string" && value.trim()) {
                window.localStorage.setItem("trove_token", value.trim());
                setTokenDashboard(true);
                setSignedOutView("landing");
                void load();
              }
            }}
          >
            <input
              name="token"
              type="password"
              placeholder="API key"
              autoFocus
              className="h-9 rounded-md border bg-background px-3 font-mono text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <button
              type="submit"
              className="h-9 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-transform active:scale-[0.98]"
            >
              Connect
            </button>
          </form>
          {clerkEnabled && (
            <p className="mt-4 text-center text-[13px] text-muted-foreground">
              or{" "}
              <button type="button" onClick={openLogin} className="font-medium text-foreground underline-offset-4 hover:underline">
                log in
              </button>
            </p>
          )}
        </div>
      ) : error ? (
        <div className="mx-auto mt-16 max-w-md rounded-lg border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            Is the Trove API running on :8787?
          </p>
        </div>
      ) : activeTab === "overview" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Overview stats={stats} dark={dark} />
        </main>
      ) : activeTab === "graph" ? (
        <main className="min-h-0 flex-1">
          <GraphView snapshot={snapshot} dark={dark} />
        </main>
      ) : activeTab === "keys" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <ApiKeys />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Admin />
        </main>
      )}

      {clerkEnabled && (
        <LoginDrawer
          open={drawer.open}
          mode={drawer.mode}
          prefillEmail={drawer.email}
          onClose={() => setDrawer((current) => ({ ...current, open: false }))}
          dark={dark}
        />
      )}

      {clerkEnabled && ssoCallback && !signedIn && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-background">
          <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" />
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Completing sign-in…</p>
        </div>
      )}
    </div>
  );
}
