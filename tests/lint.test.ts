import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore, isolateDatabase } from "./helpers.js";

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
