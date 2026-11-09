import { type GraphOperationContext, ownerScope } from "./graphCore.js";

/**
 * Session-served provenance log (backlog #9b). Records which text units a
 * session was actually shown — ingest/search/recall/grep/read/project
 * responses — so `remember` can flag a cited unit the caller never received:
 * a ref the agent was never given is a hallucination by definition.
 *
 * In-process and per-owner BY DESIGN: it backs a warning, not a security
 * boundary, one tenant's serves must never validate another's refs, and the
 * cap + TTL keep it session-sized. Both drivers hold one instance each, so
 * the check behaves identically on either driver.
 */
export class ServedUnitLog {
  private buckets = new Map<string, Map<string, number>>();

  constructor(
    private readonly cap = 2000,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    /**
     * Owner buckets need their own cap. Only the entries *inside* a bucket were
     * bounded before, so every distinct owner that ever ran a recall left a
     * bucket behind for the life of the process — bounded per owner, unbounded
     * across them. Evicted LRU, exactly like the entries.
     */
    private readonly ownerCap = 1000,
  ) {}

  private keyFor(context?: GraphOperationContext): string {
    const scope = ownerScope(context);
    return scope.scoped ? `owner:${scope.ownerId}` : "global";
  }

  mark(unitIds: Iterable<string>, context?: GraphOperationContext): void {
    const now = Date.now();
    const key = this.keyFor(context);
    const bucket = this.buckets.get(key) ?? new Map<string, number>();
    // delete+set moves this owner to the young end too, so the LRU sweep below
    // evicts whoever has been idle longest rather than whoever arrived first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    for (const [id, at] of bucket) {
      if (now - at > this.ttlMs) bucket.delete(id);
    }
    for (const id of unitIds) {
      // delete+set refreshes recency AND moves the entry to the young end.
      bucket.delete(id);
      bucket.set(id, now);
    }
    while (bucket.size > this.cap) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
    }
    // An owner whose entries have all aged out is dead weight: drop the bucket
    // with them rather than keeping an empty Map keyed by that owner forever.
    if (bucket.size === 0) this.buckets.delete(key);
    while (this.buckets.size > this.ownerCap) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  wasServed(textUnitId: string, context?: GraphOperationContext): boolean {
    const bucket = this.buckets.get(this.keyFor(context));
    const at = bucket?.get(textUnitId);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      bucket?.delete(textUnitId);
      return false;
    }
    return true;
  }
}
