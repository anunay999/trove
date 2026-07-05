import { createGraphStore } from "../src/createStore.js";
import { remember, forget, readAny } from "../src/agentOps.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "agent-ops-smoke",
  interfaceId: "agent-ops-smoke",
  requestId: `agent-ops-smoke-${stamp}`,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  // --- remember: creates a node when nothing matches ---
  const title = `Agent ops smoke fact ${stamp}`;
  const first = await remember(store, {
    title,
    type: "claim",
    summary: "Trove agent-ops smoke: the widget port is 9191.",
    content: "The widget service listens on port 9191.",
    evidence: [],
    links: [],
  }, context);
  assert(first.action === "created", `Expected created, got ${first.action}.`);
  const nodeId = first.node.id;

  // --- remember: same title routes to update, mints a new revision ---
  const second = await remember(store, {
    title,
    type: "claim",
    summary: "Trove agent-ops smoke: the widget port moved to 9292.",
    content: "The widget service listens on port 9292 after the migration.",
    evidence: [],
    links: [],
  }, context);
  assert(second.action === "updated", `Expected updated, got ${second.action}.`);
  assert(second.node.id === nodeId, "Update must target the existing node.");
  assert(second.node.revisionId !== first.node.revisionId, "Update must mint a new revision.");

  // --- remember: explicit slug target forces update ---
  const forced = await remember(store, {
    slug: second.node.slug,
    title,
    type: "claim",
    summary: "Trove agent-ops smoke: widget port confirmed 9292.",
    evidence: [],
    links: [],
  }, context);
  assert(forced.action === "updated" && forced.node.id === nodeId, "Slug-targeted remember must update in place.");

  // --- remember: near-but-not-exact title creates and reports similar ---
  const near = await remember(store, {
    title: `Smoke fact ${stamp}`,
    type: "claim",
    summary: "A related but distinct fact.",
    evidence: [],
    links: [],
  }, context);
  assert(near.action === "created", "Non-exact title must create, not merge.");
  assert(near.similar.some((s) => s.slug === second.node.slug), "Similar hits must surface the near-match.");

  // --- grep: finds nodes and source text lexically ---
  const ingested = await store.ingest({
    kind: "agent_note",
    title: `Agent ops grep source ${stamp}`,
    contentText: `Deploy notes.\n\nThe rollback flag is TROVE_ROLLBACK_${stamp} and nothing else mentions it.`,
    metadata: {},
  }, context);
  const grepHits = await store.grep({ pattern: `TROVE_ROLLBACK_${stamp}`, scope: "all", caseSensitive: false, limit: 20 });
  assert(grepHits.matches.some((m) => m.kind === "source" && m.sourceId === ingested.source.id), "Grep must find the source text unit.");
  const nodeGrep = await store.grep({ pattern: "widget service listens on port 9292", scope: "nodes", caseSensitive: false, limit: 20 });
  assert(nodeGrep.matches.some((m) => m.kind === "node" && m.nodeId === nodeId), "Grep must find node content.");
  assert(nodeGrep.matches.every((m) => typeof m.excerpt === "string" && m.excerpt.length > 0), "Grep matches must carry excerpts.");

  // --- grep: regex works, invalid regex falls back to literal ---
  const regexGrep = await store.grep({ pattern: `port 9[0-9]{3}`, scope: "nodes", caseSensitive: false, limit: 20 });
  assert(regexGrep.matches.some((m) => m.nodeId === nodeId), "Regex grep must match.");
  const literalGrep = await store.grep({ pattern: "port 9292 (", scope: "nodes", caseSensitive: false, limit: 20 });
  assert(Array.isArray(literalGrep.matches), "Invalid regex must not throw; falls back to literal.");

  // --- connect + forget: dryRun previews, apply retires ---
  const other = await remember(store, {
    title: `Agent ops smoke neighbor ${stamp}`,
    type: "claim",
    summary: "Neighbor node for forget smoke.",
    evidence: [],
    links: [],
  }, context);
  const edge = await store.link({
    fromNodeId: nodeId,
    toNodeId: other.node.id,
    predicate: "relates_to",
    weight: 1,
  }, context);
  assert(edge, "Link must create an edge.");

  const preview = await forget(store, { query: title, dryRun: true }, context);
  assert(preview.dryRun === true, "Query forget defaults to dry run.");
  assert(preview.edges.some((e) => e.edgeId === edge.id), "Dry run must list the candidate edge.");
  assert(preview.retired === 0, "Dry run must not retire anything.");

  const applied = await forget(store, { edgeIds: [edge.id] }, context);
  assert(applied.dryRun === false, "Explicit edgeIds default to applying.");
  assert(applied.retired === 1, `Expected 1 retired edge, got ${applied.retired}.`);
  const afterNeighborhood = await store.neighborhood({ nodeId, depth: 1, includeExpired: false });
  assert(!afterNeighborhood.edges.some((e) => e.id === edge.id), "Retired edge must leave the active neighborhood.");
  const withExpired = await store.neighborhood({ nodeId, depth: 1, includeExpired: true });
  assert(withExpired.edges.some((e) => e.id === edge.id), "Retired edge must remain in history.");

  // --- readAny: dispatches to node by slug and source by id ---
  const readNode = await readAny(store, { slug: second.node.slug });
  assert(readNode && readNode.kind === "node" && readNode.node?.id === nodeId, "readAny must resolve nodes by slug.");
  const readSource = await readAny(store, { id: ingested.source.id });
  assert(readSource && readSource.kind === "source" && readSource.source?.id === ingested.source.id, "readAny must fall through to sources by id.");
  const readMissing = await readAny(store, { id: "00000000-0000-0000-0000-000000000000" });
  assert(readMissing === null, "readAny must return null for unknown ids.");

  console.log(`agent-ops tests passed (${driver})`);
  process.exit(0);
} catch (error) {
  console.error("agent-ops tests FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
