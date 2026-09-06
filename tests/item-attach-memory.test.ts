import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  attachFromItemDesc,
  attachMemory,
  ensureItemHub,
  itemBucketPredicate,
  itemHubSlug,
} from "../src/itemAttachOps.js";
import { statusForBucket } from "../src/relayMemoryEvents.js";
import { suiteStore, closeStore } from "./helpers.js";

describe("item-center memory attach", () => {
  const { store, context, stamp } = suiteStore("item-attach");
  const itemId = `wi_${stamp}`;

  after(async () => {
    await closeStore(store);
  });

  it("maps logical item:{id} to stored item-{slug} hub slug", () => {
    assert.equal(itemHubSlug("abc:123"), "item-abc-123");
    assert.equal(itemHubSlug("WI_42"), "item-wi-42");
    assert.match(itemHubSlug(itemId), /^item-/);
    assert.equal(itemBucketPredicate("suggested"), "item_suggested");
    assert.equal(statusForBucket("suggested"), "proposed");
    assert.equal(statusForBucket("pinned"), "approved");
    assert.equal(statusForBucket("excluded"), "rejected");
  });

  it("ensureItemHub creates once and is idempotent", async () => {
    const first = await ensureItemHub(store, itemId, context);
    const second = await ensureItemHub(store, itemId, context);
    assert.equal(first.id, second.id);
    assert.equal(first.slug, itemHubSlug(itemId));
    assert.equal(first.type, "task");
  });

  it("attach_memory creates a claim and links it under suggested", async () => {
    const result = await attachMemory(store, {
      itemId,
      title: `Item attach fact ${stamp}`,
      summary: "The widget SLA is 99.9%.",
      evidence: [],
      bucket: "suggested",
    }, context);
    assert.ok(result.memoryId);
    assert.equal(result.itemId, itemId);
    assert.equal(result.bucket, "suggested");
    assert.equal(result.hubSlug, itemHubSlug(itemId));
    assert.ok(["created_and_attached", "attached"].includes(result.action));
    assert.equal(result.relayEvent?.emitted, false);
    assert.equal(result.relayEvent?.status, "proposed");
    assert.equal(result.relayEvent?.reason, "url_unset");

    const hood = await store.neighborhood({ nodeId: result.memoryId, depth: 1, includeExpired: false }, context);
    assert.ok(
      hood.edges.some((edge) => edge.id === result.edgeId && edge.predicate === "item_suggested"),
      "expected item_suggested edge to hub",
    );
  });

  it("attach_memory is idempotent for the same bucket and rebuckets with supersession", async () => {
    const created = await attachMemory(store, {
      itemId,
      title: `Item attach rebucket ${stamp}`,
      summary: "Support owns the escalation inbox.",
      evidence: [],
      bucket: "suggested",
    }, context);

    const again = await attachMemory(store, {
      itemId,
      memoryId: created.memoryId,
      bucket: "suggested",
    }, context);
    assert.equal(again.action, "idempotent");
    assert.equal(again.edgeId, created.edgeId);

    const pinned = await attachMemory(store, {
      itemId,
      memoryId: created.memoryId,
      bucket: "pinned",
    }, context);
    assert.equal(pinned.action, "rebucketed");
    assert.notEqual(pinned.edgeId, created.edgeId);
    assert.equal(pinned.relayEvent?.status, "approved");

    const active = await store.neighborhood({ nodeId: created.memoryId, depth: 1, includeExpired: false }, context);
    assert.ok(active.edges.some((edge) => edge.predicate === "item_pinned"));
    assert.ok(!active.edges.some((edge) => edge.id === created.edgeId));

    const history = await store.neighborhood({ nodeId: created.memoryId, depth: 1, includeExpired: true }, context);
    assert.ok(history.edges.some((edge) => edge.id === created.edgeId && edge.expiredAt));
  });

  it("attach_from_item_desc ingests, remembers claims, and attaches each", async () => {
    const descItem = `wi_desc_${stamp}`;
    const result = await attachFromItemDesc(store, {
      itemId: descItem,
      title: `Ship checklist ${stamp}`,
      note: [
        "Deploy freezes after Friday noon.",
        "",
        "Customer success owns churn emails.",
        "",
        "Rollback flag is FEATURE_SAFE_MODE.",
      ].join("\n"),
      bucket: "suggested",
      maxClaims: 5,
    }, context);

    assert.equal(result.itemId, descItem);
    assert.equal(result.hubSlug, itemHubSlug(descItem));
    assert.ok(result.sourceId);
    assert.ok(result.memories.length >= 2, `expected multiple claims, got ${result.memories.length}`);
    for (const memory of result.memories) {
      assert.equal(memory.itemId, descItem);
      assert.equal(memory.bucket, "suggested");
      const read = await store.read({ nodeId: memory.memoryId }, context, { trackAccess: false });
      assert.ok(read, "remembered claim must be readable");
    }
  });
});
