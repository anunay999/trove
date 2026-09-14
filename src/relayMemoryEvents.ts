/**
 * Relay Outcome OS memory-event webhook.
 *
 * When a memory's lifecycle on an item resolves (proposed / approved / rejected /
 * superseded), Trove POSTs `{ itemId, memoryId, status, bucket? }` to
 * RELAY_MEMORY_EVENTS_URL (Relay serves POST /api/trove/memory-events).
 *
 * Until the URL is set the emit is a no-op log — attach paths must never fail
 * because Relay is unreachable or unset.
 */

export type MemoryEventStatus = "proposed" | "approved" | "rejected" | "superseded";

export type MemoryBucket = "suggested" | "pinned" | "excluded" | "available";

export type RelayMemoryEvent = {
  itemId: string;
  memoryId: string;
  status: MemoryEventStatus;
  bucket?: MemoryBucket;
};

/** Map attach bucket → Relay lifecycle status for MVP (no separate approve UI yet). */
export function statusForBucket(bucket: MemoryBucket): MemoryEventStatus {
  switch (bucket) {
    case "pinned":
    case "available":
      return "approved";
    case "excluded":
      return "rejected";
    case "suggested":
    default:
      return "proposed";
  }
}

export function relayMemoryEventsUrl(): string | undefined {
  const raw = process.env.RELAY_MEMORY_EVENTS_URL?.trim();
  return raw || undefined;
}

/**
 * Fire-and-forget webhook. Never throws to callers: network/HTTP failures are
 * logged and swallowed so attach_memory stays durable even when Relay is down.
 */
export async function emitRelayMemoryEvent(event: RelayMemoryEvent): Promise<{ emitted: boolean; reason?: string }> {
  const url = relayMemoryEventsUrl();
  if (!url) {
    console.info("[relay-memory-events] skipped (RELAY_MEMORY_EVENTS_URL unset)", event);
    return { emitted: false, reason: "url_unset" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `[relay-memory-events] Relay returned ${response.status} for ${event.itemId}/${event.memoryId}: ${body.slice(0, 200)}`,
      );
      return { emitted: false, reason: `http_${response.status}` };
    }
    return { emitted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[relay-memory-events] emit failed (non-fatal): ${message}`);
    return { emitted: false, reason: "network_error" };
  }
}
