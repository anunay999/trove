import {
  annotateInputSchema,
  createViewInputSchema,
  deleteViewInputSchema,
  enqueueJobInputSchema,
  eventFeedInputSchema,
  forgetInputSchema,
  grepInputSchema,
  ingestInputSchema,
  linkInputSchema,
  listViewsInputSchema,
  listJobsInputSchema,
  neighborhoodInputSchema,
  projectInputSchema,
  readAnyInputSchema,
  readViewInputSchema,
  recallInputSchema,
  rememberInputSchema,
  runJobInputSchema,
} from "./contracts.js";
import type { TroveScope } from "./auth.js";

/**
 * Tool tiers gate VISIBILITY (which tools a credential is shown), not
 * execution — call-time scope checks remain the security boundary.
 *
 * - core: the everyday agent vocabulary. Visible to any credential.
 * - curator: ingestion/curation flows used by skills and power users.
 *   Visible with any write scope.
 * - operator: maintenance and sync plumbing. Visible with graph:admin only.
 */
export type ToolTier = "core" | "curator" | "operator";

/**
 * Operating doctrine for any LLM using Trove MCP (no client-specific skills required).
 * Exposed as server instructions + trove://doctrine resource.
 * Examples stay generic so any product team can map them to their world.
 */
export const TROVE_AGENT_DOCTRINE = `Trove is a working memory graph, not an end-of-day diary.

MENTAL MODEL
- Sources (ingest): raw long-form evidence — a meeting transcript, a design doc, an email paste. Split into citable spans. Not ranked as beliefs.
- Atoms (remember): small distilled notes — "we bill monthly, not annually", "staging DB is shared", a how-to. These are what recall finds.
- Edges (connect/forget): links between notes (this decision is for that project). Supersede or retire; never delete history.
- Packs (recall): a short brief for one open question — not always the whole note.
- Full pages (read): the complete note when you already know its name.

READ (before reinventing something already known)
1) Exact string — a product code, ticket id, error text, config key, email, URL path → grep, then read if you need the full note.
   Example: grep "INV-1042" or "ECONNRESET" or "FEATURE_DARK_MODE".
2) You know the note's name — "billing-pricing-rules", "onboarding-checklist" → read it.
3) Open question — "how do we handle refunds?" or "what's the plan for mobile?" → recall (tokenBudget ~8000).
   If the top hit is right but the brief is thin → read that note.
Ask recall in plain language: "How do we handle refunds for annual plans?" — not "refund annual plan keywords".

WRITE (when something becomes true — during the session, not only at the end)
- Long material (transcript, doc, paste) → ingest first, then remember 3–7 short atoms that cite those spans, then connect each to a project or topic hub.
  Example: ingest the pricing call notes → remember "annual plans are not refundable after 14 days" → connect to billing.
- One fact or decision → remember with a clear title + summary + links.
  Example: "Deploy freezes start Friday noon" or "Customer success owns churn emails".
- Prefer several small linked notes over one giant "notes from today" blob.
- remember updates an existing note when the title/slug matches exactly. ALWAYS check the returned "similar" list; if it almost matched the right note, call again with that slug.

CORRECTIONS
- Wrong note text → remember with the same slug (new revision).
- Wrong link between notes → connect with supersedesEdgeId.
- No longer true → forget (query mode previews first). Never delete.

SESSION LOOP
Start: load what you already know → do the work → save truths as they land → link them → fix outdated beliefs → finish with a handful of solid notes, not one mega dump.

INVARIANTS
Load before re-deriving. Pick tools by query shape. Ingest raw text, remember distilled beliefs. Write when it's true, not only when the day ends. Supersede, don't delete. Cite a source or say it's your inference. Put note names in answers so the next agent can open them.`;

