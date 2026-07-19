/* eslint-disable */
// bench/providers/trove/index.ts — Trove as a MemoryBench `Provider`.
//
// MemoryBench (https://github.com/supermemoryai/memorybench) drives the whole
// benchmark: it loads LongMemEval, ingests each question's haystack, calls
// search(), hands the results to an answering model, and grades with a judge.
// This file is the only Trove-specific piece. Everything else — dataset, judge,
// answer model, and the Mem0/Zep/Supermemory providers we compare against —
// comes from upstream, so all systems run through one identical pipeline.
//
// ISOLATION. MemoryBench allocates one `containerTag` per question
// (`${questionId}-${runId}`, see orchestrator/phases/ingest.ts), and questions
// run concurrently. Trove already has exactly the right primitive for this:
// every graph row carries `owner_id` (migration 006) and every read filters by
// it via GraphOperationContext.ownerId. So a containerTag maps to a synthetic
// app_user, and 500 haystacks coexist in one database with no truncation and
// no cross-talk. Do NOT swap this for a truncate-between-questions scheme; it
// would serialize the run and race with concurrent containers.
//
// WRITE PATH. Trove's doctrine is ingest (raw, citable spans) then remember
// (short distilled atoms that cite those spans). Its recall ranks atoms, so an
// ingest-only provider would be benchmarking half the system. Mem0 and Zep both
// run LLM extraction at write time, so doing the same here is the like-for-like
// comparison — this provider plays the role of the agent that calls remember.
// Set TROVE_BENCH_EXTRACT=0 to ablate extraction and measure ingest-only recall.

import pg from "pg";
import type { GraphStore } from "../../../src/graphCore.js";
import type { GraphOperationContext } from "../../../src/graphCore.js";
import { trovePrompts } from "./prompts.js";

// ---- MemoryBench's Provider contract (src/types/provider.ts upstream). Kept as
// a local structural type so this file compiles inside the Trove repo without
// depending on memorybench being cloned. bench/setup.sh links it into place.
type UnifiedMessage = { role: string; content: string; timestamp?: string };
type UnifiedSession = { sessionId: string; messages: UnifiedMessage[]; timestamp?: string; metadata?: Record<string, unknown> };
type ProviderConfig = { apiKey: string; baseUrl?: string; [key: string]: unknown };
type IngestOptions = { containerTag: string; metadata?: Record<string, unknown> };
type SearchOptions = { containerTag: string; limit?: number; threshold?: number };
type IngestResult = { documentIds: string[]; taskIds?: string[] };

const EXTRACT = process.env.TROVE_BENCH_EXTRACT !== "0";
const EXTRACT_MODEL = process.env.TROVE_BENCH_EXTRACT_MODEL ?? "gpt-4o-mini";
/** Parallel extraction calls per haystack. Raise if your rate limit allows. */
const EXTRACT_CONCURRENCY = Number(process.env.TROVE_BENCH_EXTRACT_CONCURRENCY ?? 8);
// The dial the whole exercise exists to measure. Trove caps recall at 32000.
const TOKEN_BUDGET = Number(process.env.TROVE_BENCH_TOKEN_BUDGET ?? 8000);
const RECALL_DEPTH = Number(process.env.TROVE_BENCH_DEPTH ?? 1);

export class TroveProvider {
  name = "trove";
  // MemoryBench reads `prompts` off the provider instance. We supply an
  // answerPrompt only — never a judgePrompt. See prompts.ts for why.
  prompts = trovePrompts;

  private store!: GraphStore;
  private pool!: pg.Pool;
  /** containerTag -> synthetic app_user.id. One graph per benchmark question. */
  private owners = new Map<string, string>();

  async initialize(config: ProviderConfig): Promise<void> {
    const databaseUrl = process.env.TROVE_BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("TROVE_BENCH_DATABASE_URL (or DATABASE_URL) is required.");

    // A benchmark run writes ~500 synthetic users' worth of junk. Refuse to
    // point it at anything that looks like a real deployment.
    const url = new URL(databaseUrl);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal && process.env.TROVE_BENCH_ALLOW_REMOTE !== "1") {
      throw new Error(
        `Refusing to benchmark against non-local database ${url.hostname}. ` +
          `Set TROVE_BENCH_ALLOW_REMOTE=1 only if you are certain this is a scratch instance.`,
      );
    }

