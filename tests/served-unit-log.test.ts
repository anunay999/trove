import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ServedUnitLog } from "../src/graphCore.js";
import type { GraphOperationContext } from "../src/graphCore.js";

// Production RSS grew ~0.42 GB/day with flat CPU. Per-owner maps that are
// bounded *within* an owner but unbounded *across* owners were one of the
// shapes that can do that, and this log was one: entries expired, buckets
// never did. These lock the outer bound in.

const ownerContext = (ownerId: string): GraphOperationContext =>
  ({ actorId: `actor-${ownerId}`, interfaceId: "test", ownerId }) as GraphOperationContext;

/** Owner buckets live in a private field; count them through observable reads. */
function residentOwners(log: ServedUnitLog, ownerIds: string[]): number {
  return ownerIds.filter((ownerId) => log.wasServed(`unit-${ownerId}`, ownerContext(ownerId))).length;
}

describe("ServedUnitLog owner buckets", () => {
  it("keeps serving the owners it has marked", () => {
    const log = new ServedUnitLog();
    log.mark(["unit-a"], ownerContext("a"));
    assert.equal(log.wasServed("unit-a", ownerContext("a")), true);
    assert.equal(log.wasServed("unit-a", ownerContext("b")), false, "owners must not read each other's log");
  });

  it("evicts least-recently-used owners past the owner cap", () => {
    const ownerCap = 10;
    const log = new ServedUnitLog(2000, 6 * 60 * 60 * 1000, ownerCap);
    const ownerIds = Array.from({ length: ownerCap * 5 }, (_, i) => `owner-${i}`);
    for (const ownerId of ownerIds) log.mark([`unit-${ownerId}`], ownerContext(ownerId));

    const resident = residentOwners(log, ownerIds);
    assert.ok(resident <= ownerCap, `expected at most ${ownerCap} resident owners, got ${resident}`);

    // The most recent writers are the ones that survived.
    const newest = ownerIds.slice(-ownerCap);
    assert.equal(residentOwners(log, newest), ownerCap, "most-recent owners should all still be resident");
  });

  it("drops a bucket once every entry in it has aged out", () => {
    const ttlMs = 20;
    const log = new ServedUnitLog(2000, ttlMs, 1000);
    log.mark(["unit-a"], ownerContext("a"));
    assert.equal(log.wasServed("unit-a", ownerContext("a")), true);

    // Re-marking with nothing, after the TTL, must collect the empty bucket
    // rather than leave an owner-keyed Map resident forever.
    const expired = Date.now() + ttlMs + 1;
    while (Date.now() < expired) { /* spin briefly; TTL is 20ms */ }
    log.mark([], ownerContext("a"));
    assert.equal(log.wasServed("unit-a", ownerContext("a")), false);
  });
});
