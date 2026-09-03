import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { InMemoryGraphStore } from "../src/store.js";
import { suiteStore, closeStore, isolateDatabase, hasPostgres } from "./helpers.js";
import { capEventPayload, EVENT_PAYLOAD_MAX_BYTES, isSmokeEvent, WRITE_ACTIONS } from "../src/graphCore.js";
import type { GraphEvent } from "../src/graphCore.js";

/**
 * graph_event was the one table with no ceiling: append-only, four indexes,
 * before/after JSON on every row, and nothing that ever removed one.
 * Production reached 30,479 rows / 16 MB in two months of ordinary use, 76%
 * of them dead tuples, and it grew on every single write.
 *
 * The lint job now prunes past TROVE_EVENT_RETENTION_DAYS. These pin the
 * horizon, the per-run bound, the environment knobs, and — the part that
 * matters most — that the two readers of the table (the cursor feed and the
 * day/action rollup) still agree with each other after a prune has moved the
 * ground under them.
 *
 * The suite writes and deletes events with abandon and the prune is global,
 * not owner-scoped, so it must not share a database with anything.
 */
await isolateDatabase("event-retention");

const DAY_MS = 86_400_000;

/** Run one statement against the suite's Postgres database. */
async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

function syntheticEvent(id: string, ageDays: number): GraphEvent {
  return {
    id,
    action: "capture",
    entityTable: "node",
    entityId: `node-${id}`,
    actorId: "retention-test",
    actorHandle: "retention-test",
    interfaceId: "retention-test",
    requestId: `retention-${id}`,
    createdAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
  };
}

/**
 * A memory store whose log is exactly these events. The memory driver owns its
 * log privately; a test that needs backdated history reaches past that on
 * purpose, the same way tests/event-stats.test.ts does.
 */
function storeWithLog(events: GraphEvent[]): InMemoryGraphStore {
  const store = new InMemoryGraphStore();
  const log = (store as unknown as { eventLog: GraphEvent[] }).eventLog;
  log.length = 0;
  log.push(...events);
  return store;
}

function logOf(store: InMemoryGraphStore): GraphEvent[] {
  return (store as unknown as { eventLog: GraphEvent[] }).eventLog;
}

/** Run one lint through the queue and hand back its result. */
async function lintOnce(store: InMemoryGraphStore, tag: string): Promise<{ prunedEvents: number }> {
  const job = await store.enqueueJob({
    kind: "lint_graph",
    payload: { smoke: tag },
    priority: 90,
    dedupeKey: `smoke:retention:${tag}:${randomUUID()}`,
  });
  const done = await store.runJob({ jobId: job.id });
  assert.equal(done?.status, "succeeded", "the lint job did not succeed");
  return done?.result as { prunedEvents: number };
}

