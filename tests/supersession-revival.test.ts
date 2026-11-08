import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import { supersessionRevivedBy } from "../src/graphCore.js";
import { closeStore, isolateDatabase, sleep, suiteStore } from "./helpers.js";

await isolateDatabase("supersession_revival");

/**
 * A note revised after something superseded it re-asserts itself. Before this
 * fix recall kept labelling the freshest value "SUPERSEDED by <stale note>",
 * and a reader that respects the label answered with the stale value.
 */
describe("supersession revival", () => {
  const { store, context, stamp } = suiteStore("supersession-revival");

  after(async () => {
    await closeStore(store);
  });

  it("only a strictly later fact revision revives the target", () => {
    assert.equal(supersessionRevivedBy("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), true);
    assert.equal(supersessionRevivedBy("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), false);
    assert.equal(supersessionRevivedBy("2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), false);
    assert.equal(supersessionRevivedBy(null, "2026-01-01T00:00:00.000Z"), false);
  });

  it("revising a superseded note clears its SUPERSEDED mark and lints the edge", async () => {
    const marker = `revivalport${stamp}`;
    const oldNote = await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} listens on v1001.` }, context);
    const newer = await remember(store, { title: `port for ${marker}`, type: "claim", summary: `${marker} listens on v1002.` }, context);
    const edge = await store.link({ fromSlug: newer.node.slug, toSlug: oldNote.node.slug, predicate: "supersedes", weight: 1 }, context);
    assert.ok(edge, "supersedes edge must be written");

    const before = await store.supersededBy([oldNote.node.id], context);
    assert.equal(before.get(oldNote.node.id)?.byNodeId, newer.node.id, "freshly superseded note is marked");

    await sleep(15);
    const revised = await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} listens on v1003.` }, context);
    assert.equal(revised.action, "updated");
    assert.equal(revised.node.id, oldNote.node.id);

    const afterRevision = await store.supersededBy([oldNote.node.id], context);
    assert.equal(afterRevision.has(oldNote.node.id), false, "a revision after the edge re-asserts the note");

    const pack = await store.recall({ query: `${marker} port`, tokenBudget: 4000, depth: 0, includeEvidence: false }, context);
    const header = pack.context.split("\n").find((line) => line.includes(`(${oldNote.node.slug})`));
    assert.ok(header, "revised note is recalled");
    assert.doesNotMatch(header, /SUPERSEDED/, "recall no longer labels the current value outdated");

    const lint = await store.lint(context);
    const finding = lint.findings.find((item) => item.code === "revised_after_superseded" && item.entityId === edge.id);
    assert.ok(finding, "the edge it stopped honouring is reported for curation");
  });

  it("a no-op remember does not clear the mark", async () => {
    const marker = `revivalnoop${stamp}`;
    const oldNote = await remember(store, { title: `${marker} owner`, type: "claim", summary: `${marker} is owned by Platform.` }, context);
    const newer = await remember(store, { title: `owner of ${marker}`, type: "claim", summary: `${marker} is owned by Billing.` }, context);
    await store.link({ fromSlug: newer.node.slug, toSlug: oldNote.node.slug, predicate: "supersedes", weight: 1 }, context);

    await sleep(15);
    // Same title and summary: no new fact revision, so the edge still applies.
    await remember(store, { title: `${marker} owner`, type: "claim", summary: `${marker} is owned by Platform.` }, context);
    const marks = await store.supersededBy([oldNote.node.id], context);
    assert.equal(marks.get(oldNote.node.id)?.byNodeId, newer.node.id);
  });

  it("an edge recorded after the revision still supersedes", async () => {
    const marker = `revivalorder${stamp}`;
    const oldNote = await remember(store, { title: `${marker} region`, type: "claim", summary: `${marker} runs in eu-west-1.` }, context);
    await sleep(15);
    await remember(store, { title: `${marker} region`, type: "claim", summary: `${marker} runs in eu-west-2.` }, context);
    await sleep(15);
    const newer = await remember(store, { title: `${marker} region (moved)`, type: "claim", summary: `${marker} runs in us-east-1.` }, context);
    await store.link({ fromSlug: newer.node.slug, toSlug: oldNote.node.slug, predicate: "supersedes", weight: 1 }, context);
    const marks = await store.supersededBy([oldNote.node.id], context);
    assert.equal(marks.get(oldNote.node.id)?.byNodeId, newer.node.id);
  });
});
