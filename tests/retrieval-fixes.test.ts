import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { suiteStore, closeStore, hasPostgres, sleep, isolateDatabase } from "./helpers.js";
import type { GraphJob, GraphOperationContext } from "../src/graphCore.js";
import { FakeEmbeddingProvider, cosineSimilarity } from "../src/embeddings.js";
import { normalizeRetrievalQuery } from "../src/queryNormalize.js";
import { UserStore } from "../src/users.js";

// Self-contained semantic behavior: the deterministic offline provider runs in
// both store modes and the default distance floor (0.55) applies.
process.env.TROVE_EMBEDDING_PROVIDER = "fake";
delete process.env.TROVE_SEMANTIC_MAX_DISTANCE;

// This suite runs many captures and asserts on queue state; it gets its own
// database so it can neither break nor be broken by concurrent suites.
await isolateDatabase("retrieval-fixes");

const { store, driver, context, stamp } = suiteStore("retrieval-fixes");

/** Run claimable maintenance jobs (pg: this is what writes embeddings). Only
 * touches shared maintenance rows and this suite's own jobs. */
async function drainJobs(limit = 200): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const pending = (await store.jobs({ status: "pending", limit: 100 }))
      .filter((job) => job.dedupeKey?.startsWith("maintenance:") || job.dedupeKey?.startsWith("retrieval-fixes:"));
    const next = pending[0];
    if (!next) break;
    await store.runJob({ jobId: next.id });
  }
}

/** Push a job's last-update past any retry backoff. */
async function ageJob(jobId: string): Promise<void> {
  if (driver === "postgres") {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("update graph_job set updated_at = now() - interval '2 days' where id = $1", [jobId]);
    } finally {
      await client.end();
    }
    return;
  }
  const jobs = (store as unknown as { graphJobs: Map<string, GraphJob> }).graphJobs;
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, updatedAt: new Date(Date.now() - 172_800_000).toISOString() });
}

after(async () => {
  // Leave no claimable jobs behind: sibling pg suites share this database and
  // some assert on global pending counts.
  await drainJobs();
  await closeStore(store);
});

