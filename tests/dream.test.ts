import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/agentOps.js";
import { DREAM_PAGE_MARKER, newerSpanChangesValue, performDream } from "../src/dream.js";
import { jobResultAs } from "../src/jobResults.js";
import { UserStore } from "../src/users.js";
import { closeStore, hasPostgres, isolateDatabase, sleep, suiteStore } from "./helpers.js";

await isolateDatabase("dream");

describe("dream (offline consolidation)", () => {
  const { store, context, stamp } = suiteStore("dream");

  after(async () => {
    await closeStore(store);
  });

  it("detects a newer span that changes a note's number, and nothing looser", () => {
    const note = { title: "Falcon port", summary: "Falcon port is 8787", content: null };
    assert.equal(newerSpanChangesValue(note, "Falcon now listens on port 9090."), true);
    assert.equal(newerSpanChangesValue(note, "Falcon port is 8787, confirmed."), false, "same value");
    assert.equal(newerSpanChangesValue(note, "Heron port is 9090."), false, "different subject");
    assert.equal(newerSpanChangesValue(note, "Falcon port docs were rewritten."), false, "no number");
  });

  it("re-points a supersession that a later revision turned around", async () => {
    const marker = `dreamrevive${stamp}`;
    const original = await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} port is v1` }, context);
    const variant = await remember(store, { title: `port for ${marker}`, type: "claim", summary: `${marker} port is v2` }, context);
    const edge = await store.link({ fromSlug: variant.node.slug, toSlug: original.node.slug, predicate: "supersedes", weight: 1 }, context);
    assert.ok(edge);
    await sleep(15);
    await remember(store, { title: `${marker} port`, type: "claim", summary: `${marker} port is v3` }, context);

    const result = await performDream(store, { pages: false });
    const resolved = result.supersessionsResolved.find((entry) => entry.expiredEdgeId === edge.id);
    assert.ok(resolved, "the stale edge is replaced");
    assert.equal(resolved.currentNodeId, original.node.id);
    assert.equal(resolved.supersededNodeId, variant.node.id);

    const marks = await store.supersededBy([original.node.id, variant.node.id], context);
    assert.equal(marks.has(original.node.id), false, "the revised note reads as current");
    assert.equal(marks.get(variant.node.id)?.byNodeId, original.node.id, "the old successor is now the superseded one");
    const lint = await store.lint(context);
    assert.equal(lint.findings.some((finding) => finding.entityId === edge.id), false, "nothing left to curate");
  });

  it("leaves a supersession alone when both sides changed after it", async () => {
    const marker = `dreamboth${stamp}`;
    const original = await remember(store, { title: `${marker} owner`, type: "claim", summary: `${marker} owner is Platform` }, context);
    const variant = await remember(store, { title: `owner of ${marker}`, type: "claim", summary: `${marker} owner is Billing` }, context);
    const edge = await store.link({ fromSlug: variant.node.slug, toSlug: original.node.slug, predicate: "supersedes", weight: 1 }, context);
    assert.ok(edge);
    await sleep(15);
    await remember(store, { title: `${marker} owner`, type: "claim", summary: `${marker} owner is Growth` }, context);
    await remember(store, { title: `owner of ${marker}`, type: "claim", summary: `${marker} owner is Support` }, context);

    const result = await performDream(store, { pages: false });
    assert.ok(result.supersessionsAmbiguous.some((entry) => entry.edgeId === edge.id));
    assert.equal(result.supersessionsResolved.some((entry) => entry.expiredEdgeId === edge.id), false);
  });

  it("reports newer sources that disagree with a note and sources nobody cites", async () => {
    const marker = `dreamverify${stamp}`;
    await store.ingest({ kind: "agent_note", title: `${marker} log 1`, contentText: `Event: ${marker} gateway port is 8787.`, metadata: {} }, context);
    const note = await remember(store, {
      title: `${marker} gateway port`,
      type: "claim",
      summary: `${marker} gateway port is 8787`,
      evidence: [{ quote: `${marker} gateway port is 8787` }],
    }, context);
    await sleep(15);
    const later = await store.ingest({ kind: "agent_note", title: `${marker} log 2`, contentText: `Event: ${marker} gateway port moved to 9090.`, metadata: {} }, context);

    const result = await performDream(store, { pages: false, budget: 1000 });
    const conflict = result.newerSourceConflicts.find((entry) => entry.nodeId === note.node.id);
    assert.ok(conflict, "the newer span is reported against the note");
    assert.equal(conflict.sourceId, later.source.id);
    assert.ok(result.uncitedSources.count >= 1);
    const notes = await store.read({ nodeId: note.node.id }, context, { trackAccess: false });
    assert.equal(notes?.summary, `${marker} gateway port is 8787`, "verification never rewrites the note");
  });

  it("keeps one page per hub, quoting its current notes, and is idempotent", async () => {
    const marker = `dreampage${stamp}`;
    const hub = await remember(store, { title: `${marker} billing`, type: "project", summary: `The ${marker} billing project.` }, context);
    for (const [i, fact] of ["refunds within 30 days", "invoices monthly", "Stripe is the processor"].entries()) {
      await remember(store, {
        title: `${marker} billing fact ${i}`,
        type: "claim",
        summary: `${marker} ${fact}`,
        links: [{ toSlug: hub.node.slug, predicate: "part_of" }],
      }, context);
    }

    const first = await performDream(store, {});
    assert.ok(first.pages.written.includes(`${hub.node.slug}-page`));
    const page = await store.read({ slug: `${hub.node.slug}-page` }, context, { trackAccess: false });
    assert.ok(page);
    assert.ok(page.content?.startsWith(DREAM_PAGE_MARKER));
    assert.match(page.content ?? "", new RegExp(`${marker} refunds within 30 days`));

    const second = await performDream(store, {});
    assert.equal(second.pages.written.includes(`${hub.node.slug}-page`), false, "unchanged notes leave the page alone");
  });

  it("retires unused, unlinked, uncited notes only when asked", async () => {
    const marker = `dreamnoise${stamp}`;
    const noise = await remember(store, { title: `${marker} dashboard looked green`, type: "claim", summary: `${marker} panel was green.` }, context);
    const future = new Date(Date.now() + 10 * 86_400_000);

    const keep = await performDream(store, { pages: false, now: future });
    assert.equal(keep.retired.some((entry) => entry.nodeId === noise.node.id), false, "off by default");

    const retire = await performDream(store, { pages: false, now: future, retireAfterDays: 1 });
    assert.ok(retire.retired.some((entry) => entry.nodeId === noise.node.id));
    assert.equal(await store.read({ nodeId: noise.node.id }, context, { trackAccess: false }), null, "tombstoned out of reads");
  });

  it("is scheduled per owner only when TROVE_DREAM=1", { skip: !hasPostgres() }, async () => {
    const users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
    let ownerId: string;
    try {
      ownerId = (await users.ensureUser({ clerkUserId: `dream-owner-${stamp}`, email: `dream-owner-${stamp}@example.com` })).id;
    } finally {
      await users.close();
    }
    const ownerContext = { ...context, ownerId };
    const previous = process.env.TROVE_DREAM;
    try {
      delete process.env.TROVE_DREAM;
      await remember(store, { title: `dreamsched off ${stamp}`, type: "claim", summary: "scheduling stays off by default" }, ownerContext);
      let jobs = await store.jobs({ kind: "dream", limit: 50 }, ownerContext);
      assert.equal(jobs.some((job) => job.dedupeKey === `maintenance:dream:${ownerContext.ownerId}`), false);

      process.env.TROVE_DREAM = "1";
      await remember(store, { title: `dreamsched on ${stamp}`, type: "claim", summary: "now a dream is queued for this owner" }, ownerContext);
      jobs = await store.jobs({ kind: "dream", limit: 50 }, ownerContext);
      assert.ok(jobs.some((job) => job.dedupeKey === `maintenance:dream:${ownerContext.ownerId}` && job.status === "pending"));
    } finally {
      if (previous === undefined) delete process.env.TROVE_DREAM;
      else process.env.TROVE_DREAM = previous;
    }
  });

  it("runs as a durable job", async () => {
    const job = await store.enqueueJob({ kind: "dream", payload: { pages: false, budget: 5 }, priority: 1 }, context);
    const ran = await store.runJob({ jobId: job.id }, context);
    assert.equal(ran?.status, "succeeded", ran?.error ?? "dream job failed");
    const result = ran ? jobResultAs(ran, "dream") : null;
    assert.ok(result);
    assert.ok(result.checked <= 5);
  });
});
