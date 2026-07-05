import { createGraphStore } from "../src/createStore.js";
import { UserStore } from "../src/users.js";

// Per-user isolation is a property of the Postgres store (multi-user needs the
// app_user table); the in-memory store is single-user by construction.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("isolation test skipped (no DATABASE_URL; multi-user needs Postgres)");
  process.exit(0);
}

const { store, driver } = createGraphStore();
if (driver !== "postgres") {
  console.log(`isolation test skipped (driver=${driver})`);
  process.exit(0);
}

const users = new UserStore({ connectionString: databaseUrl });
const stamp = Date.now();
const MARK = `ISOLATIONMARK${stamp}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ctxFor(ownerId: string, tag: string) {
  return { actorId: `${tag}-smoke`, interfaceId: `${tag}-smoke`, requestId: `${tag}-${stamp}`, ownerId };
}

try {
  // Two distinct owners (active members) sharing one Trove deployment.
  const alice = await users.ensureUser({ clerkUserId: `iso-alice-${stamp}`, email: `alice-${stamp}@example.com` });
  const bob = await users.ensureUser({ clerkUserId: `iso-bob-${stamp}`, email: `bob-${stamp}@example.com` });
  assert(alice.id !== bob.id, "owners must be distinct");
  const A = ctxFor(alice.id, "iso-alice");
  const B = ctxFor(bob.id, "iso-bob");

  // --- Alice writes a small graph with unique markers -----------------------
  const aliceNode = await store.capture({
    title: `Alice secret ${MARK}`,
    type: "claim",
    summary: `Alice's private fact ${MARK}: the launch code is ${MARK}.`,
    content: `Only Alice should ever read ${MARK}.`,
    evidence: [],
    links: [],
  }, A);
  const aliceSource = await store.ingest({
    kind: "agent_note",
    title: `Alice source ${MARK}`,
    contentText: `Alice's raw evidence mentioning ${MARK} and nothing else.`,
    metadata: {},
  }, A);
  const aliceNode2 = await store.capture({
    title: `Alice neighbor ${MARK}`,
    type: "claim",
    summary: `A second Alice node ${MARK}.`,
    evidence: [],
    links: [],
  }, A);
  const aliceEdge = await store.link({ fromNodeId: aliceNode.id, toNodeId: aliceNode2.id, predicate: "relates_to", weight: 1 }, A);
  assert(aliceEdge, "Alice's link should create an edge");

  // --- Bob must not see any of it through any read path ---------------------
  const bobRecall = await store.recall({ query: `launch code ${MARK}`, tokenBudget: 2000 }, B);
  assert(!bobRecall.atoms.some((a) => a.node.id === aliceNode.id), "recall leaked Alice's node to Bob");

  const bobGrepNodes = await store.grep({ pattern: MARK, scope: "nodes", caseSensitive: false, limit: 50 }, B);
  assert(!bobGrepNodes.matches.some((m) => m.nodeId === aliceNode.id || m.nodeId === aliceNode2.id), "grep leaked Alice's nodes to Bob");
  const bobGrepSources = await store.grep({ pattern: MARK, scope: "sources", caseSensitive: false, limit: 50 }, B);
  assert(!bobGrepSources.matches.some((m) => m.sourceId === aliceSource.source.id), "grep leaked Alice's source to Bob");

  const bobSearch = await store.search({ query: MARK, includeTextUnits: true, mode: "lexical", limit: 50 }, B);
  assert(!bobSearch.nodes.some((n) => n.id === aliceNode.id), "search leaked Alice's node to Bob");
  assert(!bobSearch.textUnits.some((t) => t.sourceId === aliceSource.source.id), "search leaked Alice's text unit to Bob");

  assert((await store.read({ nodeId: aliceNode.id }, B)) === null, "read-by-id leaked Alice's node to Bob");
  assert((await store.read({ slug: aliceNode.slug }, B)) === null, "read-by-slug leaked Alice's node to Bob");
  assert((await store.readSource({ sourceId: aliceSource.source.id }, B)) === null, "readSource leaked Alice's source to Bob");

  const bobHood = await store.neighborhood({ nodeId: aliceNode.id, depth: 2, includeExpired: true }, B);
  assert(bobHood.nodes.length === 0 && bobHood.edges.length === 0, "neighborhood leaked Alice's subgraph to Bob");

  const bobGraph = await store.exportGraph(B);
  assert(!bobGraph.nodes.some((n) => n.id === aliceNode.id), "exportGraph leaked Alice's node to Bob");
  assert(!bobGraph.edges.some((e) => e.id === aliceEdge.id), "exportGraph leaked Alice's edge to Bob");

  let sawAliceEvent = false;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const feed = await store.events(cursor ? { afterCursor: cursor, limit: 200 } : { limit: 200 }, B);
    if (feed.events.some((e) => e.entityId === aliceNode.id || e.entityId === aliceSource.source.id)) sawAliceEvent = true;
    if (!feed.hasMore || !feed.nextCursor) break;
    cursor = feed.nextCursor;
  }
  assert(!sawAliceEvent, "events leaked Alice's mutations to Bob");

  // --- Bob cannot mutate Alice's data by id ---------------------------------
  const bobUpdate = await store.update({ nodeId: aliceNode.id, baseRevisionId: aliceNode.revisionId, summary: "hijacked" }, B);
  assert(bobUpdate === null, "Bob was able to update Alice's node");
  const bobInvalidate = await store.invalidateEdge({ edgeId: aliceEdge.id }, B);
  assert(bobInvalidate === null, "Bob was able to invalidate Alice's edge");

  // --- Alice still sees her own data ----------------------------------------
  const aliceReads = await store.read({ nodeId: aliceNode.id }, A);
  assert(aliceReads?.id === aliceNode.id, "Alice cannot read her own node");
  const aliceGrep = await store.grep({ pattern: MARK, scope: "all", caseSensitive: false, limit: 50 }, A);
  assert(aliceGrep.matches.some((m) => m.nodeId === aliceNode.id), "Alice cannot grep her own node");
  const aliceHood = await store.neighborhood({ nodeId: aliceNode.id, depth: 1 }, A);
  assert(aliceHood.edges.some((e) => e.id === aliceEdge.id), "Alice cannot see her own edge");

  // --- Superuser (maintenance / auth-disabled) sees everything --------------
  const superRead = await store.read({ nodeId: aliceNode.id }, { superuser: true });
  assert(superRead?.id === aliceNode.id, "superuser cannot read the node");
  const superGraph = await store.exportGraph({ superuser: true });
  assert(superGraph.nodes.some((n) => n.id === aliceNode.id), "superuser export missing the node");

  // --- Cross-owner dedup: Bob ingesting Alice's exact content gets his own ---
  const bobSource = await store.ingest({
    kind: "agent_note",
    title: `Alice source ${MARK}`,
    contentText: `Alice's raw evidence mentioning ${MARK} and nothing else.`,
    metadata: {},
  }, B);
  assert(bobSource.source.id !== aliceSource.source.id, "cross-owner ingest deduped into Alice's source row");
  const bobReadsOwnSource = await store.readSource({ sourceId: bobSource.source.id }, B);
  assert(bobReadsOwnSource?.id === bobSource.source.id, "Bob cannot read his own ingested source");

  console.log(`isolation tests passed (${driver})`);
  process.exit(0);
} catch (error) {
  console.error("isolation tests FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await users.close();
}
