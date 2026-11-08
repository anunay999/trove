import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import { citationContradictsRevision } from "../src/graphCore.js";
import { closeStore, isolateDatabase, suiteStore } from "./helpers.js";

await isolateDatabase("evidence_stale");

describe("citations that contradict a revision", () => {
  const { store, context, stamp } = suiteStore("evidence-stale");

  after(async () => {
    await closeStore(store);
  });

  it("flags only units that state a replaced term and none of its replacement", () => {
    const before = "billing port\nbilling-service port is 8787";
    const afterText = "billing port\nbilling-service port is 9090";
    assert.deepEqual(citationContradictsRevision(before, afterText, "Event: billing-service port is 8787."), ["8787"]);
    assert.equal(citationContradictsRevision(before, afterText, "Moved billing-service from port 8787 to 9090."), null, "a unit stating the new value supports it");
    assert.equal(citationContradictsRevision(before, afterText, "The billing service runs on Kubernetes."), null, "unrelated units are not contradictions");
    assert.equal(citationContradictsRevision(before, `${before}\nOwned by Platform.`, "billing-service port is 8787"), null, "pure additions never flag");
  });

  it("remember reports the stale citation and marks the write incomplete", async () => {
    const marker = `stalecite${stamp}`;
    await store.ingest({ kind: "agent_note", title: `${marker} deploy log`, contentText: `Event: ${marker} port is 8787.`, metadata: {} }, context);
    const first = await remember(store, {
      title: `${marker} port`,
      type: "claim",
      summary: `${marker} port is 8787`,
      evidence: [{ quote: `${marker} port is 8787` }],
    }, context);
    assert.equal(first.complete, true);

    const revised = await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} port is 9090` }, context);
    assert.equal(revised.action, "updated");
    assert.equal(revised.complete, false);
    assert.equal(revised.evidenceStale?.length, 1);
    assert.deepEqual(revised.evidenceStale?.[0]?.staleTerms, ["8787"]);
  });

  it("citing the new span in the same call keeps the write complete", async () => {
    const marker = `freshcite${stamp}`;
    await store.ingest({
      kind: "agent_note",
      title: `${marker} deploy log`,
      contentText: `Event: ${marker} port is 8787.\n\nEvent: ${marker} port moved to 9090.`,
      metadata: {},
    }, context);
    await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} port is 8787`, evidence: [{ quote: `${marker} port is 8787` }] }, context);
    const revised = await remember(store, {
      title: `${marker} port`,
      type: "claim",
      summary: `${marker} port is 9090`,
      evidence: [{ quote: `${marker} port moved to 9090` }],
    }, context);
    assert.equal(revised.evidenceStale?.length, 1, "the old citation is still reported");
    assert.equal(revised.complete, true, "but the revision brought its own support");
  });

  it("an unchanged revision reports nothing", async () => {
    const marker = `samecite${stamp}`;
    await store.ingest({ kind: "agent_note", title: `${marker} log`, contentText: `Event: ${marker} region is eu-west.`, metadata: {} }, context);
    await remember(store, { title: `${marker} region`, type: "claim", summary: `${marker} region is eu-west`, evidence: [{ quote: `${marker} region is eu-west` }] }, context);
    const again = await remember(store, { title: `${marker} region`, type: "claim", summary: `${marker} region is eu-west` }, context);
    assert.equal(again.evidenceStale, undefined);
    assert.equal(again.complete, true);
  });
});
