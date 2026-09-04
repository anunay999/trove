import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeStore, hasPostgres, isolateDatabase, suiteStore } from "./helpers.js";
import {
  buildChatMessages,
  citedSlugs,
  createGraphChatModelFromEnv,
  parseChatDelta,
  providerErrorMessage,
  type GraphChatModel,
} from "../src/chatModel.js";
import { encodeChatEvent, graphChatResponse, runGraphChat, type GraphChatEvent } from "../src/graphChat.js";
import { createGraphStore } from "../src/createStore.js";
import type { GraphStore } from "../src/graphCore.js";
import { UserStore } from "../src/users.js";

// Both retrieval arms must REPORT, so both must exist: the deterministic
// offline provider gives this suite a semantic arm on either driver.
process.env.TROVE_EMBEDDING_PROVIDER = "fake";
// The env-built model must stay off while these tests run; every test injects
// its own. Explicit rather than assumed, because a developer's .env may have
// both an OPENAI_API_KEY and the flag set.
delete process.env.TROVE_GRAPH_CHAT;

// Packing is budget-sensitive and this suite asserts on which atoms made the
// pack: nodes left by a neighbouring suite would compete for the same budget.
await isolateDatabase("graph-chat");

/** Collect a whole turn. */
async function collect(events: AsyncGenerator<GraphChatEvent>): Promise<GraphChatEvent[]> {
  const out: GraphChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** A model that answers with fixed text, one "token" per chunk. */
function scriptedModel(chunks: string[], name = "fake-chat"): GraphChatModel {
  return {
    name,
    // eslint-disable-next-line require-yield
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * A model that emits one token and then hangs until aborted, recording in
 * `state` whether its own cleanup ran. This is how "a dropped stream does not
 * leak a connection" is observable without a real socket: the generator's
 * finally is exactly where the real provider cancels its reader.
 */
function hangingModel(state: { released: boolean }): GraphChatModel {
  return {
    name: "hanging-fake",
    async *stream({ signal }) {
      try {
        yield "thinking";
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      } finally {
        state.released = true;
      }
    },
  };
}

describe("provider error messages", () => {
  it("prefers the provider's own message over the raw body", () => {
    const body = JSON.stringify({ error: { message: "No endpoints found matching your data policy." } });
    assert.equal(providerErrorMessage(body), "No endpoints found matching your data policy.");
  });

  it("reaches the nested raw message OpenRouter sometimes wraps", () => {
    const body = JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "model requires prompt logging" } } });
    assert.equal(providerErrorMessage(body), "Provider returned error");
  });

  it("falls back to text, stripped of markup, for a gateway that answers HTML", () => {
    assert.equal(providerErrorMessage("<html><body>403 Forbidden</body></html>"), "403 Forbidden");
  });

  it("is empty for an empty body, so the caller shows the status alone", () => {
    assert.equal(providerErrorMessage("   "), "");
  });

  it("caps a long body so a notice stays readable", () => {
    const long = providerErrorMessage(JSON.stringify({ error: { message: "x".repeat(500) } }));
    assert.equal(long.length, 301);
    assert.ok(long.endsWith("\u2026"));
  });
});

