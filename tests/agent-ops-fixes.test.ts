import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { forget, remember } from "../src/agentOps.js";
import { suiteStore, closeStore } from "./helpers.js";

// Regression tests for the agent-ops fixes:
// - F2: forget retires whole beliefs (nodes), not only edges.
// - F9: remember dedupes via trigram title similarity and reports scored
//   near-matches; exact titles still revise.
// - F4: remember's internal reads never bump access activation.
describe("agent ops fixes", () => {
  const { store, context, stamp } = suiteStore("agent-ops-fixes");

  after(async () => {
    await closeStore(store);
  });

  it("forget with nodeIds tombstones the node out of read, grep, and recall", async () => {
    const marker = `FORGETSMOKE_${stamp}`;
    const node = await store.capture({
      title: `Retire me ${marker}`,
      type: "claim",
      summary: "This belief is about to be retired.",
      content: `Retired belief body ${marker}.`,
      evidence: [],
      links: [],
    }, context);

    const preview = await forget(store, { nodeIds: [node.id], dryRun: true }, context);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.tombstoned, 0, "dry run must not tombstone");
    assert.ok(preview.nodes.some((target) => target.nodeId === node.id), "dry run must preview the targeted node");
    assert.ok(await store.read({ nodeId: node.id }, context), "dry run must leave the node readable");

    const applied = await forget(store, { nodeIds: [node.id] }, context);
    assert.equal(applied.dryRun, false);
    assert.equal(applied.tombstoned, 1, "exactly one node must be tombstoned");
    assert.ok(applied.nodes.some((target) => target.nodeId === node.id));

    assert.equal(await store.read({ nodeId: node.id }, context), null, "tombstoned node must leave read");
    const grepHits = await store.grep({ pattern: marker, scope: "nodes", caseSensitive: false, limit: 20 }, context);
    assert.ok(!grepHits.matches.some((match) => match.nodeId === node.id), "tombstoned node must leave grep");
    const recalled = await store.recall({ query: marker, tokenBudget: 2000 }, context);
    assert.ok(!recalled.atoms.some((atom) => atom.node.id === node.id), "tombstoned node must leave recall");
  });

  it("forget resolves slugs, errors hard on unknown slugs, and keeps edge-only behavior", async () => {
    const marker = `FORGETSLUG_${stamp}`;
    const bySlug = await store.capture({
      title: `Slug target ${marker}`,
      type: "claim",
      summary: "Retired via slug.",
      content: `Slug target body ${marker}.`,
      evidence: [],
      links: [],
    }, context);

    const applied = await forget(store, { slugs: [bySlug.slug] }, context);
    assert.equal(applied.tombstoned, 1);
    assert.ok(applied.nodes.some((target) => target.nodeId === bySlug.id));
    assert.equal(await store.read({ nodeId: bySlug.id }, context), null, "slug-targeted node must be tombstoned");

    await assert.rejects(
      () => forget(store, { slugs: [`no-such-slug-${stamp}`] }, context),
      /no node with slug/,
      "unknown slug must be a hard error",
    );

    // Edge-only forget is unchanged: retires the edge, touches no node.
    const from = await store.capture({
      title: `Edge source ${marker}`,
      type: "claim",
      summary: "Edge-only forget source.",
      evidence: [],
      links: [],
    }, context);
    const to = await store.capture({
      title: `Edge target ${marker}`,
      type: "claim",
      summary: "Edge-only forget target.",
      evidence: [],
      links: [],
    }, context);
    const edge = await store.link({ fromNodeId: from.id, toNodeId: to.id, predicate: "relates_to", weight: 1 }, context);
    assert.ok(edge, "link must create an edge");

    const retired = await forget(store, { edgeIds: [edge.id] }, context);
    assert.equal(retired.retired, 1, "exactly one edge must be retired");
    assert.equal(retired.tombstoned, 0, "edge-only forget must not tombstone nodes");
    assert.equal(retired.nodes.length, 0);
    assert.ok(await store.read({ nodeId: from.id }, context), "edge-only forget leaves nodes readable");
  });

  it("remember reports scored near-title twins but still revises on exact titles", async () => {
    const base = await remember(store, {
      title: `Airflow DAG ownership rules ${stamp}`,
      type: "claim",
      summary: "Data platform owns DAG scheduling.",
      content: "Ownership rules body.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(base.action, "created");

    const twin = await remember(store, {
      title: `Airflow DAG ownership ${stamp}`,
      type: "claim",
      summary: "A related but distinct note.",
      content: "Twin body.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(twin.action, "created", "near-title must create, not merge");
    assert.notEqual(twin.node.id, base.node.id);
    const hit = twin.similar.find((candidate) => candidate.nodeId === base.node.id);
    assert.ok(hit, "trigram dedupe must surface the near-twin in similar");
    assert.equal(typeof hit.score, "number", "similar entries must carry a score");
    assert.ok(hit.score > 0.25, `near-twin score must clear the 0.25 floor, got ${hit.score}`);

    const revise = await remember(store, {
      title: `Airflow DAG ownership rules ${stamp}`,
      type: "claim",
      summary: "Revised: analytics owns DAG scheduling now.",
      content: "Revised ownership rules body.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(revise.action, "updated", "exact title must revise in place");
    assert.equal(revise.node.id, base.node.id);
  });

  it("remember's revise path does not bump accessCount or lastAccessedAt", async () => {
    const title = `Activation remember ${stamp}`;
    const created = await remember(store, {
      title,
      type: "claim",
      summary: "First write.",
      content: "First body.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(created.action, "created");

    const revised = await remember(store, {
      title,
      type: "claim",
      summary: "Revised write.",
      content: "Revised body.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(revised.action, "updated");

    const snapshot = await store.exportGraph(context);
    const node = snapshot.nodes.find((candidate) => candidate.id === created.node.id);
    assert.ok(node, "remembered node missing from graph snapshot");
    assert.equal(node.accessCount, 0, "remember's dedupe reads must not bump accessCount");
    assert.equal(node.lastAccessedAt, null, "remember's dedupe reads must not stamp lastAccessedAt");
  });
});
