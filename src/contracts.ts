import { z } from "zod";

export const nodeTypeSchema = z.enum([
  "entity",
  "project",
  "pattern",
  "domain",
  "person",
  "infrastructure",
  "claim",
  "decision",
  "task",
  "question",
  "community",
  "view",
]);

export const sourceKindSchema = z.enum([
  "markdown_page",
  "url",
  "file",
  "paste",
  "email",
  "slack",
  "screenshot",
  "transcript",
  "agent_note",
]);

export const motivationSchema = z.enum([
  "mentions",
  "supports",
  "contradicts",
  "supersedes",
  "summarizes",
  "asks",
  "todo",
  "important_quote",
]);

export const graphSourceSchema = z.object({
  id: z.string().uuid(),
  kind: sourceKindSchema,
  title: z.string().min(1),
  uri: z.string().nullable(),
  contentSha256: z.string().min(1),
  createdAt: z.string(),
});

export const textUnitSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  ordinal: z.number().int().min(0),
  sectionPath: z.array(z.string()),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
  text: z.string(),
  contentSha256: z.string().min(1),
});

export const graphNodeSchema = z.object({
  id: z.string().uuid(),
  type: nodeTypeSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  content: z.string().nullable(),
  revisionId: z.string().uuid(),
  updatedAt: z.string(),
  accessCount: z.number().int().min(0),
  lastAccessedAt: z.string().nullable(),
});

export const graphEdgeSchema = z.object({
  id: z.string().uuid(),
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  predicate: z.string().min(1),
  weight: z.number(),
  recordedAt: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  expiredAt: z.string().nullable(),
  invalidatedBy: z.string().uuid().nullable(),
});