describe("graph chat", () => {
  const { store, context, stamp } = suiteStore("graph-chat");
  const MARK = `zephyrite${stamp}`;
  const QUESTION = `What did the ${MARK} rollout decide?`;

  let hubId: string;
  let hubSlug: string;
  let neighborId: string;
  let strangerId: string;

  before(async () => {
    await store.ingest({
      kind: "agent_note",
      title: `Chat evidence ${MARK}`,
      contentText: [
        `# ${MARK} rollout`,
        "",
        `The ${MARK} rollout decided to ship the pack budget before the reranker.`,
      ].join("\n"),
      metadata: { smoke: true },
    }, context);

    const hub = await store.capture({
      title: `${MARK} rollout decision`,
      type: "decision",
      summary: `The ${MARK} rollout shipped the token budget first.`,
      content: `The ${MARK} rollout decided the token budget lands before the reranker, because ranking is the bottleneck and a budget is the thing a pack is spent against.`,
      evidence: [],
      links: [],
    }, context);
    hubId = hub.id;
    hubSlug = hub.slug;

    // Deliberately shares no vocabulary with the question: the only way this
    // node can light up is graph traversal from the hub.
    const neighbor = await store.capture({
      title: `Budget guard pattern ${stamp}`,
      type: "pattern",
      summary: "A wire guard keeps a serialized response within a multiple of its budget.",
      content: "The guard shrinks neighbour teasers first, then drops the least relevant evidence, and never cuts the primary match.",
      evidence: [],
      links: [],
    }, context);
    neighborId = neighbor.id;

    const stranger = await store.capture({
      title: `Unrelated kitchen note ${stamp}`,
      type: "claim",
      summary: "Sourdough starters want a warm shelf.",
      content: "Nothing here touches retrieval, ranking, or budgets in any way.",
      evidence: [],
      links: [],
    }, context);
    strangerId = stranger.id;

    const edge = await store.link({ fromNodeId: hubId, toNodeId: neighborId, predicate: "depends_on", weight: 1 }, context);
    assert.ok(edge, "hub-neighbor edge was not created");
  });

  after(async () => {
    await closeStore(store);
  });

  it("streams the real retrieval stages in the order recall runs them", async () => {
    const events = await collect(runGraphChat(store, { query: QUESTION }, context, {
      model: scriptedModel([`The rollout shipped the budget first `, `[[${hubSlug}]].`]),
    }));
    const types = events.map((event) => event.type);

    assert.equal(types[0], "start", "the turn must open with start");
    assert.equal(types.at(-1), "done", "done is always terminal");

    // Stage order is recall's own order, not a sort we imposed.
    const firstOf = (type: GraphChatEvent["type"]) => types.indexOf(type);
    assert.ok(firstOf("seeds") > 0, "no retrieval arm reported");
    assert.ok(firstOf("fused") > firstOf("seeds"), "fusion cannot precede its arms");
    assert.ok(firstOf("rank") > firstOf("fused"), "ranking cannot precede the seed pool");
    assert.ok(firstOf("pack") > firstOf("rank"), "packing cannot precede ranking");
    assert.ok(firstOf("answer_start") > firstOf("pack"), "the answer cannot precede its pack");
    assert.ok(firstOf("token") > firstOf("answer_start"), "tokens cannot precede answer_start");

    // Both arms of hybrid search report, each with its own name.
    const arms = events.flatMap((event) => (event.type === "seeds" ? [event.arm] : []));
    assert.ok(arms.includes("lexical"), `expected a lexical arm, got ${arms.join(",")}`);
    assert.ok(arms.includes("semantic"), `expected a semantic arm, got ${arms.join(",")}`);

    // Every event is stamped with real elapsed time, and time never runs back.
    const elapsed = events.map((event) => event.elapsedMs);
    assert.deepEqual(elapsed, [...elapsed].sort((left, right) => left - right), "elapsedMs went backwards");
  });

  it("names the seed that matched and the hop distance of what expansion reached", async () => {
    const events = await collect(runGraphChat(store, { query: QUESTION }, context, {
      model: scriptedModel(["ok"]),
    }));

    const fused = events.find((event) => event.type === "fused");
    assert.ok(fused && fused.type === "fused");
    assert.ok(fused.nodes.some((node) => node.id === hubId), "the lexical hit was not a seed");
    assert.ok(!fused.nodes.some((node) => node.id === neighborId), "the neighbour shares no query terms and must not be a seed");

    const expansions = events.flatMap((event) => (event.type === "expand" ? [event] : []));
    assert.ok(expansions.length > 0, "no expansion was reported");
    const reached = expansions.flatMap((event) => event.nodes);
    const neighbour = reached.find((node) => node.id === neighborId);
    assert.ok(neighbour, "the linked neighbour was never reached by expansion");
    assert.equal(neighbour.hops, 1, "a directly linked node is one hop away");
    // Expansion reports what it ADDED. A node already in the seed pool was not
    // reached by traversal and must not be claimed as such.
    assert.ok(!reached.some((node) => node.id === hubId), "a seed was re-reported as an expansion hit");

    const pack = events.find((event) => event.type === "pack");
    assert.ok(pack && pack.type === "pack");
    assert.ok(pack.atoms.some((atom) => atom.id === hubId), "the matching node did not survive into the pack");
    assert.ok(pack.spentTokens > 0 && pack.spentTokens <= pack.tokenBudget, "the pack ignored its budget");
    assert.ok(!pack.atoms.some((atom) => atom.id === strangerId), "an unrelated node was packed");
  });

  it("streams a model's tokens and cites only slugs the answer actually wrote", async () => {
    const chunks = ["The rollout ", "shipped the budget ", `first [[${hubSlug}]]`, " [[never-a-real-slug]]."];
    const events = await collect(runGraphChat(store, { query: QUESTION }, context, {
      model: scriptedModel(chunks, "cheap-fake"),
    }));

    const start = events.find((event) => event.type === "answer_start");
    assert.ok(start && start.type === "answer_start");
    assert.equal(start.model, "cheap-fake", "the answering model is named on the wire");

    const tokens = events.flatMap((event) => (event.type === "token" ? [event.text] : []));
    assert.deepEqual(tokens, chunks, "tokens must arrive as the model produced them");

    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.finish, "ok");
    assert.equal(done.answer, chunks.join(""));
    assert.deepEqual(done.citedNodeIds, [hubId], "only a packed slug the answer wrote counts as cited");
    assert.ok(done.citations.length >= 0, "citations ride the terminal event");
  });

  it("streams the whole traversal and returns the pack when no model is configured", async () => {
    const events = await collect(runGraphChat(store, { query: QUESTION }, context, { model: null }));

    const pack = events.find((event) => event.type === "pack");
    assert.ok(pack && pack.type === "pack");
    assert.ok(pack.atoms.length > 0, "the pack is the point when there is no model");

    const start = events.find((event) => event.type === "answer_start");
    assert.ok(start && start.type === "answer_start");
    assert.equal(start.model, null);

    const notice = events.find((event) => event.type === "notice");
    assert.ok(notice && notice.type === "notice");
    assert.equal(notice.code, "model_not_configured");
    assert.match(notice.message, /TROVE_GRAPH_CHAT/);

    assert.ok(!events.some((event) => event.type === "token"), "no model means no tokens");
    assert.ok(!events.some((event) => event.type === "error"), "an unconfigured model is not an error");

    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.finish, "no_model");
    assert.equal(done.answer, "");
    assert.deepEqual(done.citedNodeIds, []);
  });

  it("says so, and asks no model, when retrieval finds nothing", async () => {
    let asked = false;
    const model: GraphChatModel = {
      name: "must-not-run",
      async *stream() {
        asked = true;
        yield "invented";
      },
    };
    const events = await collect(runGraphChat(
      store,
      { query: `qzxvwk${stamp}mnprltg unmatchable phrase` },
      context,
      { model },
    ));

    const pack = events.find((event) => event.type === "pack");
    assert.ok(pack && pack.type === "pack");
    assert.equal(pack.atoms.length, 0);

    const notice = events.find((event) => event.type === "notice");
    assert.ok(notice && notice.type === "notice");
    assert.equal(notice.code, "no_results");

    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.finish, "no_results");
    assert.equal(asked, false, "an empty pack must never be handed to a model");
  });

  it("reports a model that dies mid-answer without losing what arrived", async () => {
    const model: GraphChatModel = {
      name: "flaky-fake",
      async *stream() {
        yield "half an ";
        throw new Error("upstream closed the stream");
      },
    };
    const events = await collect(runGraphChat(store, { query: QUESTION }, context, { model }));

    const failure = events.find((event) => event.type === "error");
    assert.ok(failure && failure.type === "error");
    assert.equal(failure.code, "model_failed");
    assert.match(failure.message, /upstream closed/);

    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.finish, "error");
    assert.equal(done.answer, "half an ", "the partial answer is kept, not discarded");
  });

  it("releases the model when the consumer walks away mid-answer", async () => {
    const state = { released: false };
    const events = runGraphChat(store, { query: QUESTION }, context, { model: hangingModel(state) });
    for await (const event of events) {
      if (event.type === "token") break;
    }
    assert.equal(state.released, true, "abandoning the stream must abort the model call");
  });

  it("serves the same turn as Server-Sent Events, and cancels cleanly", async () => {
    const response = graphChatResponse(store, { query: QUESTION }, context, {
      model: scriptedModel(["answered"]),
    });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    const text = await response.text();
    const parsed = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as GraphChatEvent);
    assert.equal(parsed[0]?.type, "start");
    assert.equal(parsed.at(-1)?.type, "done");
    assert.ok(parsed.some((event) => event.type === "pack"));

    // And a reader that hangs up releases the model rather than orphaning it.
    const state = { released: false };
    const live = graphChatResponse(store, { query: QUESTION }, context, { model: hangingModel(state) });
    const reader = live.body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(state.released, true, "cancelling the response must abort the model call");
  });

  it("rejects a question the schema will not carry", async () => {
    await assert.rejects(
      () => collect(runGraphChat(store, { query: "" }, context, { model: null })),
      /query/i,
    );
  });
});

