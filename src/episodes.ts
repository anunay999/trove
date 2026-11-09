import type { GraphSource, IngestInput, TextUnit } from "./contracts.js";
import { type GraphOperationContext, type GraphStore, sha256 } from "./graphCore.js";

export type LogicalSegment = {
  ordinal: number;
  heading: string | null;
  date: string | null;
  text: string;
};

export type LogicalSplit = {
  mode: "dated" | "sectional";
  segments: LogicalSegment[];
};

const DATED_HEADING = /^## \[?(\d{4}-\d{2}-\d{2})/;

// Append-heavy files (event logs) and registries (index.md) should not be
// re-snapshotted wholesale on every import. Split them into logical segments
// so the (kind, content_sha256) upsert dedupes unchanged segments and growth
// becomes O(new entries) instead of O(file size x versions).
export function splitLogicalSegments(contentText: string, relPath: string): LogicalSplit | null {
  const lines = contentText.split("\n");
  const segments: LogicalSegment[] = [];
  let current: string[] = [];
  let currentHeading: string | null = null;

  const push = () => {
    const text = current.join("\n").trim();
    if (text.length > 0) {
      const date = currentHeading ? DATED_HEADING.exec(currentHeading)?.[1] ?? null : null;
      segments.push({ ordinal: segments.length, heading: currentHeading, date, text });
    }
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      push();
      currentHeading = line;
    }
    current.push(line);
  }
  push();

  const datedCount = segments.filter((segment) => segment.date !== null).length;
  if (datedCount >= 3) {
    return { mode: "dated", segments };
  }

  const fileName = relPath.split("/").at(-1) ?? relPath;
  if (fileName.toLowerCase() === "index.md" && segments.length >= 2) {
    return { mode: "sectional", segments };
  }
  return null;
}

export type EpisodicIngestResult = {
  episodic: boolean;
  newSegments: number;
  totalSegments: number;
  results: Array<{ source: GraphSource; textUnits: TextUnit[] }>;
};

export async function ingestEpisodic(
  store: GraphStore,
  input: {
    kind: IngestInput["kind"];
    title: string;
    uri: string;
    relPath: string;
    contentText: string;
    metadata?: Record<string, unknown>;
  },
  context?: GraphOperationContext,
): Promise<EpisodicIngestResult> {
  const split = splitLogicalSegments(input.contentText, input.relPath);
  if (!split) {
    const result = await store.ingest({
      kind: input.kind,
      title: input.title,
      uri: input.uri,
      contentText: input.contentText,
      metadata: { ...input.metadata, relPath: input.relPath },
    }, context);
    return { episodic: false, newSegments: 1, totalSegments: 1, results: [result] };
  }

  const existing = await store.sources({ limit: 10000 }, context);
  const knownHashes = new Set(existing.map((row) => `${row.kind}:${row.contentSha256}`));

  let newSegments = 0;
  const results: EpisodicIngestResult["results"] = [];
  for (const segment of split.segments) {
    if (!knownHashes.has(`${input.kind}:${sha256(segment.text)}`)) {
      newSegments += 1;
    }
    const label = segment.heading?.replace(/^##\s*/, "").slice(0, 120) ?? `intro`;
    const result = await store.ingest({
      kind: input.kind,
      title: `${input.title} · ${label}`,
      uri: `${input.uri}#${segment.ordinal}`,
      contentText: segment.text,
      metadata: {
        ...input.metadata,
        relPath: input.relPath,
        episodeOf: input.uri,
        episodeOrdinal: segment.ordinal,
        entryDate: segment.date,
        mode: split.mode,
      },
    }, context);
    results.push(result);
  }
  return { episodic: true, newSegments, totalSegments: split.segments.length, results };
}
