/**
 * MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) for Trove.
 *
 * The extension moves long-running tools (export_obsidian today) off the
 * request that started them: tools/call answers with a durable task handle
 * (`CreateTaskResult`, `resultType: "task"`) and the client polls
 * `tasks/get`. Task state lives in Postgres, so any instance can serve the
 * poll — the same stateless posture the 2026-07-28 protocol core requires.
 *
 * Two deliberate seams, both documented:
 *
 * 1. Dispatch happens at the HTTP layer (this module + src/server.ts), not
 *    through the SDK's request-handler table. Two upstream reasons: the SDK
 *    v2 era gate shadows the historical `tasks/get` / `tasks/cancel` core
 *    method names with `-32601` before custom handlers are consulted
 *    (typescript-sdk #2598, fix #2599 unmerged as of 2.0.0), and the
 *    high-level `registerTool` callback cannot author the `task` result
 *    family at all (ToolCallback only returns CallToolResult |
 *    InputRequiredResult). Serving the three extension methods from Hono
 *    sidesteps both and keeps us on the released SDK.
 * 2. Execution is in-process after the row is durably inserted. A restart
 *    mid-execution leaves the row `working`; the first poll after ten
 *    minutes of silence marks it `failed` ("task lost"), so a client never
 *    polls a dead task forever.
 */

import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import pg from "pg";
import type { GraphStore } from "./graphCore.js";
import { buildObsidianVaultExport } from "./obsidianExport.js";

/** The extension identifier this module implements. */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
/** Per-request `_meta` key carrying client capabilities on the 2026-07-28 era. */
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** A task never needs mid-flight input today; one second is a polite floor. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Rows are kept a day past creation; TTL itself is one hour. */
const DEFAULT_TTL_MS = 3_600_000;
/** A `working` row silent this long is a dead task (process restarted). */
const STALE_WORKING_MS = 10 * 60_000;

export type McpTaskStatus = "working" | "completed" | "failed" | "cancelled";

