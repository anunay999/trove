import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/graphCore.js";
import { suiteStore, closeStore } from "./helpers.js";

// Regression tests for the recall packing fixes:
// - F3: the token budget covers the whole wire response; atoms carry the
//   packed slice (contentTruncated marks cut bodies); hops is true BFS depth.
// - F4: recall packing must not bump access activation.
// - F10: per-node evidence is query-ranked and capped at 5, packed only after
//   every atom has its body/teaser allocation.
describe("recall packing fixes", () => {
  const { store, context, stamp } = suiteStore("recall-packing-fixes");

  after(async () => {
    await closeStore(store);
  });

  it("keeps the whole serialized response within ~1.5× a small token budget", async () => {
    const marker = `WIREGUARD_${stamp}`;
    const hub = await store.capture({
      title: `Wire guard hub ${marker}`,
      type: "pattern",
      summary: "Hub for the recall wire-budget guard.",
      content: `${marker} hub body. ${"pack the hub body ".repeat(40)}`, // ~750 chars
      evidence: [],
      links: [],
    }, context);
    for (const name of ["alpha", "bravo", "charlie"]) {
      const neighbor = await store.capture({
        title: `Wire guard ${name} neighbor ${stamp}`,
        type: "pattern",
        summary: `Neighbor ${name} of the wire guard hub.`,
        content: `Neighbor ${name} body. ${"teaser filler text ".repeat(70)}`, // ~1.3k chars
        evidence: [],
        links: [],
      }, context);
      await store.link({ fromNodeId: hub.id, toNodeId: neighbor.id, predicate: "relates_to", weight: 1 }, context);
    }

    const tokenBudget = 500;
    const result = await store.recall({ query: marker, tokenBudget, depth: 1, includeEvidence: false });
    const payloadTokens = estimateTokens(JSON.stringify(result));
    assert.ok(
      payloadTokens <= Math.ceil(tokenBudget * 1.5),
      `serialized recall response must stay within ~1.5× budget: ${payloadTokens} tokens > ${Math.ceil(tokenBudget * 1.5)}`,
    );
    const hubAtom = result.atoms.find((atom) => atom.node.id === hub.id);
    assert.ok(hubAtom, "primary hub must still be packed");
    assert.ok((hubAtom.node.content ?? "").length > 0, "primary match body is never cut by the wire guard");
  });

  it("atoms carry the packed slice with contentTruncated, giants are teaser-capped", async () => {
    const marker = `GIANTPAGESMOKE_${stamp}`;
    const smallBody = `Small note body ${marker}. ${"concise prose ".repeat(50)}`; // ~750 chars
    const small = await store.capture({
      title: `Small note ${marker}`,
      type: "claim",
      summary: "Small fully-packed note.",
      content: smallBody,
      evidence: [],
      links: [],
    }, context);
    const endMarker = `ENDMARK_${stamp}`;
    const giantContent = `# Giant index ${marker}\n\n${"giant catalog filler ".repeat(900)}\n${endMarker}`; // >12k chars
    const giant = await store.capture({
      title: `Giant catalog ${marker}`,
      type: "entity",
      summary: "Giant catalog page that must be teaser-capped.",
      content: giantContent,
      evidence: [],
      links: [],
    }, context);

    const result = await store.recall({ query: marker, tokenBudget: 8000, depth: 0, includeEvidence: false });
    const giantAtom = result.atoms.find((atom) => atom.node.id === giant.id);
    assert.ok(giantAtom, "giant page must be packed");
    assert.equal(giantAtom.contentTruncated, true, "giant atom must report a truncated body");
    const giantSlice = giantAtom.node.content ?? "";
    assert.ok(giantSlice.length <= 2500, `giant slice must be teaser-capped, got ${giantSlice.length} chars`);
    assert.equal(giantSlice, giantContent.slice(0, giantSlice.length), "atom content must be a prefix slice of the body");
    assert.ok(!giantSlice.includes(endMarker), "tail of the giant body must not leak into the pack");

    const smallAtom = result.atoms.find((atom) => atom.node.id === small.id);
    assert.ok(smallAtom, "small note must be packed");
    assert.equal(smallAtom.contentTruncated, false, "fully packed note must not report truncation");
    assert.equal(smallAtom.node.content, smallBody, "fully packed note carries its whole body");
  });

  it("labels hops by true BFS depth from the match", async () => {
    const marker = `HOPSMOKE_${stamp}`;
    const seed = await store.capture({
      title: `Hops seed ${marker}`,
      type: "claim",
      summary: "Depth-zero match for the hops labeling check.",
      content: `Seed body ${marker}.`,
      evidence: [],
      links: [],
    }, context);
    const middle = await store.capture({
      title: `Hops middle ${stamp}`,
      type: "claim",
      summary: "One hop from the seed.",
      content: "Middle body without the query marker.",
      evidence: [],
      links: [],
    }, context);
    const far = await store.capture({
      title: `Hops far ${stamp}`,
      type: "claim",
      summary: "Two hops from the seed.",
      content: "Far body without the query marker.",
      evidence: [],
      links: [],
    }, context);
    await store.link({ fromNodeId: seed.id, toNodeId: middle.id, predicate: "relates_to", weight: 1 }, context);
    await store.link({ fromNodeId: middle.id, toNodeId: far.id, predicate: "relates_to", weight: 1 }, context);

    const result = await store.recall({ query: marker, tokenBudget: 4000, depth: 2, includeEvidence: false });
    assert.equal(result.atoms.find((atom) => atom.node.id === seed.id)?.hops, 0, "seed match is hops 0");
    assert.equal(result.atoms.find((atom) => atom.node.id === middle.id)?.hops, 1, "direct neighbor is hops 1");
    assert.equal(result.atoms.find((atom) => atom.node.id === far.id)?.hops, 2, "depth-2 neighbor must be labeled hops 2");
  });

  it("does not bump accessCount or lastAccessedAt while packing", async () => {
    const marker = `ACTIVATIONSMOKE_${stamp}`;
    const node = await store.capture({
      title: `Activation probe ${marker}`,
      type: "claim",
      summary: "Recall packing must leave activation counters alone.",
      content: `Probe body ${marker}.`,
      evidence: [],
      links: [],
    }, context);

    const result = await store.recall({ query: marker, tokenBudget: 2000, depth: 0, includeEvidence: false });
    assert.ok(result.atoms.some((atom) => atom.node.id === node.id), "probe node must be packed");

    const snapshot = await store.exportGraph(context);
    const after = snapshot.nodes.find((candidate) => candidate.id === node.id);
    assert.ok(after, "probe node missing from graph snapshot");
    assert.equal(after.accessCount, 0, "recall packing must not bump accessCount");
    assert.equal(after.lastAccessedAt, null, "recall packing must not stamp lastAccessedAt");
  });

  it("caps per-node evidence at 5 query-relevant units so other atoms keep their bodies", async () => {
    const marker = `QUOKKASMOKE_${stamp}`;
    const paragraphs: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      paragraphs.push(
        index < 5
          ? `Evidence ${index}: ${marker} migration notes that matter for the query.`
          : `Evidence ${index}: unrelated zymurgy protocol trivia with no bearing on anything here.`,
      );
    }
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Evidence pool ${stamp}`,
      contentText: paragraphs.join("\n\n"),
      metadata: {},
    }, context);
    const relevantIds = new Set(
      ingested.textUnits.filter((unit) => unit.text.includes(marker)).map((unit) => unit.id),
    );
    assert.equal(relevantIds.size, 5, "fixture must produce exactly 5 query-relevant units");

    const hungry = await store.capture({
      title: `Hungry evidence node ${marker}`,
      type: "claim",
      summary: "Node citing 15 evidence units, only 5 of them relevant.",
      content: `Hungry node body ${marker}.`,
      evidence: ingested.textUnits.map((unit) => ({ textUnitId: unit.id, selector: {} })),
      links: [],
    }, context);
    const peerBody = `Peer body ${marker}. ${"peer prose that must survive ".repeat(20)}`; // ~650 chars
    const peer = await store.capture({
      title: `Peer node ${marker}`,
      type: "claim",
      summary: "Second matching node whose body allocation must survive.",
      content: peerBody,
      evidence: [],
      links: [],
    }, context);

    const result = await store.recall({ query: marker, tokenBudget: 8000, depth: 0, includeEvidence: true });

    const hungryCitations = result.citations.filter(
      (citation) => citation.nodeId === hungry.id && citation.textUnitId !== null,
    );
    const citedUnitIds = new Set(hungryCitations.map((citation) => citation.textUnitId));
    assert.ok(citedUnitIds.size <= 5, `per-node evidence must be capped at 5, packed ${citedUnitIds.size}`);
    for (const unitId of citedUnitIds) {
      assert.ok(unitId !== null && relevantIds.has(unitId), `packed evidence ${unitId} must be query-relevant`);
    }

    const peerAtom = result.atoms.find((atom) => atom.node.id === peer.id);
    assert.ok(peerAtom, "peer atom must be packed");
    assert.equal(peerAtom.node.content, peerBody, "peer atom must keep its full body allocation");
    assert.equal(peerAtom.contentTruncated, false);
  });
});
