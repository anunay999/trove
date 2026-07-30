import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import { UserStore } from "../src/users.js";
import { closeStore, hasPostgres, isolateDatabase, suiteStore } from "./helpers.js";

await isolateDatabase("integrity");

describe("integrity suite (backlog #28)", () => {
  const { store, context, stamp } = suiteStore("integrity");

  after(async () => {
    await closeStore(store);
  });

  it("#1 every recalled atom has a resolvable citation or an explicit agent-inference mark", async () => {
    const marker = `integrityprovenance${stamp}`;
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Integrity provenance source ${stamp}`,
      contentText: `The ${marker} release train leaves at 09:30 UTC.`,
      metadata: {},
    }, context);
    const cited = await remember(store, {
      title: `Cited ${marker} release train`,
      type: "claim",
      summary: `The ${marker} release train leaves at 09:30 UTC.`,
      evidence: [{ quote: `The ${marker} release train leaves at 09:30 UTC.` }],
      links: [],
    }, context);
    const inferred = await remember(store, {
      title: `Inferred ${marker} owner`,
      type: "claim",
      summary: `Agent inference: the ${marker} release owner is the platform team.`,
      evidence: [],
      links: [],
    }, context);
    const sourceCited = await store.capture({
      title: `Source-cited ${marker} schedule`,
      type: "claim",
      summary: `The ${marker} schedule comes from the cited release note.`,
      evidence: [{ sourceId: ingested.source.id, selector: {} }],
      links: [],
    }, context);
    assert.equal(cited.complete, true);
    assert.equal(inferred.complete, true);

    const pack = await store.recall({
      query: marker,
      tokenBudget: 4000,
      depth: 0,
      includeEvidence: false,
    }, context);
    const expectedIds = new Set([cited.node.id, inferred.node.id, sourceCited.id]);
    const atoms = pack.atoms.filter((atom) => expectedIds.has(atom.node.id));
    assert.equal(atoms.length, 3, "all integrity provenance fixtures must be recalled");

    for (const atom of atoms) {
      if (atom.provenance === "citation") {
        const read = await store.read({ nodeId: atom.node.id }, context, { trackAccess: false });
        assert.ok(read && read.evidence.length > 0, "a citation-marked atom must resolve to stored evidence");
      } else {
        assert.equal(atom.provenance, "agent_inference");
        assert.match(atom.node.summary ?? "", /agent inference/i);
        assert.match(pack.context, new RegExp(`${atom.node.title}[^\\n]*AGENT INFERENCE`));
      }
    }

    assert.ok(ingested.textUnits.length > 0, "the cited fixture must contain a resolvable text unit");
  });

  it("#2 remember never reports a complete write for rejected or unserved evidence", async () => {
    const rejected = await remember(store, {
      title: `Rejected integrity evidence ${stamp}`,
      type: "claim",
      summary: "A claim whose quoted evidence does not exist.",
      evidence: [{ quote: `missing-integrity-quote-${stamp}` }],
      links: [],
    }, context);
    assert.equal(rejected.action, "created", "the node mutation is reported independently");
    assert.equal(rejected.complete, false, "a rejected citation must prevent a complete result");
    assert.equal(rejected.evidenceRejected?.length, 1);
    assert.match(rejected.evidenceRejected?.[0]?.reason ?? "", /does not appear|closest/i);

    let otherOwnerId = `integrity-other-${stamp}`;
    if (hasPostgres()) {
      const users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
      try {
        const user = await users.ensureUser({
          clerkUserId: `integrity-other-${stamp}`,
          email: `integrity-other-${stamp}@example.com`,
        });
        otherOwnerId = user.id;
      } finally {
        await users.close();
      }
    }
    const otherOwner = { ...context, ownerId: otherOwnerId };
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Unserved integrity source ${stamp}`,
      contentText: `A private producer session served this integrity span ${stamp}.`,
      metadata: {},
    }, otherOwner);
    const unservedUnit = ingested.textUnits[0];
    assert.ok(unservedUnit);
    const unserved = await remember(store, {
      title: `Unserved integrity evidence ${stamp}`,
      type: "claim",
      summary: "A claim citing a real span that this session was never served.",
      evidence: [{ textUnitId: unservedUnit.id }],
      links: [],
    }, context);
    assert.equal(unserved.action, "created");
    assert.equal(unserved.complete, false, "an unserved UUID citation must prevent a complete result");
    assert.equal(unserved.evidenceUnserved?.length, 1);
    assert.match(unserved.evidenceUnserved?.[0]?.reason ?? "", /never served/i);

    const inference = await remember(store, {
      title: `Allowed integrity inference ${stamp}`,
      type: "claim",
      summary: "Agent inference: this conclusion was derived during the current session.",
      evidence: [],
      links: [],
    }, context);
    assert.equal(inference.complete, true, "explicit agent inference needs no citation");
    assert.equal(inference.evidenceRejected, undefined);
    assert.equal(inference.evidenceUnserved, undefined);

    const sourceOnly = await remember(store, {
      title: `Spanless integrity evidence ${stamp}`,
      type: "claim",
      summary: "A source id alone does not identify the exact supporting span.",
      evidence: [{ sourceId: ingested.source.id }],
      links: [],
    }, context);
    assert.equal(sourceOnly.complete, false, "source-only evidence must not bypass the served-span gate");
    assert.equal(sourceOnly.evidenceRejected?.length, 1);
    assert.match(sourceOnly.evidenceRejected?.[0]?.reason ?? "", /quote|text unit|span/i);
  });

  it("#3 labels superseded atoms and never packs their successor at lower fidelity", async () => {
    const marker = `integritylegacymarker${stamp}`;
    const supersededBody = `The old deployment window was Tuesday. ${marker}\n${"stale detail ".repeat(25)}`;
    const successorBody = `The current deployment window is Thursday.\n${"current operational detail ".repeat(520)}`;
    const finalBody = `The final deployment window is Friday.\n${"final operational detail ".repeat(620)}`;
    const superseded = await store.capture({
      title: `Legacy deployment window ${marker}`,
      type: "claim",
      summary: "Agent inference: the deployment window was Tuesday.",
      content: supersededBody,
      evidence: [],
      links: [],
    }, context);
    const successor = await store.capture({
      title: `Current deployment window ${stamp}`,
      type: "claim",
      summary: "Agent inference: the deployment window moved to Thursday.",
      content: successorBody,
      evidence: [],
      links: [],
    }, context);
    const finalSuccessor = await store.capture({
      title: `Final deployment window ${marker}`,
      type: "claim",
      summary: "Agent inference: the deployment window moved again to Friday.",
      content: finalBody,
      evidence: [],
      links: [],
    }, context);
    // Insert oldest→middle first: a single order-dependent floor pass would
    // compare this pair before the middle is subsequently trimmed.
    await store.link({
      fromNodeId: successor.id,
      toNodeId: superseded.id,
      predicate: "supersedes",
      weight: 1,
    }, context);
    await store.link({
      fromNodeId: finalSuccessor.id,
      toNodeId: successor.id,
      predicate: "supersedes",
      weight: 1,
    }, context);

    for (const tokenBudget of [800, 1200, 4000]) {
      const pack = await store.recall({
        query: marker,
        tokenBudget,
        depth: 2,
        includeEvidence: false,
      }, context);
      const supersededAtom = pack.atoms.find((atom) => atom.node.id === superseded.id);
      const successorAtom = pack.atoms.find((atom) => atom.node.id === successor.id);
      const finalAtom = pack.atoms.find((atom) => atom.node.id === finalSuccessor.id);
      assert.ok(supersededAtom, `budget ${tokenBudget}: historical atom must remain available`);
      assert.ok(successorAtom, `budget ${tokenBudget}: successor must remain in the same pack`);
      assert.ok(finalAtom, `budget ${tokenBudget}: final successor must remain in the same pack`);
      assert.match(pack.context, new RegExp(`Legacy deployment window [^\\n]*SUPERSEDED by ${successor.title}`));
      assert.match(pack.context, new RegExp(`Current deployment window [^\\n]*SUPERSEDED by ${finalSuccessor.title}`));

      const supersededFidelity = (supersededAtom.node.content?.length ?? 0) / supersededBody.length;
      const successorFidelity = (successorAtom.node.content?.length ?? 0) / successorBody.length;
      const finalFidelity = (finalAtom.node.content?.length ?? 0) / finalBody.length;
      assert.ok(
        successorFidelity >= supersededFidelity,
        `budget ${tokenBudget}: successor fidelity ${successorFidelity.toFixed(3)} must be >= superseded fidelity ${supersededFidelity.toFixed(3)}`,
      );
      assert.ok(
        finalFidelity >= successorFidelity,
        `budget ${tokenBudget}: final fidelity ${finalFidelity.toFixed(3)} must be >= successor fidelity ${successorFidelity.toFixed(3)}`,
      );
      if (!supersededAtom.contentTruncated) {
        assert.equal(successorAtom.contentTruncated, false, "a full stale body requires a full successor body");
      }
      if (!successorAtom.contentTruncated) {
        assert.equal(finalAtom.contentTruncated, false, "a full middle body requires a full final successor body");
      }
    }
  });

  it("#4 reports a partial write when a requested annotation or link fails", async () => {
    const missingSlug = `missing-integrity-target-${stamp}`;
    const partial = await remember(store, {
      title: `Partial integrity write ${stamp}`,
      type: "claim",
      summary: "Agent inference: the node should land while its failed link remains visible.",
      evidence: [],
      links: [{ toSlug: missingSlug, predicate: "relates_to" }],
    }, context);

    assert.equal(partial.action, "created", "the durable node mutation still occurred");
    assert.equal(partial.complete, false, "a failed requested link must prevent a complete result");
    assert.equal(partial.linkRejected?.length, 1);
    assert.equal(partial.linkRejected?.[0]?.toSlug, missingSlug);
    assert.match(partial.linkRejected?.[0]?.reason ?? "", /not found|missing|unknown/i);
    const read = await store.read({ nodeId: partial.node.id }, context, { trackAccess: false });
    assert.ok(read, "the result must identify the partial node that actually landed");
  });

  it("#5 never spends more context tokens than the requested budget", async () => {
    const marker = `integritybudget${stamp}`;
    const hub = await store.capture({
      title: `Integrity budget hub ${marker}`,
      type: "pattern",
      summary: "Agent inference: a deliberately large recall-budget fixture.",
      content: `${marker} ${"large primary body for deterministic packing ".repeat(180)}`,
      evidence: [],
      links: [],
    }, context);
    for (const name of ["alpha", "bravo", "charlie"]) {
      const neighbor = await store.capture({
        title: `Integrity budget ${name} ${stamp}`,
        type: "pattern",
        summary: `Agent inference: ${name} is linked to the budget fixture.`,
        content: `${name} ${"linked body that competes for the same budget ".repeat(80)}`,
        evidence: [],
        links: [],
      }, context);
      await store.link({
        fromNodeId: hub.id,
        toNodeId: neighbor.id,
        predicate: "relates_to",
        weight: 1,
      }, context);
    }

    for (const tokenBudget of [300, 500, 800, 1200, 2000]) {
      const pack = await store.recall({
        query: marker,
        tokenBudget,
        depth: 1,
        includeEvidence: false,
      }, context);
      assert.ok(pack.atoms.some((atom) => atom.node.id === hub.id), `budget ${tokenBudget} must exercise atom packing`);
      assert.ok(
        pack.spentTokens <= tokenBudget,
        `budget ${tokenBudget}: spent ${pack.spentTokens} context tokens`,
      );
    }
  });
});
