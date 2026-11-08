import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import type { GraphEdge, GraphNode } from "../src/contracts.js";
import { buildMemoryIndex, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES, renderMemoryIndex } from "../src/memoryIndex.js";
import { closeStore, isolateDatabase, sleep, suiteStore } from "./helpers.js";

await isolateDatabase("memory_index");

let counter = 0;
function node(over: Partial<GraphNode>): GraphNode {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return {
    id,
    type: "claim",
    slug: `note-${counter}`,
    title: `Note ${counter}`,
    summary: null,
    content: null,
    revisionId: id,
    updatedAt: "2026-11-01T00:00:00.000Z",
    accessCount: 0,
    lastAccessedAt: null,
    ...over,
  };
}
function edge(from: GraphNode, to: GraphNode, predicate: string, recordedAt = "2026-11-02T00:00:00.000Z"): GraphEdge {
  counter += 1;
  return {
    id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    fromNodeId: from.id,
    toNodeId: to.id,
    predicate,
    weight: 1,
    recordedAt,
    validFrom: recordedAt,
    validUntil: null,
    expiredAt: null,
    invalidatedBy: null,
    invalidationReason: null,
  };
}

describe("memory index (renderer)", () => {
  it("says memory is empty when it is", () => {
    const index = renderMemoryIndex({ nodes: [], edges: [] }, { now: new Date("2026-11-08T00:00:00Z") });
    assert.match(index.text, /Memory is empty/);
    assert.equal(index.nodes, 0);
  });

  it("lists hubs by degree, most-used by access, and leaves superseded notes out", () => {
    const billing = node({ type: "project", title: "Billing", slug: "billing" });
    const refunds = node({ title: "Refund window", slug: "refund-window", accessCount: 7, summary: "Annual plans: 30 days." });
    const oldRefunds = node({ title: "Old refund window", slug: "old-refund-window", accessCount: 50 });
    const owner = node({ title: "Churn email owner", slug: "churn-owner" });
    const index = renderMemoryIndex({
      nodes: [billing, refunds, oldRefunds, owner],
      edges: [edge(refunds, billing, "part_of"), edge(owner, billing, "part_of"), edge(refunds, oldRefunds, "supersedes")],
    });
    assert.match(index.text, /## Hubs\n- Billing \(billing\) · project, 2 links/);
    assert.match(index.text, /## Most used\n- Refund window \(refund-window\) · read 7× — Annual plans: 30 days\./);
    assert.doesNotMatch(index.text, /old-refund-window/, "a superseded note must not be advertised");
    assert.match(index.text, /look it up/);
  });

  it("lists dream pages in their own section", () => {
    const page = node({ type: "community", title: "Billing page", slug: "billing-page", content: "Page kept by Trove dreaming for Billing (billing).", summary: "Current notes about Billing, as of 2026-11-01." });
    const index = renderMemoryIndex({ nodes: [page], edges: [] });
    assert.match(index.text, /## Entity pages \(one read covers the hub\)\n- Billing page \(billing-page\)/);
    assert.doesNotMatch(index.text, /## Recently changed/);
  });

  it("stays inside the injected-context budget", () => {
    const nodes = Array.from({ length: 400 }, (_, i) => node({ accessCount: i + 1, summary: "x".repeat(300) }));
    const index = renderMemoryIndex({ nodes, edges: [] }, { mostUsed: 400, recent: 400 });
    assert.ok(index.text.split("\n").length <= MEMORY_INDEX_MAX_LINES + 1);
    assert.ok(Buffer.byteLength(index.text, "utf8") <= MEMORY_INDEX_MAX_BYTES + 1);
    assert.equal(index.truncated, true);
  });
});

describe("memory index (store)", () => {
  const { store, context, stamp } = suiteStore("memory-index");

  after(async () => {
    await closeStore(store);
  });

  it("indexes what was just written", async () => {
    const marker = `indexed${stamp}`;
    await remember(store, { title: `${marker} deploy freeze`, type: "decision", summary: `No ${marker} deploys after Friday noon.` }, context);
    await sleep(5);
    const index = await buildMemoryIndex(store, context);
    assert.match(index.text, new RegExp(`${marker} deploy freeze`));
    assert.ok(index.nodes > 0);
  });
});
