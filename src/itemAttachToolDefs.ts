import {
  attachFromItemDescInputSchema,
  attachMemoryInputSchema,
} from "./itemAttachContracts.js";

export const attachMemoryTool = {
  name: "attach_memory",
  tier: "core" as const,
  description:
    "Attach a memory to an Outcome OS / Relay WorkItem. Required: itemId (Relay WorkItem.id). Either attach an existing memory via memoryId or slug, OR create one with title+summary (+ optional evidence) then attach. Optional bucket: suggested|pinned|excluded|available (default suggested). Ensures hub node item-{itemId} exists (logical form item:{itemId}; Trove stores hyphenated slug). Returns { memoryId, itemId, bucket, ... }. Relay should store memoryIds[] on the item; Trove owns storage/hubs. Emits Relay memory-event webhook when RELAY_MEMORY_EVENTS_URL is set (proposed/approved/rejected/superseded) — never fails attach if unset. Durable beliefs use remember today; propose→approve is product intent for suggested.",
  inputSchema: attachMemoryInputSchema,
};

export const attachFromItemDescTool = {
  name: "attach_from_item_desc",
  tier: "curator" as const,
  description:
    "Auto-attach from an item description: ingest(title+note) → remember short claim atoms (paragraph/sentence split, maxClaims) citing those spans → connect each to hub item-{itemId}. Prefer this over hand-rolling the pipeline when Relay has only a work-item title+note. Same bucket/hub/webhook semantics as attach_memory.",
  inputSchema: attachFromItemDescInputSchema,
};
