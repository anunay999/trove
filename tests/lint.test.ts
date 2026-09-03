import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { PgGraphStore } from "../src/pgStore.js";
import { UserStore } from "../src/users.js";
import type { GraphOperationContext } from "../src/graphCore.js";
import type { ReconcileJudge } from "../src/reconcile.js";
import { suiteStore, closeStore, hasPostgres, isolateDatabase } from "./helpers.js";

// Provenance quality (backlog #17): a citation that is present but wrong must
// surface, as a reviewable warning — not gate anything. Own database: the
// shared dev DB's real lint findings would flood these assertions.
await isolateDatabase("lint");
describe("lint: weak_evidence", () => {
  const { store, context, stamp } = suiteStore("lint");

  after(async () => {
    await closeStore(store);
  });

  it("flags citations whose span does not support the atom, and spares supporting ones", async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Lint weak-evidence source ${stamp}`,
      contentText: [
        "The billing service charges customers monthly on the first of the month.",
        "",
        "A completely unrelated note about weekend hiking trails and rain.",
      ].join("\n"),
      metadata: {},
    }, context);
    const billingUnit = ingested.textUnits.find((unit) => unit.text.includes("billing service"));
    assert.ok(billingUnit, "the billing line must be a text unit");

    // Supporting citation: the atom restates the cited span.
    const supported = await store.capture({
      title: `Billing cadence is monthly ${stamp}`,
      type: "claim",
      summary: "The billing service charges customers monthly on the first of the month.",
      content: "Monthly billing, charged on the first.",
      evidence: [{ sourceId: ingested.source.id, textUnitId: billingUnit.id, selector: {} }],
      links: [],
    }, context);

    // Present-but-wrong citation: the atom is about something else entirely.
    const weak = await store.capture({
      title: `Deploy freeze on Fridays ${stamp}`,
      type: "claim",
      summary: "All production deploys freeze on Fridays before the weekend.",
      content: "Friday deploy freeze, no exceptions.",
      evidence: [{ sourceId: ingested.source.id, textUnitId: billingUnit.id, selector: {} }],
      links: [],
    }, context);

    const report = await store.lint(context);
    const weakFindings = report.findings.filter((finding) => finding.code === "weak_evidence");
    assert.ok(
      weakFindings.some((finding) => finding.entityId === weak.id),
      `expected a weak_evidence finding for the miscited node; got ${JSON.stringify(weakFindings)}`,
    );
    assert.ok(
      !weakFindings.some((finding) => finding.entityId === supported.id),
      "a citation whose span supports the atom must not be flagged",
    );
  });
});

// Reconciliation's judged verdicts are per-owner findings: one tenant's
// duplicates must never appear in another's report, the same guarantee every
// other lint pass makes. Per-user ownership is a Postgres-only property (the
// in-memory driver is single-user by construction).
describe("lint: reconcile findings are owner-scoped", { skip: hasPostgres() ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const duplicateJudge: ReconcileJudge = async ({ candidates }) =>
    candidates.map(() => ({ verdict: "duplicate" as const, confidence: 0.95, reason: "same fact restated" }));

  it("keeps one owner's judged duplicates out of another owner's lint", async () => {
    const connectionString = process.env.DATABASE_URL as string;
    const store = new PgGraphStore({ connectionString, reconcileJudge: duplicateJudge });
    const users = new UserStore({ connectionString });
    try {
      const alice = await users.ensureUser({ clerkUserId: `lint-alice-${stamp}`, email: `lint-alice-${stamp}@example.com` });
      const bob = await users.ensureUser({ clerkUserId: `lint-bob-${stamp}`, email: `lint-bob-${stamp}@example.com` });
      const ctx = (ownerId: string, tag: string): GraphOperationContext => ({
        actorId: `${tag}-lint`,
        interfaceId: `${tag}-lint`,
        requestId: `${tag}-${stamp}`,
        ownerId,
      });
      const A = ctx(alice.id, "lint-alice");
      const B = ctx(bob.id, "lint-bob");

      const capture = async (context: GraphOperationContext, title: string) =>
        await store.capture({ title, type: "claim", summary: title, content: title, evidence: [], links: [] }, context);

      const aliceOld = await capture(A, `Alice standup is at nine ${stamp}`);
      const aliceNew = await capture(A, `Alice standup is at nine am ${stamp}`);
      await capture(B, `Bob standup is at nine ${stamp}`);
      const bobNew = await capture(B, `Bob standup is at nine am ${stamp}`);

      const runReconcile = async (context: GraphOperationContext, nodeId: string) => {
        const jobs = await store.jobs({ kind: "reconcile_node", limit: 100 }, context);
        const job = jobs.find((candidate) => (candidate.payload as Record<string, unknown>).nodeId === nodeId);
        assert.ok(job, `expected a reconcile_node job for ${nodeId}`);
        assert.equal((await store.runJob({ jobId: job.id }, context))?.status, "succeeded");
      };
      await runReconcile(A, aliceNew.id);
      await runReconcile(B, bobNew.id);

      const reconcileFindings = async (context: GraphOperationContext) =>
        (await store.lint(context)).findings.filter((finding) => finding.code.startsWith("reconcile_"));

      const aliceFindings = await reconcileFindings(A);
      assert.ok(
        aliceFindings.some((finding) => finding.code === "reconcile_duplicate" && finding.entityId === aliceNew.id),
        `Alice must see her own judged duplicate; got ${JSON.stringify(aliceFindings)}`,
      );
      assert.ok(aliceFindings.every((finding) => finding.message.includes(String(stamp))));
      assert.ok(
        aliceFindings.every((finding) => !finding.message.includes("Bob")),
        "Alice's report must not name Bob's nodes",
      );

      const bobFindings = await reconcileFindings(B);
      assert.ok(bobFindings.some((finding) => finding.entityId === bobNew.id), "Bob sees his own");
      assert.ok(
        bobFindings.every((finding) => finding.entityId !== aliceNew.id && !finding.message.includes(aliceOld.id)),
        "Bob's report must not carry Alice's node ids",
      );
    } finally {
      await store.close();
      await users.close();
    }
  });
});
