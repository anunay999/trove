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

  it("captures a node after draining any existing feed", async () => {
    for (let page = 0; page < 100; page += 1) {
      const feed = await store.events({ afterCursor: cursor ?? undefined, limit: 100 });
      cursor = feed.nextCursor;
      if (!feed.hasMore) break;
    }

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
});
