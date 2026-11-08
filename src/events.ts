import type { GraphEvent } from "./graphCore.js";

/** Actions the dashboard counts as a write on the cadence chart. */
export const WRITE_ACTIONS = ["capture", "update", "link", "ingest", "annotate", "invalidate_edge"];

/**
 * Test suites tag their writes with a "-smoke" actor or interface. The audit
 * log keeps them forever, but the dashboard should reflect real memory
 * activity, so every rollup drops them.
 */
export function isSmokeEvent(event: Pick<GraphEvent, "actorHandle" | "actorId" | "interfaceId">): boolean {
  return (event.actorHandle ?? "").endsWith("-smoke") ||
    (event.actorId ?? "").endsWith("-smoke") ||
    (event.interfaceId ?? "").endsWith("-smoke");
}

/**
 * How long an audit event stays in `graph_event`, in days.
 *
 * The log is append-only and nothing ever removed a row: production carried
 * 30,479 rows / 16 MB across four indexes, growing on every write, forever.
 * Six months answers "who changed this, and when" for anything anybody
 * actually asks, and the dashboard's rollups only ever draw the recent past.
 *
 * 0 disables pruning entirely -- for an operator who wants the whole history
 * kept, and for tests that assert nothing is removed.
 */
export function eventRetentionDays(): number {
  const parsed = Number(process.env.TROVE_EVENT_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 180;
}

/**
 * Ceiling on how many event rows one prune run removes. The prune rides on the
 * lint job, which runs on a request thread; a first prune over a log that has
 * never been trimmed must not turn one lint into a table-wide delete holding
 * locks and bloating WAL. Steady state is far below this (production writes
 * ~500 events a day), so the cap only bites on catch-up runs, and lint runs
 * often enough to drain the backlog over a few of them.
 */
export function eventPruneMaxRows(): number {
  const parsed = Number(process.env.TROVE_EVENT_PRUNE_MAX_ROWS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20_000;
}

/** Rows per delete statement inside one prune run; the cap above bounds the run. */
export const EVENT_PRUNE_BATCH_ROWS = 2_000;

/**
 * Ceiling on the serialized size of one `before`/`after` audit payload.
 *
 * Every event stores both, and no reader reads either: `GraphEvent` does not
 * expose them, so they are pure storage. The payloads recordEvent builds are
 * small metadata objects, but two of them quote unbounded input -- `update`
 * carries the node summary, `tombstone` the id of every edge it expired -- so
 * one write can put a megabyte into columns nothing ever selects.
 *
 * Over the cap the payload keeps its shape: every top-level key survives, and
 * only the oversized values become a `{ truncated, bytes }` marker. The audit
 * still says which node changed and what kind of change it was; it stops
 * promising to reproduce the value verbatim.
 */
export const EVENT_PAYLOAD_MAX_BYTES = 8_192;

/** Longest single value retained verbatim once a payload is over the cap. */
const EVENT_PAYLOAD_MAX_VALUE_BYTES = 512;

function payloadBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/**
 * Bound one audit payload to EVENT_PAYLOAD_MAX_BYTES, keeping its top-level
 * keys. Under the cap the value is returned untouched, which is every event
 * the graph writes in normal use.
 */
export function capEventPayload(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const bytes = payloadBytes(value);
  if (bytes <= EVENT_PAYLOAD_MAX_BYTES) return value;
  if (typeof value !== "object" || Array.isArray(value)) return { truncated: true, bytes };
  const capped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryBytes = payloadBytes(entry);
    capped[key] = entryBytes <= EVENT_PAYLOAD_MAX_VALUE_BYTES ? entry : { truncated: true, bytes: entryBytes };
  }
  return capped;
}

export function encodeEventCursor(event: Pick<GraphEvent, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id })).toString("base64url");
}

export function decodeEventCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid event cursor.");
  const value = decoded as Record<string, unknown>;
  if (typeof value.createdAt !== "string" || typeof value.id !== "string") {
    throw new Error("Invalid event cursor.");
  }
  return { createdAt: value.createdAt, id: value.id };
}
