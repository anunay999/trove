/**
 * Track 3 — competitor CALIBRATION arm for the thesis harness.
 *
 * THIS IS AN INSTRUMENT CHECK, NOT A RANKING. Nothing this arm produces is a
 * publishable number. Its only job is to answer one question the two-arm harness
 * cannot: *is the `flat` cosine baseline unusually strong on this corpus?* The
 * backlog records that a lone comparator is exactly how the retracted "-18 pts"
 * became a claim about Trove when it was a fixture artifact (docs/backlog.md,
 * "Track 3" + "Standing rule"). A third, independent system on the SAME 51
 * items and the SAME judge is the cheapest available guard against repeating
 * that mistake.
 *
 * PROVIDER: Mem0, via its open-source library `mem0ai/oss` — NOT the Mem0
 * Platform (cloud).
 *
 * WHY MEM0, AND WHY THE OSS LIBRARY (grounded in bench/FINDINGS.md):
 *   - Mem0 is the only competitor FINDINGS.md ever got as far as attempting
 *     (§1, "Partially attempted"). Zep and Supermemory were never run because
 *     their keys were unfunded ("free tiers likely will not cover a full run").
 *   - FINDINGS.md's Mem0 blocker was specifically the Mem0 *cloud* Platform's
 *     asynchronous indexing phase, which never converged (~1h+, stuck
 *     `in_progress`): "This appears to be provider-side latency rather than
 *     anything fixable here." The OSS `Memory` class sidesteps that entirely —
 *     it extracts and stores synchronously into a LOCAL in-memory vector store,
 *     with no cloud indexing phase to wait on.
 *   - The OSS library reuses the harness's EXISTING dependency: it drives its
 *     own fact-extraction and embedding through `OPENAI_API_KEY`, which the
 *     thesis harness already requires. So the calibration arm needs no funded
 *     third-party key beyond the OpenAI key already in play — unlike Zep, which
 *     is cloud-only and (§Secondary) also overrides the grader's prompt.
 *
 * FINDINGS.md QUIRKS THIS ARM HANDLES:
 *   1. Cloud indexing non-convergence (§1) — avoided by construction: OSS local
 *      `Memory`, `provider: "memory"` vector store, no async indexing.
 *   2. Silent extraction failures (§Secondary) — the old adapter swallowed them
 *      ("index.ts:177"). Here every failed `add` is counted and warned, never
 *      hidden.
 *   3. Judge/prompt contamination (§Secondary, the Zep lesson) — this arm
 *      supplies RETRIEVAL CONTEXT ONLY. It is answered with the harness's own
 *      ANSWER_PROMPT and graded by the harness's own JUDGE_PROMPT, exactly like
 *      the `flat` arm. Mem0 never sees the question-answering or grading path,
 *      so the comparison stays apples-to-apples.
 *   4. Slow, sequential ingest (§Secondary, "~169 s/question") — disclosed. Each
 *      `add` runs an LLM extraction call; padding the competitor's haystack with
 *      the 7,202 distractors is thousands of extra LLM calls (see the cost
 *      warning printed at run time and TROVE_THESIS_COMPETITOR_DISTRACTORS).
 *
 * WHAT A CALIBRATION PASS WOULD TELL US:
 *   - Whether `flat` is anomalously strong here: if a mature, independent memory
 *     system ALSO loses to raw top-k cosine on these items, that is evidence the
 *     corpus/shape favours span retrieval — a property of the instrument, not of
 *     Trove. That is precisely the artifact the two-arm harness cannot detect.
 *   - A rough sanity band: does Trove's 65% / flat 57% sit somewhere plausible
 *     next to a third system on identical items and judge, or is one arm an
 *     outlier?
 *
 * WHAT IT WOULD NOT TELL US:
 *   - A publishable Trove-vs-Mem0 ranking. This is Mem0-as-context-supplier
 *     under Trove's harness (our prompt, our judge, our corpus shape — which
 *     FINDINGS.md argues is the WRONG shape for these systems). Write policies
 *     differ; neither side is "the product as shipped".
 *   - Anything about Mem0's real product performance.
 *   - Anything comparable at all UNLESS the competitor ingests the same
 *     distractor haystack. Run without distractors and its number is doubly
 *     non-comparable (smaller world) — hence the loud disclosure.
 *
 * EXTERNAL DEPENDENCY TO ACTUALLY RUN (disclosed):
 *   - `npm i mem0ai` (the OSS library; not added to package.json so the default
 *     no-flag harness path installs and runs unchanged).
 *   - `OPENAI_API_KEY` — already required by the harness; Mem0 OSS reuses it for
 *     its own extraction + embeddings. No Mem0 cloud key, no network service
 *     beyond OpenAI, no Qdrant (the in-memory vector store needs nothing).
 *
 * ENABLE WITH:  TROVE_THESIS_COMPETITOR=mem0
 * When unset (the default), this module is inert and the harness is byte-for-byte
 * the existing two-arm run.
 */

