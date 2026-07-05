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

export const troveTools = [
  // ---- core ----------------------------------------------------------------
  {
    name: "remember",
    tier: "core",
    description:
      "Save a memory. One write door: if the title (or an explicit slug/nodeId) matches an existing node it revises it, otherwise it creates one. Returns action taken plus similar nodes it did NOT merge into — retarget with slug if the dedupe missed.",
    inputSchema: rememberInputSchema,
  },
  {
    name: "recall",
    tier: "core",
    description:
      "Retrieve relevant memory as a token-budgeted context pack: hybrid search, graph expansion, activation ranking, citations. Use this for questions; never exceeds tokenBudget.",
    inputSchema: recallInputSchema,
  },
  {
    name: "grep",
    tier: "core",
    description:
      "Exact/regex text search over memories and raw source documents. Use for identifiers, ports, error strings, flags — anything where exact match beats semantic search. Invalid regex degrades to a literal match.",
    inputSchema: grepInputSchema,
  },
  {
    name: "read",
    tier: "core",
    description: "Read anything by id or slug: a memory node (with evidence and annotations) or a raw source document.",
    inputSchema: readAnyInputSchema,
  },
  {
    name: "connect",
    tier: "core",
    description:
      "Create a typed relationship between two memories. Pass supersedesEdgeId to replace an old belief on the record (the old edge is expired, never deleted).",
    inputSchema: linkInputSchema,
  },
  {
    name: "forget",
    tier: "core",
    description:
      "Retire beliefs. Explicit edgeIds apply immediately; a query previews the affected relationships first (dryRun defaults true for queries). Nothing is deleted — history stays queryable.",
    inputSchema: forgetInputSchema,
  },
  // ---- curator ---------------------------------------------------------------
  {
    name: "ingest",
    tier: "curator",
    description:
      "Store a long-form source document as evidence, split into addressable text units. Use for transcripts, pages, files — then remember the distilled facts citing it.",
    inputSchema: ingestInputSchema,
  },
  {
    name: "annotate",
    tier: "curator",
    description: "Attach meaning to a source or text unit without rewriting the raw evidence.",
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