export const graphAnnotationSchema = z.object({
  id: z.string().uuid(),
  motivation: motivationSchema,
  sourceId: z.string().uuid().nullable(),
  textUnitId: z.string().uuid().nullable(),
  nodeId: z.string().uuid().nullable(),
  body: z.record(z.string(), z.unknown()),
  selector: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const searchInputSchema = z.object({
  query: z.string().min(1),
  types: z.array(nodeTypeSchema).optional(),
  includeTextUnits: z.boolean().default(true),
  mode: z.enum(["lexical", "semantic", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(50).default(10),
  // Cosine-distance ceiling for semantic hits (0..2). Default effective 0.55,
  // overridable via TROVE_SEMANTIC_MAX_DISTANCE on the server.
  maxSemanticDistance: z.number().min(0).max(2).optional(),
});

export const readInputSchema = z.object({
  nodeId: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
}).refine((value) => value.nodeId || value.slug, {
  message: "Provide nodeId or slug.",
});

export const neighborhoodInputSchema = z.object({
  nodeId: z.string().uuid(),
  depth: z.number().int().min(1).max(3).default(1),
  predicates: z.array(z.string().min(1)).optional(),
  asOf: z.string().optional(),
  includeExpired: z.boolean().default(false),
  maxNodes: z.number().int().min(1).max(500).default(100),
  // Valid-time filter: edges qualify when valid_from <= t and (valid_until is null or valid_until > t).
  validAt: z.iso.datetime().optional(),
});

export const linkInputSchema = z.object({
  fromNodeId: z.string().uuid().optional(),
  fromSlug: z.string().min(1).optional(),
  toNodeId: z.string().uuid().optional(),
  toSlug: z.string().min(1).optional(),
  predicate: z.string().min(1).default("relates_to"),
  weight: z.number().positive().default(1),
  validFrom: z.string().optional(),
  supersedesEdgeId: z.string().uuid().optional(),
}).refine((value) => value.fromNodeId || value.fromSlug, {
  message: "Link must include fromNodeId or fromSlug.",
}).refine((value) => value.toNodeId || value.toSlug, {
  message: "Link must include toNodeId or toSlug.",
});

export const readSourceInputSchema = z.object({
  sourceId: z.string().uuid(),
});

export const readDocumentInputSchema = z.object({
  uri: z.string().min(1),
});

export const invalidateEdgeInputSchema = z.object({
  edgeId: z.string().uuid(),
  validUntil: z.string().optional(),
});

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  scope: z.enum(["nodes", "sources", "all"]).default("all"),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
});

export const recallInputSchema = z.object({
  query: z.string().min(1),
  // Default high enough to pack full Scribe-style runbook pages on hop-0 matches.
  // Latency is acceptable on hobby hosting; accuracy is the goal.
  tokenBudget: z.number().int().min(100).max(32000).default(8000),
  types: z.array(nodeTypeSchema).optional(),
  depth: z.number().int().min(0).max(2).default(1),
  asOf: z.string().optional(),
  includeEvidence: z.boolean().default(true),
  // Cosine-distance ceiling for semantic seed hits (0..2). See searchInputSchema.
  maxSemanticDistance: z.number().min(0).max(2).optional(),
});

export const ingestInputSchema = z.object({
  kind: sourceKindSchema,
  title: z.string().min(1),
  uri: z.string().optional(),
  contentText: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const evidenceRefSchema = z.object({
  sourceId: z.string().uuid().optional(),
  textUnitId: z.string().uuid().optional(),
  selector: z.record(z.string(), z.unknown()).default({}),
}).refine((value) => value.sourceId || value.textUnitId, {
  message: "Evidence must reference a source or text unit.",
});

export const captureInputSchema = z.object({
  title: z.string().min(1),
  type: nodeTypeSchema.default("claim"),
  summary: z.string().min(1),
  content: z.string().optional(),
  evidence: z.array(evidenceRefSchema).default([]),
  links: z.array(z.object({
    toSlug: z.string().min(1),
    predicate: z.string().min(1).default("relates_to"),
  })).default([]),
});

export const rememberInputSchema = z.object({
  title: z.string().min(1),
  type: nodeTypeSchema.default("claim"),
  summary: z.string().min(1),
  content: z.string().optional(),
  evidence: z.array(evidenceRefSchema).default([]),
  links: z.array(z.object({
    toSlug: z.string().min(1),
    predicate: z.string().min(1).default("relates_to"),
  })).default([]),
  nodeId: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
});

export const forgetInputSchema = z.object({
  edgeIds: z.array(z.string().uuid()).optional(),
  nodeIds: z.array(z.string().uuid()).optional(),
  slugs: z.array(z.string().min(1)).optional(),
  query: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
  validUntil: z.string().optional(),
}).refine(
  (value) =>
    (value.edgeIds && value.edgeIds.length > 0) ||
    (value.nodeIds && value.nodeIds.length > 0) ||
    (value.slugs && value.slugs.length > 0) ||
    value.query,
  {
    message: "Provide edgeIds, nodeIds, slugs, or a query.",
  },
);

export const readAnyInputSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
}).refine((value) => value.id || value.slug, {
  message: "Provide id or slug.",
});

export const annotateInputSchema = z.object({
  motivation: motivationSchema,
  sourceId: z.string().uuid().optional(),
  textUnitId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
  body: z.record(z.string(), z.unknown()).default({}),
  selector: z.record(z.string(), z.unknown()).default({}),
}).refine((value) => value.sourceId || value.textUnitId, {
  message: "Annotation must target a source or text unit.",
}).refine((value) => value.nodeId || Object.keys(value.body).length > 0, {
  message: "Annotation must link to a node or include a body.",
});

export const updateInputSchema = z.object({
  nodeId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
});

export const projectInputSchema = z.object({
  nodeId: z.string().uuid(),
  format: z.enum(["markdown", "mind_map", "agent_context"]),
  depth: z.number().int().min(0).max(3).default(1),
});

export const graphViewSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  rootNodeId: z.string().uuid().nullable(),
  query: z.string().nullable(),
  summary: z.string().nullable(),
  layout: z.record(z.string(), z.unknown()),
  includedNodeIds: z.array(z.string().uuid()),
  includedEdgeIds: z.array(z.string().uuid()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createViewInputSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1).optional(),
  rootNodeId: z.string().uuid().optional(),
  rootSlug: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  summary: z.string().optional(),
  depth: z.number().int().min(0).max(3).default(1),
  predicates: z.array(z.string().min(1)).optional(),
  layout: z.record(z.string(), z.unknown()).default({}),
  includedNodeIds: z.array(z.string().uuid()).optional(),
  includedEdgeIds: z.array(z.string().uuid()).optional(),
}).refine((value) => value.rootNodeId || value.rootSlug || value.query || value.includedNodeIds?.length, {
  message: "View must include rootNodeId, rootSlug, query, or includedNodeIds.",
});

