import {
  annotateInputSchema,
  captureInputSchema,
  createViewInputSchema,
  deleteViewInputSchema,
  enqueueJobInputSchema,
  eventFeedInputSchema,
  ingestInputSchema,
  invalidateEdgeInputSchema,
  linkInputSchema,
  listViewsInputSchema,
  listJobsInputSchema,
  neighborhoodInputSchema,
  projectInputSchema,
  readViewInputSchema,
  readInputSchema,
  readSourceInputSchema,
  recallInputSchema,
  runJobInputSchema,
  searchInputSchema,
  updateInputSchema,
} from "./contracts.js";

export const troveTools = [
  {
    name: "graph.search",
    description: "Search Trove nodes with lexical, semantic, and graph-aware retrieval.",
    inputSchema: searchInputSchema,
  },
  {
    name: "graph.read",
    description: "Read a canonical graph node, its current revision, and adjacent context.",
    inputSchema: readInputSchema,
  },
  {
    name: "graph.read_source",
    description: "Read a raw source document in full, including its original text.",
    inputSchema: readSourceInputSchema,
  },
  {
    name: "graph.neighborhood",
    description: "Return a bounded graph neighborhood for mind maps or agent context.",
    inputSchema: neighborhoodInputSchema,
  },
  {
    name: "graph.recall",
    description: "Build a token-budgeted context pack from hybrid search, graph expansion, and activation ranking.",
    inputSchema: recallInputSchema,
  },
  {
    name: "graph.link",
    description: "Create or update a typed relationship between two semantic graph nodes. Pass supersedesEdgeId to invalidate the belief this edge replaces.",
    inputSchema: linkInputSchema,
  },
  {
    name: "graph.invalidate_edge",
    description: "Mark an edge as no longer believed. History is preserved: the edge is expired, never deleted.",
    inputSchema: invalidateEdgeInputSchema,
  },
  {
    name: "graph.capture",
    description: "Capture a non-trivial semantic atom into the graph with optional evidence refs.",
    inputSchema: captureInputSchema,
  },
  {
    name: "graph.ingest",
    description: "Ingest long-form source content and split it into addressable text units.",
    inputSchema: ingestInputSchema,
  },
  {
    name: "graph.annotate",
    description: "Attach meaning to a source or text unit without rewriting the raw evidence.",
    inputSchema: annotateInputSchema,
  },
  {
    name: "graph.update",
    description: "Update a node with optimistic revision checking.",
    inputSchema: updateInputSchema,
  },
  {
    name: "graph.project",
    description: "Render a node as markdown, a mind map, or an agent context pack.",
    inputSchema: projectInputSchema,
  },
  {
    name: "graph.timeline",
    description: "Inspect recent graph mutation events with actor, interface, and request attribution.",
  },
  {
    name: "graph.events",
    description: "Read cursor-paginated graph mutation events for interface sync.",
    inputSchema: eventFeedInputSchema,
  },
  {
    name: "graph.lint",
    description: "Find graph health issues such as orphan nodes, missing evidence, duplicate titles, and dangling edges.",
  },
  {
    name: "graph.views",
    description: "List saved mind-map and projection views.",
    inputSchema: listViewsInputSchema,
  },
  {
    name: "graph.read_view",
    description: "Read a saved mind-map view with included nodes and edges.",
    inputSchema: readViewInputSchema,
  },
  {
    name: "graph.create_view",
    description: "Create a durable saved mind-map view from a root node, search query, or explicit node set.",
    inputSchema: createViewInputSchema,
  },
  {
    name: "graph.delete_view",
    description: "Delete a saved mind-map view by id or slug.",
    inputSchema: deleteViewInputSchema,
  },
  {
    name: "graph.jobs",
    description: "List durable maintenance jobs for projections, lint, and embedding refresh.",
    inputSchema: listJobsInputSchema,
  },
  {
    name: "graph.enqueue_job",
    description: "Enqueue a durable maintenance job. Admin scope required.",
    inputSchema: enqueueJobInputSchema,
  },
  {
    name: "graph.run_job",
    description: "Claim and run one pending durable maintenance job inline. Admin scope required.",
    inputSchema: runJobInputSchema,
  },
  {
    name: "graph.export_obsidian",
    description: "Export an Obsidian projection with markdown pages, canvas, log, and manifest.",
  },
  {
    name: "scribe.query",
    description: "Scribe-compatible query over Trove.",
    inputSchema: searchInputSchema,
  },
  {
    name: "scribe.capture",
    description: "Scribe-compatible durable capture backed by Trove.",
    inputSchema: captureInputSchema,
  },
  {
    name: "scribe.ingest",
    description: "Scribe-compatible source ingestion backed by Trove.",
    inputSchema: ingestInputSchema,
  },
  {
    name: "scribe.update",
    description: "Scribe-compatible revision-checked update backed by Trove.",
    inputSchema: updateInputSchema,
  },
  {
    name: "scribe.lint",
    description: "Scribe-compatible wiki health check backed by Trove lint.",
  },
  {
    name: "scribe.export_obsidian",
    description: "Scribe-compatible Obsidian projection export.",
  },
] as const;
