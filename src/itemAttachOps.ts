import type { AttachFromItemDescInput, AttachMemoryInput, MemoryBucket } from "./itemAttachContracts.js";
import type { GraphEdge, GraphNode } from "./contracts.js";
import type { GraphOperationContext, GraphStore } from "./graphCore.js";
import { remember, type RememberResult } from "./agentOps.js";
import { slugify } from "./slug.js";
import { emitRelayMemoryEvent, statusForBucket } from "./relayMemoryEvents.js";

// ---------------------------------------------------------------------------
// Outcome OS item-center memory attach
// ---------------------------------------------------------------------------

const ITEM_BUCKET_PREDICATES: Record<MemoryBucket, string> = {
  suggested: "item_suggested",
  pinned: "item_pinned",
  excluded: "item_excluded",
  available: "item_available",
};

const ALL_ITEM_PREDICATES = new Set(Object.values(ITEM_BUCKET_PREDICATES));

/**
 * Stored hub slug for a Relay WorkItem.
 *
 * Contract logical form is `item:{itemId}`. Trove slugify replaces non
 * [a-z0-9] with `-`, so the durable slug is `item-{slugify(itemId)}`.
 */
export function itemHubSlug(itemId: string): string {
  return `item-${slugify(itemId)}`;
}

export function itemBucketPredicate(bucket: MemoryBucket): string {
  return ITEM_BUCKET_PREDICATES[bucket];
}

export type AttachMemoryResult = {
  memoryId: string;
  itemId: string;
  bucket: MemoryBucket;
  hubSlug: string;
  hubNodeId: string;
  edgeId: string;
  action: "attached" | "created_and_attached" | "rebucketed" | "idempotent";
  evidence?: Array<{ sourceId: string | null; textUnitId: string | null; quote?: string | null; reason: string }>;
  remember?: RememberResult;
  relayEvent?: { emitted: boolean; status: string; reason?: string };
};

export type AttachFromItemDescResult = {
  itemId: string;
  bucket: MemoryBucket;
  hubSlug: string;
  hubNodeId: string;
  sourceId: string;
  memories: AttachMemoryResult[];
};

/** Ensure hub node for Relay WorkItem exists (create if missing). */
export async function ensureItemHub(
  store: GraphStore,
  itemId: string,
  context?: GraphOperationContext,
): Promise<GraphNode> {
  const slug = itemHubSlug(itemId);
  const existing = await store.read({ slug }, context, { trackAccess: false });
  if (existing) return existing;

  // Title slugifies to the canonical hub slug for typical itemIds.
  const created = await store.capture({
    title: `Item ${itemId}`,
    type: "task",
    summary: `Outcome OS item hub for Relay WorkItem ${itemId}.`,
    content: `Logical hub id: item:${itemId}\nStored slug: ${slug}`,
    evidence: [],
    links: [],
  }, context);

  if (created.slug === slug) return created;

  // Rare collision on title-derived slug — force the canonical hub slug.
  const updated = await store.update({
    nodeId: created.id,
    baseRevisionId: created.revisionId,
    slug,
  }, context);
  if (!updated || "conflict" in updated) {
    throw new Error(`ensureItemHub: unable to set hub slug ${slug} for item ${itemId}.`);
  }
  return updated;
}

async function findItemAttachEdge(
  store: GraphStore,
  memoryId: string,
  hubNodeId: string,
  context?: GraphOperationContext,
): Promise<GraphEdge | null> {
  const { edges } = await store.neighborhood({ nodeId: memoryId, depth: 1, includeExpired: false }, context);
  return edges.find(
    (edge) =>
      !edge.expiredAt &&
      ALL_ITEM_PREDICATES.has(edge.predicate) &&
      ((edge.fromNodeId === memoryId && edge.toNodeId === hubNodeId) ||
        (edge.toNodeId === memoryId && edge.fromNodeId === hubNodeId)),
  ) ?? null;
}

/**
 * Attach existing memory (memoryId/slug) or create via title/summary then attach
 * to hub item-{itemId} under the given bucket. Emits Relay memory-event webhook
 * (no-op until RELAY_MEMORY_EVENTS_URL is set).
 *
 * Durable belief: uses remember() today — beliefs land immediately. Product
 * intent is propose→approve for suggested bucket; until that gate exists,
 * suggested emits status "proposed" and pinned/available emit "approved".
 */