export type McpTaskRow = {
  id: string;
  kind: string;
  status: McpTaskStatus;
  statusMessage: string | null;
  request: unknown;
  result: unknown;
  error: unknown;
  ownerId: string | null;
  actorId: string;
  ttlMs: number;
  pollIntervalMs: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Caller identity for task reads: re-authenticated on every request. */
export type TaskViewer = {
  ownerId?: string | undefined;
  actorId: string;
  superuser?: boolean | undefined;
};

export class McpTaskStore {
  private pool: pg.Pool;

  constructor(options: { connectionString: string }) {
    this.pool = new pg.Pool({ connectionString: options.connectionString, keepAlive: true });
    this.pool.on("error", (error) => {
      console.error("[mcp-task-pool] idle client error:", error.message);
    });
  }

  async create(input: {
    kind: string;
    request: unknown;
    viewer: TaskViewer;
    ttlMs?: number;
    pollIntervalMs?: number;
  }): Promise<McpTaskRow> {
    // Opportunistic purge: expired handles are legal to discard (spec), and
    // doing it on insert keeps the table tidy without a new job kind.
    await this.pool.query(
      "delete from mcp_task where created_at < now() - interval '24 hours'",
    );
    const result = await this.pool.query(
      `insert into mcp_task (kind, request, owner_id, actor_id, ttl_ms, poll_interval_ms)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       returning id, kind, status, status_message, request, result, error,
                 owner_id, actor_id, ttl_ms, poll_interval_ms, created_at, updated_at`,
      [
        input.kind,
        JSON.stringify(input.request ?? {}),
        input.viewer.ownerId ?? null,
        input.viewer.actorId,
        input.ttlMs ?? DEFAULT_TTL_MS,
        input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      ],
    );
    return taskRow(result.rows[0]);
  }

  /**
   * Fetch a task for a viewer, or null when the id is unknown or belongs to
   * another caller. A `working` row silent past STALE_WORKING_MS is the
   * remains of a process restart: it is failed here, once, so the caller
   * sees a terminal state instead of polling a dead task forever.
   */
  async get(taskId: string, viewer: TaskViewer): Promise<McpTaskRow | null> {
    const result = await this.pool.query(
      `select id, kind, status, status_message, request, result, error,
              owner_id, actor_id, ttl_ms, poll_interval_ms, created_at, updated_at
       from mcp_task
       where id = $1
         and ($2 or owner_id is null or owner_id = $3 or actor_id = $4)`,
      [taskId, viewer.superuser ?? false, viewer.ownerId ?? null, viewer.actorId],
    );
    const row = result.rows[0] ? taskRow(result.rows[0]) : null;
    if (!row) return null;
    if (row.status === "working" && Date.now() - row.updatedAt.getTime() > STALE_WORKING_MS) {
      await this.fail(row.id, { code: -32603, message: "Task lost: the executing process restarted." });
      return { ...row, status: "failed", statusMessage: "Task lost: the executing process restarted." };
    }
    return row;
  }

  /** Store the final tool result. Terminal: a completed task never changes. */
  async complete(taskId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `update mcp_task
       set status = 'completed', result = $2::jsonb, updated_at = now()
       where id = $1 and status = 'working'`,
      [taskId, JSON.stringify(result)],
    );
  }

  /** Record a JSON-RPC execution error (protocol faults only, per spec). */
  async fail(taskId: string, error: { code: number; message: string }): Promise<void> {
    await this.pool.query(
      `update mcp_task
       set status = 'failed', error = $2::jsonb, status_message = $3, updated_at = now()
       where id = $1 and status = 'working'`,
      [taskId, JSON.stringify(error), error.message],
    );
  }

  /**
   * Cooperative cancellation: the row is cancelled only if it has not
   * already reached a terminal state. The in-process executor keeps
   * running; its final write is a no-op against a non-working row.
   */
  async cancel(taskId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update mcp_task
       set status = 'cancelled', status_message = 'Cancelled by client.', updated_at = now()
       where id = $1 and status = 'working'
       returning id`,
      [taskId],
    );
    return result.rowCount === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function taskRow(row: Record<string, unknown>): McpTaskRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: row.status as McpTaskStatus,
    statusMessage: row.status_message === null ? null : String(row.status_message),
    request: row.request,
    result: row.result,
    error: row.error,
    ownerId: row.owner_id === null ? null : String(row.owner_id),
    actorId: String(row.actor_id),
    ttlMs: Number(row.ttl_ms),
    pollIntervalMs: Number(row.poll_interval_ms),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ---- wire shapes ------------------------------------------------------------
// Exactly the fields the extension spec requires — ISO-8601 timestamps,
// `resultType` discriminator, and the server-info meta a 2026-era client
// reads off every result.

export function taskCreateResult(task: McpTaskRow, serverInfo: { name: string; version: string }) {
  return {
    resultType: "task" as const,
    taskId: task.id,
    status: task.status,
    statusMessage: task.statusMessage ?? undefined,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    _meta: { [SERVER_INFO_META_KEY]: serverInfo },
  };
}

export function taskDetailedResult(task: McpTaskRow, serverInfo: { name: string; version: string }) {
  return {
    resultType: "complete" as const,
    taskId: task.id,
    status: task.status,
    statusMessage: task.statusMessage ?? undefined,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.status === "completed" ? { result: task.result } : {}),
    ...(task.status === "failed" ? { error: task.error } : {}),
    _meta: { [SERVER_INFO_META_KEY]: serverInfo },
  };
}

/** The empty `resultType: "complete"` acknowledgement tasks/update and tasks/cancel return. */
export function taskAckResult(serverInfo: { name: string; version: string }) {
  return {
    resultType: "complete" as const,
    _meta: { [SERVER_INFO_META_KEY]: serverInfo },
  };
}

/** The final CallToolResult a blocking export_obsidian call would have returned. */
export function toolResultFromValue(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

// ---- request classification -------------------------------------------------

/**
 * Whether a parsed JSON-RPC request declares the tasks extension in its
 * per-request capability envelope. This is the spec's opt-in: without it a
 * server MUST NOT answer tools/call with a task handle, and tasks/get and
 * friends MUST be refused with -32021.
 */
export function declaresTasksExtension(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const params = (parsed as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return false;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return false;
  const capabilities = (meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  if (typeof extensions !== "object" || extensions === null) return false;
  return Boolean((extensions as Record<string, unknown>)[TASKS_EXTENSION_ID]);
}

export type JsonRpcRequestLike = { id?: unknown; method: string; params?: unknown };

export function isTasksMethodRequest(parsed: unknown): parsed is JsonRpcRequestLike {
  if (typeof parsed !== "object" || parsed === null) return false;
  const method = (parsed as { method?: unknown }).method;
  return (
    typeof method === "string"
    && (method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel")
  );
}

// ---- task execution ---------------------------------------------------------

/** Runs the export_obsidian work for a task and records the outcome. */
export async function runExportObsidianTask(
  store: GraphStore,
  taskStore: McpTaskStore,
  taskId: string,
  owner: Parameters<GraphStore["exportMarkdown"]>[0],
): Promise<void> {
  try {
    const value = buildObsidianVaultExport(
      await store.exportMarkdown(owner),
      await store.timeline(owner),
      await store.exportGraph(owner),
    );
    await taskStore.complete(taskId, toolResultFromValue(value));
  } catch (error) {
    await taskStore.fail(taskId, {
      code: -32603,
      message: error instanceof Error ? error.message : "Export failed.",
    });
  }
}
