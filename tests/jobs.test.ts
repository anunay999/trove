import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { suiteStore, closeStore, isolateDatabase, hasPostgres } from "./helpers.js";
import { enqueueEmbeddingDrainFollowUp } from "../src/jobWorker.js";
import { UserStore } from "../src/users.js";
import type { GraphJob, GraphOperationContext } from "../src/graphCore.js";

// This suite asserts on queue state, and `runJob({})` claims whichever job is
// next — including a parallel sibling's. Own database, own queue.
await isolateDatabase("jobs");

/**
 * A fresh owner id for scoping tests. graph_job.owner_id references app_user
 * under Postgres, so mint a real user there; the memory driver has no user
 * table and accepts any id.
 */
async function freshOwner(tag: string): Promise<string> {
  if (!hasPostgres()) return randomUUID();
  const users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
  try {
    const user = await users.ensureUser({ clerkUserId: `${tag}-${randomUUID()}`, email: `${tag}-${Date.now()}@example.com` });
    return user.id;
  } finally {
    await users.close();
  }
}

describe("jobs", () => {
  const { store, context, stamp } = suiteStore("job");

  after(async () => {
    await closeStore(store);
  });

  it("a scoped write enqueues an owner-scoped lint that other owners cannot list", async () => {
    const ownerA = await freshOwner("jobs-owner-a");
    const ownerB = await freshOwner("jobs-owner-b");
    const asA: GraphOperationContext = { ...context, ownerId: ownerA };
    const asB: GraphOperationContext = { ...context, ownerId: ownerB };

    await store.capture({
      title: `Owner-scoped lint ${stamp}`,
      type: "claim",
      summary: "A scoped write should enqueue a lint that covers only this owner's graph.",
      content: "Lint findings carry node ids and titles, so the job must belong to the writer.",
      evidence: [],
      links: [],
    }, asA);

    const mine = await store.jobs({ kind: "lint_graph", limit: 100 }, asA);
    const lint = mine.find((job) => job.dedupeKey === `maintenance:lint_graph:${ownerA}`);
    assert.ok(lint, `expected a per-owner lint job; saw keys ${mine.map((job) => job.dedupeKey).join(",") || "none"}`);
    assert.equal(lint.ownerId, ownerA, "the job row is stamped with the writer's owner");
    assert.equal(lint.payload.ownerId, ownerA, "the payload scopes the lint run");
    assert.ok(mine.every((job) => job.ownerId === ownerA), "a scoped list shows only the caller's jobs");

    const theirs = await store.jobs({ limit: 200 }, asB);
    assert.ok(!theirs.some((job) => job.id === lint.id), "another owner cannot list this job");
    assert.ok(theirs.every((job) => job.ownerId === ownerB), "a scoped list never leaks other owners' rows");

    const everyone = await store.jobs({ limit: 200 });
    assert.ok(everyone.some((job) => job.id === lint.id), "an unscoped (operator) list sees every job");

    const done = await store.runJob({ jobId: lint.id }, context);
    assert.equal(done?.status, "succeeded");
    const report = done?.result?.lint as { nodes: number } | undefined;
    assert.ok(report, "lint job carries its report");
    // The memory driver is single-user and lints everything; Postgres scopes.
    if (hasPostgres()) assert.equal(report.nodes, 1, "the lint ran over the owner's graph only");
  });

  it("an operator-enqueued lint without an owner stays global and invisible to scoped users", async () => {
    const ownerB = await freshOwner("jobs-owner-global");
    const asB: GraphOperationContext = { ...context, ownerId: ownerB };
    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: { reason: "operator" },
      priority: 95,
      dedupeKey: `smoke:global-lint:${stamp}`,
    }, context);
    assert.equal(job.ownerId, null, "an unscoped enqueue leaves the job global");
    assert.ok(!(await store.jobs({ limit: 200 }, asB)).some((candidate) => candidate.id === job.id));
    const done = await store.runJob({ jobId: job.id }, context);
    assert.equal(done?.status, "succeeded");
    const report = done?.result?.lint as { nodes: number } | undefined;
    assert.ok(report && report.nodes >= 1, "a global lint covers the whole graph");
  });

  it("a graph write enqueues durable maintenance jobs", async () => {
    // Maintenance jobs use a global dedupe key (`maintenance:${kind}`). Under
    // parallel node:test + shared Postgres, a sibling suite (or job-worker)
    // may already hold the pending/running row — or drain it between capture
    // and list. Assert "active or just-finished", not "pending in isolation".
    const startedAt = Date.now();
    await store.capture({
      title: `Job smoke ${stamp}`,
      type: "claim",
      summary: "Graph writes should enqueue durable maintenance jobs.",
      content: "This node verifies that Trove schedules lint and embedding refresh work after mutations.",
      evidence: [],
      links: [],
    }, context);

    const listed = await store.jobs({ limit: 200 });
    for (const expected of ["lint_graph", "refresh_embeddings"] as const) {
      const ofKind = listed.filter((job) => job.kind === expected);
      const active = ofKind.some(
        (job) => job.status === "pending" || job.status === "running",
      );
      const justFinished = ofKind.some((job) => {
        if (job.status !== "succeeded" && job.status !== "failed") return false;
        const stampMs = Date.parse(job.finishedAt ?? job.updatedAt);
        return Number.isFinite(stampMs) && stampMs >= startedAt - 2_000;
      });
      assert.ok(
        active || justFinished,
        `expected maintenance job ${expected} pending/running or finished around this capture; saw ${
          ofKind.map((j) => j.status).join(",") || "none"
        }`,
      );
    }
  });

  it("runs an enqueued job to success", async () => {
    const manualJob = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: true },
      priority: 99,
      dedupeKey: `smoke:lint:${stamp}`,
    }, context);
    const completed = await store.runJob({ jobId: manualJob.id }, context);
    assert.equal(completed?.status, "succeeded", "expected the lint job to succeed");
  });

  it("enqueue reports whether it created or joined a dedupe-keyed job", async () => {
    const first = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: true },
      priority: 90,
      dedupeKey: `smoke:dedupe:${stamp}`,
    }, context);
    const second = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: true },
      priority: 90,
      dedupeKey: `smoke:dedupe:${stamp}`,
    }, context);

    assert.equal(first.dedupeJoined ?? false, false, "the first enqueue creates the row");
    assert.equal(second.dedupeJoined, true, "the second enqueue joins the pending row");
    assert.equal(second.id, first.id, "a join returns the existing job");

    await store.runJob({ jobId: first.id }, context); // drain: leave nothing pending
  });

  it("enqueueEmbeddingDrainFollowUp continues an unfinished drain in its owner scope", async () => {
    const drainJob = (ownerId: string | null, missing: number, embedded: number): GraphJob => ({
      id: `drain-${stamp}`,
      kind: "refresh_embeddings",
      status: "succeeded",
      payload: ownerId ? { ownerId } : {},
      result: {
        provider: "fake", model: "fake", status: "refreshed", ownerId,
        missingBefore: { nodeRevisions: missing, textUnits: 0 },
        embedded: { nodeRevisions: embedded, textUnits: 0 },
      },
      dedupeKey: null, ownerId, error: null, attempts: 1, priority: 40,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });

    // Unfinished, owner-scoped: follow-up queued with the owner's dedupe key.
    const queued = await enqueueEmbeddingDrainFollowUp(store, drainJob(`owner-${stamp}`, 10, 4), context);
    assert.equal(queued, true);
    const followUps = (await store.jobs({ kind: "refresh_embeddings", limit: 100 }))
      .filter((job) => String(job.dedupeKey).endsWith(`:owner-${stamp}`));
    assert.equal(followUps.length, 1, "exactly one owner-scoped follow-up");
    assert.equal((followUps[0]!.payload as Record<string, unknown>).ownerId, `owner-${stamp}`);

    // Finished drain: no follow-up.
    assert.equal(await enqueueEmbeddingDrainFollowUp(store, drainJob(`owner-${stamp}`, 4, 4), context), false);

    // Global drain: global dedupe key, no ownerId in the payload.
    await store.enqueueJob({ kind: "refresh_embeddings", payload: { reason: "graph_mutation" }, priority: 40, dedupeKey: "maintenance:refresh_embeddings" }, context);
    const globalQueued = await enqueueEmbeddingDrainFollowUp(store, drainJob(null, 10, 4), context);
    assert.equal(globalQueued, true);
    const globals = (await store.jobs({ kind: "refresh_embeddings", limit: 100 }))
      .filter((job) => job.dedupeKey === "maintenance:refresh_embeddings" && job.status === "pending");
    assert.equal(globals.length, 1, "the global follow-up dedupes onto the one pending row");
    assert.equal((globals[0]!.payload as Record<string, unknown>).ownerId, undefined);
  });
});
