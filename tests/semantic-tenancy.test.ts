import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { GraphOperationContext } from "../src/graphCore.js";
import { PgGraphStore } from "../src/pgStore.js";
import { isolateDatabase, hasPostgres } from "./helpers.js";

/**
 * Vectors have an owner. The embedding table is polymorphic (owner_table /
 * owner_id name the owning ROW) with no tenant of its own, and the semantic arm
 * used to probe the HNSW index for a fixed candidate window across every
 * tenant and filter by owner afterwards. With one owner holding ~70k of 72k
 * vectors in production, a second tenant's semantic search came back short —
 * usually empty. These tests build that shape in miniature: tenant A's rows are
 * strictly closer to the query than tenant B's, and there are more of them than
 * the candidate window, so any filter-after-the-window design returns nothing
 * for B.
 */

process.env.TROVE_EMBEDDING_PROVIDER = "fake";
await isolateDatabase("semantic_tenancy");

const QUERY = "quorum ledger reconciliation cadence";
const LARGE_TENANT_ROWS = 210;

let ownerA = "";
let ownerB = "";
let ctxA: GraphOperationContext;
let ctxB: GraphOperationContext;

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function insertOwner(email: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query(
      "insert into app_user (clerk_user_id, email, status) values ($1, $2, 'active') returning id",
      [`test-${email}`, email],
    );
    return String(result.rows[0].id);
  });
}

