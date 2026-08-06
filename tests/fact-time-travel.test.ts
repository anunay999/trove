import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readAny } from "../src/agentOps.js";
import { readAnyInputSchema, readInputSchema } from "../src/contracts.js";
import { closeStore, isolateDatabase, sleep, suiteStore } from "./helpers.js";

await isolateDatabase("fact_time_travel");

describe("fact-level time travel", () => {
  const { store, context, stamp } = suiteStore("fact_time_travel");
  after(async () => closeStore(store));

  const capture = (suffix: string, summary = "Original summary.", content = "Original body.") =>
    store.capture({
      title: stamp + " " + suffix,
      type: "claim",
      summary,
      content,
      evidence: [],
      links: [],
    }, context);

  it("returns the old summary at asOf and the new summary now", async () => {
    const node = await capture("summary history");
    await sleep(20);
    const beforeUpdate = new Date().toISOString();
    await sleep(20);
    const updated = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      summary: "Revised summary.",
    }, context);
    assert.ok(updated && !("conflict" in updated));
    assert.equal((await store.read({ nodeId: node.id, asOf: beforeUpdate }, context))?.summary, "Original summary.");
    const publicRead = await readAny(store, { id: node.id, asOf: beforeUpdate }, context);
    assert.equal(publicRead?.kind, "node");
    assert.equal(publicRead?.kind === "node" ? publicRead.node.summary : null, "Original summary.");
    assert.equal((await store.read({ nodeId: node.id }, context))?.summary, "Revised summary.");
  });

  it("returns null when asOf predates the node's first revision", async () => {
    const beforeCreation = new Date().toISOString();
    await sleep(20);
    const node = await capture("not yet believed");
    assert.equal(await store.read({ nodeId: node.id, asOf: beforeCreation }, context), null);
  });

  it("mints distinct revisions for title-only and summary-only changes", async () => {
    const node = await capture("version fact fields");
    await sleep(20);
    const beforeTitleUpdate = new Date().toISOString();
    await sleep(20);
    const revisedTitle = stamp + " revised title";
    const titled = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      title: revisedTitle,
    }, context);
    assert.ok(titled && !("conflict" in titled));
    assert.notEqual(titled.revisionId, node.revisionId, "content-only triggering would miss title changes");
    assert.equal((await store.read({ nodeId: node.id, asOf: beforeTitleUpdate }, context))?.title, node.title);
    assert.equal((await store.read({ nodeId: node.id }, context))?.title, revisedTitle);

    const summarized = await store.update({
      nodeId: node.id,
      baseRevisionId: titled.revisionId,
      summary: "Versioned fact summary.",
    }, context);
    assert.ok(summarized && !("conflict" in summarized));
    assert.notEqual(summarized.revisionId, titled.revisionId, "content-only triggering would miss summary changes");
  });

  it("keeps content-only revisions time-travelable", async () => {
    const node = await capture("content history");
    await sleep(20);
    const beforeUpdate = new Date().toISOString();
    await sleep(20);
    const updated = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      content: "Revised body.",
    }, context);
    assert.ok(updated && !("conflict" in updated));
    assert.notEqual(updated.revisionId, node.revisionId);
    assert.equal((await store.read({ nodeId: node.id, asOf: beforeUpdate }, context))?.content, "Original body.");
    assert.equal((await store.read({ nodeId: node.id }, context))?.content, "Revised body.");
  });

  it("accepts ISO asOf on both public read schemas and rejects malformed timestamps", () => {
    const asOf = "2026-08-06T12:34:56.000Z";
    assert.equal(readInputSchema.parse({ slug: "fact", asOf }).asOf, asOf);
    assert.equal(readAnyInputSchema.parse({ slug: "fact", asOf }).asOf, asOf);
    assert.throws(() => readInputSchema.parse({ slug: "fact", asOf: "yesterday" }));
    assert.throws(() => readAnyInputSchema.parse({ slug: "fact", asOf: "yesterday" }));
  });
});
