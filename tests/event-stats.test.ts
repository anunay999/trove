import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGraphStore } from "../src/store.js";
import type { GraphEvent } from "../src/graphCore.js";
import { suiteStore, closeStore, hasPostgres, isolateDatabase } from "./helpers.js";
import { isSmokeEvent, WRITE_ACTIONS } from "../src/graphCore.js";

/**
 * The dashboard's day/action rollups used to be built by paging the event feed
 * oldest-first, capped at 20 pages of 500. Once the log passed 10,000 events
 * the walk ran out before it reached the newest days, so the write-cadence
 * chart read zero for the most recent week while writes were still landing —
 * and the truncation flag compared the post-filter count against the raw cap,
 * so nothing ever announced the blind spot.
 *
 * These pin the rollup to the WHOLE log. The fixture size is deliberately past
 * the old budget: at 10,000 the previous implementation lost everything after
 * the cutoff.
 */
// The day-for-day assertion compares an aggregate against a full drain of the
// feed; on a shared database any sibling suite writing between the two reads
// breaks the equality, so this suite gets its own.
await isolateDatabase("event-stats");

const PAST_OLD_PAGE_BUDGET = 10_600;

function syntheticEvent(index: number, date: string, overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: `event-${index}`,
    action: "capture",
    entityTable: "node",
    entityId: `node-${index}`,
    actorId: "cadence-test",
    actorHandle: "cadence-test",
    interfaceId: "cadence-test",
    requestId: `cadence-${index}`,
    createdAt: `${date}T0${index % 10}:00:00.000Z`,
    ...overrides,
  };
}

/**
 * The memory store owns its log privately; a test that needs a log larger than
 * it is worth writing one event at a time reaches past that on purpose. The
 * seeded demo graph's own events are cleared so the fixture counts are exact.
 */
function storeWithLog(events: GraphEvent[]): InMemoryGraphStore {
  const store = new InMemoryGraphStore();
  const log = (store as unknown as { eventLog: GraphEvent[] }).eventLog;
  log.length = 0;
  log.push(...events);
  return store;
}

describe("event stats", () => {
  it("counts the newest day in a log past the old page budget", async () => {
    const events: GraphEvent[] = [];
    for (let index = 0; index < PAST_OLD_PAGE_BUDGET; index += 1) {
      events.push(syntheticEvent(index, "2026-07-01"));
    }
    for (let index = 0; index < 100; index += 1) {
      events.push(syntheticEvent(PAST_OLD_PAGE_BUDGET + index, "2026-08-14"));
    }

    const stats = await storeWithLog(events).eventStats();
    const newest = stats.perDay.at(-1);

    assert.equal(newest?.date, "2026-08-14", "rollup stopped before the newest day");
    assert.equal(newest?.total, 100, "newest day lost events");
    assert.equal(stats.total, PAST_OLD_PAGE_BUDGET + 100, "rollup dropped events for size");
  });

  it("separates writes from reads, and drops smoke actors", async () => {
    const stats = await storeWithLog([
      syntheticEvent(1, "2026-08-14", { action: "capture" }),
      syntheticEvent(2, "2026-08-14", { action: "link" }),
      syntheticEvent(3, "2026-08-14", { action: "recall" }),
      syntheticEvent(4, "2026-08-14", { action: "capture", actorHandle: "suite-smoke" }),
      syntheticEvent(5, "2026-08-14", { action: "capture", interfaceId: "mcp-smoke" }),
    ]).eventStats();

    const day = stats.perDay.at(-1);
    assert.equal(day?.total, 3, "smoke events leaked into the day rollup");
    assert.equal(day?.writes, 2, "write count did not match the write actions");
    assert.equal(stats.actions.find((row) => row.key === "capture")?.count, 1);
    assert.equal(stats.total, 3);
  });

  it("days with no events are absent rather than zero", async () => {
    const stats = await storeWithLog([
      syntheticEvent(1, "2026-08-10"),
      syntheticEvent(2, "2026-08-14"),
    ]).eventStats();

    assert.deepEqual(stats.perDay.map((row) => row.date), ["2026-08-10", "2026-08-14"]);
  });
});

describe("event stats against the live driver", () => {
  const { store, context, stamp } = suiteStore("cadence");

  after(async () => {
    await closeStore(store);
  });

  it("buckets a fresh write on the same day the feed reports it", async () => {
    await store.capture({
      title: `Cadence rollup ${stamp}`,
      type: "claim",
      summary: "The day rollup and the event feed must agree on a write's date.",
      content: "This node verifies day bucketing matches the feed.",
      evidence: [],
      links: [],
    }, context);

    const recent = await store.events({ limit: 1, order: "desc" }, context);
    const newest = recent.events[0];
    assert.ok(newest, "feed returned no events after a capture");

    const stats = await store.eventStats(context);
    const day = stats.perDay.find((row) => row.date === newest.createdAt.slice(0, 10));

    assert.ok(day, `rollup has no bucket for ${newest.createdAt.slice(0, 10)}`);
    assert.ok(day.writes >= 1, "a capture did not count as a write");
    assert.ok(
      (stats.actions.find((row) => row.key === "capture")?.count ?? 0) >= 1,
      "capture missing from the action rollup",
    );
  });

  /**
   * The aggregate and the feed are two independent readings of one log, and
   * they must agree exactly — same days, same totals, same write split. This
   * is the check that caught the SQL smoke filter disagreeing with the JS one
   * while the fix was being written; it is worth keeping because the two
   * filters live in different languages and drift silently.
   *
   * Postgres only: the memory driver shares one filter between both paths, so
   * there is nothing here for it to disagree about.
   */
  it("matches a full drain of the feed, day for day", { skip: hasPostgres() ? false : "postgres only" }, async () => {
    const writeActions = new Set(WRITE_ACTIONS);
    const drained = new Map<string, { total: number; writes: number }>();
    let total = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 500; page += 1) {
      const feed = await store.events(cursor ? { afterCursor: cursor, limit: 500 } : { limit: 500 }, context);
      for (const event of feed.events) {
        if (isSmokeEvent(event)) continue;
        const date = event.createdAt.slice(0, 10);
        const entry = drained.get(date) ?? { total: 0, writes: 0 };
        entry.total += 1;
        if (writeActions.has(event.action)) entry.writes += 1;
        drained.set(date, entry);
        total += 1;
      }
      if (!feed.hasMore || !feed.nextCursor) break;
      cursor = feed.nextCursor;
    }

    const stats = await store.eventStats(context);
    assert.equal(stats.total, total, "aggregate and feed disagree on the event count");
    assert.equal(stats.perDay.length, drained.size, "aggregate and feed disagree on which days have events");
    for (const [date, want] of drained) {
      const got = stats.perDay.find((row) => row.date === date);
      assert.deepEqual(
        { total: got?.total, writes: got?.writes },
        want,
        `aggregate and feed disagree on ${date}`,
      );
    }
  });
});
