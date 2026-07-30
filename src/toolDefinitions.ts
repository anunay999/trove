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
 * Agent-facing operating guide for Trove MCP.
 *
 * This is the single source of truth for “how to use Trove” for any LLM host
 * (Claude, Cursor, Codex, custom MCP clients). It is not a code comment only —
 * the string is served as:
 *   - MCP server `instructions` on initialize
 *   - resource `trove://doctrine` (resources/read)
 *   - body of the `trove-session` prompt
 *
 * Keep examples everyday and product-agnostic (refunds, ticket ids, owners)
 * so teams map them to their own domain. Prefer plain language over jargon.
 * Tool parameter names (slug, tokenBudget, supersedesEdgeId) stay exact so
 * agents can call tools correctly.
 *
 * Human-readable long form: docs/agent-usage.md
 */
export const TROVE_AGENT_DOCTRINE = `Trove is a working memory graph, not an end-of-day diary.

MENTAL MODEL
- Sources (ingest): raw long material — meeting notes, a design doc, an email paste. Split into citable spans. Not ranked as beliefs.
- Atoms (remember): short distilled notes — "we bill monthly, not annually", "support owns the help inbox", a how-to. These are what recall finds.
- Edges (connect/forget): links between notes (this decision is for that project). Supersede or retire; never delete history.
- Packs (recall): a short brief for one open question — not always the whole note.
- Full notes (read): the complete note when you already know its name.

READ (before reinventing something already known)
1) Exact string — a ticket id, product code, error text, setting name, email → grep, then read if you need the full note.
   Example: grep "INV-1042" or "payment failed" or "FEATURE_DARK_MODE".
2) You know the note's name — "billing-pricing-rules", "onboarding-checklist" → read it.
3) Open question — "how do we handle refunds?" or "what's the plan for mobile?" → recall (tokenBudget ~8000).
   If the top hit is right but the brief is thin → read that note.
Ask recall in plain language: "How do we handle refunds for annual plans?" — not "refund annual plan keywords".

WRITE (when something becomes true — during the session, not only at the end)
- Long material (notes, doc, paste) → ingest first, then remember 3–7 short notes that cite those spans, then connect each to a project or topic.
  Example: ingest the pricing call notes → remember "annual plans are not refundable after 14 days" → connect to billing.
- One fact or decision → remember with a clear title + summary + links.
  Example: "No production deploys after Friday noon" or "Customer success owns churn emails".
- Prefer several small linked notes over one giant "notes from today" blob.
- remember updates an existing note when the title/slug matches exactly. ALWAYS check the returned "similar" list (scored by title similarity); if it almost matched the right note, call again with that slug.

CORRECTIONS
- Wrong note text → remember with the same slug (new revision).
- Wrong link between notes → connect with supersedesEdgeId.
- No longer true → forget (query mode previews first): edgeIds expire links, nodeIds/slugs retire whole notes out of recall/grep/read. Never delete — history stays queryable via neighborhood includeExpired/asOf.

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
      "Save a short distilled note (a fact, decision, or how-to) — not a raw dump. Same title/slug revises; otherwise creates. Prefer several small linked notes while you work (e.g. 'refunds within 14 days', 'CS owns churn email') over one 'notes from today' blob. Always check returned `similar` (title-similarity scored) and re-call with slug if the right note almost matched. Cite evidence as { quote: \"the span's own words, copied from what you were served\" } — Trove resolves it to the right text unit (exact first, then fuzzy) and stores a W3C TextQuoteSelector, so you never echo a UUID. Raw textUnitIds from an ingest/recall/grep/read response still work, but only ids you were actually served this session. Check `complete`: false means requested attachments were partial; repair details are in `evidenceRejected`, `evidenceUnserved`, or `linkRejected`. No source at all? Say it's agent inference in the summary. Link each note to a project or topic hub.",
    inputSchema: rememberInputSchema,
  },
  {
    name: "recall",
    tier: "core",
    description:
      "Open questions only — e.g. 'how do we handle refunds?' — returns a short ranked brief with citations. Not for exact ids or error strings (use grep) or when you already know the note name (use read). Default tokenBudget 8000 covers the whole response. Atoms carry the packed body slice — contentTruncated marks cut bodies, hops is the true graph distance from the match — and evidence is relevance-ranked to the query. An atom marked SUPERSEDED has been replaced by a newer note (named in the header) — prefer the successor, cite the superseded one only for history. The brief is a digest; if the right note is on top but incomplete, follow with read on that slug.",
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
      "Retire a belief that is no longer true. Pass nodeIds/slugs to tombstone whole notes (they leave recall, grep, and read), edgeIds to expire links, or a query to preview first (dryRun defaults true in query mode). Nothing is hard-deleted — supersession history stays queryable via neighborhood includeExpired/asOf.",
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
    description: "Return a bounded graph neighborhood around a node — each node carries its BFS level from the seed. Bound with maxNodes, filter valid-time with validAt, or pass asOf/includeExpired for recorded-time history.",
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
