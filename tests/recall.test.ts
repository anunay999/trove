import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { recallInputSchema } from "../src/contracts.js";
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

  it("draws its candidates from more than the first ten search hits", async () => {
    // A query that fourteen short notes all match. With the seed search capped
    // at ten, four of them could never enter the pack no matter how generous
    // the budget — recall was silently narrower than search.
    const token = `quorumpool${stamp}`;
    const ids: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      const node = await store.capture({
        title: `${token} note ${index}`,
        type: "claim",
        summary: `${token} candidate ${index} for the recall pool.`,
        content: `Short body ${index} mentioning ${token} once so the pack stays cheap.`,
        evidence: [],
        links: [],
      }, context);
      ids.push(node.id);
    }

    const result = await store.recall({ query: token, tokenBudget: 32000, includeEvidence: false }, context);
    const packed = result.atoms.filter((atom) => atom.hops === 0 && ids.includes(atom.node.id));
    assert.ok(
      packed.length > 10,
      `recall packed only ${packed.length} of 14 matching notes under a 32k budget — the seed search is capping candidates`,
    );
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

  it("rejects asOf outright instead of answering from the present", async () => {
    // recall never time-travelled: search, supersession, and evidence always
    // came from the present, only the expansion honoured asOf. An old client
    // still sending it must hear that, not get a present-day pack.
    const asOf = "2026-01-01T00:00:00.000Z";
    const parsed = recallInputSchema.safeParse({ query: "anything", asOf });
    assert.equal(parsed.success, false, "asOf must not parse on recall");
    const messages = parsed.error?.issues.map((issue) => issue.message).join("\n") ?? "";
    assert.match(messages, /asOf is not supported on recall/);
    assert.match(messages, /read/);
    assert.match(messages, /neighborhood/);
    await assert.rejects(
      async () => store.recall({ query: "anything", asOf } as never, context),
      /asOf is not supported on recall/,
    );
    // Without asOf the same input is fine: the rejection is targeted, not strict mode.
    assert.equal(recallInputSchema.safeParse({ query: "anything" }).success, true);
  });

  // asOf is gone, but the question can still carry a time. recall now reads it
  // out of the query text and uses it to REWEIGHT ranking — never to filter,
  // and never to swap a body for an older revision, which is the incoherence
  // that got asOf removed.
  it("leaves a query with no temporal words exactly as it is today", async () => {
    const withFeature = await store.recall({ query: "recall smoke", tokenBudget: 2000 });
    assert.equal(withFeature.temporalScope, undefined, "a dateless query must report no scope");
    assert.ok(!withFeature.context.includes("Temporal scope"), "a dateless pack must not grow a scope line");

    // The kill switch is the honest baseline for "what recall did before".
    const previous = process.env.TROVE_TEMPORAL_SCOPE;
    process.env.TROVE_TEMPORAL_SCOPE = "0";
    try {
      const withoutFeature = await store.recall({ query: "recall smoke", tokenBudget: 2000 });
      // Byte-identical bar the last float digits: the activation term reads the
      // wall clock, so two recalls milliseconds apart already differ around the
      // tenth decimal. Anything this feature could do would move a score by
      // 0.25, or reorder atoms, or add a field — all of which survive rounding.
      const shape = (pack: Awaited<ReturnType<typeof store.recall>>): string =>
        JSON.stringify(pack, (_key, value) =>
          (typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(6)) : value));
      assert.equal(
        shape(withFeature),
        shape(withoutFeature),
        "a dateless recall must be identical with temporal scoping on and off",
      );
    } finally {
      if (previous === undefined) delete process.env.TROVE_TEMPORAL_SCOPE;
      else process.env.TROVE_TEMPORAL_SCOPE = previous;
    }
  });

  it("prefers the fact that was true in the asked-about window, and says which window", async () => {
    // Two neighbors of one hub, alike in everything the ranker measures, told
    // apart only by the world time of the edge that attaches them: one link
    // was true in January, the other only became true in March. Last year, so
    // both windows are firmly in the past whenever this suite runs.
    const year = new Date().getUTCFullYear() - 1;
    const token = `kestrelscope${stamp}`;
    const hub = await store.capture({
      title: `${token} rollout hub`,
      type: "decision",
      summary: `The ${token} rollout hub links the runbook that was current in each window.`,
      content: `Everything about the ${token} rollout hangs off this hub.`,
      evidence: [],
      links: [],
    }, context);
    // Padded to one length, so of the pre-existing tie-breaks (content length,
    // then slug) only the slug can speak: Alfa sorts before Zulu, and the
    // baseline order is therefore the opposite of the temporal answer.
    const body = (text: string): string => text.padEnd(96, ".");
    const january = await store.capture({
      title: `Zulu runbook ${stamp}`,
      type: "pattern",
      summary: "Deploys went out through the blue pipeline with two approvals.",
      content: body("The blue pipeline required two approvals and a manual smoke pass before release."),
      evidence: [],
      links: [],
    }, context);
    const march = await store.capture({
      title: `Alfa runbook ${stamp}`,
      type: "pattern",
      summary: "Deploys went out through the gold pipeline with one approval.",
      content: body("The gold pipeline required one approval and an automated smoke pass at release."),
      evidence: [],
      links: [],
    }, context);
    await store.link({
      fromNodeId: hub.id, toNodeId: january.id, predicate: "documented_by", weight: 1,
      validFrom: `${year}-01-05T00:00:00.000Z`,
    }, context);
    await store.link({
      fromNodeId: hub.id, toNodeId: march.id, predicate: "documented_by", weight: 1,
      validFrom: `${year}-03-05T00:00:00.000Z`,
    }, context);

    const query = `what did the ${token} rollout look like in January ${year}`;
    const rank = (pack: Awaited<ReturnType<typeof store.recall>>, nodeId: string): number =>
      pack.atoms.findIndex((atom) => atom.node.id === nodeId);

    // Baseline: with scoping off, the tie-breaks put Alfa ahead of Zulu.
    const previous = process.env.TROVE_TEMPORAL_SCOPE;
    process.env.TROVE_TEMPORAL_SCOPE = "0";
    let baseline: Awaited<ReturnType<typeof store.recall>>;
    try {
      baseline = await store.recall({ query, tokenBudget: 4000, includeEvidence: false }, context);
    } finally {
      if (previous === undefined) delete process.env.TROVE_TEMPORAL_SCOPE;
      else process.env.TROVE_TEMPORAL_SCOPE = previous;
    }
    assert.ok(rank(baseline, january.id) >= 0 && rank(baseline, march.id) >= 0, "both neighbors must reach the baseline pack");
    assert.ok(
      rank(baseline, march.id) < rank(baseline, january.id),
      "baseline order must put the March-linked note first, or this test proves nothing",
    );
    assert.equal(baseline.temporalScope, undefined, "the kill switch must also silence the reported scope");

    const scoped = await store.recall({ query, tokenBudget: 4000, includeEvidence: false }, context);
    assert.ok(rank(scoped, january.id) >= 0 && rank(scoped, march.id) >= 0, "both neighbors must reach the scoped pack");
    assert.ok(
      rank(scoped, january.id) < rank(scoped, march.id),
      "'in January' must lift the note whose link was true in January above the one that only became true in March",
    );

    // Surfaced, so an agent can answer "as of January" instead of silently
    // answering about another time.
    assert.ok(scoped.temporalScope, "a parsed scope must be reported on the pack");
    assert.equal(scoped.temporalScope.kind, "interval");
    assert.equal(scoped.temporalScope.label, `January ${year}`);
    assert.equal(scoped.temporalScope.applied, "reweight");
    assert.equal(scoped.temporalScope.from, `${year}-01-01T00:00:00.000Z`);
    assert.equal(scoped.temporalScope.until, `${year}-02-01T00:00:00.000Z`);
    assert.equal(scoped.temporalScope.phrase, `in January ${year}`);
    assert.ok(
      !scoped.temporalScope.searchQuery.toLowerCase().includes("january"),
      "the date phrase must be stripped before the lexical and semantic arms see the query",
    );
    assert.ok(scoped.temporalScope.searchQuery.includes(token), "stripping must leave the question itself intact");
    assert.ok(scoped.context.includes(`Temporal scope: January ${year}`), "the pack text must name the window it answers about");
  });
});
