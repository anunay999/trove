import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultSignedOutView } from "../web/src/lib/signedOutView.js";

const app = readFileSync(fileURLToPath(new URL("../web/src/App.tsx", import.meta.url)), "utf8");

// Without Clerk an API key is the only credential, so the key form must be the
// default wherever the dashboard is served. It used to be the default only on
// app.* hosts, which left a self-hosted dashboard on localhost:8787 showing
// "/v1/stats failed: 401" and nothing to type a key into.
test("without Clerk the key form is the default view", () => {
  assert.equal(defaultSignedOutView(false), "connect");
});

test("with Clerk the landing stays the default view", () => {
  assert.equal(defaultSignedOutView(true), "landing");
});

// The helper only helps if App uses it everywhere it picks a signed-out view:
// the initial state, disconnecting a key, and submitting one (a refused key
// must land back on the form, not on a bare 401).
test("App picks every signed-out view through the helper, never by hostname", () => {
  assert.doesNotMatch(app, /isAppHost && !clerkEnabled \? "connect"/);
  assert.doesNotMatch(app, /setSignedOutView\("landing"\)/);
  assert.match(app, /defaultSignedOutView\(clerkEnabled\)/);
});
