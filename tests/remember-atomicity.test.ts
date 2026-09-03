import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import { UnknownEvidenceReferenceError } from "../src/graphCore.js";
import { slugify } from "../src/slug.js";
import { suiteStore, closeStore, hasPostgres } from "./helpers.js";

/**
 * docs/architecture.md promises that remember is one transaction. These lock
 * that in: the node, its evidence and its links land together or not at all,
 * on the create path and on the revise path, on both drivers.
 */
describe("remember writes the node, its evidence and its links atomically", () => {
  const { store, context, stamp } = suiteStore("remember-atomicity");

  after(async () => {
    await closeStore(store);
  });

  const bogusUnitId = "00000000-0000-0000-0000-000000000000";

  const ingestSpan = async (text: string) => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Atomicity source ${text.slice(0, 12)} ${stamp}`,
      contentText: text,
      metadata: {},
    }, context);
    const unit = ingested.textUnits[0];
    assert.ok(unit, "ingest must produce a text unit");
    return { sourceId: ingested.source.id, unit };
  };

  it("create path lands the node with its links and evidence in one write", async () => {
    const { unit } = await ingestSpan(`The atomic widget listens on port 4242 ${stamp}.`);
    const target = await remember(store, {
      title: `Atomic link target ${stamp}`,
      type: "claim",
      summary: "A node for remember to link to.",
      evidence: [],
      links: [],
    }, context);

    const result = await remember(store, {
      title: `Atomic create ${stamp}`,
      type: "claim",
      summary: "The atomic widget listens on port 4242.",
      evidence: [{ quote: `The atomic widget listens on port 4242 ${stamp}.` }],
      links: [{ toSlug: target.node.slug, predicate: "relates_to" }],
    }, context);
    assert.equal(result.action, "created");
    assert.equal(result.complete, true, JSON.stringify(result));

    const read = await store.read({ nodeId: result.node.id }, context, { trackAccess: false });
    assert.ok(read);
    assert.equal(read.annotations.length, 1, "the quote citation must be attached");
    assert.equal(read.annotations[0]?.textUnitId, unit.id);
    assert.equal(read.annotations[0]?.selector.type, "TextQuoteSelector");
    const hood = await store.neighborhood({ nodeId: result.node.id, depth: 1, includeExpired: false }, context);
    assert.ok(
      hood.edges.some((edge) => edge.fromNodeId === result.node.id && edge.toNodeId === target.node.id && edge.predicate === "relates_to"),
      "the requested link must be attached",
    );
    assert.equal(hood.edges[0]?.weight, 1, "remember links carry weight 1");

    const events = await store.events({ limit: 50, order: "desc" }, context);
    assert.ok(
      events.events.some((event) => event.action === "link" && event.entityId === hood.edges[0]?.id),
      "a link attached by remember must still show in the event feed",
    );
  });

  it("revise path attaches new links and evidence in the same write as the revision", async () => {
    const title = `Atomic revise ${stamp}`;
    const { unit } = await ingestSpan(`Revisions carry their citations with them ${stamp}.`);
    const target = await remember(store, {
      title: `Atomic revise target ${stamp}`,
      type: "claim",
      summary: "Link target for the revise path.",
      evidence: [],
      links: [],
    }, context);
    const created = await remember(store, {
      title,
      type: "claim",
      summary: "First write, no evidence yet.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(created.action, "created");

    const revised = await remember(store, {
      title,
      type: "claim",
      summary: "Revised: now cited and linked.",
      evidence: [{ textUnitId: unit.id }],
      links: [{ toSlug: target.node.slug, predicate: "supports" }],
    }, context);
    assert.equal(revised.action, "updated");
    assert.equal(revised.node.id, created.node.id);
    assert.equal(revised.complete, true, JSON.stringify(revised));

    const read = await store.read({ nodeId: created.node.id }, context, { trackAccess: false });
    assert.ok(read);
    assert.equal(read.revisionId, revised.node.revisionId, "the revision must be current");
    assert.ok(read.annotations.some((annotation) => annotation.textUnitId === unit.id), "the citation must be attached");
    const hood = await store.neighborhood({ nodeId: created.node.id, depth: 1, includeExpired: false }, context);
    assert.ok(hood.edges.some((edge) => edge.toNodeId === target.node.id && edge.predicate === "supports"));
  });

  it("a link to a missing slug and a bogus ref are still reported, not fatal", async () => {
    const missing = slugify(`No such atomic target ${stamp}`);
    const result = await remember(store, {
      title: `Atomic partial ${stamp}`,
      type: "claim",
      summary: "One bad link, one bad citation, the node still lands.",
      evidence: [{ textUnitId: bogusUnitId }],
      links: [{ toSlug: missing, predicate: "relates_to" }],
    }, context);
    assert.equal(result.action, "created");
    assert.equal(result.complete, false);
    assert.equal(result.linkRejected?.[0]?.toSlug, missing);
    assert.equal(result.evidenceRejected?.[0]?.textUnitId, bogusUnitId);
    assert.ok(await store.read({ nodeId: result.node.id }, context, { trackAccess: false }));
  });

  it("capture with an unknown evidence ref leaves no node behind", async () => {
    const title = `Atomic capture failure ${stamp}`;
    await assert.rejects(
      async () => store.capture({
        title,
        type: "claim",
        summary: "This must never land.",
        evidence: [{ textUnitId: bogusUnitId, selector: {} }],
        links: [],
      }, context),
      (error: unknown) => error instanceof UnknownEvidenceReferenceError,
    );
    assert.equal(await store.read({ slug: slugify(title) }, context, { trackAccess: false }), null, "the node must roll back");
    const similar = await store.findSimilarTitles(title, 5, context);
    assert.ok(!similar.some((match) => match.node.title === title), "no trace of the node may remain");
  });

  it("update with an unknown evidence ref leaves the node untouched", async () => {
    const node = await store.capture({
      title: `Atomic update failure ${stamp}`,
      type: "claim",
      summary: "Before.",
      content: "Before body.",
      evidence: [],
      links: [],
    }, context);
    await assert.rejects(
      async () => store.update({
        nodeId: node.id,
        baseRevisionId: node.revisionId,
        summary: "After.",
        content: "After body.",
        evidence: [{ textUnitId: bogusUnitId, selector: {} }],
      }, context),
      (error: unknown) => error instanceof UnknownEvidenceReferenceError,
    );
    const read = await store.read({ nodeId: node.id }, context, { trackAccess: false });
    assert.ok(read);
    assert.equal(read.revisionId, node.revisionId, "no revision may be minted by a failed update");
    assert.equal(read.summary, "Before.");
    assert.equal(read.content, "Before body.");
    assert.equal(read.annotations.length, 0);
  });

  it("pg: a failure inside the evidence step rolls the whole remember back", async () => {
    // Postgres jsonb refuses \u0000 in a string (22P05). The selector is written by the
    // annotation insert, which runs after the node and revision rows, so this
    // is a deterministic failure inside the evidence step of a write whose
    // refs all resolved. Before the fix the node landed and the citation did
    // not; now nothing lands.
    if (!hasPostgres()) return;
    const { unit } = await ingestSpan(`A citation that cannot be stored ${stamp}.`);
    const title = `Atomic pg rollback ${stamp}`;
    await assert.rejects(
      async () => remember(store, {
        title,
        type: "claim",
        summary: "A citation that cannot be stored.",
        evidence: [{ textUnitId: unit.id, selector: { note: "\u0000" } }],
        links: [],
      }, context),
      /unicode|\\u0000/i,
    );
    assert.equal(await store.read({ slug: slugify(title) }, context, { trackAccess: false }), null, "the node must roll back");

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL as string });
    await client.connect();
    try {
      const nodes = await client.query("select count(*)::int as n from node where title = $1", [title]);
      assert.equal(nodes.rows[0].n, 0, "no node row may survive the rollback");
      const annotations = await client.query("select count(*)::int as n from annotation where text_unit_id = $1", [unit.id]);
      assert.equal(annotations.rows[0].n, 0, "no annotation row may survive the rollback");
      const events = await client.query(
        "select count(*)::int as n from graph_event where action = 'capture' and after->>'title' = $1",
        [title],
      );
      assert.equal(events.rows[0].n, 0, "no capture event may survive the rollback");
    } finally {
      await client.end();
    }
  });
});