export async function attachMemory(
  store: GraphStore,
  input: AttachMemoryInput,
  context?: GraphOperationContext,
): Promise<AttachMemoryResult> {
  const bucket = (input.bucket ?? "suggested") as MemoryBucket;
  const hub = await ensureItemHub(store, input.itemId, context);
  const hubSlug = hub.slug;
  const predicate = itemBucketPredicate(bucket);

  let rememberResult: RememberResult | undefined;
  let memory: GraphNode;
  let created = false;

  if (input.memoryId) {
    const found = await store.read({ nodeId: input.memoryId }, context, { trackAccess: false });
    if (!found) throw new Error(`attach_memory: no node with id ${input.memoryId}.`);
    memory = found;
  } else if (input.slug && !(input.title && input.summary)) {
    const found = await store.read({ slug: input.slug }, context, { trackAccess: false });
    if (!found) throw new Error(`attach_memory: no node with slug ${input.slug}.`);
    memory = found;
  } else if (input.title && input.summary) {
    rememberResult = await remember(store, {
      title: input.title,
      summary: input.summary,
      type: input.type ?? "claim",
      content: input.content,
      evidence: input.evidence ?? [],
      links: [],
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.memoryId ? { nodeId: input.memoryId } : {}),
    }, context);
    memory = rememberResult.node;
    created = rememberResult.action === "created";
  } else {
    throw new Error("attach_memory: provide memoryId, slug, or title+summary.");
  }

  const existing = await findItemAttachEdge(store, memory.id, hub.id, context);
  let action: AttachMemoryResult["action"] = created ? "created_and_attached" : "attached";
  let edge: GraphEdge | null = null;

  if (existing && existing.predicate === predicate) {
    action = "idempotent";
    edge = existing;
  } else if (existing) {
    edge = await store.link({
      fromNodeId: memory.id,
      toNodeId: hub.id,
      predicate,
      weight: 1,
      supersedesEdgeId: existing.id,
    }, context);
    action = "rebucketed";
    // Prior attachment superseded — notify Relay (non-fatal).
    await emitRelayMemoryEvent({
      itemId: input.itemId,
      memoryId: memory.id,
      status: "superseded",
      bucket,
    });
  } else {
    edge = await store.link({
      fromNodeId: memory.id,
      toNodeId: hub.id,
      predicate,
      weight: 1,
    }, context);
  }

  if (!edge) throw new Error(`attach_memory: failed to link memory ${memory.id} to hub ${hubSlug}.`);

  const status = statusForBucket(bucket);
  const relay = await emitRelayMemoryEvent({
    itemId: input.itemId,
    memoryId: memory.id,
    status,
    bucket,
  });

  const evidence =
    rememberResult?.evidenceRejected?.map((row) => ({ ...row })) ??
    undefined;

  return {
    memoryId: memory.id,
    itemId: input.itemId,
    bucket,
    hubSlug,
    hubNodeId: hub.id,
    edgeId: edge.id,
    action,
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
    ...(rememberResult ? { remember: rememberResult } : {}),
    relayEvent: { emitted: relay.emitted, status, ...(relay.reason ? { reason: relay.reason } : {}) },
  };
}

/** Split item description into short claim texts (paragraph / sentence heuristic; no LLM). */
function claimTextsFromNote(note: string, maxClaims: number): string[] {
  const blocks = note
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0);

  const raw = blocks.length > 0 ? blocks : [note.replace(/\s+/g, " ").trim()].filter(Boolean);
  const claims: string[] = [];
  for (const block of raw) {
    if (claims.length >= maxClaims) break;
    if (block.length <= 280) {
      claims.push(block);
      continue;
    }
    const sentences = block.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (claims.length >= maxClaims) break;
      claims.push(sentence.slice(0, 280));
    }
  }
  return claims.slice(0, maxClaims);
}

/**
 * ingest(title+note) → remember short claims → connect each to item hub.
 * Emits Relay events per attached memory (non-fatal if URL unset).
 */
export async function attachFromItemDesc(
  store: GraphStore,
  input: AttachFromItemDescInput,
  context?: GraphOperationContext,
): Promise<AttachFromItemDescResult> {
  const bucket = (input.bucket ?? "suggested") as MemoryBucket;
  const maxClaims = input.maxClaims ?? 5;
  const hub = await ensureItemHub(store, input.itemId, context);

  const ingested = await store.ingest({
    kind: "agent_note",
    title: input.title,
    contentText: input.note,
    metadata: { itemId: input.itemId, source: "attach_from_item_desc" },
  }, context);

  const claims = claimTextsFromNote(input.note, maxClaims);
  const memories: AttachMemoryResult[] = [];

  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i]!;
    const title = claims.length === 1
      ? input.title
      : `${input.title} (${i + 1}/${claims.length})`;
    const attached = await attachMemory(store, {
      itemId: input.itemId,
      title,
      summary: claim,
      type: "claim",
      content: claim,
      evidence: [{ quote: claim.slice(0, 500) }],
      bucket,
    }, context);
    memories.push(attached);
  }

  return {
    itemId: input.itemId,
    bucket,
    hubSlug: hub.slug,
    hubNodeId: hub.id,
    sourceId: ingested.source.id,
    memories,
  };
}
