import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "event-smoke",
  interfaceId: "event-smoke",
  requestId: `event-smoke-${stamp}`,
};

try {
  let cursor: string | null = null;
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

  const feed = await store.events({ afterCursor: cursor ?? undefined, limit: 20 });
  const captureEvent = feed.events.find((event) =>
    event.action === "capture" &&
    event.entityTable === "node" &&
    event.entityId === node.id &&
    event.actorHandle === context.actorId &&
    event.interfaceId === context.interfaceId &&
    event.requestId === context.requestId
  );
  if (!captureEvent) {
    throw new Error("Cursor event feed did not include attributed capture event.");
  }
  if (!feed.nextCursor) {
    throw new Error("Cursor event feed did not return a next cursor.");
  }

  // Newest-first read: the dashboard activity feed must see fresh writes even
  // when the log outgrows any forward-walk window.
  const recent = await store.events({ limit: 20, order: "desc" });
  if (recent.events.length < 2) throw new Error("Descending feed returned too few events.");
  for (let i = 1; i < recent.events.length; i += 1) {
    if ((recent.events[i - 1]?.createdAt ?? "") < (recent.events[i]?.createdAt ?? "")) {
      throw new Error("Descending feed is not newest-first.");
    }
  }
  if (!recent.events.some((event) => event.entityId === node.id)) {
    throw new Error("Descending feed missed the just-captured event.");
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    events: feed.events.length,
    captureEvent: {
      id: captureEvent.id,
      action: captureEvent.action,
      entityTable: captureEvent.entityTable,
      actorHandle: captureEvent.actorHandle,
      interfaceId: captureEvent.interfaceId,
    },
    hasMore: feed.hasMore,
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
