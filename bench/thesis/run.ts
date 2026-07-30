/**
 * Trove thesis harness — does the graph earn its complexity?
 *
 * Runs the dataset against two systems that share the SAME ingested text units,
 * so the only variable is what happens between ingest and retrieval:
 *
 *   trove : sessions -> ingest -> distill into linked atoms -> recall(depth=1)
 *   flat  : sessions -> ingest -> embed the same units -> cosine top-k
 *
 * Both then answer with the same model and prompt, and are graded by the same
 * judge. Reported per shape, because the shape split IS the result — see
 * dataset.ts. A win everywhere means the dataset is rigged, not that the thesis
 * holds.
 *
 * THE HAYSTACK (backlog #31): the first full run measured retrieval over a
 * 100-text-unit corpus, where TOP_K=8 handed the flat baseline 8% of
 * everything per question — the comparison was meaningless and its number was
 * retracted. The corpus is now padded with ~7k distractor notes
 * (genDistractors.ts -> distractors.json, committed so the haystack is
 * identical across runs). Distractors pad BOTH sides symmetrically: ingested
 * as sources (flat's units) and captured as pre-atomic claim nodes (trove's
 * graph) — padding only one side would rig the comparison in the other
 * direction. They carry no LLM distillation by construction (they are already
 * single-fact notes); their reconcile jobs are never drained (no measurement
 * value, pure cost). Every run prints its corpus sizes — the standing rule at
 * the end of docs/backlog.md exists because a number without its corpus size
 * already fooled us once.
 *
 * Alongside accuracy, every run reports BRIDGE COVERAGE: the share of an item's
 * requiredFacts present in the retrieved context. A wrong answer with full
 * coverage is a ranking or answering failure; a wrong answer with partial
 * coverage is a retrieval failure. Without that split, accuracy alone tells you
 * nothing about where to work next.
 *
 *   TROVE_THESIS_DATABASE_URL=postgres://... npx tsx bench/thesis/run.ts
 *
 * Requires OPENAI_API_KEY (distillation, answering, judging) and a scratch
 * database — it writes a corpus and refuses anything non-local by default.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PgGraphStore } from "../../src/pgStore.js";
import { performRecall } from "../../src/graphCore.js";
import type { GraphOperationContext, TextUnit } from "../../src/graphCore.js";
import { cosineSimilarity, createEmbeddingProviderFromEnv } from "../../src/embeddings.js";
import { createReconcileJudgeFromEnv } from "../../src/reconcile.js";
import { enqueueEmbeddingDrainFollowUp } from "../../src/jobWorker.js";
import { THESIS_ITEMS, validateDataset, type ThesisItem, type ThesisShape } from "./dataset.js";

const DATABASE_URL = process.env.TROVE_THESIS_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const MODEL = process.env.TROVE_THESIS_MODEL ?? "gpt-4o";
const JUDGE_MODEL = process.env.TROVE_THESIS_JUDGE_MODEL ?? "gpt-4o";
const TOP_K = Number(process.env.TROVE_THESIS_TOP_K ?? 8);
const TOKEN_BUDGET = Number(process.env.TROVE_THESIS_TOKEN_BUDGET ?? 8000);
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
// Backlog #31: the haystack. Distractors from bench/thesis/distractors.json
// (genDistractors.ts) pad BOTH sides symmetrically — ingested as sources
// (text units for the flat baseline) and captured as pre-atomic claim nodes
// (the Trove graph). TROVE_THESIS_DISTRACTORS=0 reproduces the retracted
// 100-unit regime; LIMIT caps the load for smoke runs.
const DISTRACTORS_ENABLED = process.env.TROVE_THESIS_DISTRACTORS !== "0";
const DISTRACTOR_LIMIT = Number(process.env.TROVE_THESIS_DISTRACTOR_LIMIT ?? Infinity);
// Dev knobs: comma-separated id substrings to run a subset, and a prepare-only
// mode that stops after the corpus is built and embedded (no answering/judging).
const ITEM_FILTER = (process.env.TROVE_THESIS_ITEM_FILTER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PREPARE_ONLY = process.env.TROVE_THESIS_PREPARE_ONLY === "1";

type Outcome = {
  id: string;
  shape: ThesisShape;
  correct: boolean;
  coverage: number;
  answer: string;
  /** Context tokens put in front of the answering model (backlog #30). */
  contextTokens: number;
  /** Wall time of the retrieval step alone, ms — not the LLM answer call. */
  retrievalMs: number;
};