/** Set an env var for one test and put it back afterwards. */
function pinEnv(t: { after: (fn: () => void) => void }, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

describe("event retention", () => {
  it("a lint run drops events past the horizon and keeps the ones inside it", async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "180");
    const store = storeWithLog([
      syntheticEvent("ancient", 400),
      syntheticEvent("stale", 181),
      syntheticEvent("fresh", 179),
      syntheticEvent("today", 0),
    ]);

    const result = await lintOnce(store, "horizon");

    assert.equal(result.prunedEvents, 2, "the lint reports what it pruned");
    const kept = new Set(logOf(store).map((event) => event.id));
    assert.ok(!kept.has("ancient"), "a 400-day-old event survived the horizon");
    assert.ok(!kept.has("stale"), "an event one day past the horizon survived");
    assert.ok(kept.has("fresh"), "an event one day inside the horizon was pruned");
    assert.ok(kept.has("today"), "today's event was pruned");
  });

  it("one run never removes more than the per-run cap, and the next run finishes the job", async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "180");
    pinEnv(t, "TROVE_EVENT_PRUNE_MAX_ROWS", "3");
    const store = storeWithLog([0, 1, 2, 3, 4].map((index) => syntheticEvent(`old-${index}`, 200 + index)));

    const first = await lintOnce(store, "bounded-a");
    assert.equal(first.prunedEvents, 3, "the first run exceeded the per-run cap");
    // Oldest first: the two youngest of the five are what is left behind.
    const remaining = logOf(store).filter((event) => event.id.startsWith("old-")).map((event) => event.id);
    assert.deepEqual(remaining.sort(), ["old-0", "old-1"], "the prune did not take the oldest rows first");

    const second = await lintOnce(store, "bounded-b");
    assert.equal(second.prunedEvents, 2, "the next run did not finish the backlog");
    assert.equal(logOf(store).filter((event) => event.id.startsWith("old-")).length, 0);
  });

  it("honours TROVE_EVENT_RETENTION_DAYS, and 0 keeps the whole log", async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "400");
    const wide = storeWithLog([syntheticEvent("old", 200), syntheticEvent("older", 401)]);
    const widened = await lintOnce(wide, "wide");
    assert.equal(widened.prunedEvents, 1, "a 400-day window should only reach the 401-day-old event");
    assert.ok(logOf(wide).some((event) => event.id === "old"), "a widened window still pruned a 200-day-old event");

    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "0");
    const forever = storeWithLog([syntheticEvent("ancient", 4_000)]);
    const untouched = await lintOnce(forever, "disabled");
    assert.equal(untouched.prunedEvents, 0, "retention 0 must disable pruning entirely");
    assert.ok(logOf(forever).some((event) => event.id === "ancient"), "retention 0 pruned an event");
  });

  it("the feed and the rollup report exactly the surviving log", async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "180");
    const store = storeWithLog([
      syntheticEvent("ancient", 400),
      syntheticEvent("fresh", 2),
    ]);
    const before = await store.eventStats();
    assert.equal(before.total, 2);

    await lintOnce(store, "readers");

    const feed = await store.events({ limit: 100 });
    const ids = feed.events.map((event) => event.id);
    assert.ok(!ids.includes("ancient"), "the feed still serves a pruned event");
    assert.ok(ids.includes("fresh"), "the feed lost an event inside the horizon");

    const stats = await store.eventStats();
    const visible = feed.events.filter((event) => !isSmokeEvent(event));
    assert.equal(stats.total, visible.length, "rollup and feed disagree after a prune");
    const ancientDay = new Date(Date.now() - 400 * DAY_MS).toISOString().slice(0, 10);
    assert.ok(!stats.perDay.some((row) => row.date === ancientDay), "the rollup kept a day it no longer holds events for");
    const writes = new Set(WRITE_ACTIONS);
    for (const row of stats.perDay) {
      const day = visible.filter((event) => event.createdAt.slice(0, 10) === row.date);
      assert.equal(row.total, day.length, `rollup and feed disagree on ${row.date}`);
      assert.equal(row.writes, day.filter((event) => writes.has(event.action)).length, `write split wrong on ${row.date}`);
    }
  });
});

describe("audit payload cap", () => {
  it("leaves an ordinary payload untouched", () => {
    const payload = { revisionId: "rev-1", title: "A node", summary: "Short enough." };
    assert.equal(capEventPayload(payload), payload, "a small payload must not be rewritten");
    assert.equal(capEventPayload(null), null);
    assert.equal(capEventPayload(undefined), null);
  });

  it("keeps every top-level key and truncates only the oversized value", () => {
    const summary = "x".repeat(EVENT_PAYLOAD_MAX_BYTES * 2);
    const capped = capEventPayload({ revisionId: "rev-1", title: "A node", summary }) as Record<string, unknown>;

    assert.deepEqual(Object.keys(capped).sort(), ["revisionId", "summary", "title"], "the cap dropped a key");
    assert.equal(capped.revisionId, "rev-1", "an identifying field did not survive the cap");
    assert.equal(capped.title, "A node", "an identifying field did not survive the cap");
    assert.deepEqual(capped.summary, { truncated: true, bytes: summary.length + 2 }, "the oversized value was not marked");
    assert.ok(
      Buffer.byteLength(JSON.stringify(capped), "utf8") < EVENT_PAYLOAD_MAX_BYTES,
      "the capped payload is still over the cap",
    );
  });

  it("marks an oversized array or scalar whole", () => {
    const edgeIds = Array.from({ length: 2_000 }, () => randomUUID());
    const capped = capEventPayload(edgeIds) as Record<string, unknown>;
    assert.equal(capped.truncated, true, "an oversized array was stored verbatim");
    assert.ok(Number(capped.bytes) > EVENT_PAYLOAD_MAX_BYTES);
  });
});

