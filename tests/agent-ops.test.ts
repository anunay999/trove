import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { remember, forget, readAny } from "../src/agentOps.js";
import { suiteStore, closeStore } from "./helpers.js";

describe("agent ops", () => {
  const { store, context, stamp } = suiteStore("agent-ops");
  const title = `Agent ops smoke fact ${stamp}`;
  let nodeId: string;
  let firstRevisionId: string | undefined;
  let secondSlug: string;

  after(async () => {
    await closeStore(store);
  });

  it("remember creates a node when nothing matches", async () => {
    const first = await remember(store, {
      title,
      type: "claim",
      summary: "Trove agent-ops smoke: the widget port is 9191.",
      content: "The widget service listens on port 9191.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(first.action, "created");
    nodeId = first.node.id;
    firstRevisionId = first.node.revisionId;
  });

  it("remember with the same title updates and mints a new revision", async () => {
    const second = await remember(store, {
      title,
      type: "claim",
      summary: "Trove agent-ops smoke: the widget port moved to 9292.",
      content: "The widget service listens on port 9292 after the migration.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(second.action, "updated");
    assert.equal(second.node.id, nodeId, "update must target the existing node");
    assert.notEqual(second.node.revisionId, firstRevisionId, "update must mint a new revision");
    secondSlug = second.node.slug;
  });

  it("an explicit slug target forces an in-place update", async () => {
    const forced = await remember(store, {
      slug: secondSlug,
      title,
      type: "claim",
      summary: "Trove agent-ops smoke: widget port confirmed 9292.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(forced.action, "updated");
    assert.equal(forced.node.id, nodeId, "slug-targeted remember must update in place");
  });

  it("a near-but-not-exact title creates and reports the similar node", async () => {
    const near = await remember(store, {
      title: `Smoke fact ${stamp}`,
      type: "claim",
      summary: "A related but distinct fact.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(near.action, "created", "non-exact title must create, not merge");
    assert.ok(
      near.similar.some((s) => s.slug === secondSlug),
      "similar hits must surface the near-match",
    );
  });

  it("grep finds nodes and source text lexically", async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Agent ops grep source ${stamp}`,
      contentText: `Deploy notes.\n\nThe rollback flag is TROVE_ROLLBACK_${stamp} and nothing else mentions it.`,
      metadata: {},
    }, context);

    const grepHits = await store.grep({ pattern: `TROVE_ROLLBACK_${stamp}`, scope: "all", caseSensitive: false, limit: 20 });
    assert.ok(
      grepHits.matches.some((m) => m.kind === "source" && m.sourceId === ingested.source.id),
      "grep must find the source text unit",
    );

    const nodeGrep = await store.grep({ pattern: "widget service listens on port 9292", scope: "nodes", caseSensitive: false, limit: 20 });
    assert.ok(
      nodeGrep.matches.some((m) => m.kind === "node" && m.nodeId === nodeId),
      "grep must find node content",
    );
    assert.ok(
      nodeGrep.matches.every((m) => typeof m.excerpt === "string" && m.excerpt.length > 0),
      "grep matches must carry excerpts",
    );
  });

  it("grep supports regex and falls back to literal for invalid patterns", async () => {
    const regexGrep = await store.grep({ pattern: `port 9[0-9]{3}`, scope: "nodes", caseSensitive: false, limit: 20 });
    assert.ok(regexGrep.matches.some((m) => m.nodeId === nodeId), "regex grep must match");
    const literalGrep = await store.grep({ pattern: "port 9292 (", scope: "nodes", caseSensitive: false, limit: 20 });
    assert.ok(Array.isArray(literalGrep.matches), "invalid regex must not throw; falls back to literal");
  });

  it("connect + forget preview with dryRun and retire on apply", async () => {
    const other = await remember(store, {
      title: `Agent ops smoke neighbor ${stamp}`,
      type: "claim",
      summary: "Neighbor node for forget smoke.",
      evidence: [],
      links: [],
    }, context);
    const edge = await store.link({
      fromNodeId: nodeId,
      toNodeId: other.node.id,
      predicate: "relates_to",
      weight: 1,
    }, context);
    assert.ok(edge, "link must create an edge");

    const preview = await forget(store, { query: title, dryRun: true }, context);
    assert.equal(preview.dryRun, true, "query forget defaults to dry run");
    assert.ok(preview.edges.some((e) => e.edgeId === edge.id), "dry run must list the candidate edge");
    assert.equal(preview.retired, 0, "dry run must not retire anything");

    const applied = await forget(store, { edgeIds: [edge.id] }, context);
    assert.equal(applied.dryRun, false, "explicit edgeIds default to applying");
    assert.equal(applied.retired, 1, "expected exactly one retired edge");

    const active = await store.neighborhood({ nodeId, depth: 1, includeExpired: false });
    assert.ok(!active.edges.some((e) => e.id === edge.id), "retired edge must leave the active neighborhood");
    const withExpired = await store.neighborhood({ nodeId, depth: 1, includeExpired: true });
    assert.ok(withExpired.edges.some((e) => e.id === edge.id), "retired edge must remain in history");
  });

  it("readAny dispatches to node by slug and source by id, null for unknown", async () => {
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Agent ops read source ${stamp}`,
      contentText: "A source used to check readAny id dispatch.",
      metadata: {},
    }, context);

    const readNode = await readAny(store, { slug: secondSlug });
    assert.ok(readNode && readNode.kind === "node" && readNode.node?.id === nodeId, "readAny must resolve nodes by slug");
    const readSource = await readAny(store, { id: ingested.source.id });
    assert.ok(
      readSource && readSource.kind === "source" && readSource.source?.id === ingested.source.id,
      "readAny must fall through to sources by id",
    );
    const readMissing = await readAny(store, { id: "00000000-0000-0000-0000-000000000000" });
    assert.equal(readMissing, null, "readAny must return null for unknown ids");
  });
});
