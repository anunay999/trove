/**
 * The dashboard keeps its tab in the URL, so /graph and /keys are addresses
 * inside one bundle rather than files on disk. A hard refresh, a bookmark or a
 * shared link has to be handed web/dist/index.html for exactly those paths.
 *
 * It is a named list rather than a catch-all on purpose. Every API route,
 * /mcp, the skills feeds and the hashed assets are matched before it, and a
 * fallback that answered "anything I don't recognise" would be one typo away
 * from swallowing a new one of them and turning a 404 into a page of HTML that
 * no client asked for. Unknown paths stay 404s.
 *
 * Keep it in step with the tabs in web/src/App.tsx; tests/web-routes.test.ts
 * fails if the two drift, or if one of these paths ever collides with a route
 * the server registers itself.
 */
export const DASHBOARD_PATHS = ["/", "/overview", "/graph", "/agents", "/keys", "/admin"] as const;

const dashboardPaths = new Set<string>(DASHBOARD_PATHS);

/** Whether a request path is one of the dashboard's own client-side routes. */
export function isDashboardPath(pathname: string): boolean {
  return dashboardPaths.has(pathname);
}
