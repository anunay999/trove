import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import { siGithub } from "simple-icons";
import { Overview } from "@/pages/Overview";
// The force-graph library is the biggest thing we ship. Split it out so the
// landing, which most visitors never scroll past, doesn't download the explorer.
const GraphView = lazy(() => import("@/pages/GraphView").then((m) => ({ default: m.GraphView })));
import { Landing } from "@/pages/Landing";
import { ApiKeys } from "@/pages/ApiKeys";
import { Agents } from "@/pages/Agents";
import { Admin } from "@/pages/Admin";
import { WaitlistGate } from "@/pages/WaitlistGate";
import { AuthControls } from "@/components/AuthControls";
import { LoginDrawer } from "@/components/LoginDrawer";
import { UserSwitcher, switchToUser, userLabel } from "@/components/UserSwitcher";
import {
  fetchGraph,
  fetchMe,
  fetchStats,
  getImpersonation,
  setImpersonation,
  type GraphSnapshot,
  type Me,
  type Stats,
} from "@/lib/api";

type Tab = "overview" | "graph" | "agents" | "keys" | "admin";

const clerkEnabled = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
// app.<domain> is the product; the bare domain is the front door and shows
// nothing but the landing. Same bundle, same API (the server answers on both
// hosts). Signing in, joining, or connecting a key from the front door hops
// to the app host, which opens the matching drawer on arrival. Dev mirrors
// production: localhost:5173 is the front door, app.localhost:5173 the app.
const hostname = window.location.hostname;
const isAppHost = hostname.startsWith("app.");
const isFrontDoor = clerkEnabled && !isAppHost;
const appOrigin = `${window.location.protocol}//app.${hostname}${window.location.port ? `:${window.location.port}` : ""}`;

