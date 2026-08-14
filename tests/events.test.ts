import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("events", () => {
  const { store, context, stamp } = suiteStore("event");
  let nodeId: string;
  let cursor: string | null = null;

  after(async () => {
    await closeStore(store);
  });

  it("captures a node after parking a cursor at the tail of the feed", async () => {
    // Take the tail cursor newest-first rather than paging forward to find it:
    // a forward drain needs a page budget, and any budget is eventually
    // smaller than the log, which parks the cursor mid-history and makes every
    // assertion below look at events from months ago.
    const newest = await store.events({ limit: 1, order: "desc" });
    cursor = newest.nextCursor;

    const node = await store.capture({
      title: `Event smoke ${stamp}`,
      type: "claim",
      summary: "Interfaces should consume graph changes through a cursor event feed.",
      content: "This node verifies cursor-based event sync.",
      evidence: [],
      links: [],
    }, context);
    nodeId = node.id;
  });

  it("the cursor feed includes the attributed capture event", async () => {
    const feed = await store.events({ afterCursor: cursor ?? undefined, limit: 20 });
    const captureEvent = feed.events.find((event) =>
      event.action === "capture" &&
      event.entityTable === "node" &&
      event.entityId === nodeId &&
      event.actorHandle === context.actorId &&
      event.interfaceId === context.interfaceId &&
      event.requestId === context.requestId
    );
    assert.ok(captureEvent, "cursor event feed did not include the attributed capture event");
    assert.ok(feed.nextCursor, "cursor event feed did not return a next cursor");
  });

  it("the descending feed is newest-first and sees fresh writes", async () => {
    const recent = await store.events({ limit: 20, order: "desc" });
    assert.ok(recent.events.length >= 2, "descending feed returned too few events");
    for (let i = 1; i < recent.events.length; i += 1) {
      assert.ok(
        (recent.events[i - 1]?.createdAt ?? "") >= (recent.events[i]?.createdAt ?? ""),
        "descending feed is not newest-first",
      );
    }
    assert.ok(recent.events.some((event) => event.entityId === nodeId), "descending feed missed the just-captured event");
  });

  /**
   * Postgres keeps created_at to the microsecond; a JS ISO string stops at the
   * millisecond. A cursor built from the mapped event therefore pointed at a
   * moment just before the row it was meant to resume after, and the keyset
   * predicate handed that row back at the top of the next page. Paging with a
   * page size of one makes every row a boundary, so any re-serve shows up.
   */
  it("never re-serves a row across page boundaries", async () => {
    const newest = await store.events({ limit: 1, order: "desc" }, context);
    const start = newest.nextCursor ?? undefined;

    for (let index = 0; index < 3; index += 1) {
      await store.capture({
        title: `Cursor boundary ${stamp}-${index}`,
        type: "claim",
        summary: "Paging the event feed one row at a time must not repeat a row.",
        content: "This node verifies keyset pagination excludes the cursor row.",
        evidence: [],
        links: [],
      }, context);
    }

    const seen = new Set<string>();
    let served = 0;
    let cursor = start;
    for (let page = 0; page < 50; page += 1) {
      const feed = await store.events({ afterCursor: cursor, limit: 1 }, context);
      for (const event of feed.events) {
        served += 1;
        seen.add(event.id);
      }
      if (!feed.hasMore || !feed.nextCursor) break;
      cursor = feed.nextCursor;
    }

    assert.ok(served > 0, "feed served nothing after three captures");
    assert.equal(served, seen.size, `feed re-served ${served - seen.size} row(s) at page boundaries`);
  });
});
