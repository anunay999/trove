import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DASHBOARD_PATHS, isDashboardPath } from "../src/webRoutes.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

// src/server.ts opens a listener the moment it is imported, so the app object
// itself is not reachable from a test. What matters is the shape of the route
// table, and that is decidable without one: the dashboard's fallback is a fixed
// list, and every route the server registers is a string literal in the source.
describe("web routes: the dashboard's own paths", () => {
  it("answers for every tab path and for nothing else", () => {
    for (const path of ["/", "/overview", "/graph", "/agents", "/keys", "/admin"]) {
      assert.ok(isDashboardPath(path), `${path} should be served the dashboard`);
    }
    for (const path of [
      "/health",
      "/ready",
      "/mcp",
      "/skills.md",
      "/llms.txt",
      "/skills/trove-recall",
      "/.well-known/oauth-protected-resource",
      "/v1/graph",
      "/v1/stats",
      "/v1/me",
      "/v1/keys/abc",
      "/assets/index-D3adB33f.js",
      "/favicon.ico",
      "/graph/extra",
      "/graphs",
      "/nope",
      "",
    ]) {
      assert.ok(!isDashboardPath(path), `${path} must not be answered with index.html`);
    }
  });

  it("covers exactly the tabs the dashboard renders", () => {
    const app = read("web/src/App.tsx");
    const declared = /const TABS: Tab\[\] = \[([^\]]*)\]/.exec(app);
    assert.ok(declared, "could not find the TABS list in web/src/App.tsx");
    const tabs = [...(declared[1] ?? "").matchAll(/"([a-z]+)"/g)].map((match) => match[1] ?? "");
    assert.ok(tabs.length >= 5, `expected the five tabs, parsed ${tabs.join(", ")}`);
    for (const tab of tabs) {
      const path = tab === "overview" ? "/" : `/${tab}`;
      assert.ok(isDashboardPath(path), `tab ${tab} has no server route for ${path}`);
      assert.ok(isDashboardPath(`/${tab}`), `tab ${tab} is not reachable at /${tab}`);
    }
    // The other direction: no path in the list that no tab claims.
    for (const path of DASHBOARD_PATHS) {
      const tab = path === "/" ? "overview" : path.slice(1);
      assert.ok(tabs.includes(tab), `${path} is served but no tab named ${tab} exists`);
    }
  });

  it("never stands in front of a route the server registers itself", () => {
    const server = read("src/server.ts");
    const registered = [...server.matchAll(/^app\.(?:get|post|put|patch|delete|all|use|on)\(\s*"([^"]+)"/gm)]
      .map((match) => match[1] ?? "")
      .filter((path) => path !== "" && !path.includes("*"));
    assert.ok(registered.includes("/v1/me"), "route scrape found nothing; the regex has drifted");
    assert.ok(registered.includes("/mcp") && registered.includes("/skills.md"), "route scrape missed known routes");
    for (const path of registered) {
      assert.ok(
        !isDashboardPath(path),
        `${path} is both an API route and a dashboard path; the fallback would shadow it`,
      );
    }
  });

  it("is registered after everything else, so it can only answer for leftovers", () => {
    const server = read("src/server.ts");
    const fallback = server.indexOf("for (const path of DASHBOARD_PATHS)");
    assert.ok(fallback > 0, "the dashboard fallback loop is gone from src/server.ts");
    const lastRoute = server.lastIndexOf('app.get("/skills/:name"');
    assert.ok(lastRoute > 0 && lastRoute < fallback, "an API route is registered after the dashboard fallback");
    assert.ok(
      server.indexOf('app.use("/*", serveStatic({ root: "./web/dist" }))') < fallback,
      "static assets must be matched before the dashboard fallback",
    );
  });
});
