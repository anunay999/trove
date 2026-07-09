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
 */
export const TROVE_AGENT_DOCTRINE = `Trove is a working memory graph, not an end-of-day diary.

MENTAL MODEL
- Sources (ingest): raw long-form evidence, split into citable text units. Do not compete as beliefs.
- Atoms (remember): small distilled facts/decisions/patterns/runbooks that recall ranks.
- Edges (connect/forget): typed relationships; supersede or retire, never delete history.
- Packs (recall): budgeted digests for open questions — not always a full page.
- Full pages (read): complete node body or raw source when you need Scribe-depth.

READ (before re-deriving project/system knowledge)
1) Exact string (port, IP, slug, error, flag, SHA) → grep, then read the hit if you need the full doc.
2) Known slug/title → read (full body).
3) Open / multi-hop question → recall (tokenBudget ~8000; raise for broad synthesis). If the top atom is right but the pack is thin → read that slug.
Phrase recall as a natural-language question, not keywords.

WRITE (when beliefs crystallize — mid-session, not only wrap-up)
- Long material (transcript, PR, page, paste) → ingest first, then remember 3–7 distilled atoms citing textUnitIds, then connect each to a project/domain hub.
- Single fact/decision/gotcha → remember with type + summary + links; cite evidence or state "agent inference from session YYYY-MM-DD".
- Prefer several small linked atoms over one mega "session summary" node.
- remember revises on exact title/slug match; ALWAYS check the returned "similar" list and re-call with slug if the dedupe missed.

CORRECTIONS
- Wrong atom content → remember with the same slug (new revision).
- Wrong relationship → connect with supersedesEdgeId.
- Retire with no replacement → forget (query mode dry-runs first). Never delete.

SESSION LOOP
boot: load context → work → capture as truths form → link hubs → correct via supersession → close with 3–8 high-value atoms.

INVARIANTS
Load before re-deriving. Route tools by query shape. Ingest evidence, remember beliefs. Write when true, not only when done. Supersede never delete. Provenance or explicit inference. Cite slugs in answers so the next agent can read them.`;

export const troveTools = [
  // ---- core ----------------------------------------------------------------
  {
    name: "remember",
    tier: "core",
    description:
      "Save a distilled BELIEF (fact/decision/gotcha/pattern), not a raw dump. One write door: exact title/slug match revises, else creates. Prefer several small linked atoms mid-session when truths crystallize — not one end-of-day mega-node. Always check returned `similar` and re-call with slug if dedupe missed. Pass evidence textUnitIds from ingest, or state agent-inference in summary. Use links to attach project/domain hubs.",
    inputSchema: rememberInputSchema,
  },
  {
    name: "recall",
    tier: "core",
    description:
      "Open-ended memory questions only — hybrid search + graph expansion into a token-budgeted context pack with citations. NOT for exact strings (use grep) or when you already know the page slug (use read). Default tokenBudget is 8000; raise for broad syntheses. The pack is a digest, not always a full page — if the top atom is the right runbook but the answer is thin, follow with read on that slug.",
    inputSchema: recallInputSchema,
  },
  {
    name: "grep",
    tier: "core",
    description:
      "Prefer this over recall when the query has an exact string: port, IP, slug, env var, error code, flag, commit SHA. Regex over node titles/summaries/content AND raw sources; invalid regex falls back to literal. Returns excerpts + ids — then read the hit if you need the full document.",
    inputSchema: grepInputSchema,
  },
  {
    name: "read",
    tier: "core",
    description:
      "Full document by id or slug: complete node body (Scribe-depth runbooks) with evidence/annotations, or a raw source when the id is a source. Use when you know the slug/title, or after recall/grep found the right atom and you need the whole page — not a budgeted pack.",
    inputSchema: readAnyInputSchema,
  },
  {
    name: "connect",
    tier: "core",
    description:
      "Create a typed relationship between two memories (part_of, decision_for, implements, relates_to, …). Every new atom should link to a hub. Pass supersedesEdgeId to replace an old belief on the record (old edge is expired, never deleted).",
    inputSchema: linkInputSchema,
  },
  {
    name: "forget",
    tier: "core",
    description:
      "Retire beliefs on the record. Explicit edgeIds apply immediately; a query previews the affected relationships first (dryRun defaults true for queries). Nothing is deleted — history stays queryable via neighborhood asOf/includeExpired.",
    inputSchema: forgetInputSchema,
  },
  // ---- curator ---------------------------------------------------------------
  {
    name: "ingest",
    tier: "curator",
    description:
      "Store long-form RAW EVIDENCE (transcript, page, file, paste) split into addressable text units. Does NOT create a recall-ranked belief — after ingest, remember 3–7 distilled facts citing textUnitIds and connect them. Pipeline: ingest → remember → connect.",
    inputSchema: ingestInputSchema,
  },
  {
    name: "annotate",
    tier: "curator",
    description:
      "Attach meaning to a source or text unit (supports/contradicts/summarizes/…) without minting a belief. Use when you need provenance marks without a new remember atom.",
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
