import { z } from "zod";
import { nodeTypeSchema, quoteEvidenceRefSchema } from "./contracts.js";

/** Outcome OS item-center attach buckets (Relay WorkItem memory lanes). */
export const memoryBucketSchema = z.enum(["suggested", "pinned", "excluded", "available"]);

/**
 * Attach an existing memory (by memoryId/slug) OR create via title/summary
 * (+ optional evidence) and link it to the item hub `item-{itemId}`.
 * Canonical id: itemId = Relay WorkItem.id.
 */
export const attachMemoryInputSchema = z.object({
  itemId: z.string().min(1),
  memoryId: z.string().uuid().optional(),
  slug: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  type: nodeTypeSchema.optional(),
  content: z.string().optional(),
  evidence: z.array(quoteEvidenceRefSchema).default([]),
  bucket: memoryBucketSchema.default("suggested"),
}).refine(
  (value) => Boolean(value.memoryId || value.slug || (value.title && value.summary)),
  { message: "Provide memoryId, slug, or title+summary to create then attach." },
);

/**
 * Auto path from an item description: ingest(title+note) → remember short
 * claims → connect each to hub item-{itemId}. Separate tool (not a mode on
 * attach_memory) to match ingest→remember→connect as distinct curator ops.
 */
export const attachFromItemDescInputSchema = z.object({
  itemId: z.string().min(1),
  title: z.string().min(1),
  note: z.string().min(1),
  bucket: memoryBucketSchema.default("suggested"),
  maxClaims: z.number().int().min(1).max(7).default(5),
});

export type MemoryBucket = z.infer<typeof memoryBucketSchema>;
export type AttachMemoryInput = z.input<typeof attachMemoryInputSchema>;
export type AttachFromItemDescInput = z.input<typeof attachFromItemDescInputSchema>;