export const listViewsInputSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).default({ limit: 25 });

export const readViewInputSchema = z.object({
  viewId: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
}).refine((value) => value.viewId || value.slug, {
  message: "Provide viewId or slug.",
});

export const deleteViewInputSchema = z.object({
  viewId: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
}).refine((value) => value.viewId || value.slug, {
  message: "Provide viewId or slug.",
});

export const graphJobKindSchema = z.enum([
  "refresh_obsidian_projection",
  "lint_graph",
  "refresh_embeddings",
]);

export const graphJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead",
  "cancelled",
]);

export const enqueueJobInputSchema = z.object({
  kind: graphJobKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(0).max(100).default(50),
  dedupeKey: z.string().min(1).optional(),
});

export const listJobsInputSchema = z.object({
  status: graphJobStatusSchema.optional(),
  kind: graphJobKindSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).default({ limit: 25 });

export const runJobInputSchema = z.object({
  jobId: z.string().uuid().optional(),
}).default({});

export const eventFeedInputSchema = z.object({
  afterCursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  order: z.enum(["asc", "desc"]).optional(),
}).default({ limit: 100 });

export type GraphSource = z.infer<typeof graphSourceSchema>;
export type TextUnit = z.infer<typeof textUnitSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphAnnotation = z.infer<typeof graphAnnotationSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type ReadInput = z.infer<typeof readInputSchema>;
export type NeighborhoodInput = z.input<typeof neighborhoodInputSchema>;
export type LinkInput = z.infer<typeof linkInputSchema>;
export type InvalidateEdgeInput = z.infer<typeof invalidateEdgeInputSchema>;
export type ReadSourceInput = z.infer<typeof readSourceInputSchema>;
export type ReadDocumentInput = z.infer<typeof readDocumentInputSchema>;
export type RecallInput = z.input<typeof recallInputSchema>;
export type IngestInput = z.infer<typeof ingestInputSchema>;
export type CaptureInput = z.infer<typeof captureInputSchema>;
export type AnnotateInput = z.infer<typeof annotateInputSchema>;
export type UpdateInput = z.infer<typeof updateInputSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type GraphView = z.infer<typeof graphViewSchema>;
export type CreateViewInput = z.infer<typeof createViewInputSchema>;
export type ListViewsInput = z.infer<typeof listViewsInputSchema>;
export type ReadViewInput = z.infer<typeof readViewInputSchema>;
export type DeleteViewInput = z.infer<typeof deleteViewInputSchema>;
export type GraphJobKind = z.infer<typeof graphJobKindSchema>;
export type GraphJobStatus = z.infer<typeof graphJobStatusSchema>;
export type EnqueueJobInput = z.infer<typeof enqueueJobInputSchema>;
export type ListJobsInput = z.infer<typeof listJobsInputSchema>;
export type RunJobInput = z.infer<typeof runJobInputSchema>;
export type EventFeedInput = z.infer<typeof eventFeedInputSchema>;
export type GrepInput = z.input<typeof grepInputSchema>;
export type RememberInput = z.input<typeof rememberInputSchema>;
export type ForgetInput = z.infer<typeof forgetInputSchema>;
export type ReadAnyInput = z.infer<typeof readAnyInputSchema>;
