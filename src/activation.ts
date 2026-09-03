/**
 * Buffered activation bumps.
 *
 * Every agent-facing `read` strengthens the atom it served — the ACT-R loop
 * that makes recall favour what the agent actually uses. The design has always
 * said those bumps are batched (memory-db-design.md #4); the implementation
 * was not. Each tracked read fired its own
 * `update node set access_count = access_count + 1` — its own round trip, its
 * own transaction, its own WAL record, and its own dead tuple on `node`, the
 * hottest table in the graph (production measured it at 18% dead).
 *
 * WHY A TIMED BUFFER RATHER THAN A PER-CALL FLUSH. A read touches exactly one
 * node, so "collect the ids a call touched and flush at the end of it" would
 * still emit one statement per read: no batching at all. The only place where
 * bumps are collectable is *across* calls, so they accumulate here and drain on
 * a short window. A session that reads the same hot note ten times pays one
 * row version instead of ten, and ten reads of ten different notes pay one
 * statement instead of ten.
 *
 * CONSISTENCY WINDOW. `access_count` in Postgres therefore trails the true
 * count by at most `windowMs` (default 1s, `TROVE_ACTIVATION_FLUSH_MS`). Reads
 * fold the un-flushed delta back on top of the row they just selected, so a
 * caller always sees its own bumps immediately; what lags is the value seen by
 * *other* processes and by the ranking arm of recall — a soft signal weighted
 * by `log1p(accessCount)`, where a sub-second lag is not observable. Nothing
 * else in the schema reads the column.
 *
 * BOUNDED. The buffer is a Map keyed by node id, so it cannot grow with
 * traffic, only with the number of *distinct* nodes read inside one window; it
 * drains at `maxNodes` and, if the database is down and flushes keep failing,
 * evicts oldest-first at `hardCap` rather than growing without limit. An
 * unbounded per-owner cache has bitten this codebase once already (#75).
 *
 * DURABLE ACROSS EXIT. The drain timer is deliberately NOT unref'd: a pending
 * window keeps the process alive long enough to flush, so a CLI or stdio MCP
 * session that exits naturally loses nothing. `close()` flushes synchronously
 * for the paths that exit on a signal instead.
 */

/** One node's accumulated, un-flushed activation. */
export type ActivationBump = {
  nodeId: string;
  /** Reads since the last successful flush. */
  count: number;
  /** The most recent of those reads. */
  lastAccessedAt: Date;
};

export type ActivationFlusher = (bumps: ActivationBump[]) => Promise<void>;

/** Default drain window; override with TROVE_ACTIVATION_FLUSH_MS. */
export const DEFAULT_ACTIVATION_FLUSH_MS = 1_000;

