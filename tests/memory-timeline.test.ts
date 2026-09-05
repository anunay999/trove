import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGraphStore } from "../src/store.js";
import { suiteStore, closeStore, hasPostgres, isolateDatabase } from "./helpers.js";

/**
 * The dashboard's "Memory timeline" plotted sources, not memories. Sources are
 * the rarest write in the product — you distil atoms daily and ingest a
 * transcript once a month — so the chart read 0 or 1 on nearly every day while
 * the graph beside it held fifteen hundred atoms, and looked broken.
 *
 * These pin the series it plots now: one bucket per memory, dated by the day
 * it was FIRST written, live rows only.
 */
// The live-driver case asserts the series sums to the node count, which is only
// true of a database this suite has to itself.
await isolateDatabase("memory-timeline");

/**
 * Backdate a node's first revision. The store owns its revisions privately;
 * a test that needs a memory older than the process reaches past that on
 * purpose, the way the event-stats suite reaches past the log.
 */
function backdateFirstWrite(store: InMemoryGraphStore, nodeId: string, iso: string): void {
  const revisions = (store as unknown as {
    revisions: Map<string, { nodeId: string; revisionNumber: number; createdAt: string }>;
  }).revisions;
  for (const [key, revision] of revisions) {
    if (revision.nodeId === nodeId && revision.revisionNumber === 1) {
      revisions.set(key, { ...revision, createdAt: iso });
    }
  }
}

/**
 * The memory store seeds a demo graph in its constructor, all of it written
 * "today". These cases are about which day a memory lands on, so they start
 * from an empty graph rather than counting around the fixture.
 */
function emptyStore(): InMemoryGraphStore {
  const store = new InMemoryGraphStore();
  const internals = store as unknown as {
    nodes: Map<string, unknown>;
    revisions: Map<string, unknown>;
    edges: Map<string, unknown>;
  };
  internals.nodes.clear();
  internals.revisions.clear();
  internals.edges.clear();
  return store;
}

function capture(store: InMemoryGraphStore, title: string) {
  return store.capture({
    title,
    type: "claim",
    summary: `${title} summary`,
    content: `${title} content`,
    evidence: [],
    links: [],
  });
}

describe("memory timeline", () => {
  it("dates each memory by its first write, not its latest edit", async () => {
    const store = emptyStore();
    const first = await capture(store, "Refunds are manual");
    const second = await capture(store, "Deploys freeze on Friday");
    backdateFirstWrite(store, first.id, "2026-03-01T09:00:00.000Z");
    backdateFirstWrite(store, second.id, "2026-03-05T09:00:00.000Z");

    // A revision today must not move the March memory to today: a timeline
    // that reshuffles its own history on every edit is worse than no chart.
    await store.update({
      nodeId: first.id,
      baseRevisionId: first.revisionId,
      content: "Refunds are manual, and the finance team owns them.",
    });

    const days = store.memoryDays();

    assert.deepEqual(days, [
      { date: "2026-03-01", memories: 1 },
      { date: "2026-03-05", memories: 1 },
    ]);
  });

  it("counts memories, not revisions", async () => {
    const store = emptyStore();
    const node = await capture(store, "Support owns the help inbox");
    const revised = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      content: "Support owns the help inbox, and triages it daily.",
    });
    assert.ok(revised && "id" in revised, "update did not return the revised node");

    const days = store.memoryDays();

    assert.equal(days.length, 1, "an edit opened a second bucket");
    assert.equal(days[0]?.memories, 1, "an edit counted as a second memory");
  });

  it("drops tombstoned memories, so the series matches the node count", async () => {
    const store = emptyStore();
    const kept = await capture(store, "Annual plans refund within 14 days");
    const retired = await capture(store, "A claim that stopped being true");
    store.tombstoneNodes([retired.id]);

    const days = store.memoryDays();
    const total = days.reduce((sum, day) => sum + day.memories, 0);

    assert.equal(total, store.exportGraph().nodes.length, "series and node count disagree");
    assert.equal(total, 1);
    assert.ok(kept.id, "fixture node was not written");
  });

  it("days with no memories are absent rather than zero", async () => {
    const store = emptyStore();
    const early = await capture(store, "Early note");
    const late = await capture(store, "Later note");
    backdateFirstWrite(store, early.id, "2026-03-01T09:00:00.000Z");
    backdateFirstWrite(store, late.id, "2026-03-09T09:00:00.000Z");

    assert.deepEqual(store.memoryDays().map((day) => day.date), ["2026-03-01", "2026-03-09"]);
  });
});

describe("memory timeline against the live driver", { skip: !hasPostgres() }, () => {
  const { store, context, stamp } = suiteStore("memory-timeline");

  after(async () => {
    await closeStore(store);
  });

  it("buckets a fresh memory on today, and sums to the live node count", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = await store.memoryDays(context);
    const beforeToday = before.find((day) => day.date === today)?.memories ?? 0;

    await store.capture({
      title: `Timeline bucketing ${stamp}`,
      type: "claim",
      summary: "A memory written today belongs on today's bar.",
      content: "This node verifies day bucketing against the database.",
      evidence: [],
      links: [],
    }, context);

    const after = await store.memoryDays(context);
    const afterToday = after.find((day) => day.date === today)?.memories ?? 0;
    assert.equal(afterToday, beforeToday + 1, "a fresh memory missed today's bucket");

    const total = after.reduce((sum, day) => sum + day.memories, 0);
    const snapshot = await store.exportGraph(context);
    assert.equal(total, snapshot.nodes.length, "series and node count disagree");
  });
});