/**
 * Estimate context tokens the SAME way for both arms — the comparable quantity
 * is "tokens of context each system asked the model to read", so both go
 * through one chars-per-token approximation on the string actually sent. Trove
 * also exposes pack.spentTokens (its budgeter's own count); we deliberately do
 * not use it here, because comparing Trove's tokenizer against a char estimate
 * for flat would not be apples-to-apples. ~4 chars/token, English prose.
 */
function estimateTokens(context: string): number {
  return Math.round(context.length / 4);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A full run makes ~600 model calls; over a couple of hours a handful will hit
 * a transient blip (`fetch failed`, a 429, a 5xx). The first scale run died on
 * exactly one of those — a single reconcile's network error aborted two hours of
 * work — so every model call here retries transient failures with backoff. A
 * genuine client error (401, 400) is NOT transient and still throws at once.
 */
async function chat(model: string, prompt: string, jsonMode = false): Promise<string> {
  const MAX_ATTEMPTS = 5;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error); // network error: retry
      await sleep(Math.min(2 ** attempt * 400, 8000));
      continue;
    }
    if (response.ok) {
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? "";
    }
    const text = await response.text();
    // 429 (rate limit) and 5xx are transient; other 4xx (auth, bad request) are not.
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`${model}: OpenAI ${response.status} ${text}`);
    }
    lastError = `OpenAI ${response.status} ${text}`;
    await sleep(Math.min(2 ** attempt * 400, 8000));
  }
  throw new Error(`${model}: giving up after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Distillation is where the graph is actually built, so it is part of what this
 * harness measures — not scaffolding around it. Each session becomes atoms, and
 * every atom is linked to the entities it mentions via shared hub titles. Those
 * hubs are the join: "notes moved to X" and "X syncs via Y" become connected
 * through the X hub, which is exactly the edge recall traverses when the
 * question names neither X nor Y.
 */
const DISTILL_PROMPT = (text: string) => `Extract the durable facts from this note as JSON.

{"atoms":[{"title":"short specific title","summary":"one sentence stating the fact","entities":["Canonical Entity Name", ...]}]}

Rules:
- One fact per atom. Keep names, numbers, dates and identifiers verbatim — they are the answer.
- "entities" lists the people, systems, places or things the fact is ABOUT, in canonical form
  (e.g. "Obsidian", "Billing Service", "Helsinki Office"). Use the same spelling for the same
  thing every time — these become the shared hubs that join facts across notes.
- If a note updates an earlier fact, state the new value plainly in the summary.

NOTE:
${text}`;

/**
 * Both systems get the same prompt, including the supersession sentence. That
 * sentence mirrors what Trove's `recall` tool description already tells every
 * real MCP client, so including it measures the product as deployed; omitting
 * it measured a Trove whose consumer had never been told what its own marker
 * means, and the supersede items failed at 100% retrieval coverage because the
 * model saw two times and refused to choose. It is inert for the flat baseline,
 * whose context never carries the marker.
 */
const ANSWER_PROMPT = (question: string, context: string) =>
  `Answer the question using only the context. Be brief — a few words where possible. If the context does not contain the answer, say "I don't know".
If an entry is marked "SUPERSEDED by <name>", it has been replaced by a newer entry — prefer the newer value.

CONTEXT:
${context}

QUESTION: ${question}
ANSWER:`;

const JUDGE_PROMPT = (question: string, expected: string[], got: string) =>
  `Does the ANSWER convey the same fact as any ACCEPTED answer? Ignore wording, formatting and extra detail.

QUESTION: ${question}
ACCEPTED: ${expected.join(" | ")}
ANSWER: ${got}

Reply JSON only: {"correct": true|false}`;

/** Share of an item's requiredFacts whose distinctive words survive into the context. */
function bridgeCoverage(item: ThesisItem, context: string): number {
  if (item.requiredFacts.length === 0) return 1;
  const haystack = context.toLowerCase();
  const present = item.requiredFacts.filter((fact) => {
    // A fact counts as covered when most of its content words appear. Exact
    // substring matching would fail on distillation's legitimate rephrasing.
    const words = fact.toLowerCase().match(/[a-z0-9%#-]+/g) ?? [];
    const hits = words.filter((word) => word.length > 2 && haystack.includes(word)).length;
    const meaningful = words.filter((word) => word.length > 2).length;
    return meaningful > 0 && hits / meaningful >= 0.7;
  });
  return present.length / item.requiredFacts.length;
}

type DistractorFile = {
  generatedAt: string;
  model: string;
  count: number;
  notes: Array<{ title: string; text: string; domain: string }>;
};

async function loadDistractors(): Promise<DistractorFile["notes"]> {
  if (!DISTRACTORS_ENABLED) return [];
  let parsed: DistractorFile;
  try {
    parsed = JSON.parse(await readFile(new URL("./distractors.json", import.meta.url), "utf8")) as DistractorFile;
  } catch {
    console.log("No distractors.json found (run genDistractors.ts) — running WITHOUT the haystack, the retracted regime.");
    return [];
  }
  const notes = parsed.notes.slice(0, DISTRACTOR_LIMIT);
  console.log(`Distractors: ${notes.length}/${parsed.count} notes (${parsed.model}, generated ${parsed.generatedAt})`);
  return notes;
}

/**
 * Drain jobs selectively. The blanket `runJob({})` claims whatever is pending —
 * which would judge thousands of distractor reconciles at model prices for no
 * measurement value. Embeddings must all drain (retrieval needs them); item
 * reconciles must drain (supersedes edges are the measurement); everything
 * else stays pending in the scratch corpus by design.
 */
/** Errors worth retrying — network blips and server-side transients, not auth or bad-request. */
const TRANSIENT_JOB_ERROR = /fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network|timeout|rate.?limit|\b429\b|\b5\d\d\b/i;

/**
 * Run one job by id, retrying transient failures. A failed job is retryable
 * server-side (claimJob re-claims `failed` with attempts<5 after an
 * attempts^2 x 10s backoff), so between retries we sleep just past that window
 * and re-invoke. Embeddings are load-bearing (retrieval needs the vectors), so
 * an exhausted embedding job is fatal; a single reconcile that can't be judged
 * costs at most one item's supersedes edge, so it is disclosed and skipped
 * rather than aborting a two-hour run. Returns the final job (succeeded, or the
 * skipped-failed reconcile), or null if the job vanished.
 */
async function runJobWithRetry(
  store: PgGraphStore,
  ctx: GraphOperationContext,
  jobId: string,
  kind: "refresh_embeddings" | "reconcile_node",
): Promise<Awaited<ReturnType<PgGraphStore["runJob"]>>> {
  const MAX_RETRIES = 4;
  for (let retry = 0; ; retry += 1) {
    const done = await store.runJob({ jobId }, ctx);
    if (!done || done.status === "succeeded") return done;
    const retryable =
      done.status === "failed" && done.attempts < 5 && retry < MAX_RETRIES && TRANSIENT_JOB_ERROR.test(done.error ?? "");
    if (retryable) {
      const waitMs = (done.attempts ** 2 * 10 + 3) * 1000; // clear claimJob's backoff window, then some
      console.log(
        `  ${kind} ${jobId.slice(0, 8)} transient "${(done.error ?? "").slice(0, 60)}" — retry ${retry + 1}/${MAX_RETRIES} in ${Math.round(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
      continue;
    }
    if (kind === "refresh_embeddings") {
      throw new Error(`job ${kind} ${done.status}: ${done.error} (embeddings are load-bearing; not skippable)`);
    }
    console.warn(`  WARN: reconcile ${jobId.slice(0, 8)} ${done.status}: ${(done.error ?? "").slice(0, 80)} — skipped (one item may lose its supersedes edge)`);
    return done;
  }
}