    process.env.DATABASE_URL = databaseUrl;
    process.env.TROVE_STORE = "postgres";
    // Reconciliation is not under measurement here, and awaitIndexing drains
    // EVERY job kind — so the LLM judge would fire on all ~3k ingested atoms
    // (up to 5 candidate pairs each) purely as a side effect of needing
    // OPENAI_API_KEY for embeddings. Worse, it would be judging a corpus this
    // adapter deliberately distorts: titles are session-suffixed (see ingest),
    // so its verdicts would be noise. Force the heuristic; benchmark
    // reconciliation explicitly if it ever becomes the thing being measured.
    process.env.TROVE_RECONCILE_JUDGE = "0";
    const { createGraphStore } = await import("../../../src/createStore.js");
    const { store, driver } = createGraphStore();
    if (driver !== "postgres") throw new Error(`expected postgres driver, got ${driver}`);
    this.store = store;
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  /** Mint (once) the synthetic app_user that scopes this question's graph. */
  private async ownerFor(containerTag: string): Promise<string> {
    const cached = this.owners.get(containerTag);
    if (cached) return cached;
    // clerk_user_id is the natural unique key; reuse it as the container handle
    // so a resumed run (MemoryBench checkpoints per phase) rebinds to the same
    // graph instead of duplicating it.
    const { rows } = await this.pool.query(
      `insert into app_user (clerk_user_id, email, display_name, role, status)
       values ($1, null, $2, 'member', 'active')
       on conflict (clerk_user_id) do update set display_name = excluded.display_name
       returning id`,
      [`bench:${containerTag}`, `bench ${containerTag}`],
    );
    const ownerId = String(rows[0].id);
    this.owners.set(containerTag, ownerId);
    return ownerId;
  }

  private ctx(ownerId: string, containerTag: string): GraphOperationContext {
    return { actorId: "memorybench", interfaceId: "memorybench", requestId: containerTag, ownerId };
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const ownerId = await this.ownerFor(options.containerTag);
    const ctx = this.ctx(ownerId, options.containerTag);

    // Ingest is sequential (cheap, all local SQL), but distillation is one LLM
    // round trip per session and dominates wall clock: a LongMemEval haystack is
    // ~50 sessions, so serializing it cost ~150s of a ~170s ingest. Sessions are
    // independent — each writes its own source, and atom titles are already
    // session-scoped so there is no slug contention — so the extraction calls
    // fan out over a bounded pool. The cap keeps us under provider rate limits
    // and bounds the damage if a haystack is unusually large.
    const pending: Array<{ session: UnifiedSession; textUnits: Array<{ id: string }> }> = [];
    const documentIds: string[] = [];

    for (const session of sessions) {
      // One source per session preserves LongMemEval's session granularity —
      // which the paper's own index-side findings say matters — and gives each
      // turn its own citable text unit.
      const dateLine = session.timestamp ? `Session date: ${session.timestamp}\n` : "";
      const { source, textUnits } = await this.store.ingest(
        {
          kind: "paste",
          title: `Session ${session.sessionId}`,
          contentText: `${dateLine}${transcriptOf(session)}`,
          metadata: { sessionId: session.sessionId, timestamp: session.timestamp ?? null },
        },
        ctx,
      );
      documentIds.push(source.id);
      if (EXTRACT) pending.push({ session, textUnits });
    }

    await inPool(EXTRACT_CONCURRENCY, pending, (item) => this.distill(item.session, item.textUnits, ctx));

    return { documentIds };
  }

