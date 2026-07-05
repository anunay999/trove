import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { clerkAuthorizationServer, buildProtectedResourceMetadata } from "../src/oauthMetadata.js";

describe("oauth metadata", () => {
  describe("clerkAuthorizationServer", () => {
    it("derives the production Clerk host from a pk_live key", () => {
      const prodKey = `pk_live_${Buffer.from("clerk.mytrove.in$").toString("base64")}`;
      assert.equal(clerkAuthorizationServer(prodKey), "https://clerk.mytrove.in");
    });

    it("derives the accounts.dev host from a pk_test key", () => {
      const testKey = `pk_test_${Buffer.from("rational-lamprey-67.clerk.accounts.dev$").toString("base64")}`;
      assert.equal(
        clerkAuthorizationServer(testKey),
        "https://rational-lamprey-67.clerk.accounts.dev",
      );
    });

    it("returns null for undefined, malformed, and empty keys", () => {
      assert.equal(clerkAuthorizationServer(undefined), null);
      assert.equal(clerkAuthorizationServer("not-a-key"), null);
      assert.equal(clerkAuthorizationServer(""), null);
    });
  });

  describe("buildProtectedResourceMetadata", () => {
    const prodKey = `pk_live_${Buffer.from("clerk.mytrove.in$").toString("base64")}`;
    let prevPk: string | undefined;
    let prevVite: string | undefined;

    before(() => {
      prevPk = process.env.CLERK_PUBLISHABLE_KEY;
      prevVite = process.env.VITE_CLERK_PUBLISHABLE_KEY;
      delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
      process.env.CLERK_PUBLISHABLE_KEY = prodKey;
    });

    after(() => {
      if (prevPk === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
      else process.env.CLERK_PUBLISHABLE_KEY = prevPk;
      if (prevVite === undefined) delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
      else process.env.VITE_CLERK_PUBLISHABLE_KEY = prevVite;
    });

    it("builds a well-formed document when a publishable key is set", () => {
      const metadata = buildProtectedResourceMetadata("https://mytrove.in");
      assert.ok(metadata, "metadata should build when a publishable key is set");
      assert.equal(metadata.resource, "https://mytrove.in/mcp", "resource should be the /mcp URL");
      assert.equal(
        metadata.authorization_servers[0],
        "https://clerk.mytrove.in",
        "authorization_servers must point at the Clerk instance",
      );
      assert.ok(metadata.bearer_methods_supported.includes("header"), "bearer must be accepted via header");
    });

    it("returns null when no publishable key is configured", () => {
      delete process.env.CLERK_PUBLISHABLE_KEY;
      assert.equal(buildProtectedResourceMetadata("https://mytrove.in"), null);
      process.env.CLERK_PUBLISHABLE_KEY = prodKey;
    });
  });
});
