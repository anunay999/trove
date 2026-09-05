import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import { GITHUB_PATH } from "@/lib/brandIcons";
import { clearLayout, layoutOwnerKey } from "@/lib/graphLayoutCache";
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
  takeImpersonationBounce,
  fetchStats,
  getImpersonation,
  setImpersonation,
  type GraphSnapshot,
  type Me,
  type Stats,
} from "@/lib/api";

type Tab = "overview" | "graph" | "agents" | "keys" | "admin";

// The tab is the URL. /graph is an address you can link, bookmark and reload,
// and the back button walks the tabs instead of leaving the app. Overview is
// the root; /overview is accepted and normalised away. Five tabs and the
// History API do not need a router, and the bundle is already the heaviest
// thing we ship. Keep this list in step with DASHBOARD_PATHS in
// src/webRoutes.ts — that is what makes a hard refresh on /graph reach us.
const TABS: Tab[] = ["overview", "graph", "agents", "keys", "admin"];

function tabFromPath(pathname: string): Tab {
  const segment = pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  if (!segment) return "overview";
  return TABS.find((candidate) => candidate === segment) ?? "overview";
}

function pathForTab(tab: Tab): string {
  return tab === "overview" ? "/" : `/${tab}`;
}

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
  const [tab, setTab] = useState<Tab>(() => tabFromPath(window.location.pathname));
  const [dark, setDark] = useState(initialDark);
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  // A "view as" that the API refused bounces back to yourself on reload; this
  // carries the reason across so the switcher is not silently inert.
  const [error, setError] = useState<string | null>(() => takeImpersonationBounce());
  const [me, setMe] = useState<Me | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [drawer, setDrawer] = useState<{ open: boolean; mode: "sign-in" | "sign-up"; email?: string }>({ open: false, mode: "sign-in" });
  /**
   * What a signed-out visitor sees on the app host.
   *
   * It used to be "connect" — the API-key form, as the front page of the
   * product. That was right when a key was the only way in and is wrong now
   * that accounts are: someone arriving at app.<domain> is asked for a
   * credential they have probably never minted, with the actual way in (log in)
   * relegated to a line of small print underneath.
   *
   * So the key form stops being the default and becomes what it always was — a
   * fallback. It is still reachable by the #connect hash the landing links to,
   * and it is still the DEFAULT on a deployment with no Clerk, where a key is
   * genuinely the only credential that exists.
   */
  const [signedOutView, setSignedOutView] = useState<"landing" | "connect">(
    isAppHost && !clerkEnabled ? "connect" : "landing",
  );
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

  /**
   * Only the newest load may write state.
   *
   * The first load fires at mount, before Clerk has restored the session, so on
   * a hosted app it 401s. The session then lands and loads again, with a token,
   * and succeeds — but the first request's rejection can arrive AFTER that
   * success and overwrite it, leaving `error` set on a signed-in page. Since a
   * 401 sends the shell to the connect form, the result was being asked for an
   * API key immediately after signing in with GitHub.
   */
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = (loadSeq.current += 1);
    setError(null);
    try {
      const [statsResult, graphResult] = await Promise.all([fetchStats(), fetchGraph()]);
      if (seq !== loadSeq.current) return;
      setStats(statsResult);
      setSnapshot(graphResult);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Failed to load Trove data.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // /v1/me is where the API says whether it wants a credential at all. A local
  // or demo server started with auth off answers mode "disabled" to anyone, and
  // then parking on the connect form asks for a key that server would ignore —
  // which is how the dashboard managed to render with no tab row at all. A
  // Clerk session change is not the only way to learn this, so ask once at
  // mount, on every path. Kept apart from `me`: this is the server's mode, not
  // the caller's identity, and it must never race the session's own answer.
  const [authDisabled, setAuthDisabled] = useState(false);
  const [authProbed, setAuthProbed] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchMe()
      .then((result) => {
        if (live) setAuthDisabled(result.mode === "disabled");
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setAuthProbed(true);
      });
    return () => {
      live = false;
    };
  }, []);

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
  // A layout belongs to the graph it describes, and viewing as someone else is
  // a different graph again.
  const layoutOwner = layoutOwnerKey(identity, impersonating);
  const isWaitlisted = signedIn && identity != null && identity.status !== "active";
  const isAdmin = identity?.role === "admin" && identity.status === "active";
  const hasApiToken = !!window.localStorage.getItem("trove_token");
  const tokenMode = !signedIn && hasApiToken && (tokenDashboard || !clerkEnabled);
  const dashboardReady = !error && (signedIn ? !isWaitlisted : tokenMode || authDisabled);
  const clerkSettling = clerkEnabled && !clerkLoaded;
  const showLanding = isFrontDoor;
  const showConnect = !signedIn && !dashboardReady && signedOutView === "connect";
  // Everything else a signed-out visitor to the app host can be: not the
  // landing (that is the front door's job), not the key form, and never the
  // dashboard branches below — those read `stats` and would render an empty
  // shell. A 401 from an unauthenticated load lands here too, which is why the
  // connect form no longer special-cases it.
  const showSignIn = !signedIn && !dashboardReady && !showLanding && !showConnect && clerkEnabled;

  const disconnectKey = useCallback(() => {
    window.localStorage.removeItem("trove_token");
    clearLayout();
    setImpersonation(null);
    setTokenDashboard(false);
    setSignedOutView(isAppHost && !clerkEnabled ? "connect" : "landing");
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

  // Clicking a tab is a navigation, not a state change: push it, so back and
  // forward walk the tabs instead of walking out of the app.
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (window.location.pathname !== pathForTab(next)) {
      window.history.pushState(null, "", pathForTab(next) + window.location.search);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => setTab(tabFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Nothing about the URL is trustworthy until the tab row is: Clerk settled,
  // the API's auth mode heard, and — once signed in — the identity that decides
  // whether keys and admin are on the list at all. Correcting before then would
  // rewrite a perfectly good deep link into "/" and then back again.
  const navigationSettled = !clerkSettling && authProbed && (!signedIn || me !== null);

  // A path this visitor cannot open — /admin as a member, /keys while viewing as
  // someone else, any tab at all before the dashboard opens — resolves the way
  // `activeTab` already resolves it, and the address bar is rewritten to agree
  // rather than left standing as a claim the page does not honour. replaceState,
  // because nobody asked for this history entry. The hash rides along untouched:
  // the front-door drawers and Clerk's #/sso-callback own it.
  useEffect(() => {
    if (!navigationSettled) return;
    const canonical = dashboardReady ? pathForTab(activeTab) : "/";
    if (window.location.pathname !== canonical) {
      window.history.replaceState(null, "", canonical + window.location.search + window.location.hash);
    }
  }, [activeTab, dashboardReady, navigationSettled]);

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
        {/* Three regions, and the outer two carry the centring. The tabs used to
            take `flex-1` and start at their own left edge, which pinned them
            against the wordmark and left the whole right half empty. Giving the
            brand and the controls `flex-1` instead makes them equal, so the
            nav — sized to its content — sits on the header's true centre
            whatever the tab count, and still lands right when there is no nav
            at all (signed out), where two equal siblings simply split the bar.

            Below sm none of that applies: five tabs and the account controls do
            not fit one 375px line, so the tab row wraps to its own (order-last,
            full width, bled to the edges so it scrolls past the padding). From
            sm it sits back inline and absorbs any remaining squeeze by
            scrolling, so the document never gets a horizontal scrollbar. */}
        <div
          className={`flex min-h-14 w-full flex-wrap items-center gap-x-6 gap-y-2 px-6 py-2 sm:flex-nowrap sm:py-0 ${
            /* The app bar spans the window. Centring the tabs was only half the
               problem: the row itself sat in a max-w-7xl container, so on a wide
               screen the wordmark and the account both stopped short of the
               corners by whatever gutter the container left — about 180px at
               2000px wide — and read as floating rather than anchored. The
               canvas underneath is already full-bleed, which made it obvious.

               The landing keeps the container: it is a marketing page whose
               content is measured to a column, and a header wider than the page
               it heads would be the same mistake in the other direction. */
            showLanding ? "mx-auto max-w-7xl 2xl:max-w-[88rem]" : ""
          }`}
        >
          <span className="shrink-0 font-serif text-xl tracking-tight sm:flex-1">Trove</span>
          {dashboardReady && (
            <nav className="order-last -mx-6 flex w-[calc(100%+3rem)] items-center gap-1 overflow-x-auto px-6 py-1 [scrollbar-width:none] sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:shrink sm:justify-center sm:px-0 [&::-webkit-scrollbar]:hidden">
              {tabs.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => selectTab(candidate)}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
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
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3 sm:flex-1 sm:justify-end">
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
                <path d={GITHUB_PATH} />
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
      ) : showSignIn ? (
        <div className="mx-auto mt-24 w-full max-w-sm rounded-lg border bg-card p-8 text-center">
          <h2 className="font-serif text-xl">Your graph is behind a login</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Log in to open it.
          </p>
          <button
            type="button"
            onClick={openLogin}
            className="mt-5 h-9 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-transform active:scale-[0.98]"
          >
            Log in
          </button>
          <p className="mt-4 text-[13px] text-muted-foreground">
            or{" "}
            <button
              type="button"
              onClick={() => setSignedOutView("connect")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              use an API key
            </button>
          </p>
        </div>
      ) : showConnect ? (
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
            <GraphView snapshot={snapshot} dark={dark} layoutOwner={layoutOwner} />
          </Suspense>
        </main>
      ) : activeTab === "agents" ? (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <Agents stats={stats} onOpenKeys={tabs.includes("keys") ? () => selectTab("keys") : undefined} />
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
