import { createGraphStore } from "../../src/createStore.js";
import { remember as agentRemember, readAny } from "../../src/agentOps.js";
import type { GraphStore, GraphOperationContext } from "../../src/graphCore.js";
import { UserStore } from "../../src/users.js";
import { slugify } from "../../src/slug.js";
import { LOCAL_DATABASE_URL } from "./env.js";
import type { AgentTool } from "./agent.js";

export type Arm = {
  name: string;
  /** Fresh memory for a new run (scenario × seed). Persists across sessions within a run. */
  reset: (runId: string) => Promise<void>;
  /** Tools handed to the agent this session. */
  tools: () => AgentTool[];
  close: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// nomem — control arm. No tools, no persistence. Every session is fresh.
// ---------------------------------------------------------------------------
export function createNomemArm(): Arm {
  return {
    name: "nomem",
    async reset() {},
    tools: () => [],
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// scratchpad — a single notes buffer. A fair "files are all you need" rival:
// same tool budget, free read/write. Appends ACCUMULATE (no auto-dedupe), so a
// superseded fact and its replacement can coexist in the notes — by design.
// ---------------------------------------------------------------------------
export function createScratchpadArm(): Arm {
  let notes = "";
  return {
    name: "scratchpad",
    async reset() {
      notes = "";
    },
    tools: () => [
      {
        name: "read_notes",
        description: "Read your full notes buffer (everything you have written across sessions).",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run() {
          return notes.trim().length > 0 ? notes : "(notes are empty)";
        },
      },
      {
        name: "write_notes",
        description:
          "Append text to your notes buffer. Use this to record durable facts for future sessions. Appends accumulate; existing notes are never overwritten.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Text to append to your notes." } },
          required: ["text"],
          additionalProperties: false,
        },
        async run(args) {
          const text = String(args.text ?? "").trim();
          if (!text) return "Nothing written (empty text).";
          notes += (notes ? "\n" : "") + text;
          return "Appended to notes.";
        },
      },
    ],
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// trove — agent memory backed by the LOCAL Trove graph store. A fresh, unique
// owner per run isolates each run's graph. NEVER the hosted prod MCP.
// ---------------------------------------------------------------------------
export function createTroveArm(): Arm {
  // Pin the local docker DSN so createGraphStore selects Postgres locally.
  process.env.TROVE_STORE = "postgres";
  process.env.DATABASE_URL = LOCAL_DATABASE_URL;

  const { store, driver } = createGraphStore() as { store: GraphStore; driver: string };
  if (driver !== "postgres") {
    throw new Error(`trove arm requires the postgres driver, got ${driver}`);
  }
  const users = new UserStore({ connectionString: LOCAL_DATABASE_URL });

  let ctx: GraphOperationContext = {};

  return {
    name: "trove",
    async reset(runId) {
      // A fresh app_user => a fresh, isolated graph scope for this run.
      const clerkId = `taskbench-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const user = await users.ensureUser({
        clerkUserId: clerkId,
        email: `${clerkId}@task-eval.local`,
        displayName: "task-eval runner",
      });
      ctx = { ownerId: user.id, actorId: clerkId, interfaceId: "task-eval" };
    },
    tools: () => [
      {
        name: "recall",
        description:
          "Retrieve a short brief for an open question from your memory (semantic + keyword). Use this before answering questions that depend on facts recorded earlier. Outdated facts are shown marked SUPERSEDED.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Plain-language question, e.g. 'How do we handle refunds for annual plans?'" } },
          required: ["query"],
          additionalProperties: false,
        },
        async run(args) {
          const query = String(args.query ?? "").trim();
          if (!query) return "(empty query)";
          const result = await store.recall({ query, tokenBudget: 2000 }, ctx);
          return result.context.trim().length > 0 ? result.context : "(no memory found for that query)";
        },
      },
      {
        name: "remember",
        description:
          "Save a new durable fact so future sessions can use it. Provide a short descriptive title and a one-line summary of the fact.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short descriptive title, e.g. 'Refund policy for annual plans'." },
            summary: { type: "string", description: "The fact itself, one line." },
          },
          required: ["title", "summary"],
          additionalProperties: false,
        },
        async run(args) {
          const title = String(args.title ?? "").trim();
          const summary = String(args.summary ?? "").trim();
          if (!title || !summary) return "Need both title and summary.";
          const res = await agentRemember(store, { title, summary, type: "claim" }, ctx);
          return `Saved (${res.action}) as "${res.node.title}" [${res.node.slug}].`;
        },
      },
      {
        name: "supersede",
        description:
          "Record that a previously saved fact has CHANGED. Give the title of the existing (old) note, a title for the new note, and the new fact. This saves the new fact and links it so the old note is marked outdated on future recalls. Recall first if you don't know the old note's exact title.",
        parameters: {
          type: "object",
          properties: {
            old_title: { type: "string", description: "Title (or close match) of the existing note being replaced." },
            new_title: { type: "string", description: "Title for the new, current fact." },
            new_summary: { type: "string", description: "The new, current fact, one line." },
          },
          required: ["old_title", "new_title", "new_summary"],
          additionalProperties: false,
        },
        async run(args) {
          const oldTitle = String(args.old_title ?? "").trim();
          const newTitle = String(args.new_title ?? "").trim();
          const newSummary = String(args.new_summary ?? "").trim();
          if (!oldTitle || !newTitle || !newSummary) return "Need old_title, new_title and new_summary.";

          // Resolve the old note: exact slug first, then best fuzzy title match.
          let oldSlug: string | null = null;
          const bySlug = await readAny(store, { slug: slugify(oldTitle) });
          if (bySlug && bySlug.kind === "node") {
            oldSlug = bySlug.node.slug;
          } else {
            const similar = await store.findSimilarTitles(oldTitle, 3, ctx);
            if (similar[0]) oldSlug = similar[0].node.slug;
          }

          // Save the new fact.
          const created = await agentRemember(store, { title: newTitle, summary: newSummary, type: "claim" }, ctx);

          if (!oldSlug) {
            return `Saved new fact "${created.node.title}" but found no existing note matching "${oldTitle}" to supersede.`;
          }
          if (oldSlug === created.node.slug) {
            return `Saved "${created.node.title}". (New note has the same identity as the old one; nothing separate to mark superseded.)`;
          }
          const edge = await store.link(
            { fromSlug: created.node.slug, toSlug: oldSlug, predicate: "supersedes", weight: 1 },
            ctx,
          );
          return edge
            ? `Saved "${created.node.title}" and marked "${oldSlug}" as superseded by it.`
            : `Saved "${created.node.title}" but could not link supersedes edge to "${oldSlug}".`;
        },
      },
      {
        name: "read",
        description: "Read a full note by its slug (as shown in recall output, in parentheses).",
        parameters: {
          type: "object",
          properties: { slug: { type: "string", description: "The note slug, e.g. 'refund-policy-for-annual-plans'." } },
          required: ["slug"],
          additionalProperties: false,
        },
        async run(args) {
          const slug = String(args.slug ?? "").trim();
          if (!slug) return "(empty slug)";
          const res = await readAny(store, { slug: slugify(slug) });
          if (!res || res.kind !== "node") return `(no note with slug ${slug})`;
          const n = res.node;
          return `# ${n.title} [${n.slug}]\n${n.summary ?? ""}\n${n.content ?? ""}`.trim();
        },
      },
    ],
    async close() {
      await users.close();
      const maybeClose = (store as unknown as { close?: () => Promise<void> }).close;
      if (typeof maybeClose === "function") await maybeClose.call(store);
    },
  };
}

export function createArm(name: string): Arm {
  switch (name) {
    case "trove":
      return createTroveArm();
    case "scratchpad":
      return createScratchpadArm();
    case "nomem":
      return createNomemArm();
    default:
      throw new Error(`Unknown arm: ${name}`);
  }
}
