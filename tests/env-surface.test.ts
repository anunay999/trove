import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * What is allowed to be an environment variable.
 *
 * The codebase read 44 of them and no deployment had ever set 30. An unset
 * variable is not configuration: it is a claim of configurability that nothing
 * honours, and it is paid for with a parse branch, a fallback, a test that
 * cannot assume the default, a line in this file's subject that drifts, and an
 * unanswerable "what is this set to in production?" — which can only be
 * checked by opening a deployment dashboard.
 *
 * So the rule, pinned here rather than in a style note nobody reads:
 *
 *  - `.env.example` documents DEPLOYMENT configuration and nothing else:
 *    secrets, endpoints, identity, topology, and the switches that decide which
 *    features are on.
 *  - Timeouts, intervals, retention windows, budgets and calibrated thresholds
 *    are named constants next to the code they govern. Changing one is then a
 *    reviewable diff sitting next to its rationale.
 *  - A few of those constants still read an override, because a test or the
 *    benchmark has to vary them. Those are TEST SEAMS. They are legitimate, and
 *    they must never be documented as if an operator should set them.
 */

const ROOT = new URL("../", import.meta.url);

/**
 * Overrides that exist for tests and the benchmark harness. Each one is read by
 * src/ and set by tests/ or bench/ — never by a deployment, and never listed in
 * .env.example.
 */
const TEST_SEAMS = new Set([
  "TROVE_ACTIVATION_FLUSH_MS",
  "TROVE_EMBEDDING_JOB_LIMIT",
  "TROVE_EVENT_PRUNE_MAX_ROWS",
  "TROVE_EVENT_RETENTION_DAYS",
  "TROVE_JOB_LEASE_SECONDS",
  "TROVE_LINT_MIN_INTERVAL_SECONDS",
  "TROVE_RECALL_RERANK_TIMEOUT_MS",
  "TROVE_RECONCILE_JUDGE_BUDGET",
  "TROVE_SEMANTIC_MAX_DISTANCE",
  // Per-process and per-request identity, not configuration at all.
  "TROVE_ACTOR_ID",
  "TROVE_REQUEST_ID",
  "TROVE_WORKER_ID",
  "TROVE_TEST_DB_PREFIX",
  // Behaviour that defaults ON; the off switch is documented in the code that
  // reads it, because reading this file should not suggest turning it off.
  "TROVE_TEMPORAL_SCOPE",
  "TROVE_SKILLS_DIR",
]);

/**
 * A ratchet, not a target. It exists so that adding a variable is a decision
 * somebody makes on purpose — with this line in the diff — rather than the path
 * of least resistance it was for the first forty-four.
 */
const MAX_DOCUMENTED = 24;

async function sourceFiles(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.name.endsWith(".ts")) files.push(child);
  }
  return files;
}

async function envNamesReadBySource(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await sourceFiles(new URL("src/", ROOT))) {
    const text = await readFile(fileURLToPath(file), "utf8");
    for (const match of text.matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
      names.add(match[1] as string);
    }
  }
  return names;
}

async function envNamesDocumented(): Promise<string[]> {
  const text = await readFile(fileURLToPath(new URL(".env.example", ROOT)), "utf8");
  const names: string[] = [];
  for (const line of text.split("\n")) {
    // Both live lines and the commented examples: a commented variable is still
    // this file telling an operator the variable is theirs to set.
    const match = /^#?\s*([A-Z][A-Z_0-9]*)=/.exec(line.trim());
    if (match) names.push(match[1] as string);
  }
  return [...new Set(names)];
}

describe("environment surface", () => {
  it("documents no variable the code does not read", async () => {
    const documented = await envNamesDocumented();
    const read = await envNamesReadBySource();
    // Build-time and infrastructure names are consumed outside src/.
    const outsideSrc = new Set(["VITE_CLERK_PUBLISHABLE_KEY", "RAW_BLOB_BUCKET"]);
    const stale = documented.filter((name) => !read.has(name) && !outsideSrc.has(name));
    assert.deepEqual(stale, [], "these are documented but nothing reads them");
  });

  it("does not present a test seam as deployment configuration", async () => {
    const documented = await envNamesDocumented();
    const leaked = documented.filter((name) => TEST_SEAMS.has(name));
    assert.deepEqual(leaked, [], "a test seam is not something an operator should set");
  });

  it("keeps the documented surface small enough to hold in your head", async () => {
    const documented = await envNamesDocumented();
    assert.ok(
      documented.length <= MAX_DOCUMENTED,
      `.env.example documents ${documented.length} variables (cap ${MAX_DOCUMENTED}). `
      + "Adding one should be a decision, not a reflex: is this a secret, an "
      + "endpoint, an identity, or a feature switch? If it is a timeout, an "
      + "interval or a threshold, make it a constant instead.",
    );
  });

  it("has no variable that is neither documented nor a declared seam", async () => {
    const documented = new Set(await envNamesDocumented());
    const read = await envNamesReadBySource();
    // Node's own, and the platform's.
    const ambient = new Set(["NODE_ENV", "PORT"]);
    const undeclared = [...read]
      .filter((name) => !documented.has(name) && !TEST_SEAMS.has(name) && !ambient.has(name))
      .sort();
    assert.deepEqual(
      undeclared,
      [],
      "every variable is either deployment configuration (document it) or a test seam (list it)",
    );
  });
});

/**
 * The shape of a flag is a decision with a cost either way, so it is pinned
 * rather than left to whoever writes the next one.
 */
describe("feature flag defaults", () => {
  it("treats an unset default-on flag as on, and only an explicit no as off", async () => {
    const { featureEnabled } = await import("../src/flags.js");
    for (const value of [undefined, "", "1", "true", "yes", "on", "maybe"]) {
      assert.equal(featureEnabled(value), true, `${JSON.stringify(value)} should stay on`);
    }
    for (const value of ["0", "false", "no", "off", " OFF "]) {
      assert.equal(featureEnabled(value), false, `${JSON.stringify(value)} should turn it off`);
    }
  });

  it("keeps opt-in strict, so the expensive direction is never reached by accident", async () => {
    const { optedIn } = await import("../src/flags.js");
    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      assert.equal(optedIn(value), false, `${JSON.stringify(value)} must not opt in`);
    }
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      assert.equal(optedIn(value), true, `${JSON.stringify(value)} should opt in`);
    }
  });
});