// One tenant's question must never light up — or cite — another tenant's node.
// Per-owner scoping is a property of the Postgres store; the in-memory driver
// is single-user by construction (see tests/isolation.test.ts).
describe("graph chat owner scoping", { skip: hasPostgres() ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const MARK = `TENANTMARK${stamp}`;
  let store: GraphStore;
  let users: UserStore;
  let aliceId: string;
  let aliceSlug: string;
  let alice: { actorId: string; interfaceId: string; requestId: string; ownerId: string };
  let bob: typeof alice;

  before(async () => {
    store = createGraphStore().store;
    users = new UserStore({ connectionString: process.env.DATABASE_URL as string });
    const a = await users.ensureUser({ clerkUserId: `chat-alice-${stamp}`, email: `chat-alice-${stamp}@example.com` });
    const b = await users.ensureUser({ clerkUserId: `chat-bob-${stamp}`, email: `chat-bob-${stamp}@example.com` });
    alice = { actorId: "chat-alice", interfaceId: "chat-alice", requestId: `chat-alice-${stamp}`, ownerId: a.id };
    bob = { actorId: "chat-bob", interfaceId: "chat-bob", requestId: `chat-bob-${stamp}`, ownerId: b.id };

    const secret = await store.capture({
      title: `Alice ${MARK} rollout`,
      type: "decision",
      summary: `Alice decided the ${MARK} rollout ships on Friday.`,
      content: `Only Alice should ever see ${MARK}.`,
      evidence: [],
      links: [],
    }, alice);
    aliceId = secret.id;
    aliceSlug = secret.slug;

    await store.capture({
      title: `Bob unrelated note ${stamp}`,
      type: "claim",
      summary: "Bob keeps his own notes.",
      content: "Bob's graph has nothing to do with Alice's rollout.",
      evidence: [],
      links: [],
    }, bob);
  });

  after(async () => {
    await closeStore(store);
    await users.close?.();
  });

  it("never lights or cites a node belonging to another owner", async () => {
    const events = await collect(runGraphChat(
      store,
      { query: `What did the ${MARK} rollout decide?` },
      bob,
      { model: scriptedModel([`I will try to cite [[alice-${MARK.toLowerCase()}-rollout]].`]) },
    ));

    // Only the retrieval events: the model's own (invented) text is echoed back
    // on token/done by construction, and proves nothing either way.
    const retrieval = events.filter((event) =>
      ["seeds", "fused", "expand", "rank", "pack"].includes(event.type));
    const serialized = JSON.stringify(retrieval);
    assert.ok(!serialized.includes(aliceId), "another owner's node id reached the stream");
    assert.ok(!serialized.includes(aliceSlug), "another owner's slug reached the stream");

    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.deepEqual(done.citedNodeIds, [], "a slug outside the pack can never be cited");

    // And Alice, asking the same question, does see her own node.
    const hers = await collect(runGraphChat(
      store,
      { query: `What did the ${MARK} rollout decide?` },
      alice,
      { model: null },
    ));
    const pack = hers.find((event) => event.type === "pack");
    assert.ok(pack && pack.type === "pack");
    assert.ok(pack.atoms.some((atom) => atom.id === aliceId), "the owner's own node must be retrievable");
  });
});

