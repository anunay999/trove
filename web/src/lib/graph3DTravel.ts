// Keep this pure queue independent of browser hooks and their DOM types.
type RetrievalHighlights = ReadonlyMap<string, { state: string; at: number }> | null;

/** Camera visits are sampled from actual replay promotions, never invented nodes. */
export class RetrievalTravel {
  private seen = new Map<string, string>();
  private queue: string[] = [];
  interrupted = false;
  active = false;

  ingest(highlights: RetrievalHighlights, knownIds: ReadonlySet<string>): void {
    if (highlights === null || highlights.size === 0) {
      this.seen.clear();
      this.queue = [];
      this.interrupted = false;
      this.active = highlights !== null;
      return;
    }
    this.active = true;
    for (const [id, highlight] of [...highlights].sort((a, b) => a[1].at - b[1].at)) {
      const signature = `${highlight.state}:${highlight.at}`;
      if (!knownIds.has(id) || this.seen.get(id) === signature) continue;
      this.seen.set(id, signature);
      if (this.interrupted) continue;
      // Promote a pending node in place; do not circle back for every state.
      if (!this.queue.includes(id)) this.queue.push(id);
    }
    // Keep a large recall watchable. This drops old camera stops, not highlights.
    this.queue = this.queue.slice(-5);
  }

  next(): string | undefined { return this.interrupted ? undefined : this.queue.shift(); }
  get pending(): boolean { return this.queue.length > 0; }
  interrupt(): void { this.interrupted = true; this.queue = []; }
}

export function flightDuration(distance: number): number {
  return Math.max(1000, Math.min(1800, distance * 4));
}

export function easeTravel(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}