describe("semantic search under many tenants", { skip: !hasPostgres() }, () => {
  const store = new PgGraphStore({ connectionString: process.env.DATABASE_URL as string });
  const nodeIdsB: string[] = [];
  const unitIdsB: string[] = [];

  const drain = async (ownerId: string, tag: string): Promise<void> => {
    const job = await store.enqueueJob({
      kind: "refresh_embeddings",
      payload: { reason: "tenancy_test", ownerId, limit: 1000 },
      priority: 40,
      dedupeKey: `tenancy:${tag}:${ownerId}`,
    }, ctxA);
    const done = await store.runJob({ jobId: job.id }, ctxA);
    assert.equal(done?.status, "succeeded", `refresh_embeddings for ${tag} did not succeed`);
  };

  before(async () => {
    // At a few hundred rows the planner answers exactly from a sequential scan
    // and the starvation never shows. Production answers from the HNSW index,
    // whose scan stops at hnsw.ef_search candidates unless told to iterate —
    // so this suite's database plans the way production does.
    await withClient(async (client) => {
      const name = String((await client.query("select current_database() as db")).rows[0].db);
      await client.query(`alter database "${name}" set enable_seqscan = off`);
    });
    ownerA = await insertOwner("large@example.com");
    ownerB = await insertOwner("small@example.com");
    ctxA = { actorId: "tenancy-test", interfaceId: "tenancy-test", ownerId: ownerA };
    ctxB = { actorId: "tenancy-test", interfaceId: "tenancy-test", ownerId: ownerB };

    // A's notes are the query plus one token; B's carry three foreign tokens,
    // so under the deterministic provider every A vector is nearer the query.
    for (let index = 0; index < LARGE_TENANT_ROWS; index += 1) {
      await store.capture({
        title: `${QUERY} ${index}`,
        type: "claim",
        summary: QUERY,
        content: QUERY,
        evidence: [],
        links: [],
      }, ctxA);
    }
    for (let index = 0; index < 5; index += 1) {
      const node = await store.capture({
        title: `${QUERY} beta ${index}`,
        type: "claim",
        summary: `${QUERY} beta filler`,
        content: `${QUERY} beta filler words`,
        evidence: [],
        links: [],
      }, ctxB);
      nodeIdsB.push(node.id);
    }

    const paragraphsA = Array.from({ length: LARGE_TENANT_ROWS }, (_, index) => `${QUERY} paragraph ${index}`);
    await store.ingest({ kind: "agent_note", title: "Large tenant source", contentText: paragraphsA.join("\n\n"), metadata: {} }, ctxA);
    const ingestedB = await store.ingest({
      kind: "agent_note",
      title: "Small tenant source",
      contentText: Array.from({ length: 5 }, (_, index) => `${QUERY} beta filler words ${index}`).join("\n\n"),
      metadata: {},
    }, ctxB);
    unitIdsB.push(...ingestedB.textUnits.map((unit) => unit.id));
    assert.equal(unitIdsB.length, 5, "expected five text units for the small tenant");

    await drain(ownerA, "large");
    await drain(ownerB, "small");
  });

  after(async () => {
    await store.close();
  });

  it("a small tenant's node search returns its whole result set beside a large one", async () => {
    const result = await store.search({
      query: QUERY,
      includeTextUnits: false,
      mode: "semantic",
      limit: 10,
      maxSemanticDistance: 1.0,
    }, ctxB);
    const ids = result.nodes.map((node) => node.id).sort();
    assert.deepEqual(ids, [...nodeIdsB].sort(), `expected all five of B's notes, got ${ids.length}`);
  });

  it("a small tenant's text-unit search returns its whole result set beside a large one", async () => {
    const result = await store.search({
      query: QUERY,
      includeTextUnits: true,
      mode: "semantic",
      limit: 10,
      maxSemanticDistance: 1.0,
    }, ctxB);
    const ids = result.textUnits.map((unit) => unit.id).sort();
    assert.deepEqual(ids, [...unitIdsB].sort(), `expected all five of B's text units, got ${ids.length}`);
  });

  it("the large tenant still sees only its own rows, capped at the limit", async () => {
    const result = await store.search({
      query: QUERY,
      includeTextUnits: true,
      mode: "semantic",
      limit: 10,
      maxSemanticDistance: 1.0,
    }, ctxA);
    assert.equal(result.nodes.length, 10);
    assert.equal(result.textUnits.length, 10);
    assert.ok(result.nodes.every((node) => !nodeIdsB.includes(node.id)), "B's notes leaked into A's search");
    assert.ok(result.textUnits.every((unit) => !unitIdsB.includes(unit.id)), "B's units leaked into A's search");
  });

  it("the store turns on hnsw.iterative_scan for the probes, on their own connection", async () => {
    // At this fixture's size the planner answers scoped probes exactly, so the
    // SET cannot be observed through results here; tests/query-plans.test.ts
    // shows it is what fills a scoped limit once HNSW is chosen. This checks
    // the store actually issues it, on the connection that runs the probes.
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const connect = pool.connect.bind(pool);
    const statements: string[] = [];
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        statements.push(String(args[0]));
        return (query as (...inner: unknown[]) => unknown)(...args);
      };
      return client;
    };
    try {
      await store.search({ query: QUERY, includeTextUnits: true, mode: "semantic", limit: 5, maxSemanticDistance: 1.0 }, ctxB);
    } finally {
      (pool as unknown as { connect: typeof connect }).connect = connect;
    }

    const begin = statements.indexOf("begin");
    const set = statements.findIndex((statement) => /set local hnsw\.iterative_scan = relaxed_order/.test(statement));
    const nodeProbe = statements.findIndex((statement) => statement.includes("with candidates as"));
    const unitProbe = statements.findIndex((statement) => statement.includes("e.owner_table = 'text_unit'"));
    const commit = statements.indexOf("commit");
    assert.ok(begin !== -1 && set > begin, "iterative scan is not enabled inside the transaction");
    assert.ok(nodeProbe > set && unitProbe > set, "a probe ran before iterative scan was enabled");
    assert.ok(commit > unitProbe, "the transaction did not close after the probes");
  });

  it("deleting a text unit or a revision takes its vector with it", async () => {
    await withClient(async (client) => {
      const unitId = unitIdsB[0] as string;
      await client.query("delete from text_unit where id = $1", [unitId]);
      const unitVectors = await client.query("select count(*)::int as c from embedding where owner_table = 'text_unit' and owner_id = $1", [unitId]);
      assert.equal(unitVectors.rows[0].c, 0, "the text unit's vector was orphaned");

      const nodeId = nodeIdsB[0] as string;
      const revision = await client.query("select current_revision_id from node where id = $1", [nodeId]);
      const revisionId = String(revision.rows[0].current_revision_id);
      await client.query("update node set current_revision_id = null where id = $1", [nodeId]);
      await client.query("delete from node_revision where id = $1", [revisionId]);
      const revisionVectors = await client.query("select count(*)::int as c from embedding where owner_table = 'node_revision' and owner_id = $1", [revisionId]);
      assert.equal(revisionVectors.rows[0].c, 0, "the revision's vector was orphaned");
    });
  });

  it("the owner_table check no longer admits the dropped claim table", async () => {
    await withClient(async (client) => {
      await assert.rejects(
        client.query(
          `insert into embedding (owner_table, owner_id, model, dimensions, embedding, content_sha256)
           values ('claim', gen_random_uuid(), 'fake', 1536, (select array_fill(0.1, array[1536])::vector), 'sha')`,
        ),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
    });
  });
});