export const troveTools = [
  // ---- core ----------------------------------------------------------------
  {
    name: "remember",
    tier: "core",
    description:
      "Save a short distilled note (a fact, decision, or how-to) — not a raw dump. Same title/slug revises; otherwise creates. Prefer several small linked notes while you work (e.g. 'refunds within 14 days', 'CS owns churn email') over one 'notes from today' blob. Always check returned `similar` and re-call with slug if the right note almost matched. Cite textUnitIds from ingest, or say it's agent inference in the summary. Link each note to a project or topic hub.",
    inputSchema: rememberInputSchema,
  },
  {
    name: "recall",
    tier: "core",
    description:
      "Open questions only — e.g. 'how do we handle refunds?' — returns a short ranked brief with citations. Not for exact ids or error strings (use grep) or when you already know the note name (use read). Default tokenBudget 8000. The brief is a digest; if the right note is on top but incomplete, follow with read on that slug.",
    inputSchema: recallInputSchema,
  },
  {
    name: "grep",
    tier: "core",
    description:
      "Prefer this over recall for an exact string: ticket id, product code, error text, config key, email, URL path (e.g. INV-1042, ECONNRESET, FEATURE_DARK_MODE). Searches note text and raw sources; invalid regex falls back to literal. Returns excerpts + ids — then read if you need the full note.",
    inputSchema: grepInputSchema,
  },
  {
    name: "read",
    tier: "core",
    description:
      "Open one note or raw source by id or name (slug) — full body, not a short brief. Use when you know the name (e.g. billing-pricing-rules) or after grep/recall found the right note and you need everything.",
    inputSchema: readAnyInputSchema,
  },
  {
    name: "connect",
    tier: "core",
    description:
      "Link two notes (this decision is for that project, this how-to is part of onboarding). Every new note should hang off a hub. Pass supersedesEdgeId to replace an old link without deleting history.",
    inputSchema: linkInputSchema,
  },
  {
    name: "forget",
    tier: "core",
    description:
      "Mark a belief as no longer true. Pass edge ids to retire now, or a query to preview first (dryRun defaults true). Nothing is hard-deleted — history stays queryable.",
    inputSchema: forgetInputSchema,
  },
  // ---- curator ---------------------------------------------------------------
  {
    name: "ingest",
    tier: "curator",
    description:
      "Store long raw material (meeting notes, a doc, a paste) as evidence spans. Does not create a findable belief by itself — next: remember 3–7 short facts citing those spans, then connect them to a topic. Pipeline: ingest → remember → connect.",
    inputSchema: ingestInputSchema,
  },
  {
    name: "annotate",
    tier: "curator",
    description:
      "Tag a source span (supports / contradicts / important quote / …) without creating a new note. Use for provenance marks only.",
    inputSchema: annotateInputSchema,
  },
  {
    name: "neighborhood",
    tier: "curator",
    description: "Return a bounded graph neighborhood around a node, optionally as of a past time or including expired edges.",
    inputSchema: neighborhoodInputSchema,
  },
  {
    name: "project",
    tier: "curator",
    description: "Render a node as markdown, a mind map, or an agent context pack.",
    inputSchema: projectInputSchema,
  },
  {
    name: "views",
    tier: "curator",
    description: "List saved mind-map and projection views.",
    inputSchema: listViewsInputSchema,
  },
  {
    name: "read_view",
    tier: "curator",
    description: "Read a saved mind-map view with included nodes and edges.",
    inputSchema: readViewInputSchema,
  },
  {
    name: "create_view",
    tier: "curator",
    description: "Create a durable saved mind-map view from a root node, search query, or explicit node set.",
    inputSchema: createViewInputSchema,
  },
  {
    name: "delete_view",
    tier: "curator",
    description: "Delete a saved mind-map view by id or slug.",
    inputSchema: deleteViewInputSchema,
  },
  // ---- operator ----------------------------------------------------------------
  {
    name: "events",
    tier: "operator",
    description: "Read cursor-paginated graph mutation events for interface sync.",
    inputSchema: eventFeedInputSchema,
  },
  {
    name: "lint",
    tier: "operator",
    description: "Find graph health issues such as orphan nodes, missing evidence, duplicate titles, and dangling edges.",
  },
  {
    name: "jobs",
    tier: "operator",
    description: "List durable maintenance jobs for projections, lint, and embedding refresh.",
    inputSchema: listJobsInputSchema,
  },
  {
    name: "enqueue_job",
    tier: "operator",
    description: "Enqueue a durable maintenance job. Admin scope required.",
    inputSchema: enqueueJobInputSchema,
  },
  {
    name: "run_job",
    tier: "operator",
    description: "Claim and run one pending durable maintenance job inline. Admin scope required.",
    inputSchema: runJobInputSchema,
  },
  {
    name: "export_obsidian",
    tier: "operator",
    description: "Export an Obsidian projection with markdown pages, canvas, log, and manifest.",
  },
] as const;

export function visibleTiers(scopes: TroveScope[] | undefined): Set<ToolTier> {
  // No auth context (local stdio, auth disabled) sees everything.
  if (!scopes) return new Set(["core", "curator", "operator"]);
  if (scopes.includes("graph:admin")) return new Set(["core", "curator", "operator"]);
  if (scopes.some((scope) => scope.startsWith("graph:write"))) return new Set(["core", "curator"]);
  return new Set(["core"]);
}

/** Look up the shared tool description used by both HTTP /v1/tools and MCP registerTool. */
export function toolDescription(name: string): string {
  const tool = troveTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown trove tool: ${name}`);
  return tool.description;
}
