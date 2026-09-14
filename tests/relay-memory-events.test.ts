import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { emitRelayMemoryEvent, statusForBucket } from "../src/relayMemoryEvents.js";

describe("relay memory events webhook", () => {
  const previous = process.env.RELAY_MEMORY_EVENTS_URL;

  after(() => {
    if (previous === undefined) delete process.env.RELAY_MEMORY_EVENTS_URL;
    else process.env.RELAY_MEMORY_EVENTS_URL = previous;
  });

  it("maps buckets to lifecycle statuses", () => {
    assert.equal(statusForBucket("suggested"), "proposed");
    assert.equal(statusForBucket("available"), "approved");
    assert.equal(statusForBucket("pinned"), "approved");
    assert.equal(statusForBucket("excluded"), "rejected");
  });

  it("no-ops when RELAY_MEMORY_EVENTS_URL is unset", async () => {
    delete process.env.RELAY_MEMORY_EVENTS_URL;
    const result = await emitRelayMemoryEvent({
      itemId: "wi_1",
      memoryId: "00000000-0000-0000-0000-000000000001",
      status: "proposed",
      bucket: "suggested",
    });
    assert.equal(result.emitted, false);
    assert.equal(result.reason, "url_unset");
  });
});
