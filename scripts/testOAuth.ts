import { clerkAuthorizationServer, buildProtectedResourceMetadata } from "../src/oauthMetadata.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// --- publishable-key → Clerk authorization server derivation ---------------
// pk_live_<base64("clerk.mytrove.in$")>
const prodKey = `pk_live_${Buffer.from("clerk.mytrove.in$").toString("base64")}`;
assert(
  clerkAuthorizationServer(prodKey) === "https://clerk.mytrove.in",
  `Expected https://clerk.mytrove.in, got ${clerkAuthorizationServer(prodKey)}`,
);

const testKey = `pk_test_${Buffer.from("rational-lamprey-67.clerk.accounts.dev$").toString("base64")}`;
assert(
  clerkAuthorizationServer(testKey) === "https://rational-lamprey-67.clerk.accounts.dev",
  `Expected accounts.dev host, got ${clerkAuthorizationServer(testKey)}`,
);

assert(clerkAuthorizationServer(undefined) === null, "undefined key must yield null");
assert(clerkAuthorizationServer("not-a-key") === null, "malformed key must yield null");
assert(clerkAuthorizationServer("") === null, "empty key must yield null");

// --- protected-resource metadata document shape ----------------------------
const prevPk = process.env.CLERK_PUBLISHABLE_KEY;
const prevVite = process.env.VITE_CLERK_PUBLISHABLE_KEY;
delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
process.env.CLERK_PUBLISHABLE_KEY = prodKey;

const metadata = buildProtectedResourceMetadata("https://mytrove.in");
assert(metadata !== null, "metadata should build when a publishable key is set");
assert(metadata.resource === "https://mytrove.in/mcp", `resource should be the /mcp URL, got ${metadata.resource}`);
assert(
  metadata.authorization_servers[0] === "https://clerk.mytrove.in",
  "authorization_servers must point at the Clerk instance",
);
assert(metadata.bearer_methods_supported.includes("header"), "bearer must be accepted via header");

delete process.env.CLERK_PUBLISHABLE_KEY;
const noMetadata = buildProtectedResourceMetadata("https://mytrove.in");
assert(noMetadata === null, "metadata must be null when no publishable key is configured");

// restore env
if (prevPk === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
else process.env.CLERK_PUBLISHABLE_KEY = prevPk;
if (prevVite === undefined) delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
else process.env.VITE_CLERK_PUBLISHABLE_KEY = prevVite;

console.log("oauth metadata tests passed");
process.exit(0);