describe("graph chat model plumbing", () => {
  it("stays off unless the flag and a key are both present", () => {
    const flag = process.env.TROVE_GRAPH_CHAT;
    const key = process.env.OPENAI_API_KEY;
    try {
      delete process.env.TROVE_GRAPH_CHAT;
      process.env.OPENAI_API_KEY = "sk-test";
      assert.equal(createGraphChatModelFromEnv(), null, "no flag means no model");

      process.env.TROVE_GRAPH_CHAT = "yes";
      delete process.env.OPENAI_API_KEY;
      assert.equal(createGraphChatModelFromEnv(), null, "no key means no model");

      process.env.OPENAI_API_KEY = "sk-test";
      process.env.TROVE_CHAT_MODEL = "deepseek-chat";
      assert.equal(createGraphChatModelFromEnv()?.name, "deepseek-chat", "TROVE_CHAT_MODEL names the model");
    } finally {
      delete process.env.TROVE_CHAT_MODEL;
      if (flag === undefined) delete process.env.TROVE_GRAPH_CHAT;
      else process.env.TROVE_GRAPH_CHAT = flag;
      if (key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = key;
    }
  });

  it("grounds the prompt in the pack and nothing else", () => {
    const messages = buildChatMessages("what shipped?", {
      context: "## Shipped thing [decision/match] (shipped-thing)\nIt shipped.",
      atoms: [{
        node: {
          id: "n1", type: "decision", slug: "shipped-thing", title: "Shipped thing",
          summary: null, content: "It shipped.", revisionId: "r1",
          updatedAt: new Date().toISOString(), accessCount: 0, lastAccessedAt: null,
        },
        provenance: "citation", score: 1, hops: 0, tokens: 10, contentTruncated: false,
      }],
      edges: [], evidence: [], citations: [], tokenBudget: 4000, spentTokens: 10, truncated: false,
    });
    assert.equal(messages.length, 2);
    assert.match(messages[0]!.content, /Answer ONLY from the context/);
    assert.match(messages[1]!.content, /\[\[shipped-thing\]\] — Shipped thing/);
    assert.match(messages[1]!.content, /QUESTION: what shipped\?/);
  });

  it("counts only citations of slugs the pack carried", () => {
    const cited = citedSlugs("Per [[real-one]] and [[made-up]], yes. [[real-one]] again.", ["real-one", "other"]);
    assert.deepEqual([...cited], ["real-one"]);
  });

  it("reads OpenAI-compatible stream frames and ignores everything else", () => {
    assert.equal(parseChatDelta(`data: {"choices":[{"delta":{"content":"hi"}}]}`), "hi");
    assert.equal(parseChatDelta("data: [DONE]"), null);
    assert.equal(parseChatDelta(": keepalive"), null);
    assert.equal(parseChatDelta(`data: {"choices":[{"delta":{}}]}`), null);
    assert.equal(parseChatDelta("data: not json"), null);
  });

  it("encodes one event per SSE frame", () => {
    const frame = encodeChatEvent({ type: "token", text: "a\nb", elapsedMs: 5 });
    assert.equal(frame, `data: {"type":"token","text":"a\\nb","elapsedMs":5}\n\n`);
    assert.ok(!frame.slice(0, -2).includes("\n\n"), "a frame must not contain a frame boundary");
  });
});