async function drainJobs(
  store: PgGraphStore,
  ctx: GraphOperationContext,
  kind: "refresh_embeddings" | "reconcile_node",
  nodeIds?: ReadonlySet<string>,
): Promise<number> {
  let drained = 0;
  let skipped = 0;
  for (;;) {
    const pending = (await store.jobs({ kind, limit: 500 })).filter((job) => job.status === "pending");
    let progressed = false;
    for (const job of pending) {
      if (nodeIds && !nodeIds.has(String((job.payload as Record<string, unknown>).nodeId))) continue;
      progressed = true;
      const done = await runJobWithRetry(store, ctx, job.id, kind);
      if (!done) continue;
      if (done.status === "succeeded") {
        // A refresh job embeds at most one batch; the follow-up is queued by the
        // job WORKER in production, never by performJob — a direct runJob loop
        // like this one must queue it or the drain silently stops after batch 1.
        if (kind === "refresh_embeddings") await enqueueEmbeddingDrainFollowUp(store, done, ctx);
        drained += 1;
      } else {
        skipped += 1; // a reconcile that exhausted retries; embeddings would have thrown
      }
    }
    if (!progressed) break;
  }
  if (skipped > 0) {
    console.warn(`  WARN: ${skipped} ${kind} job(s) skipped after exhausting retries — disclosed, not hidden (see standing rule, backlog.md)`);
  }
  return drained;
}

