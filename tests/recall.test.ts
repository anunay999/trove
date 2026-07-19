import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore, isolateDatabase } from "./helpers.js";

// Recall packs are budget-sensitive: nodes left by a previous run or a parallel
// suite compete for the same token budget and change what gets packed. Own
// database.
await isolateDatabase("recall");

describe("recall", () => {
  const { store, context, stamp } = suiteStore("recall");

  let hubId: string;
  let neighborId: string;
  let edgeId: string;
  let evidenceUnitId: string;
  let generous: Awaited<ReturnType<typeof store.recall>>;

  before(async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Recall evidence ${stamp}`,
      contentText: [
        "# Recall evidence",
        "",
        "The launchpad export smoke run confirmed that nightly sync workers copy universe rows into ClickHouse before the morning report window opens.",
      ].join("\n"),
      metadata: { smoke: true },
    }, context);
    const evidenceUnit = ingested.textUnits.at(-1);
    assert.ok(evidenceUnit, "ingest produced no text units");
    evidenceUnitId = evidenceUnit.id;

    const hub = await store.capture({
      title: `Recall smoke hub ${stamp}`,
      type: "decision",
      summary: "Recall smoke packing should surface this hub first for the recall smoke query.",
      content: "The recall smoke hub records that budgeted context packs are assembled from hybrid seeds, one-hop expansion, and activation ranking so agents receive citations instead of raw markdown dumps.",
      evidence: [{ textUnitId: evidenceUnitId, selector: {} }],
      links: [],
    }, context);
    hubId = hub.id;

    const neighbor = await store.capture({
      title: `Expansion neighbor ${stamp}`,
      type: "pattern",
      summary: "Connected pattern that must arrive through graph expansion, not lexical match.",
      content: "Graph expansion should pull this pattern into the context pack because it is linked to the hub, demonstrating that traversal complements retrieval even when the query words never appear here. The pattern also carries enough prose that a tight token budget cannot afford both the hub and this block at the same time.",
      evidence: [],
      links: [],
    }, context);
    neighborId = neighbor.id;

    const edge = await store.link({ fromNodeId: hubId, toNodeId: neighborId, predicate: "depends_on", weight: 1 }, context);
    assert.ok(edge, "hub-neighbor edge was not created");
    edgeId = edge.id;
  });

  after(async () => {
    await closeStore(store);
  });

  it("packs a generous budget with lexical hub, expanded neighbor, citations, and edges", async () => {
    generous = await store.recall({ query: "recall smoke", tokenBudget: 2000 });
    assert.ok(generous.spentTokens > 0, "recall must report spent tokens");
    assert.ok(generous.spentTokens <= 2000, "recall must respect the token budget");
    assert.ok(generous.atoms.some((atom) => atom.node.id === hubId), "recall must pack the lexically matching hub");
    assert.ok(generous.atoms.some((atom) => atom.node.id === neighborId), "recall must pack the linked neighbor via graph expansion");
    assert.ok(generous.citations.some((c) => c.textUnitId === evidenceUnitId), "recall must cite the hub evidence text unit");
    assert.ok(generous.edges.some((candidate) => candidate.id === edgeId), "recall must return edges between packed atoms");
  });

  it("respects a tight budget, truncates, and still packs the best hub", async () => {
    const tight = await store.recall({ query: "recall smoke", tokenBudget: 160 });
    assert.ok(tight.spentTokens <= 160, "tight recall must stay within budget");
    assert.ok(tight.truncated, "tight recall must report truncation");
    assert.ok(tight.atoms.some((atom) => atom.node.id === hubId), "tight recall must still pack the best-matching hub");
    assert.ok(
      tight.atoms.length < generous.atoms.length || tight.evidence.length < generous.evidence.length,
      "tight recall must pack less than the generous recall",
    );
  });

  it("reads strengthen activation via accessCount and lastAccessedAt", async () => {
    const first = await store.read({ nodeId: hubId });
    assert.ok(first, "hub read failed");
    await store.read({ nodeId: hubId });
    const third = await store.read({ nodeId: hubId });
    assert.ok(third, "hub re-read failed");
    assert.ok(third.accessCount >= first.accessCount + 2, "reads must strengthen activation by bumping accessCount");
    assert.ok(third.lastAccessedAt, "reads must stamp lastAccessedAt");
  });

  it("packs full primary-note content and only teasers giant catalog pages", async () => {
    const marker = `REFUND_POLICY_${stamp}`;
    const policyBody = [
      "# Billing pricing rules",
      "",
      "Customer-facing refund policy.",
      "",
      `Annual plans: full refund within 14 days. Marker: ${marker}.`,
      "",
      "## After 14 days",
      "",
      "No refunds on annual plans after the window closes.",
      "",
      "Customer success owns churn emails.",
      "",
      "Never promise a refund without checking the 14-day clock.",
    ].join("\n");

    await store.capture({
      title: `Billing pricing rules ${stamp}`,
      type: "pattern",
      summary: "Refund and pricing rules for annual and monthly plans.",
      content: policyBody,
      evidence: [],
      links: [],
    }, context);

    // Giant "index" that also matches loose words but must not starve the pack.
    await store.capture({
      title: `Catalog index ${stamp}`,
      type: "entity",
      summary: "Catalog of every page including billing refund and pricing notes.",
      content: ("# Index\n\n" + "billing refund pricing notes ".repeat(2000)).slice(0, 20_000),
      evidence: [],
      links: [],
    }, context);

    // In-memory search is substring-includes on the whole query string.
    const packed = await store.recall({
      query: marker,
      tokenBudget: 6000,
      depth: 0,
      includeEvidence: false,
    });

    assert.ok(
      packed.atoms.some((atom) => atom.node.title.includes("Billing pricing rules")),
      `expected pricing note among packed atoms, got: ${packed.atoms.map((a) => a.node.title).join(", ")}`,
    );
    assert.ok(packed.context.includes(marker), "primary note body must appear in the pack");
    assert.ok(packed.context.includes("14 days"), "policy window fact must appear");
    assert.ok(packed.context.includes("Customer success owns churn emails"), "owner fact must appear");
    const giantIdx = packed.context.indexOf(`Catalog index ${stamp}`);
    if (giantIdx >= 0) {
      const after = packed.context.slice(giantIdx, giantIdx + 8_000);
      assert.ok(after.length < 6_000 || after.includes("…"), "giant catalog page must be teaser-capped");
      const fillerHits = (after.match(/billing refund pricing notes/g) ?? []).length;
      assert.ok(fillerHits < 80, `giant page teaser should be short, saw ${fillerHits} filler phrases`);
    }
  });
});
