import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { suiteStore, closeStore, isolateDatabase, hasPostgres, sleep } from "./helpers.js";
import { enqueueEmbeddingDrainFollowUp } from "../src/jobWorker.js";
import { UserStore } from "../src/users.js";
import { JOB_MAX_ATTEMPTS } from "../src/graphCore.js";
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

/** Run one statement against the suite's Postgres database. */
async function sql<T extends Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Swap the store's job body for the duration of a test (the F12c pattern). */
function patchPerformJob(store: unknown, body: (job: GraphJob) => unknown): () => void {
  const patched = store as { performJob: (job: GraphJob) => unknown };
  const original = patched.performJob;
  patched.performJob = body;
  return () => {
    patched.performJob = original;
  };
}

/** Push a job's last update past any lease or retry backoff. */
async function ageJob(store: unknown, jobId: string): Promise<void> {
  if (hasPostgres()) {
    await sql("update graph_job set updated_at = now() - interval '2 days' where id = $1", [jobId]);
    return;
  }
  const jobs = (store as { graphJobs: Map<string, GraphJob> }).graphJobs;
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, updatedAt: new Date(Date.now() - 172_800_000).toISOString() });
}

describe("jobs", () => {
  const { store, context, stamp } = suiteStore("job");

  after(async () => {
    await closeStore(store);
  });

  it("a slow but healthy job heartbeats its lease and is not reclaimed", async (t) => {
    // A one-second lease with a two-second job: without a heartbeat the
    // second claim below reclaims the row (attempts 2) and the first worker's
    // finish then overwrites a job another worker is running.
    const previousLease = process.env.TROVE_JOB_LEASE_SECONDS;
    process.env.TROVE_JOB_LEASE_SECONDS = "1";
    const restore = patchPerformJob(store, async () => {
      await sleep(2_000);
      return { ownerId: null, lint: { nodes: 0, edges: 0, findings: [], errors: 0, warnings: 0 } };
    });
    t.after(() => {
      restore();
      if (previousLease === undefined) delete process.env.TROVE_JOB_LEASE_SECONDS;
      else process.env.TROVE_JOB_LEASE_SECONDS = previousLease;
    });

    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "heartbeat" },
      priority: 0,
      dedupeKey: `smoke:heartbeat:${stamp}`,
    }, context);
    const first = store.runJob({ jobId: job.id }, context);
    await sleep(1_300);
    const contender = await store.runJob({ jobId: job.id }, context);
    assert.equal(contender?.status, "running", "the contender sees the job still running");
    assert.equal(contender?.attempts, 1, "a heartbeating job is not reclaimed after the lease window");

    const finished = await first;
    assert.equal(finished?.status, "succeeded");
    assert.equal(finished?.attempts, 1, "the original claim finished its own attempt");
  });

  it("a stale claimant cannot finish a job another worker has reclaimed", { skip: hasPostgres() ? false : "postgres only" }, async (t) => {
    const restore = patchPerformJob(store, async () => {
      await sleep(600);
      return { ownerId: null, lint: { nodes: 0, edges: 0, findings: [], errors: 0, warnings: 0 } };
    });
    t.after(restore);

    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "stale-claimant" },
      priority: 0,
      dedupeKey: `smoke:stale-claimant:${stamp}`,
    }, context);
    const stale = store.runJob({ jobId: job.id }, context);
    await sleep(200);
    // Simulate a lease reclaim by another worker while the first is mid-job.
    await sql(
      "update graph_job set claimed_by = $2, attempts = attempts + 1, updated_at = now() where id = $1",
      [job.id, "other-worker:reclaim"],
    );

    const returned = await stale;
    assert.notEqual(returned?.status, "succeeded", "the stale worker's result must not land");
    const [row] = await sql<{ status: string; claimed_by: string; attempts: number; result: unknown }>(
      "select status, claimed_by, attempts, result from graph_job where id = $1",
      [job.id],
    );
    assert.equal(row?.status, "running", "the reclaiming worker still owns the row");
    assert.equal(row?.claimed_by, "other-worker:reclaim");
    assert.equal(row?.attempts, 2);
    assert.equal(row?.result, null, "the dropped result was not written");

    await sql("update graph_job set status = 'cancelled', finished_at = now(), updated_at = now() where id = $1", [job.id]);
  });

  it("a lint that succeeded recently throttles the next write's lint enqueue", async (t) => {
    const previous = process.env.TROVE_LINT_MIN_INTERVAL_SECONDS;
    process.env.TROVE_LINT_MIN_INTERVAL_SECONDS = "600";
    t.after(() => {
      if (previous === undefined) delete process.env.TROVE_LINT_MIN_INTERVAL_SECONDS;
      else process.env.TROVE_LINT_MIN_INTERVAL_SECONDS = previous;
    });

    const owner = await freshOwner("jobs-throttle");
    const asOwner: GraphOperationContext = { ...context, ownerId: owner };
    const key = `maintenance:lint_graph:${owner}`;
    const lintsForOwner = async (): Promise<GraphJob[]> =>
      (await store.jobs({ kind: "lint_graph", limit: 200 })).filter((job) => job.dedupeKey === key);
    const write = async (title: string): Promise<void> => {
      await store.capture({
        title: `${title} ${stamp}`,
        type: "claim",
        summary: "Every write used to enqueue a full lint.",
        content: "Steady state was one lint per write; dedupe only collapsed bursts.",
        evidence: [],
        links: [],
      }, asOwner);
    };

    await write("Throttle first");
    const [first] = await lintsForOwner();
    assert.ok(first, "the first write enqueues the owner's lint");
    assert.equal(first.status, "pending");
    const done = await store.runJob({ jobId: first.id }, context);
    assert.equal(done?.status, "succeeded");

    await write("Throttle second");
    const afterSecond = await lintsForOwner();
    assert.equal(afterSecond.length, 1, "a write inside the interval enqueues no new lint");
    assert.ok(!afterSecond.some((job) => job.status === "pending"), "nothing pending while the last lint is fresh");

    process.env.TROVE_LINT_MIN_INTERVAL_SECONDS = "0";
    await write("Throttle third");
    const pending = (await lintsForOwner()).find((job) => job.status === "pending");
    assert.ok(pending, "with the throttle off a write enqueues lint again");
    await store.runJob({ jobId: pending.id }, context);
  });

  it("a lint run prunes terminal jobs older than thirty days", { skip: hasPostgres() ? false : "postgres only" }, async () => {
    const insert = async (status: string, age: string, finished: boolean): Promise<string> => {
      const [row] = await sql<{ id: string }>(
        `insert into graph_job (kind, status, priority, payload, dedupe_key, created_at, updated_at, finished_at)
         values ('lint_graph', $1, 0, '{}'::jsonb, $2, now() - $3::interval, now() - $3::interval,
                 case when $4 then now() - $3::interval else null end)
         returning id`,
        [status, `smoke:prune:${status}:${age}:${randomUUID()}`, age, finished],
      );
      return row!.id;
    };
    const stale = await insert("succeeded", "40 days", true);
    const staleFailed = await insert("dead", "31 days", true);
    const recent = await insert("failed", "1 day", true);
    const oldButOpen = await insert("pending", "40 days", false);

    const lint = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "prune" },
      priority: 90,
      dedupeKey: `smoke:prune:${stamp}`,
    }, context);
    const done = await store.runJob({ jobId: lint.id }, context);
    assert.equal(done?.status, "succeeded");
    assert.ok(Number((done?.result as { prunedJobs?: number } | null)?.prunedJobs) >= 2, "the lint reports what it pruned");

    const remaining = new Set(
      (await sql<{ id: string }>("select id from graph_job where id = any($1::uuid[])", [[stale, staleFailed, recent, oldButOpen]]))
        .map((row) => row.id),
    );
    assert.ok(!remaining.has(stale), "a month-old succeeded job is pruned");
    assert.ok(!remaining.has(staleFailed), "a month-old dead job is pruned");
    assert.ok(remaining.has(recent), "a recent terminal job is kept");
    assert.ok(remaining.has(oldButOpen), "an open job is never pruned, whatever its age");

    await sql("delete from graph_job where id = any($1::uuid[])", [[recent, oldButOpen]]);
  });

  it("the retry budget is JOB_MAX_ATTEMPTS: the last failure dead-letters", async (t) => {
    const restore = patchPerformJob(store, () => {
      throw new Error("boom");
    });
    t.after(restore);

    const job = await store.enqueueJob({
      kind: "lint_graph",
      payload: { smoke: "dead-letter" },
      priority: 0,
      dedupeKey: `smoke:dead-letter:${stamp}`,
    }, context);
    assert.equal(typeof JOB_MAX_ATTEMPTS, "number");
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt += 1) {
      await ageJob(store, job.id);
      const result = await store.runJob({ jobId: job.id }, context);
      assert.equal(result?.attempts, attempt);
      assert.equal(
        result?.status as string,
        attempt < JOB_MAX_ATTEMPTS ? "failed" : "dead",
        `attempt ${attempt} of ${JOB_MAX_ATTEMPTS}`,
      );
    }
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
