import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import type { TextUnit } from "../src/contracts.js";
import type { GraphOperationContext, GraphStore } from "../src/graphCore.js";
import { UserStore } from "../src/users.js";
import { suiteStore, closeStore, hasPostgres, isolateDatabase } from "./helpers.js";

// Queue-state isolation under Postgres; harmless no-op on the memory driver.
await isolateDatabase("evidence_quote");

/**
 * Backlog #9 follow-through: cite-by-quote ({ quote } resolved to a text unit,
 * exact then fuzzy, W3C TextQuoteSelector stored) and the session-served
 * provenance check (a cited unit the session never received is flagged in
 * evidenceUnserved — attached, never silently dropped). Raw UUID-only fixtures
 * clear backlog #17's gate unless a test intentionally exercises its warning;
 * quote-grounded mixed evidence remains exempt. Runs on BOTH drivers.
 */
describe("cite-by-quote evidence (backlog #9)", () => {
  const { store, context, stamp } = suiteStore("evidence-quote");

  let s1Units: TextUnit[]; // widget line / backup line / ferris line
  let s2Units: TextUnit[]; // backup line (again) / cedar line
  let s2SourceId: string;
  let otherUnits: TextUnit[]; // ingested under a DIFFERENT owner scope
  let otherContext: GraphOperationContext;

  before(async () => {
    const one = await store.ingest({
      kind: "agent_note",
      title: `Quote source one ${stamp}`,
      contentText: [
        "The widget service listens on port 9191 after the migration.",
        "",
        "The backup window is Sunday at 3am.",
        "",
        "Ferris the cat takes gabapentin twice daily with food.",
      ].join("\n"),
      metadata: {},
    }, context);
    s1Units = one.textUnits;

    const two = await store.ingest({
      kind: "agent_note",
      title: `Quote source two ${stamp}`,
      contentText: [
        "The backup window is Sunday at 3am.",
        "",
        "Completely unrelated note about cedar decking oil.",
      ].join("\n"),
      metadata: {},
    }, context);
    s2Units = two.textUnits;
    s2SourceId = two.source.id;

    // A second owner scope: units from this ingest are served THERE, never in
    // this suite's main context. (pg owner_id references app_user, so register
    // a real user on that driver; the memory driver takes any id.)
    let otherOwnerId = `eq-other-${stamp}`;
    if (hasPostgres()) {
      const users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
      try {
        const user = await users.ensureUser({ clerkUserId: `eq-other-${stamp}`, email: `eq-other-${stamp}@example.com` });
        otherOwnerId = user.id;
      } finally {
        await users.close();
      }
    }
    otherContext = { ...context, ownerId: otherOwnerId };
    const three = await store.ingest({
      kind: "agent_note",
      title: `Quote source three ${stamp}`,
      contentText: "Persephone's telescope lives in the garden observatory dome.",
      metadata: {},
    }, otherContext);
    otherUnits = three.textUnits;
  });

  after(async () => {
    await closeStore(store);
  });

  const unitWithText = (units: TextUnit[], fragment: string): TextUnit => {
    const unit = units.find((candidate) => candidate.text.includes(fragment));
    assert.ok(unit, `fixture must contain a unit with "${fragment}"`);
    return unit;
  };

  const annotationsFor = async (store_: GraphStore, nodeId: string) => {
    const read = await store_.read({ nodeId }, context, { trackAccess: false });
    assert.ok(read, "node must be readable");
    return read.annotations;
  };

  it("exact quote resolves to the containing unit and stores a TextQuoteSelector", async () => {
    const widget = unitWithText(s1Units, "widget service");
    const result = await remember(store, {
      title: `Quote exact ${stamp}`,
      type: "claim",
      summary: "The widget service is on port 9191.",
      evidence: [{ quote: "the widget service listens on port 9191 after the migration." }],
      links: [],
    }, context);
    assert.equal(result.evidenceRejected, undefined, `exact quote must resolve: ${JSON.stringify(result.evidenceRejected)}`);
    assert.equal(result.evidenceUnserved, undefined, "quote-resolved refs are grounded, never unserved");
    assert.equal(result.evidenceUnsupported, undefined, "quote-resolved refs are exempt from the raw-UUID support gate");
    const annotations = await annotationsFor(store, result.node.id);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0]?.textUnitId, widget.id, "must cite the unit containing the quote (case-insensitively)");
    assert.equal(annotations[0]?.sourceId, widget.sourceId);
    assert.equal(annotations[0]?.selector.type, "TextQuoteSelector");
    assert.equal(annotations[0]?.selector.match, "exact");
  });

  it("fuzzy quote (same terms, not verbatim) resolves when one span clearly matches", async () => {
    const widget = unitWithText(s1Units, "widget service");
    const result = await remember(store, {
      title: `Quote fuzzy ${stamp}`,
      type: "claim",
      summary: "The widget service is on port 9191.",
      evidence: [{ quote: "widget service port 9191 migration listens" }],
      links: [],
    }, context);
    assert.equal(result.evidenceRejected, undefined, `fuzzy quote must resolve: ${JSON.stringify(result.evidenceRejected)}`);
    const annotations = await annotationsFor(store, result.node.id);
    assert.equal(annotations[0]?.textUnitId, widget.id);
    assert.equal(annotations[0]?.selector.match, "fuzzy");
    assert.equal(typeof annotations[0]?.selector.score, "number", "fuzzy citations record the containment score");
  });

  it("ambiguous exact quote is rejected with the candidate spans, then sourceId repairs it", async () => {
    const backupOne = unitWithText(s1Units, "backup window");
    const backupTwo = unitWithText(s2Units, "backup window");
    const ambiguous = await remember(store, {
      title: `Quote ambiguous ${stamp}`,
      type: "claim",
      summary: "The backup window is Sunday at 3am.",
      evidence: [{ quote: "The backup window is Sunday at 3am." }],
      links: [],
    }, context);
    assert.equal(ambiguous.evidenceRejected?.length, 1, "the ambiguous quote must be rejected");
    const reason = ambiguous.evidenceRejected?.[0]?.reason ?? "";
    assert.ok(reason.includes("ambiguous"), `reason must say why: ${reason}`);
    assert.ok(reason.includes(backupOne.id) && reason.includes(backupTwo.id), "reason must name the candidate units");
    assert.equal((await annotationsFor(store, ambiguous.node.id)).length, 0, "no annotation attaches for a rejected quote");

    // Repair path: the same quote scoped to one source resolves.
    const repaired = await remember(store, {
      title: `Quote ambiguous ${stamp}`,
      type: "claim",
      summary: "The backup window is Sunday at 3am.",
      evidence: [{ quote: "The backup window is Sunday at 3am.", sourceId: s2SourceId }],
      links: [],
    }, context);
    assert.equal(repaired.evidenceRejected, undefined, `sourceId must repair the ambiguity: ${JSON.stringify(repaired.evidenceRejected)}`);
    const annotations = await annotationsFor(store, repaired.node.id);
    assert.equal(annotations[0]?.textUnitId, backupTwo.id);
  });

  it("fuzzy-ambiguous quote (terms in two spans, verbatim in none) is rejected with the closest spans", async () => {
    const result = await remember(store, {
      title: `Quote fuzzy-ambiguous ${stamp}`,
      type: "claim",
      summary: "The backup window is Sunday at 3am.",
      evidence: [{ quote: "backup window Sunday 3am" }],
      links: [],
    }, context);
    assert.equal(result.evidenceRejected?.length, 1);
    const reason = result.evidenceRejected?.[0]?.reason ?? "";
    assert.ok(reason.includes("No span contains the quote verbatim"), `reason must distinguish fuzzy-ambiguous: ${reason}`);
    assert.ok(reason.includes("%"), "reason must report the containment of the closest spans");
  });

  it("no-match quote is rejected with an ingest-or-quote-served repair", async () => {
    const result = await remember(store, {
      title: `Quote no-match ${stamp}`,
      type: "claim",
      summary: "Something that was never said.",
      evidence: [{ quote: `zyxwv quantum umbrella never ingested ${stamp}` }],
      links: [],
    }, context);
    assert.equal(result.action, "created", "the node still lands — evidence failure is not write failure");
    assert.equal(result.evidenceRejected?.length, 1);
    const reason = result.evidenceRejected?.[0]?.reason ?? "";
    assert.ok(reason.includes("does not appear in any ingested span"), `reason must say no span matched: ${reason}`);
    assert.ok(reason.includes("Ingest the source first"), `reason must be repairable: ${reason}`);
    assert.equal(result.evidenceRejected?.[0]?.quote, `zyxwv quantum umbrella never ingested ${stamp}`, "the rejected entry carries the quote");
  });

  it("quote + textUnitId verifies containment, and a mismatch rejects with where the quote IS", async () => {
    const ferris = unitWithText(s1Units, "Ferris the cat");
    const widget = unitWithText(s1Units, "widget service");
    const verified = await remember(store, {
      title: `Quote verify ${stamp}`,
      type: "claim",
      summary: "Ferris takes gabapentin twice daily.",
      evidence: [{ quote: "Ferris the cat takes gabapentin twice daily with food.", textUnitId: ferris.id }],
      links: [],
    }, context);
    assert.equal(verified.evidenceRejected, undefined, `containment must verify: ${JSON.stringify(verified.evidenceRejected)}`);
    assert.equal((await annotationsFor(store, verified.node.id))[0]?.textUnitId, ferris.id);

    const mismatched = await remember(store, {
      title: `Quote verify mismatch ${stamp}`,
      type: "claim",
      summary: "Ferris takes gabapentin twice daily.",
      evidence: [{ quote: "Ferris the cat takes gabapentin twice daily with food.", textUnitId: widget.id }],
      links: [],
    }, context);
    assert.equal(mismatched.evidenceRejected?.length, 1);
    const reason = mismatched.evidenceRejected?.[0]?.reason ?? "";
    assert.ok(reason.includes(`does not appear in cited text unit ${widget.id}`), `reason must name the wrong unit: ${reason}`);
    assert.ok(reason.includes(ferris.id), "reason must say where the quote actually is");
    assert.equal((await annotationsFor(store, mismatched.node.id)).length, 0);
  });

  it("mixed quote + served UUID refs both attach in one remember", async () => {
    const widget = unitWithText(s1Units, "widget service");
    const ferris = unitWithText(s1Units, "Ferris the cat");
    const result = await remember(store, {
      title: `Quote mixed ${stamp}`,
      type: "claim",
      summary: "The widget service uses port 9191.",
      evidence: [
        { quote: "the widget service listens on port 9191 after the migration." },
        { textUnitId: ferris.id },
      ],
      links: [],
    }, context);
    assert.equal(result.evidenceRejected, undefined);
    assert.equal(result.evidenceUnserved, undefined, "the ingest response served the UUID unit");
    assert.equal(result.evidenceUnsupported, undefined, "a resolved quote grounds the note and suppresses the raw-UUID warning");
    const annotations = await annotationsFor(store, result.node.id);
    assert.equal(annotations.length, 2);
    assert.ok(annotations.some((annotation) => annotation.textUnitId === widget.id));
    assert.ok(annotations.some((annotation) => annotation.textUnitId === ferris.id));
  });

  it("a UUID ref to a unit never served to this session attaches but warns in evidenceUnserved", async () => {
    const other = otherUnits[0];
    assert.ok(other, "other-owner fixture unit must exist");
    const result = await remember(store, {
      title: `Unserved uuid ${stamp}`,
      type: "claim",
      summary: "Persephone's telescope lives in the garden observatory dome.",
      evidence: [{ textUnitId: other.id }],
      links: [],
    }, context);
    assert.equal(result.evidenceRejected, undefined, "the unit exists — it must attach");
    assert.equal(result.evidenceUnserved?.length, 1, "but it was never served to this session");
    const reason = result.evidenceUnserved?.[0]?.reason ?? "";
    assert.ok(reason.includes("never served"), `reason must say what is wrong: ${reason}`);
    assert.ok(reason.includes("{ quote }"), "reason must teach the repair");
    assert.equal((await annotationsFor(store, result.node.id)).length, 1, "attached — non-breaking by design");
  });

  it("grep serves the units it returns", async () => {
    const ferris = unitWithText(s1Units, "Ferris the cat");
    const hits = await store.grep({ pattern: "gabapentin", scope: "sources", caseSensitive: false, limit: 20 }, context);
    assert.ok(hits.matches.some((match) => match.textUnitId === ferris.id), "grep must return the unit id");
    const result = await remember(store, {
      title: `Grep-served uuid ${stamp}`,
      type: "claim",
      summary: "Ferris takes gabapentin twice daily with food.",
      evidence: [{ textUnitId: ferris.id }],
      links: [],
    }, context);
    assert.equal(result.evidenceUnserved, undefined, "a unit grep served is not a hallucination");
  });

  it("recall serves the evidence it packs", async () => {
    const widget = unitWithText(s1Units, "widget service");
    const pack = await store.recall({ query: "widget service port 9191", tokenBudget: 8000, depth: 0, includeEvidence: true }, context);
    assert.ok(pack.evidence.some((unit) => unit.id === widget.id), "the pack must carry the cited unit");
    const result = await remember(store, {
      title: `Recall-served uuid ${stamp}`,
      type: "claim",
      summary: "The widget service listens on port 9191 after the migration.",
      evidence: [{ textUnitId: widget.id }],
      links: [],
    }, context);
    assert.equal(result.evidenceUnserved, undefined, "a unit recall served is not a hallucination");
  });

  it("quote resolution fails closed across owner scopes (pg-only; memory declares no owner enforcement)", async () => {
    // S1/S2 were ingested by the UNSCOPED main context (owner NULL on pg), so
    // the owner-scoped context must not resolve quotes against them. The
    // memory driver is single-user by construction (declared #6 residual).
    if (!hasPostgres()) return;
    const result = await remember(store, {
      title: `Cross-owner quote ${stamp}`,
      type: "claim",
      summary: "Quoting text outside the caller's owner scope.",
      evidence: [{ quote: "the widget service listens on port 9191 after the migration." }],
      links: [],
    }, otherContext);
    assert.equal(
      result.evidenceRejected?.length,
      1,
      "an owner-scoped quote must fail closed against text it cannot see",
    );
  });

  it("raw UUID evidence fails closed as unknown across owner scopes on both drivers", async () => {
    const widget = unitWithText(s1Units, "widget service");
    const result = await remember(store, {
      title: `Cross-owner UUID ${stamp}`,
      type: "claim",
      summary: "The widget service listens on port 9191 after the migration.",
      evidence: [{ textUnitId: widget.id }],
      links: [],
    }, otherContext);

    assert.equal(result.complete, false, "an invisible UUID citation leaves a partial result");
    assert.equal(result.evidenceRejected?.length, 1);
    assert.equal(result.evidenceRejected?.[0]?.textUnitId, widget.id);
    assert.match(result.evidenceRejected?.[0]?.reason ?? "", /unknown text unit/i);
    assert.equal(result.evidenceUnsupported, undefined, "an invisible unit is rejected before support scoring");
    assert.equal((await store.read({ nodeId: result.node.id }, otherContext, { trackAccess: false }))?.annotations.length, 0);
  });

});