describe("event retention against the live driver", () => {
  const { store, context, stamp } = suiteStore("event-retention");

  after(async () => {
    await closeStore(store);
  });

  /** Insert a backdated row straight into the log; nothing in the API can. */
  const insertEvent = async (ageDays: number): Promise<string> => {
    const [row] = await sql<{ id: string }>(
      `insert into graph_event (action, entity_table, entity_id, interface_id, created_at)
       values ('capture', 'node', gen_random_uuid(), $1, now() - make_interval(days => $2::int))
       returning id`,
      [`retention-${stamp}`, ageDays],
    );
    return row!.id;
  };

  it("a lint deletes rows past the horizon, and both readers see only the survivors", {
    skip: hasPostgres() ? false : "postgres only",
  }, async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "180");
    const ancient = await insertEvent(400);
    const stale = await insertEvent(181);
    const fresh = await insertEvent(2);

    const lint = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "retention" },
      priority: 90,
      dedupeKey: `smoke:retention:${stamp}`,
    }, context);
    const done = await store.runJob({ jobId: lint.id }, context);
    assert.equal(done?.status, "succeeded");
    assert.ok(
      Number((done?.result as { prunedEvents?: number } | null)?.prunedEvents) >= 2,
      "the lint reports what it pruned",
    );

    const alive = new Set(
      (await sql<{ id: string }>("select id from graph_event where id = any($1::uuid[])", [[ancient, stale, fresh]]))
        .map((row) => row.id),
    );
    assert.ok(!alive.has(ancient), "a 400-day-old event survived the horizon");
    assert.ok(!alive.has(stale), "an event one day past the horizon survived");
    assert.ok(alive.has(fresh), "an event inside the horizon was pruned");

    // The two readers are independent queries over the same table; after a
    // prune they must still agree with each other, and with the table.
    const drained = new Map<string, { total: number; writes: number }>();
    const seen = new Set<string>();
    const writes = new Set(WRITE_ACTIONS);
    let total = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const feed = await store.events(cursor ? { afterCursor: cursor, limit: 500 } : { limit: 500 }, context);
      for (const event of feed.events) {
        seen.add(event.id);
        if (isSmokeEvent(event)) continue;
        const date = event.createdAt.slice(0, 10);
        const entry = drained.get(date) ?? { total: 0, writes: 0 };
        entry.total += 1;
        if (writes.has(event.action)) entry.writes += 1;
        drained.set(date, entry);
        total += 1;
      }
      if (!feed.hasMore || !feed.nextCursor) break;
      cursor = feed.nextCursor;
    }
    assert.ok(!seen.has(ancient) && !seen.has(stale), "the feed still serves a pruned event");
    assert.ok(seen.has(fresh), "the feed lost an event inside the horizon");

    const stats = await store.eventStats(context);
    assert.equal(stats.total, total, "aggregate and feed disagree after a prune");
    assert.equal(stats.perDay.length, drained.size, "aggregate and feed disagree on which days have events");
    for (const [date, want] of drained) {
      const got = stats.perDay.find((row) => row.date === date);
      assert.deepEqual({ total: got?.total, writes: got?.writes }, want, `aggregate and feed disagree on ${date}`);
    }
  });

  it("one run never deletes more than the per-run cap", {
    skip: hasPostgres() ? false : "postgres only",
  }, async (t) => {
    pinEnv(t, "TROVE_EVENT_RETENTION_DAYS", "180");
    pinEnv(t, "TROVE_EVENT_PRUNE_MAX_ROWS", "3");
    const old = [];
    for (let index = 0; index < 5; index += 1) old.push(await insertEvent(200 + index));

    const runLint = async (tag: string): Promise<number> => {
      const job = await store.enqueueJob({
        kind: "lint_graph",
        payload: { smoke: tag },
        priority: 90,
        dedupeKey: `smoke:retention:${tag}:${stamp}`,
      }, context);
      const done = await store.runJob({ jobId: job.id }, context);
      assert.equal(done?.status, "succeeded");
      return Number((done?.result as { prunedEvents?: number } | null)?.prunedEvents);
    };

    assert.equal(await runLint("cap-a"), 3, "the first run exceeded the per-run cap");
    const [count] = await sql<{ n: number }>(
      "select count(*)::int as n from graph_event where id = any($1::uuid[])",
      [old],
    );
    assert.equal(count?.n, 2, "the capped run left the wrong number of rows behind");

    assert.equal(await runLint("cap-b"), 2, "the next run did not finish the backlog");
  });

  it("caps an oversized before/after payload without losing the identifying fields", {
    skip: hasPostgres() ? false : "postgres only",
  }, async () => {
    const node = await store.capture({
      title: `Payload cap ${stamp}`,
      type: "claim",
      summary: "The audit columns are write-only, so an unbounded value in them is pure cost.",
      content: "This node verifies the before/after size cap.",
      evidence: [],
      links: [],
    }, context);
    const updated = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      summary: "y".repeat(EVENT_PAYLOAD_MAX_BYTES * 3),
      content: "Updated to force an oversized audit payload.",
    }, context);
    assert.ok(updated && !("conflict" in updated), "expected a successful update");

    const [row] = await sql<{ after: Record<string, unknown>; bytes: number }>(
      `select after, octet_length(after::text) as bytes
       from graph_event
       where action = 'update' and entity_id = $1
       order by created_at desc
       limit 1`,
      [node.id],
    );
    assert.ok(row, "the update recorded no audit event");
    assert.ok(row.bytes <= EVENT_PAYLOAD_MAX_BYTES, `audit payload was ${row.bytes} bytes, over the cap`);
    assert.equal(typeof row.after.revisionId, "string", "the cap dropped the revision id");
    assert.deepEqual(
      (row.after.summary as Record<string, unknown>).truncated,
      true,
      "the oversized summary was stored verbatim",
    );
  });
});
