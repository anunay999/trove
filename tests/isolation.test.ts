import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore } from "../src/createStore.js";
import { UserStore } from "../src/users.js";
import type { GraphStore } from "../src/graphCore.js";
import { closeStore } from "./helpers.js";

const databaseUrl = process.env.DATABASE_URL;

// Per-user isolation is a property of the Postgres store (multi-user needs the
// app_user table); the in-memory store is single-user by construction.
describe("per-user isolation", { skip: databaseUrl ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const MARK = `ISOLATIONMARK${stamp}`;
  const ctxFor = (ownerId: string, tag: string) => ({
    actorId: `${tag}-smoke`,
    interfaceId: `${tag}-smoke`,
    requestId: `${tag}-${stamp}`,
    ownerId,
  });

  let store: GraphStore;
  let users: UserStore;
  let A: ReturnType<typeof ctxFor>;
  let B: ReturnType<typeof ctxFor>;
  let aliceNode: Awaited<ReturnType<GraphStore["capture"]>>;
  let aliceNode2: Awaited<ReturnType<GraphStore["capture"]>>;
  let aliceSource: Awaited<ReturnType<GraphStore["ingest"]>>;
  let aliceEdge: NonNullable<Awaited<ReturnType<GraphStore["link"]>>>;

  before(async () => {
    const created = createGraphStore();
    store = created.store;
    users = new UserStore({ connectionString: databaseUrl! });

    const alice = await users.ensureUser({ clerkUserId: `iso-alice-${stamp}`, email: `alice-${stamp}@example.com` });
    const bob = await users.ensureUser({ clerkUserId: `iso-bob-${stamp}`, email: `bob-${stamp}@example.com` });
    assert.notEqual(alice.id, bob.id, "owners must be distinct");
    A = ctxFor(alice.id, "iso-alice");
    B = ctxFor(bob.id, "iso-bob");

    aliceNode = await store.capture({
      title: `Alice secret ${MARK}`,
      type: "claim",
      summary: `Alice's private fact ${MARK}: the launch code is ${MARK}.`,
      content: `Only Alice should ever read ${MARK}.`,
      evidence: [],
      links: [],
    }, A);
    aliceSource = await store.ingest({
      kind: "agent_note",
      title: `Alice source ${MARK}`,
      contentText: `Alice's raw evidence mentioning ${MARK} and nothing else.`,
      metadata: {},
    }, A);
    aliceNode2 = await store.capture({
      title: `Alice neighbor ${MARK}`,
      type: "claim",
      summary: `A second Alice node ${MARK}.`,
      evidence: [],
      links: [],
    }, A);
    const edge = await store.link({ fromNodeId: aliceNode.id, toNodeId: aliceNode2.id, predicate: "relates_to", weight: 1 }, A);
    assert.ok(edge, "Alice's link should create an edge");
    aliceEdge = edge;
  });

  after(async () => {
    if (users) await users.close();
    if (store) await closeStore(store);
  });

  it("hides Alice's nodes and sources from Bob's recall, grep, and search", async () => {
    const bobRecall = await store.recall({ query: `launch code ${MARK}`, tokenBudget: 2000 }, B);
    assert.ok(!bobRecall.atoms.some((a) => a.node.id === aliceNode.id), "recall leaked Alice's node to Bob");

    const bobGrepNodes = await store.grep({ pattern: MARK, scope: "nodes", caseSensitive: false, limit: 50 }, B);
    assert.ok(
      !bobGrepNodes.matches.some((m) => m.nodeId === aliceNode.id || m.nodeId === aliceNode2.id),
      "grep leaked Alice's nodes to Bob",
    );
    const bobGrepSources = await store.grep({ pattern: MARK, scope: "sources", caseSensitive: false, limit: 50 }, B);
    assert.ok(!bobGrepSources.matches.some((m) => m.sourceId === aliceSource.source.id), "grep leaked Alice's source to Bob");

    const bobSearch = await store.search({ query: MARK, includeTextUnits: true, mode: "lexical", limit: 50 }, B);
    assert.ok(!bobSearch.nodes.some((n) => n.id === aliceNode.id), "search leaked Alice's node to Bob");
    assert.ok(!bobSearch.textUnits.some((t) => t.sourceId === aliceSource.source.id), "search leaked Alice's text unit to Bob");
  });

  it("returns null for Bob's direct reads of Alice's data", async () => {
    assert.equal(await store.read({ nodeId: aliceNode.id }, B), null, "read-by-id leaked Alice's node to Bob");
    assert.equal(await store.read({ nodeId: aliceNode.id, asOf: new Date().toISOString() }, B), null, "historical read leaked Alice's node to Bob");
    assert.equal(await store.read({ slug: aliceNode.slug }, B), null, "read-by-slug leaked Alice's node to Bob");
    assert.equal(await store.readSource({ sourceId: aliceSource.source.id }, B), null, "readSource leaked Alice's source to Bob");

    const bobHood = await store.neighborhood({ nodeId: aliceNode.id, depth: 2, includeExpired: true }, B);
    assert.ok(bobHood.nodes.length === 0 && bobHood.edges.length === 0, "neighborhood leaked Alice's subgraph to Bob");
  });

  it("excludes Alice's data from Bob's export and event feed", async () => {
    const bobGraph = await store.exportGraph(B);
    assert.ok(!bobGraph.nodes.some((n) => n.id === aliceNode.id), "exportGraph leaked Alice's node to Bob");
    assert.ok(!bobGraph.edges.some((e) => e.id === aliceEdge.id), "exportGraph leaked Alice's edge to Bob");

    let sawAliceEvent = false;
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const feed = await store.events(cursor ? { afterCursor: cursor, limit: 200 } : { limit: 200 }, B);
      if (feed.events.some((e) => e.entityId === aliceNode.id || e.entityId === aliceSource.source.id)) sawAliceEvent = true;
      if (!feed.hasMore || !feed.nextCursor) break;
      cursor = feed.nextCursor;
    }
    assert.ok(!sawAliceEvent, "events leaked Alice's mutations to Bob");
  });

  it("prevents Bob from mutating Alice's data by id", async () => {
    const bobUpdate = await store.update({ nodeId: aliceNode.id, baseRevisionId: aliceNode.revisionId, summary: "hijacked" }, B);
    assert.equal(bobUpdate, null, "Bob was able to update Alice's node");
    const bobInvalidate = await store.invalidateEdge({ edgeId: aliceEdge.id }, B);
    assert.equal(bobInvalidate, null, "Bob was able to invalidate Alice's edge");
  });

  it("still lets Alice see her own data", async () => {
    const aliceReads = await store.read({ nodeId: aliceNode.id }, A);
    assert.equal(aliceReads?.id, aliceNode.id, "Alice cannot read her own node");
    const aliceGrep = await store.grep({ pattern: MARK, scope: "all", caseSensitive: false, limit: 50 }, A);
    assert.ok(aliceGrep.matches.some((m) => m.nodeId === aliceNode.id), "Alice cannot grep her own node");
    const aliceHood = await store.neighborhood({ nodeId: aliceNode.id, depth: 1 }, A);
    assert.ok(aliceHood.edges.some((e) => e.id === aliceEdge.id), "Alice cannot see her own edge");
  });

  it("gives each owner an independent slug namespace", async () => {
    const sharedTitle = `Shared project ${MARK}`;
    const aliceShared = await store.capture({ title: sharedTitle, type: "project", summary: `Alice's ${MARK}`, evidence: [], links: [] }, A);
    const bobShared = await store.capture({ title: sharedTitle, type: "project", summary: `Bob's ${MARK}`, evidence: [], links: [] }, B);
    assert.equal(aliceShared.slug, bobShared.slug, "both owners should get the same clean slug");
    assert.notEqual(aliceShared.id, bobShared.id, "same-slug nodes must be distinct rows");
    assert.equal((await store.read({ slug: aliceShared.slug }, A))?.id, aliceShared.id, "Alice's slug read must return Alice's node");
    assert.equal((await store.read({ slug: bobShared.slug }, B))?.id, bobShared.id, "Bob's slug read must return Bob's node");
  });

  it("lets a superuser see everything", async () => {
    const superRead = await store.read({ nodeId: aliceNode.id }, { superuser: true });
    assert.equal(superRead?.id, aliceNode.id, "superuser cannot read the node");
    const superGraph = await store.exportGraph({ superuser: true });
    assert.ok(superGraph.nodes.some((n) => n.id === aliceNode.id), "superuser export missing the node");
  });

  it("gives Bob his own row when he ingests Alice's exact content", async () => {
    const bobSource = await store.ingest({
      kind: "agent_note",
      title: `Alice source ${MARK}`,
      contentText: `Alice's raw evidence mentioning ${MARK} and nothing else.`,
      metadata: {},
    }, B);
    assert.notEqual(bobSource.source.id, aliceSource.source.id, "cross-owner ingest deduped into Alice's source row");
    assert.equal((await store.readSource({ sourceId: bobSource.source.id }, B))?.id, bobSource.source.id, "Bob cannot read his own ingested source");
  });
});