export function activationFlushMsFromEnv(): number {
  const raw = Number(process.env.TROVE_ACTIVATION_FLUSH_MS ?? DEFAULT_ACTIVATION_FLUSH_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : DEFAULT_ACTIVATION_FLUSH_MS;
}

export type ActivationBufferOptions = {
  /** How long a bump may sit unwritten. Default 1s. */
  windowMs?: number;
  /** Distinct nodes that force an early drain. Default 1000. */
  maxNodes?: number;
  /** Distinct nodes past which the oldest entries are dropped. Default 10x maxNodes. */
  hardCap?: number;
  onError?: (error: unknown) => void;
};

type Entry = { count: number; at: number };

export class ActivationBuffer {
  private pending = new Map<string, Entry>();
  /**
   * Entries handed to a flush that has not come back yet. They stay foldable
   * until the write commits, so a read during a drain still sees them, and they
   * go back into `pending` if the write fails.
   */
  private inFlight = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private closed = false;
  private dropped = 0;

  private readonly windowMs: number;
  private readonly maxNodes: number;
  private readonly hardCap: number;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly flusher: ActivationFlusher, options: ActivationBufferOptions = {}) {
    this.windowMs = options.windowMs ?? activationFlushMsFromEnv();
    this.maxNodes = Math.max(1, options.maxNodes ?? 1_000);
    this.hardCap = Math.max(this.maxNodes, options.hardCap ?? this.maxNodes * 10);
    this.onError = options.onError ?? ((error) => {
      console.error("[activation] flush failed:", error instanceof Error ? error.message : error);
    });
  }

  /**
   * Count one read of `nodeId` and report everything still un-flushed for it,
   * so the caller can fold the delta onto the row it just selected.
   */
  bump(nodeId: string, at: Date = new Date()): { count: number; lastAccessedAt: string } {
    const stamp = at.getTime();
    const existing = this.pending.get(nodeId);
    if (existing) {
      existing.count += 1;
      existing.at = Math.max(existing.at, stamp);
    } else {
      this.pending.set(nodeId, { count: 1, at: stamp });
      this.evictOverflow();
    }
    if (this.pending.size >= this.maxNodes) {
      void this.flush();
    } else {
      this.schedule();
    }
    return this.foldFor(nodeId, stamp);
  }

  /**
   * Un-flushed reads of `nodeId`, pending plus in-flight, so any read — tracked
   * or not — can fold the delta onto the row it selected instead of reporting a
   * count that is merely waiting for its window.
   */
  pendingFor(nodeId: string): { count: number; lastAccessedAt: string | null } {
    const fold = this.foldFor(nodeId, 0);
    return fold.count === 0 ? { count: 0, lastAccessedAt: null } : fold;
  }

  /** Nodes dropped because flushes kept failing; surfaced for tests and ops. */
  get droppedNodes(): number {
    return this.dropped;
  }

  private foldFor(nodeId: string, stamp: number): { count: number; lastAccessedAt: string } {
    const inFlight = this.inFlight.get(nodeId);
    const pending = this.pending.get(nodeId);
    const count = (pending?.count ?? 0) + (inFlight?.count ?? 0);
    const at = Math.max(stamp, pending?.at ?? 0, inFlight?.at ?? 0);
    return { count, lastAccessedAt: new Date(at).toISOString() };
  }

  private evictOverflow(): void {
    // Only reachable when the database has been refusing writes long enough for
    // a window's worth of drains to fail. Losing the oldest counts beats
    // holding the process's memory hostage to an outage.
    while (this.pending.size > this.hardCap) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      this.pending.delete(oldest.value);
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1_000 === 0) {
        console.error(`[activation] buffer over ${this.hardCap} nodes; dropped ${this.dropped} activation bumps`);
      }
    }
  }

  private schedule(): void {
    if (this.timer || this.closed || this.pending.size === 0) return;
    // Ref'd on purpose: a process that exits naturally waits out the window and
    // flushes rather than dropping the last reads on the floor.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
  }

  /** Drain the buffer. Concurrent callers share the in-progress drain. */
  async flush(): Promise<void> {
    if (this.draining) {
      await this.draining;
      // A drain that started before this call may not have carried the caller's
      // bumps; anything left over goes out in a second pass.
      if (this.pending.size === 0) return;
    }
    if (this.pending.size === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = new Map();
    this.inFlight = batch;
    this.draining = this.write(batch)
      .catch((error: unknown) => {
        this.onError(error);
        // Nothing committed, so the batch stops being in-flight before it goes
        // back into `pending` — otherwise a read between the two would fold the
        // same counts twice.
        this.inFlight = new Map();
        // Put the counts back so the next window retries them.
        for (const [nodeId, entry] of batch) {
          const current = this.pending.get(nodeId);
          if (current) {
            current.count += entry.count;
            current.at = Math.max(current.at, entry.at);
          } else {
            this.pending.set(nodeId, entry);
          }
        }
        this.evictOverflow();
      })
      .finally(() => {
        this.inFlight = new Map();
        this.draining = null;
        this.schedule();
      });
    await this.draining;
  }

  private async write(batch: Map<string, Entry>): Promise<void> {
    const bumps: ActivationBump[] = [];
    for (const [nodeId, entry] of batch) {
      bumps.push({ nodeId, count: entry.count, lastAccessedAt: new Date(entry.at) });
    }
    if (bumps.length > 0) await this.flusher(bumps);
  }

  /** Flush what is buffered and stop scheduling. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush().catch(() => undefined);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
