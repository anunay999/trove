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
import pg from "pg";
import { PgGraphStore } from "../../src/pgStore.js";
import { performRecall } from "../../src/graphCore.js";
import type { GraphOperationContext, TextUnit } from "../../src/graphCore.js";
import { cosineSimilarity, createEmbeddingProviderFromEnv } from "../../src/embeddings.js";
import { THESIS_ITEMS, validateDataset, type ThesisItem, type ThesisShape } from "./dataset.js";

const DATABASE_URL = process.env.TROVE_THESIS_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const MODEL = process.env.TROVE_THESIS_MODEL ?? "gpt-4o";
const JUDGE_MODEL = process.env.TROVE_THESIS_JUDGE_MODEL ?? "gpt-4o";
const TOP_K = Number(process.env.TROVE_THESIS_TOP_K ?? 8);
const TOKEN_BUDGET = Number(process.env.TROVE_THESIS_TOKEN_BUDGET ?? 8000);
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

type Outcome = {
  id: string;
  shape: ThesisShape;
  correct: boolean;
  coverage: number;
  answer: string;
};

async function chat(model: string, prompt: string, jsonMode = false): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`${model}: OpenAI ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
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
  // supersedes edge. Forcing the heuristic here (as the deleted MemoryBench
  // provider correctly did, for a corpus it deliberately distorted) silently
  // turns those items into a plain retrieval test that reads as a tie.
  const judgeDisabled = process.env.TROVE_RECONCILE_JUDGE === "0";
  const hasSupersedeItems = THESIS_ITEMS.some((item) => item.shape === "supersede");
  if (judgeDisabled && hasSupersedeItems) {
    throw new Error(
      "TROVE_RECONCILE_JUDGE=0 disables the supersedes edges the `supersede` items exist to test. " +
        "Unset it, or drop those items and say so when reporting.",
    );
  }
  const store = new PgGraphStore({ connectionString: DATABASE_URL });
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const runId = randomUUID().slice(0, 8);

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
    console.log(`Ingesting ${THESIS_ITEMS.length} items into corpus ${runId}...`);
    const flatUnits: TextUnit[] = [];
    const perItemSources: Array<{ item: ThesisItem; texts: string[] }> = [];
    for (const item of THESIS_ITEMS) {
      for (const [index, text] of item.sessions.entries()) {
        const { textUnits } = await store.ingest(
          { kind: "agent_note", title: `${item.id} session ${index + 1}`, contentText: text, metadata: { item: item.id } },
          ctx,
        );
        flatUnits.push(...textUnits);
      }
      perItemSources.push({ item, texts: item.sessions });
    }

    // --- trove: distill into linked atoms ------------------------------------
    console.log("Distilling into linked atoms...");
    const hubs = new Set<string>();
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
          await store.capture(
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
        }
      }
    }

    // Reconciliation is enqueued by capture, not performed by it. Without
    // draining, `supersedes` edges never exist and the supersede items measure
    // nothing — the failure mode is silent, which is why it is a loop and not a
    // comment. lint/embedding jobs drain here too, which is harmless.
    console.log("Draining graph jobs (reconciliation writes the supersedes edges)...");
    let drained = 0;
    while (drained < 2000) {
      const job = await store.runJob({}, ctx);
      if (!job) break;
      drained += 1;
      if (job.status === "failed" || (job.status as string) === "dead") {
        throw new Error(`job ${job.kind} ${job.status}: ${job.error}`);
      }
    }
    console.log(`  drained ${drained} jobs`);

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
    for (const item of THESIS_ITEMS) {
      const pack = await performRecall(store, { query: item.question, tokenBudget: TOKEN_BUDGET, depth: 1, includeEvidence: true }, ctx);

      const [queryVector] = await embeddings.embed([item.question]);
      const flatContext = flatUnits
        .map((unit) => ({ unit, score: cosineSimilarity(queryVector as number[], vectors.get(unit.id) ?? []) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, TOP_K)
        .map(({ unit }) => unit.text)
        .join("\n\n");

      for (const [system, context] of [["trove", pack.context], ["flat", flatContext]] as const) {
        const answer = (await chat(MODEL, ANSWER_PROMPT(item.question, context))).trim();
        const verdict = JSON.parse(await chat(JUDGE_MODEL, JUDGE_PROMPT(item.question, item.answers, answer), true)) as { correct?: boolean };
        results.get(system)?.push({
          id: item.id,
          shape: item.shape,
          correct: verdict.correct === true,
          coverage: bridgeCoverage(item, context),
          answer,
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

  console.log("shape       n   trove   flat    trove-cov  flat-cov");
  console.log("--------------------------------------------------------");
  for (const shape of shapes) {
    const trove = results.get("trove")?.filter((r) => r.shape === shape) ?? [];
    const flat = results.get("flat")?.filter((r) => r.shape === shape) ?? [];
    if (trove.length === 0) continue;
    const cov = (rows: Outcome[]) => `${((rows.reduce((sum, r) => sum + r.coverage, 0) / rows.length) * 100).toFixed(0).padStart(3)}%`;
    console.log(
      `${shape.padEnd(10)} ${String(trove.length).padStart(2)}   ` +
        `${pct(trove.filter((r) => r.correct).length, trove.length)}   ` +
        `${pct(flat.filter((r) => r.correct).length, flat.length)}   ` +
        `${cov(trove).padStart(8)}  ${cov(flat).padStart(8)}`,
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