describe("retrieval fixes", () => {
  it("fake provider: deterministic, cosine-meaningful, offline", async () => {
    const provider = new FakeEmbeddingProvider();
    const [first, second] = await provider.embed(["alpha beta gamma", "alpha beta gamma"]);
    assert.deepEqual(first, second, "same input must yield the same vector");
    assert.equal(first?.length, 1536);

    const [query, shared, disjoint] = await provider.embed([
      "alpha beta",
      "alpha beta gamma",
      "xyz wuv qrs",
    ]);
    const sharedCosine = cosineSimilarity(query ?? [], shared ?? []);
    const disjointCosine = cosineSimilarity(query ?? [], disjoint ?? []);
    assert.ok(sharedCosine > 0.5, `shared-token texts should be close, got ${sharedCosine}`);
    assert.ok(disjointCosine < 0.2, `disjoint texts should be far, got ${disjointCosine}`);
    await assert.rejects(() => provider.embed([""]));
  });

  it("F4: trackAccess:false, revise read-backs, and recall do not bump activation", async () => {
    const marker = `actprobe${stamp}`;
    const node = await store.capture({
      title: `Activation probe ${stamp}`,
      type: "claim",
      summary: `activation tracking probe ${marker}`,
      content: `content for ${marker} activation probe`,
      evidence: [],
      links: [],
    }, context);
    assert.equal(node.accessCount, 0, "capture's internal read-back must not bump");

    const tracked = await store.read({ nodeId: node.id }, context);
    assert.equal(tracked?.accessCount, 1, "default reads still bump activation");
    await store.read({ nodeId: node.id }, context, { trackAccess: false });
    const untracked = await store.read({ nodeId: node.id }, context, { trackAccess: false });
    assert.equal(untracked?.accessCount, 1, "trackAccess:false must not bump");

    const revised = await store.update({
      nodeId: node.id,
      baseRevisionId: tracked?.revisionId ?? "",
      content: `revised ${marker} content`,
    }, context);
    assert.ok(revised && !("conflict" in revised), "revise failed");
    assert.equal(revised.accessCount, 1, "update's internal read-back must not bump");
    const afterRevise = await store.read({ nodeId: node.id }, context, { trackAccess: false });
    assert.equal(afterRevise?.accessCount, 1);

    await store.recall({ query: marker, tokenBudget: 2000 });
    const afterRecall = await store.read({ nodeId: node.id }, context, { trackAccess: false });
    assert.equal(afterRecall?.accessCount, 1, "recall must not bump access activation");
    await drainJobs();
  });

  it("F5: semantic search floors unrelated queries to zero hits", async () => {
    const marker = `semfloor${stamp}`;
    const node = await store.capture({
      title: `Semantic floor ${stamp}`,
      type: "claim",
      summary: `quasar bakery lighthouse ${marker}`,
      content: `quasar bakery lighthouse ${marker} signal`,
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const control = await store.search({
      query: "quasar bakery lighthouse",
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
    });
    assert.ok(control.nodes.some((candidate) => candidate.id === node.id), "control: matching query should find the node");

    const hits = await store.search({
      query: "zzzqxv wrench nebula unrelated",
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
    });
    assert.equal(hits.nodes.length, 0, "unrelated query must return no semantic hits");
  });

  it("F6: stop-word-only queries return no lexical hits", async () => {
    await store.capture({
      title: `Stop word ${stamp}`,
      type: "claim",
      summary: "the summary",
      content: "the content the",
      evidence: [],
      links: [],
    }, context);
    const hits = await store.search({ query: "the", includeTextUnits: true, mode: "lexical", limit: 10 });
    assert.equal(hits.nodes.length, 0, "'the' must not match nodes via ilike fallback");
    assert.equal(hits.textUnits.length, 0, "'the' must not match text units via ilike fallback");
    await drainJobs();
  });

  it("F7: hybrid fusion (RRF) ranks a semantic-relevant node above weak lexical hits", async () => {
    // Weak lexical: title substring-matches "mercur" but stems to 'mercuri',
    // so no tsquery hit — it ranks only via the 0.2 title ilike boost.
    const weak = await store.capture({
      title: `Mercury ops handbook ${stamp}`,
      type: "pattern",
      summary: "procedures",
      content: "plain procedures",
      evidence: [],
      links: [],
    }, context);
    // Semantic-strong: exact token "mercur" dominates its embedded text; its
    // lexical rank stays below the weak title hit (no title match, ~0.1).
    const strong = await store.capture({
      title: `Anchor ${stamp}`,
      type: "pattern",
      summary: "mercur",
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const hybrid = await store.search({ query: "mercur", includeTextUnits: false, mode: "hybrid", limit: 10 });
    const ids = hybrid.nodes.map((candidate) => candidate.id);
    const weakIndex = ids.indexOf(weak.id);
    const strongIndex = ids.indexOf(strong.id);
    assert.notEqual(weakIndex, -1, "weak lexical hit missing from hybrid results");
    assert.notEqual(strongIndex, -1, "semantic-relevant node missing from hybrid results");
    assert.ok(
      strongIndex < weakIndex,
      `RRF must rank the semantic-relevant node first (${strongIndex} vs ${weakIndex}); concat fusion would pin it behind`,
    );
  });

  it("F8: giant nodes are excluded from search unless the query hits title or slug", async () => {
    const marker = `needleword${stamp}`;
    const filler = "padding filler words ".repeat(900); // ~19k chars > 12k
    const giant = await store.capture({
      title: `Giant catalog ${stamp}`,
      type: "entity",
      summary: "catalog",
      content: `${marker} ${filler}`,
      evidence: [],
      links: [],
    }, context);
    assert.ok((giant.content?.length ?? 0) > 12_000, "fixture must be a giant node");
    const normal = await store.capture({
      title: `Normal note ${stamp}`,
      type: "claim",
      summary: "plain",
      content: `a note containing ${marker} once`,
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const contentQuery = await store.search({ query: marker, includeTextUnits: false, mode: "lexical", limit: 10 });
    assert.ok(contentQuery.nodes.some((candidate) => candidate.id === normal.id), "normal node should match its content");
    assert.ok(!contentQuery.nodes.some((candidate) => candidate.id === giant.id), "giant node must be excluded on a content match");

    const titleQuery = await store.search({ query: `Giant catalog ${stamp}`, includeTextUnits: false, mode: "lexical", limit: 10 });
    assert.ok(titleQuery.nodes.some((candidate) => candidate.id === giant.id), "giant node must surface on a title match");

    // The giant's embedding is nearly identical to this query (same repeated
    // tokens) — without the exclusion it would rank first semantically.
    const semanticQuery = await store.search({
      query: `${marker} padding filler words`,
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
    });
    assert.ok(!semanticQuery.nodes.some((candidate) => candidate.id === giant.id), "giant node must be excluded from semantic search");
  });

  it("F11: neighborhood caps nodes, reports BFS level, and filters edges by validAt", async () => {
    const root = await store.capture({ title: `F11 root ${stamp}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
    const chain = await store.capture({ title: `F11 chain ${stamp}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
    const leaf = await store.capture({ title: `F11 leaf ${stamp}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
    await store.link({ fromNodeId: root.id, toNodeId: chain.id, predicate: "f11_link", weight: 1 }, context);
    await store.link({ fromNodeId: chain.id, toNodeId: leaf.id, predicate: "f11_link", weight: 1 }, context);
    for (let index = 0; index < 6; index += 1) {
      const fan = await store.capture({ title: `F11 fan ${stamp} ${index}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
      await store.link({ fromNodeId: root.id, toNodeId: fan.id, predicate: "f11_fan", weight: 1 }, context);
    }

    const full = await store.neighborhood({ nodeId: root.id, depth: 2 });
    const byId = new Map(full.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get(root.id)?.level, 0, "seed is level 0");
    assert.equal(byId.get(chain.id)?.level, 1, "direct neighbor is level 1");
    assert.equal(byId.get(leaf.id)?.level, 2, "second-degree neighbor is level 2");

    const capped = await store.neighborhood({ nodeId: root.id, depth: 1, maxNodes: 3 });
    assert.equal(capped.nodes.length, 3, "maxNodes must cap total nodes");
    assert.equal(capped.nodes[0]?.id, root.id, "cap ordering is level-then-id: the seed comes first");
    assert.ok(capped.nodes.every((node) => typeof node.level === "number"));

    const past = await store.capture({ title: `F11 past ${stamp}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
    const future = await store.capture({ title: `F11 future ${stamp}`, type: "domain", summary: "s", content: "c", evidence: [], links: [] }, context);
    await store.link({ fromNodeId: root.id, toNodeId: past.id, predicate: "f11_time", weight: 1, validFrom: "2020-01-01T00:00:00.000Z" }, context);
    await store.link({ fromNodeId: root.id, toNodeId: future.id, predicate: "f11_time", weight: 1, validFrom: "2030-01-01T00:00:00.000Z" }, context);
    const atTime = await store.neighborhood({ nodeId: root.id, depth: 1, validAt: "2025-06-01T00:00:00.000Z" });
    const atIds = new Set(atTime.nodes.map((node) => node.id));
    assert.ok(atIds.has(past.id), "edge valid at t must be traversable");
    assert.ok(!atIds.has(future.id), "edge not yet valid at t must be skipped");
    assert.ok(!atTime.edges.some((edge) => edge.fromNodeId === future.id || edge.toNodeId === future.id));
    await drainJobs();
  });

  it("F9: concurrent same-title captures all resolve without unique violations", async () => {
    const title = `Concurrent capture ${stamp}`;
    const actors = ["actor-a", "actor-b", "actor-c", "actor-d"].map((actorId) => ({
      ...context,
      actorId: `${actorId}-${stamp}`,
    }));
    const nodes = await Promise.all(actors.map((actorContext) => store.capture({
      title,
      type: "claim",
      summary: "concurrent slug race probe",
      content: "same title, different actor",
      evidence: [],
      links: [],
    }, actorContext)));
    assert.equal(new Set(nodes.map((node) => node.id)).size, 4);
    assert.equal(new Set(nodes.map((node) => node.slug)).size, 4, "each capture must land a distinct slug");
    await drainJobs();
  });

  it("F2: tombstone removes a node from every read path, idempotently", async () => {
    const marker = `tombmark${stamp}`;
    const doomed = await store.capture({
      title: `Tombstone target ${stamp}`,
      type: "claim",
      summary: `${marker} summary`,
      content: `${marker} content`,
      evidence: [],
      links: [],
    }, context);
    const neighbor = await store.capture({ title: `Tombstone neighbor ${stamp}`, type: "claim", summary: "s", content: "c", evidence: [], links: [] }, context);
    await store.link({ fromNodeId: neighbor.id, toNodeId: doomed.id, predicate: "tomb_link", weight: 1 }, context);
    await drainJobs();
    const before = await store.search({ query: marker, includeTextUnits: false, mode: "lexical", limit: 10 });
    assert.ok(before.nodes.some((candidate) => candidate.id === doomed.id), "fixture node should be findable");

    const result = await store.tombstoneNodes([doomed.id], context);
    assert.deepEqual(result.tombstoned, [doomed.id]);

    assert.equal(await store.read({ nodeId: doomed.id }, context), null, "tombstoned node must not read");
    const afterSearch = await store.search({ query: marker, includeTextUnits: false, mode: "lexical", limit: 10 });
    assert.ok(!afterSearch.nodes.some((candidate) => candidate.id === doomed.id), "tombstoned node must not search");
    const grep = await store.grep({ pattern: marker, scope: "nodes", limit: 10 }, context);
    assert.ok(!grep.matches.some((match) => match.nodeId === doomed.id), "tombstoned node must not grep");
    const hood = await store.neighborhood({ nodeId: neighbor.id, depth: 1 }, context);
    assert.ok(!hood.nodes.some((node) => node.id === doomed.id), "tombstoned node must not appear in neighborhoods");
    assert.equal(hood.edges.length, 0, "incident edges must be expired");

    const again = await store.tombstoneNodes([doomed.id], context);
    assert.deepEqual(again.tombstoned, [], "second tombstone must be a no-op");

    await drainJobs();
    const semanticHits = await store.search({ query: `${marker} content`, includeTextUnits: false, mode: "semantic", limit: 10 });
    assert.ok(!semanticHits.nodes.some((candidate) => candidate.id === doomed.id), "tombstoned node must not surface semantically");
  });

  it("F12a: lint job results carry the findings array", async () => {
    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: {},
      priority: 50,
      dedupeKey: `retrieval-fixes:lint:${stamp}`,
    }, context);
    // A sibling suite's worker may claim the job first; poll until it finishes.
    let done = await store.runJob({ jobId: job.id }, context);
    for (let attempt = 0; done?.status !== "succeeded" && attempt < 50; attempt += 1) {
      await sleep(25);
      done = await store.runJob({ jobId: job.id }, context);
    }
    assert.equal(done?.status, "succeeded");
    const lint = done?.result?.lint as { findings?: unknown } | undefined;
    assert.ok(lint && Array.isArray(lint.findings), "lint job result must include a findings array");
    assert.ok((lint.findings as unknown[]).length > 0, "findings should not be empty");
    await drainJobs();
  });

  it("F12b: captures no longer auto-enqueue the obsidian projection job", async () => {
    await drainJobs();
    // Owner-scoped so the event feed only carries this capture's jobs (pg
    // owner_id references app_user, so register a real user there).
    let scoped: GraphOperationContext = context;
    if (hasPostgres()) {
      const users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
      try {
        const user = await users.ensureUser({ clerkUserId: `rf-projection-${stamp}`, email: `rf-projection-${stamp}@example.com` });
        scoped = { ...context, ownerId: user.id };
      } finally {
        await users.close();
      }
    }
    await store.capture({
      title: `Projection enqueue probe ${stamp}`,
      type: "claim",
      summary: "s",
      content: "c",
      evidence: [],
      links: [],
    }, scoped);
    const feed = await store.events({ limit: 100 }, scoped);
    const enqueuedIds = new Set(
      feed.events.filter((event) => event.action === "enqueue_job").map((event) => event.entityId),
    );
    const listed = await store.jobs({ limit: 500 });
    const kinds = new Set(listed.filter((job) => enqueuedIds.has(job.id)).map((job) => job.kind));
    assert.ok(kinds.has("lint_graph"), "capture should still enqueue lint_graph");
    assert.ok(!kinds.has("refresh_obsidian_projection"), "projection must not be auto-enqueued");
    await drainJobs();
  });

  it("F12c: failed jobs retry with backoff and dead-letter at five attempts", async (t) => {
    const patched = store as unknown as { performJob: (job: GraphJob) => unknown };
    const original = patched.performJob;
    patched.performJob = () => {
      throw new Error("boom");
    };
    t.after(() => {
      patched.performJob = original;
    });

    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: {},
      // Priority 0: a sibling suite's worker always prefers other jobs, so it
      // cannot steal a retry cycle between aging and claiming.
      priority: 0,
      dedupeKey: `retrieval-fixes:dead:${stamp}`,
    }, context);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await ageJob(job.id);
      const result = await store.runJob({ jobId: job.id }, context);
      assert.equal(result?.attempts, attempt, `attempt ${attempt} should have run`);
      if (attempt < 5) {
        assert.equal(result?.status, "failed", `attempt ${attempt} should fail but stay retryable`);
      } else {
        assert.equal(result?.status as string, "dead", "the fifth failure must dead-letter");
      }
    }
    const again = await store.runJob({ jobId: job.id }, context);
    assert.equal(again?.attempts, 5, "a dead job must never be reclaimed");
    assert.equal(again?.status as string, "dead");
  });

  it("F1: semantic search never resurrects superseded revisions and never duplicates a node", { skip: !hasPostgres() }, async () => {
    const marker = `franken${stamp}`;
    const node = await store.capture({
      title: `Franken node ${stamp}`,
      type: "claim",
      summary: "semantic prune probe",
      content: `zephyrus oldphrase ${marker} one two`,
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const revised = await store.update({
      nodeId: node.id,
      baseRevisionId: node.revisionId,
      content: `completely different replacement text ${marker}`,
    }, context);
    assert.ok(revised && !("conflict" in revised), "revise failed");
    await drainJobs();

    const oldPhrase = await store.search({
      query: `zephyrus oldphrase ${marker}`,
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
    });
    assert.equal(
      oldPhrase.nodes.filter((candidate) => candidate.id === node.id).length,
      0,
      "deleted-phrase query must not hit the superseded revision",
    );

    const current = await store.search({
      query: `completely different replacement text ${marker}`,
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
    });
    assert.equal(
      current.nodes.filter((candidate) => candidate.id === node.id).length,
      1,
      "current-phrase query must hit the node exactly once",
    );
  });

  it("batched evidence fetch: unranked returns all, ranked caps and orders by relevance", async () => {
    const marker = `zorble${stamp}`;
    const lines = [
      "# Evidence doc",
      `${marker} caching improves throughput`,
      "plain filler line alpha",
      "plain filler line beta",
      "plain filler line gamma",
      "plain filler line delta",
      "plain filler line epsilon",
      "plain filler line zeta",
    ];
    const ingested = await store.ingest({
      kind: "agent_note",
      title: `Evidence doc ${stamp}`,
      contentText: lines.join("\n"),
      metadata: {},
    }, context);
    assert.equal(ingested.textUnits.length, lines.length, "fixture should produce one unit per line");
    const node = await store.capture({
      title: `Evidence probe ${stamp}`,
      type: "claim",
      summary: "s",
      content: "c",
      evidence: ingested.textUnits.map((unit) => ({ textUnitId: unit.id, selector: {} })),
      links: [],
    }, context);

    const all = await store.getEvidenceForNodes([node.id], context);
    assert.equal(all.get(node.id)?.length, ingested.textUnits.length, "unranked fetch returns every unit");

    const detail = await store.read({ nodeId: node.id }, context);
    assert.equal(detail?.evidence.length, ingested.textUnits.length, "read must assemble the same evidence without per-unit queries");

    const ranked = await store.getEvidenceForNodes([node.id], context, { query: `${marker} caching` });
    const rankedUnits = ranked.get(node.id) ?? [];
    assert.ok(rankedUnits.length <= 5, "ranked fetch defaults to at most 5 units per node");
    assert.ok(rankedUnits[0]?.text.includes(marker), "best-matching unit must rank first");

    const capped = await store.getEvidenceForNodes([node.id], context, { query: `${marker} caching`, perNodeLimit: 2 });
    assert.equal(capped.get(node.id)?.length, 2);
    await drainJobs();
  });

  it("NL0: normalizeRetrievalQuery strips question scaffolding, keeps content terms", () => {
    assert.equal(normalizeRetrievalQuery("How many weddings have I attended in this year?"), "weddings attended year");
    assert.equal(normalizeRetrievalQuery("What is the refund policy for annual plans?"), "refund policy annual plans");
    assert.equal(normalizeRetrievalQuery("events in 2024"), "events 2024", "numerals survive");
    assert.equal(normalizeRetrievalQuery("the"), "the", "stop-word-only queries fall back to the original so the empty-tsquery guard still fires");
  });

  it("NL1: a natural-language question retrieves the answering node (bench finding 1)", async () => {
    // The LongMemEval pilot: this exact question returned 0 across lexical,
    // semantic, and hybrid against a 291-atom container that held the answer.
    const wedding = await store.capture({
      title: `Traditional Nepali Dishes at Weddings ${stamp}`,
      type: "claim",
      summary: "wedding food notes",
      content: "I attended my sister's wedding this year; the Nepali dishes were outstanding.",
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const question = "How many weddings have I attended in this year?";
    const lexical = await store.search({ query: question, includeTextUnits: false, mode: "lexical", limit: 10 });
    assert.ok(
      lexical.nodes.some((node) => node.id === wedding.id),
      "lexical must find the answering node from a natural-language question",
    );
  });

  it("NL2: OR-fallback fires when no node holds every query term", async () => {
    const wedding = await store.capture({
      title: `Weddings recap ${stamp}`,
      type: "claim",
      summary: "family",
      content: "the weddings were lovely",
      evidence: [],
      links: [],
    }, context);
    const kube = await store.capture({
      title: `Kubernetes runbook ${stamp}`,
      type: "claim",
      summary: "ops",
      content: "kubernetes pod eviction runbook",
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    // "weddings kubernetes" co-occurs in no node: AND misses, OR must return both.
    const hits = await store.search({ query: "weddings kubernetes", includeTextUnits: false, mode: "lexical", limit: 10 });
    const ids = hits.nodes.map((node) => node.id);
    assert.ok(ids.includes(wedding.id), "OR-fallback should return the weddings node");
    assert.ok(ids.includes(kube.id), "OR-fallback should return the kubernetes node");
  });

  it("NL3: recall packs atoms for a natural-language question", async () => {
    const wedding = await store.capture({
      title: `Wedding attendance log ${stamp}`,
      type: "claim",
      summary: "weddings attended this year",
      content: "This year I attended two weddings: my sister's in June and a colleague's in September.",
      evidence: [],
      links: [],
    }, context);
    await drainJobs();

    const pack = await store.recall({ query: "How many weddings have I attended in this year?", tokenBudget: 2000 });
    assert.ok(pack.atoms.length > 0, "recall must not return an empty pack for a natural-language question");
    assert.ok(
      pack.atoms.some((atom) => atom.node.id === wedding.id),
      "recall should pack the answering node",
    );
  });
});