function goToApp(hash = "") {
  window.location.assign(`${appOrigin}/${hash}`);
}

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
  const [signedOutView, setSignedOutView] = useState<"landing" | "connect">(isAppHost ? "connect" : "landing");
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
      // A "view as" choice belongs to the admin who made it, not to the
      // browser. Once Clerk has settled on signed-out, drop it so the next
      // person to sign in here starts in their own account. Gated on `loaded`
      // because Clerk reports signed-out while it is still restoring.
      if (loaded && getImpersonation()) setImpersonation(null);
    }
  }, [load]);

  const identity = me?.identity ?? null;
  const impersonating = me?.impersonating ?? null;
  const isWaitlisted = signedIn && identity != null && identity.status !== "active";
  const isAdmin = identity?.role === "admin" && identity.status === "active";
  const hasApiToken = !!window.localStorage.getItem("trove_token");
  const tokenMode = !signedIn && hasApiToken && (tokenDashboard || !clerkEnabled);
  const dashboardReady = !error && (signedIn ? !isWaitlisted : tokenMode);
  const clerkSettling = clerkEnabled && !clerkLoaded;
  const showLanding = isFrontDoor;
  const showConnect = !signedIn && !dashboardReady && signedOutView === "connect";

  const disconnectKey = useCallback(() => {
    window.localStorage.removeItem("trove_token");
    setImpersonation(null);
    setTokenDashboard(false);
    setSignedOutView(isAppHost ? "connect" : "landing");
    setStats(null);
    setSnapshot(null);
    setError(null);
  }, []);

  const allTabs: Tab[] = signedIn && identity?.status === "active"
    ? (isAdmin ? ["overview", "graph", "agents", "keys", "admin"] : ["overview", "graph", "agents", "keys"])
    : ["overview", "graph", "agents"];
  // "View as" is a lens on the graph; API keys always belong to your own
  // account. Hiding the tab keeps the page from contradicting the banner.
  const tabs: Tab[] = impersonating ? allTabs.filter((candidate) => candidate !== "keys") : allTabs;
  const activeTab: Tab = tabs.includes(tab) ? tab : "overview";

  const openLogin = useCallback(() => {
    if (isFrontDoor) return goToApp("#login");
    setDrawer({ open: true, mode: "sign-in" });
  }, []);
  const openSignUp = useCallback((email?: string) => {
    if (isFrontDoor) return goToApp(`#signup${email ? `?email=${encodeURIComponent(email)}` : ""}`);
    setDrawer({ open: true, mode: "sign-up", email });
  }, []);

  // Arriving from the front door: open the drawer the visitor asked for, once
  // Clerk is ready to render it. Already signed in? The hash is stale; drop it.
  useEffect(() => {
    if (!isAppHost || !clerkLoaded) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#login") && !hash.startsWith("#signup") && !hash.startsWith("#connect")) return;
    if (!signedIn) {
      if (hash.startsWith("#login")) setDrawer({ open: true, mode: "sign-in" });
      else if (hash.startsWith("#signup")) {
        const email = new URLSearchParams(hash.split("?")[1] ?? "").get("email") ?? undefined;
        setDrawer({ open: true, mode: "sign-up", email });
      } else setSignedOutView("connect");
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [clerkLoaded, signedIn]);

  return (
    // The landing is always dark. The night tokens go on the shell, not just the
    // header: the header is 90% opaque, so a light body showed through as a grey bar.
    <div
      className={`${showLanding ? "landing-chrome bg-background" : ""} ${
        activeTab === "graph" && dashboardReady ? "flex h-dvh flex-col overflow-hidden" : "flex min-h-screen flex-col"
      }`}
    >
      <header className="sticky top-0 z-20 shrink-0 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-6 2xl:max-w-[88rem]">
          <span className="font-serif text-xl tracking-tight">Trove</span>
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
            {tokenMode && (
              <button
                type="button"
                onClick={disconnectKey}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Disconnect
              </button>
            )}
            <a
              href="https://github.com/anunay999/trove"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Trove on GitHub"
              className="flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" className="size-[15px] fill-current" aria-hidden>
                <path d={siGithub.path} />
              </svg>
            </a>
            {/* The landing ignores the theme, so the toggle would do nothing there. */}
            {!showLanding && (
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
            )}
            {isAdmin && identity && dashboardReady && (
              <UserSwitcher self={identity} impersonating={impersonating} />
            )}
            {/* The front door has no session of its own to show: Log in always goes to the app. */}
            {clerkEnabled && isFrontDoor && (
              <button
                type="button"
                onClick={openLogin}
                className="h-8 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-transform active:scale-[0.98]"
              >
                Log in
              </button>
            )}
            {clerkEnabled && !isFrontDoor && <AuthControls onOpenLogin={openLogin} onSessionChange={onSessionChange} dark={dark} />}
          </div>
        </div>
      </header>

      {impersonating && (
        <div className="shrink-0 border-b border-amber-600/30 bg-amber-500/10">
          <div className="mx-auto flex h-9 w-full max-w-7xl items-center gap-3 px-6 text-[13px] 2xl:max-w-[88rem]">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            <span className="truncate">
              Viewing Trove as <strong className="font-medium">{userLabel(impersonating)}</strong>. Anything you
              write lands in their graph, recorded as you.
            </span>
            <button
              type="button"
              onClick={() => switchToUser(null)}
              className="ml-auto shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to my account
            </button>
          </div>
        </div>
      )}

      {showLanding ? (
        <Landing onJoin={(email) => openSignUp(email)} onLogin={openLogin} onConnectKey={() => goToApp("#connect")} />
      ) : clerkSettling ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Loading…</p>
        </div>
      ) : isWaitlisted ? (
        <WaitlistGate email={identity?.email ?? null} dark={dark} />
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
          <Suspense fallback={<div className="h-full w-full" />}>
            <GraphView snapshot={snapshot} dark={dark} />
          </Suspense>
        </main>
      ) : activeTab === "agents" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Agents stats={stats} />
        </main>
      ) : activeTab === "keys" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <ApiKeys />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Admin selfClerkUserId={identity?.clerkUserId} />
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