  /**
   * The `remember` half of the doctrine: pull a handful of short atoms out of
   * the session and store each one citing the text units it came from. This is
   * what an agent using Trove would do, and it is what recall actually ranks.
   */
  private async distill(
    session: UnifiedSession,
    textUnits: Array<{ id: string }>,
    ctx: GraphOperationContext,
  ): Promise<void> {
    const transcript = transcriptOf(session);
    const dated = session.timestamp ? `This conversation happened on ${session.timestamp}.\n\n` : "";
    const facts = await chat(EXTRACT_MODEL, [
      {
        role: "system",
        content:
          "Extract the durable facts from this conversation as JSON: " +
          `{"facts":[{"title":"short noun phrase","summary":"one sentence stating the fact"}]}. ` +
          "Include anything a person might later be asked to recall: stated facts, preferences, " +
          "plans, decisions, events and their dates, and personal details. If a fact updates or " +
          "contradicts something, state the NEW value and include when it changed. " +
          "Prefer several small specific facts over one broad one. Return 3-8 facts, JSON only.",
      },
      { role: "user", content: `${dated}${transcript}` },
    ]);

    let parsed: { facts?: Array<{ title?: string; summary?: string }> } = {};
    try {
      parsed = JSON.parse(facts.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {
      return; // extraction is best-effort; the raw source is already ingested
    }

    // Cite every unit of the session. Trove caps packed evidence per node and
    // ranks it against the query (see repro-eval R10/R16), so over-citing here
    // costs nothing at recall time and keeps provenance honest.
    const evidence = textUnits.map((unit) => ({ textUnitId: unit.id, selector: {} }));
    const { remember } = await import("../../../src/agentOps.js");

    for (const fact of parsed.facts ?? []) {
      if (!fact.title || !fact.summary) continue;
      await remember(
        this.store,
        {
          // Scope the title to the session so two sessions asserting different
          // values for the same attribute do not collide into a single node via
          // remember's exact-title revise path — LongMemEval's knowledge-update
          // questions depend on both values existing and being dated.
          title: `${fact.title} (${session.sessionId})`,
          type: "claim",
          summary: fact.summary,
          content: session.timestamp ? `${fact.summary}\n\nStated on ${session.timestamp}.` : fact.summary,
          evidence,
          links: [],
        },
        ctx,
      ).catch(() => undefined);
    }
  }

  /**
   * Trove embeds asynchronously via the job queue. MemoryBench gives us an
   * explicit hook to block until the index is warm — without this, search()
   * would run lexical-only and understate semantic recall.
   */
  async awaitIndexing(_result: IngestResult, containerTag: string): Promise<void> {
    const ownerId = await this.ownerFor(containerTag);
    const ctx = this.ctx(ownerId, containerTag);

    // NOTE: refresh_embeddings is a GLOBAL maintenance job, not a per-owner one
    // — its missing-count query (pgStore.ts, `select count(*) from node n where
    // n.deleted_at is null ...`) has no owner filter, and neither does the
    // backfill it drives. So this waits for the whole database to converge, not
    // just this container. That is correct here (every container's data must be
    // embedded before its questions are searched) but it means the wait is
    // O(total corpus), and calling it per-container re-checks the same global
    // state. Keep concurrency at 1 for the benchmark.
    //
    // The job embeds `payload.limit` rows per run, default 24, hard-capped at
    // 100 by refreshMissingEmbeddings. A LongMemEval haystack produces ~3.5k
    // text units, so bulk backfill needs hundreds of rounds — loop on PROGRESS
    // rather than a fixed round count, and only give up when a round embeds
    // nothing while work remains.
    let stalledRounds = 0;

    for (let round = 0; round < 100_000; round++) {
      let drained = 0;
      while (drained < 500) {
        const job = await this.store.runJob({}, ctx);
        if (!job) break;
        drained += 1;
      }

      const job = await this.store.enqueueJob(
        {
          kind: "refresh_embeddings",
          payload: { reason: "memorybench", limit: 100 },
          priority: 40,
          dedupeKey: `memorybench:embed:${round}`,
        },
        ctx,
      );
      const ran = await this.store.runJob({ jobId: job.id }, ctx);
      const result = (ran?.result ?? {}) as Record<string, any>;
      if (result.status === "skipped_no_embedding_provider") return; // lexical-only run
      if (ran?.status === "failed" || (ran?.status as string) === "dead") {
        throw new Error(`refresh_embeddings ${ran?.status}: ${ran?.error}`);
      }

      const missing = (result.missingBefore ?? {}) as Record<string, unknown>;
      const remaining = Number(missing.nodeRevisions ?? 0) + Number(missing.textUnits ?? 0);
      if (remaining === 0) return;

      // "Did this round write anything?" — the drain is single-writer here
      // (concurrency 1, see comment above), so the embedded count is the whole
      // progress signal; tracking the previous remaining count restated it.
      const embedded = (result.embedded ?? {}) as Record<string, unknown>;
      const progressed = Number(embedded.nodeRevisions ?? 0) + Number(embedded.textUnits ?? 0) > 0;
      stalledRounds = progressed ? 0 : stalledRounds + 1;
      if (stalledRounds >= 5) {
        throw new Error(
          `awaitIndexing(${containerTag}) stalled with ${remaining} rows unembedded ` +
            `(nodeRevisions=${missing.nodeRevisions}, textUnits=${missing.textUnits})`,
        );
      }
    }
    throw new Error(`awaitIndexing(${containerTag}) exceeded round cap`);
  }

  /**
   * The flagship read operator, and the thing MemScore's contextTokens column
   * actually measures. We return the packed atoms; the harness counts their
   * tokens and hands them to the answering model.
   */
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const ownerId = await this.ownerFor(options.containerTag);
    const ctx = this.ctx(ownerId, options.containerTag);
    const pack = await this.store.recall(
      { query, tokenBudget: TOKEN_BUDGET, depth: RECALL_DEPTH, includeEvidence: true },
      ctx,
    );
    // `pack.evidence` is a flat TextUnit[] with no back-pointer to the atom that
    // cited it — `pack.citations` is the join (nodeId -> textUnitId). Resolving
    // through it is the only way to attach the right source text to each atom.
    const unitsById = new Map(pack.evidence.map((unit) => [unit.id, unit.text]));
    const unitsByNode = new Map<string, string[]>();
    for (const citation of pack.citations) {
      if (!citation.nodeId || !citation.textUnitId) continue;
      const text = unitsById.get(citation.textUnitId);
      if (!text) continue;
      const list = unitsByNode.get(citation.nodeId) ?? [];
      list.push(text);
      unitsByNode.set(citation.nodeId, list);
    }

    return pack.atoms.map((atom) => ({
      id: atom.node.id,
      title: atom.node.title,
      summary: atom.node.summary,
      content: atom.node.content,
      hops: atom.hops,
      evidence: unitsByNode.get(atom.node.id) ?? [],
    }));
  }

  async clear(containerTag: string): Promise<void> {
    const ownerId = this.owners.get(containerTag);
    if (!ownerId) return;
    // Every graph table cascades from app_user via owner_id (migration 006 sets
    // `on delete set null`, so delete the rows explicitly rather than the user).
    for (const table of ["graph_event", "annotation", "edge", "node", "text_unit", "source", "graph_view"]) {
      await this.pool.query(`delete from ${table} where owner_id = $1`, [ownerId]);
    }
    this.owners.delete(containerTag);
  }

  async close(): Promise<void> {
    await this.pool?.end();
    if ("close" in this.store && typeof (this.store as any).close === "function") {
      await (this.store as any).close();
    }
  }
}

/** Render a session the same way for ingest and for extraction — the atoms cite
 *  spans built from the ingested text, so the two must not drift apart. */
function transcriptOf(session: UnifiedSession): string {
  return session.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

/** Run `work` over `items` with at most `limit` in flight. */
async function inPool<T>(limit: number, items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

// ---- minimal OpenAI-compatible chat call for the extraction step.
async function chat(model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY required for write-time extraction (or set TROVE_BENCH_EXTRACT=0).");
  // Honour OPENAI_BASE_URL like src/embeddings.ts does, so pointing the bench at
  // a proxy or local model works for extraction as well as for embeddings.
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: "json_object" } }),
  });
  if (!response.ok) throw new Error(`extraction failed ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as any;
  return body.choices?.[0]?.message?.content ?? "{}";
}

export default TroveProvider;