const raw = (process.env.TROVE_THESIS_COMPETITOR ?? "").trim().toLowerCase();

/** True only when an explicit, non-falsy provider name is requested. */
export const COMPETITOR_ENABLED = raw !== "" && raw !== "0" && raw !== "false";

/** `1` is a convenience alias for the single scaffolded provider. */
export const COMPETITOR_NAME = raw === "1" ? "mem0" : raw;

/**
 * Symmetric haystack. Defaults ON because comparability REQUIRES the competitor
 * see the same 7,202-unit corpus as trove/flat — a number from a smaller world
 * is not comparable. Set TROVE_THESIS_COMPETITOR_DISTRACTORS=0 only for a cheap
 * wiring smoke test, and treat its output as non-comparable.
 */
export const COMPETITOR_DISTRACTORS = (process.env.TROVE_THESIS_COMPETITOR_DISTRACTORS ?? "1") !== "0";

/** Retrieval context supplier. Mirrors the `flat` arm's contract: text in, joined context out. */
export interface CompetitorProvider {
  readonly name: string;
  /** Count of `add` calls that threw — surfaced, never swallowed (FINDINGS.md §Secondary). */
  readonly ingestFailures: number;
  /** Store one session's raw text. Failures are counted and warned, not thrown. */
  ingest(sessionId: string, text: string): Promise<void>;
  /** Retrieve top-k memories for the question and join them into a context string. */
  search(query: string): Promise<string>;
  close(): Promise<void>;
}

// Minimal structural view of `mem0ai/oss`, so this file typechecks without the
// package installed. The dynamic import below uses a NON-LITERAL specifier on
// purpose: TypeScript then types the result as `any` and skips module
// resolution, so `npm i mem0ai` is needed only to RUN, never to typecheck.
interface Mem0SearchResult {
  results?: Array<{ memory?: string; score?: number }>;
}
interface Mem0Memory {
  add(
    messages: Array<{ role: string; content: string }>,
    options: { userId: string; metadata?: Record<string, unknown> },
  ): Promise<unknown>;
  search(query: string, options: { filters: { userId: string }; limit?: number }): Promise<Mem0SearchResult>;
}
interface Mem0Module {
  Memory: new (config?: unknown) => Mem0Memory;
}

export async function createCompetitorProvider(opts: { runId: string; topK: number }): Promise<CompetitorProvider> {
  if (COMPETITOR_NAME !== "mem0") {
    throw new Error(
      `TROVE_THESIS_COMPETITOR='${COMPETITOR_NAME}' is not scaffolded. Only 'mem0' exists as a calibration arm.`,
    );
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("The mem0 calibration arm needs OPENAI_API_KEY (Mem0 OSS uses it for extraction + embeddings).");
  }

  // Non-literal specifier: keeps `tsc` from requiring the package at typecheck.
  const specifier = "mem0ai/oss";
  let mod: Mem0Module;
  try {
    mod = (await import(specifier)) as Mem0Module;
  } catch (error) {
    throw new Error(
      "TROVE_THESIS_COMPETITOR=mem0 is set but the 'mem0ai' package is not installed. " +
        "Run `npm i mem0ai` to enable the Track 3 calibration arm. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const model = process.env.TROVE_THESIS_MODEL ?? "gpt-4o";
  const userId = `thesis-${opts.runId}`;
  // OSS defaults are already OpenAI + in-memory; we pin them explicitly so the
  // arm never silently reaches for a cloud store or a different model.
  const memory = new mod.Memory({
    llm: { provider: "openai", config: { apiKey, model } },
    embedder: { provider: "openai", config: { apiKey, model: "text-embedding-3-small" } },
    vectorStore: { provider: "memory", config: { collectionName: `thesis-${opts.runId}`, dimension: 1536 } },
  });

  let ingestFailures = 0;
  return {
    name: "mem0",
    get ingestFailures(): number {
      return ingestFailures;
    },
    async ingest(sessionId: string, text: string): Promise<void> {
      try {
        await memory.add([{ role: "user", content: text }], { userId, metadata: { session: sessionId } });
      } catch (error) {
        ingestFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  WARN: mem0 ingest failed for ${sessionId}: ${message.slice(0, 120)} (counted, not hidden)`);
      }
    },
    async search(query: string): Promise<string> {
      const res = await memory.search(query, { filters: { userId }, limit: opts.topK });
      return (res.results ?? [])
        .map((r) => r.memory ?? "")
        .filter((memoryText) => memoryText.length > 0)
        .join("\n\n");
    },
    async close(): Promise<void> {
      // In-memory store: nothing to tear down. Present for interface symmetry.
    },
  };
}