/** Small concurrency pool for the bulk distractor writes — sequential would be 11k round trips. */
async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queues = Array.from({ length: concurrency }, () => [] as T[]);
  items.forEach((item, i) => (queues[i % concurrency] as T[]).push(item));
  await Promise.all(queues.map(async (queue) => {
    for (const item of queue) await fn(item);
  }));
}

async function main(): Promise<void> {
  if (!DATABASE_URL) throw new Error("Set TROVE_THESIS_DATABASE_URL (or DATABASE_URL) to a scratch database.");
  if (!OPENAI_KEY) throw new Error("Set OPENAI_API_KEY — distillation, answering and judging all need it.");

  const url = new URL(DATABASE_URL);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocal && process.env.TROVE_THESIS_ALLOW_REMOTE !== "1") {
    throw new Error(`Refusing to write a benchmark corpus into non-local ${url.hostname}.`);
  }

  // Validate BEFORE ingesting: a question that names its own bridge term is a
  // similarity test wearing a graph test's clothes, and it would inflate the
  // flat baseline without anything looking wrong.
  const problems = validateDataset();
  if (problems.length > 0) {
    console.error("Dataset invalid:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }

  const embeddings = createEmbeddingProviderFromEnv();
  if (!embeddings) throw new Error("Set TROVE_EMBEDDING_PROVIDER=openai — the flat baseline needs vectors.");

  // The judge must be LIVE: `supersede` items test whether a newer belief
  // displaces an older one, and that only happens when reconciliation writes a
  // supersedes edge. Without it those items silently degrade into a plain
  // retrieval test that reads as a tie — which is exactly what happened on the
  // first run here.
  //
  // The judge is opt-IN as of the PR #26 merge (see createReconcileJudgeFromEnv:
  // opt-out meant every deployment with an embedding key paid up to 5 LLM calls
  // per write). So this harness must now ask for it explicitly rather than
  // merely refrain from disabling it.
  //
  // Ask the real factory rather than re-reading the env var: it owns which
  // values count as enabled, and a second copy of that logic here would drift
  // silently the first time one side changed.
  const judgeEnabled = createReconcileJudgeFromEnv() !== null;
  const hasSupersedeItems = THESIS_ITEMS.some((item) => item.shape === "supersede");
  if (!judgeEnabled && hasSupersedeItems) {
    throw new Error(
      "Set TROVE_RECONCILE_JUDGE=1 — the judge is opt-in, and without it no supersedes edges are " +
        "written, so the `supersede` items measure nothing. Or drop those items and say so when reporting. " +
        "Note the run judges ~one call per item atom (backlog #27: distance-gated, batched).",
    );
  }
  // The per-owner judge budget (default 100/h) would silently starve supersedes
  // edges mid-drain: ~300 item atoms each reconcile against their family. The
  // benchmark accepts and measures the cost; production keeps the cap.
  process.env.TROVE_RECONCILE_JUDGE_BUDGET ??= "10000";
  // 14k+ rows to embed; the 256 default would mean ~57 sequential drain jobs.
  process.env.TROVE_EMBEDDING_JOB_LIMIT ??= "1000";
  const store = new PgGraphStore({ connectionString: DATABASE_URL });
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const runId = randomUUID().slice(0, 8);
  const items = ITEM_FILTER.length > 0
    ? THESIS_ITEMS.filter((item) => ITEM_FILTER.some((fragment) => item.id.includes(fragment)))
    : THESIS_ITEMS;
  if (items.length === 0) throw new Error(`TROVE_THESIS_ITEM_FILTER matched nothing: ${ITEM_FILTER.join(", ")}`);
  if (items.length !== THESIS_ITEMS.length) console.log(`Item filter: running ${items.length}/${THESIS_ITEMS.length} items`);

  try {
    const { rows } = await pool.query(
      `insert into app_user (clerk_user_id, email, display_name, role, status)
       values ($1, null, $2, 'member', 'active') returning id`,
      [`thesis:${runId}`, `thesis ${runId}`],
    );
    const ctx: GraphOperationContext = {
      actorId: "thesis-harness",
      interfaceId: "thesis-harness",
      requestId: `thesis-${runId}`,
      ownerId: String(rows[0].id),
    };

    // --- ingest: one shared corpus, so every item distracts every other -------
    console.log(`Ingesting ${items.length} items into corpus ${runId}...`);
    const flatUnits: TextUnit[] = [];
    const perItemSources: Array<{ item: ThesisItem; texts: string[] }> = [];
    for (const item of items) {
      for (const [index, text] of item.sessions.entries()) {
        const { textUnits } = await store.ingest(
          { kind: "agent_note", title: `${item.id} session ${index + 1}`, contentText: text, metadata: { item: item.id } },
          ctx,
        );
        flatUnits.push(...textUnits);
      }
      perItemSources.push({ item, texts: item.sessions });
    }
    const itemUnitCount = flatUnits.length;

    // --- trove: distill into linked atoms ------------------------------------
    console.log("Distilling into linked atoms...");
    const hubs = new Set<string>();
    const itemAtomIds = new Set<string>();
    for (const { texts } of perItemSources) {
      for (const text of texts) {
        const parsed = JSON.parse(await chat(MODEL, DISTILL_PROMPT(text), true)) as {
          atoms?: Array<{ title?: string; summary?: string; entities?: string[] }>;
        };
        for (const atom of parsed.atoms ?? []) {
          if (!atom.title || !atom.summary) continue;
          const entities = (atom.entities ?? []).filter((entity) => entity.trim().length > 0);
          // Hubs must exist before anything links to them.
          for (const entity of entities) {
            if (hubs.has(entity)) continue;
            hubs.add(entity);
            await store.capture(
              { title: entity, type: "entity", summary: `Hub for ${entity}.`, content: entity, evidence: [], links: [] },
              ctx,
            );
          }
          const captured = await store.capture(
            {
              title: atom.title,
              type: "claim",
              summary: atom.summary,
              content: atom.summary,
              evidence: [],
              links: entities.map((entity) => ({ toSlug: slugOf(entity), predicate: "mentions" })),
            },
            ctx,
          );
          itemAtomIds.add(captured.id);
        }
      }
    }
    const itemAtomCount = itemAtomIds.size;

    // Reconciliation is enqueued by capture, not performed by it — without
    // draining, `supersedes` edges never exist and the supersede items measure
    // nothing. EMBEDDINGS DRAIN FIRST: reconcile's candidate-match leans on the
    // semantic arm, which is empty until vectors exist (the old blanket drain
    // got this order from job priorities, refresh=40 before reconcile=30).
    // Only item-atom reconciles are drained: distractor reconciles have no
    // measurement value and stay pending (see below).
    console.log("Draining embedding jobs, then item reconciles (reconciliation writes the supersedes edges)...");
    await drainJobs(store, ctx, "refresh_embeddings");
    const reconciled = await drainJobs(store, ctx, "reconcile_node", itemAtomIds);
    console.log(`  drained ${reconciled} item reconciles`);

    // --- distractors: pad BOTH haystacks symmetrically (backlog #31) ----------
    const distractors = await loadDistractors();
    if (distractors.length > 0) {
      console.log(`Ingesting ${distractors.length} distractor notes (flat haystack)...`);
      await mapWithConcurrency(distractors, 8, async (note) => {
        const { textUnits } = await store.ingest(
          { kind: "agent_note", title: `distractor: ${note.title}`, contentText: note.text, metadata: { distractor: true, domain: note.domain } },
          ctx,
        );
        flatUnits.push(...textUnits);
      });
      console.log("Capturing distractor atoms (trove haystack; pre-atomic, no LLM distillation — see backlog #31)...");
      await mapWithConcurrency(distractors, 8, async (note) => {
        await store.capture(
          { title: note.title, type: "claim", summary: note.text, content: note.text, evidence: [], links: [] },
          ctx,
        );
      });
      console.log("Draining embedding jobs (reconcile jobs for distractors stay pending by design)...");
      await drainJobs(store, ctx, "refresh_embeddings");
    }

    console.log(
      `Corpus: ${itemUnitCount} item units + ${flatUnits.length - itemUnitCount} distractor units = ${flatUnits.length} text units; ` +
        `${itemAtomCount} item atoms + ${distractors.length} distractor atoms; ${hubs.size} hubs`,
    );

    if (PREPARE_ONLY) {
      console.log("TROVE_THESIS_PREPARE_ONLY=1 — corpus built, skipping questions.");
      return;
    }

    // --- flat baseline: embed the same units ---------------------------------
    console.log(`Embedding ${flatUnits.length} text units for the flat baseline...`);
    const vectors = new Map<string, number[]>();
    for (let start = 0; start < flatUnits.length; start += 128) {
      const batch = flatUnits.slice(start, start + 128);
      const embedded = await embeddings.embed(batch.map((unit) => unit.text));
      batch.forEach((unit, index) => vectors.set(unit.id, embedded[index] as number[]));
    }

    // --- ask both -------------------------------------------------------------
    const results = new Map<"trove" | "flat", Outcome[]>([["trove", []], ["flat", []]]);
    for (const item of items) {
      // Time each arm's RETRIEVAL alone (backlog #30) — the LLM answer/judge
      // calls that follow are identical across arms and dominated by network, so
      // timing them would drown the signal we care about: what does each system
      // cost to turn a question into context? Trove pays for graph traversal;
      // flat pays for a full-corpus cosine scan. Both embed the query once.
      const troveStart = Date.now();
      const pack = await performRecall(store, { query: item.question, tokenBudget: TOKEN_BUDGET, depth: 1, includeEvidence: true }, ctx);
      const troveMs = Date.now() - troveStart;

      const flatStart = Date.now();
      const [queryVector] = await embeddings.embed([item.question]);
      const flatContext = flatUnits
        .map((unit) => ({ unit, score: cosineSimilarity(queryVector as number[], vectors.get(unit.id) ?? []) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, TOP_K)
        .map(({ unit }) => unit.text)
        .join("\n\n");
      const flatMs = Date.now() - flatStart;

      const arms = [
        ["trove", pack.context, troveMs],
        ["flat", flatContext, flatMs],
      ] as const;
      for (const [system, context, retrievalMs] of arms) {
        const answer = (await chat(MODEL, ANSWER_PROMPT(item.question, context))).trim();
        const verdict = JSON.parse(await chat(JUDGE_MODEL, JUDGE_PROMPT(item.question, item.answers, answer), true)) as { correct?: boolean };
        results.get(system)?.push({
          id: item.id,
          shape: item.shape,
          correct: verdict.correct === true,
          coverage: bridgeCoverage(item, context),
          answer,
          contextTokens: estimateTokens(context),
          retrievalMs,
        });
      }
      process.stdout.write(".");
    }
    console.log("\n");

    report(results);
  } finally {
    await store.close();
    await pool.end();
  }
}

/** Mirrors src/slug.ts's behaviour for the titles this harness creates. */
function slugOf(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function report(results: Map<"trove" | "flat", Outcome[]>): void {
  const shapes: ThesisShape[] = ["bridge", "chain", "supersede", "control"];
  const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${((n / d) * 100).toFixed(0).padStart(3)}%`);

  const cov = (rows: Outcome[]) => `${((rows.reduce((sum, r) => sum + r.coverage, 0) / rows.length) * 100).toFixed(0).padStart(3)}%`;
  console.log("shape       n   trove   flat    trove-cov  flat-cov");
  console.log("--------------------------------------------------------");
  for (const shape of shapes) {
    const trove = results.get("trove")?.filter((r) => r.shape === shape) ?? [];
    const flat = results.get("flat")?.filter((r) => r.shape === shape) ?? [];
    if (trove.length === 0) continue;
    console.log(
      `${shape.padEnd(10)} ${String(trove.length).padStart(2)}   ` +
        `${pct(trove.filter((r) => r.correct).length, trove.length)}   ` +
        `${pct(flat.filter((r) => r.correct).length, flat.length)}   ` +
        `${cov(trove).padStart(8)}  ${cov(flat).padStart(8)}`,
    );
  }

  // The MemScore triple (backlog #30): accuracy is only one leg. A system that
  // wins accuracy while shipping 5x the context tokens or 10x the latency has
  // not won — it has moved the cost somewhere the accuracy column can't see.
  // These are corpus-scale-dependent by construction: flat's cosine scan and
  // token count both grow with the haystack, so the numbers are only meaningful
  // next to the corpus sizes printed above (the standing rule in backlog.md).
  const mean = (rows: Outcome[], pick: (r: Outcome) => number) =>
    rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
  const troveAll = results.get("trove") ?? [];
  const flatAll = results.get("flat") ?? [];
  console.log("\nsystem   accuracy   ctx-tokens (mean)   retrieval-ms (mean)");
  console.log("--------------------------------------------------------------");
  for (const [system, rows] of [["trove", troveAll], ["flat", flatAll]] as const) {
    console.log(
      `${system.padEnd(7)}  ${pct(rows.filter((r) => r.correct).length, rows.length)}      ` +
        `${String(Math.round(mean(rows, (r) => r.contextTokens))).padStart(10)}          ` +
        `${mean(rows, (r) => r.retrievalMs).toFixed(0).padStart(8)}`,
    );
  }

  const multi = (system: "trove" | "flat") => (results.get(system) ?? []).filter((r) => r.shape !== "control");
  const control = (system: "trove" | "flat") => (results.get(system) ?? []).filter((r) => r.shape === "control");
  const rate = (rows: Outcome[]) => (rows.length === 0 ? 0 : rows.filter((r) => r.correct).length / rows.length);

  const multiGap = rate(multi("trove")) - rate(multi("flat"));
  const controlGap = rate(control("trove")) - rate(control("flat"));

  const multiN = multi("trove").length;
  const perItem = multiN === 0 ? 1 : 1 / multiN;

  console.log("\n--- verdict ---");
  console.log(`multi-hop gap (trove - flat): ${(multiGap * 100).toFixed(0)} pts  (n=${multiN}, one item = ${(perItem * 100).toFixed(0)} pts)`);
  console.log(`control gap   (trove - flat): ${(controlGap * 100).toFixed(0)} pts  (n=${control("trove").length})`);

  // Refuse to conclude when the gap is within a couple of items of zero. The
  // LongMemEval pilot reported "40% vs 30%" off ten questions — one question of
  // separation — and that number was quoted back for days as though it meant
  // something. A verdict line is exactly where that mistake gets made, so the
  // sample size gates the sentence, not just the caveat next to it.
  const MIN_MULTI_N = 30;
  if (multiN < MIN_MULTI_N || Math.abs(multiGap) < perItem * 2) {
    console.log(
      `INCONCLUSIVE at this sample size. Need n>=${MIN_MULTI_N} multi-hop items and a gap clearing\n` +
      `two items (${(perItem * 200).toFixed(0)} pts here) before either direction means anything.\n` +
      "Read the per-shape and coverage columns as diagnostics, not as a result.",
    );
  } else if (multiGap > 0 && Math.abs(controlGap) <= 0.15) {
    console.log("SUPPORTS the thesis: ahead on multi-hop, level on single-hop — the graph is doing the work.");
  } else if (multiGap > 0 && controlGap > 0.15) {
    console.log("AMBIGUOUS: ahead everywhere, including single-hop. Something other than traversal explains it —\n" +
      "suspect the dataset or the flat baseline's chunking before claiming the graph.");
  } else {
    console.log("DOES NOT support the thesis: no multi-hop advantage at adequate n. Either distillation is not\n" +
      "building the joining edges, or recall is not traversing them — check trove-cov before blaming ranking.");
  }

  for (const system of ["trove", "flat"] as const) {
    const wrong = (results.get(system) ?? []).filter((r) => !r.correct);
    if (wrong.length === 0) continue;
    console.log(`\n${system} missed ${wrong.length}:`);
    for (const row of wrong) {
      console.log(`  ${row.id} [cov ${(row.coverage * 100).toFixed(0)}%] -> ${row.answer.slice(0, 90)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
