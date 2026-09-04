import type { GraphSource } from "./contracts.js";

export type DatedSource = GraphSource & { metadata: Record<string, unknown> };
export type DocumentsPerDay = { date: string; documents: number };

export type SourceDaySeries = {
  /** Dated by domain time: what the document says about itself. */
  byDocumentDate: DocumentsPerDay[];
  /** Dated by transaction time: when Trove ingested it. */
  byIngestDate: DocumentsPerDay[];
};

const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/;

/**
 * Domain time: the date a document claims for itself — an explicit entryDate,
 * then frontmatter created/date/updated, then an ISO date in its path or title.
 * Falls back to ingest time when the document says nothing about when it is
 * from. Two thirds of a real vault answer here with a date months in the past,
 * which is why the dashboard also needs the ingest-dated series: a note
 * imported today belongs on today's bar when the question is "what did I add".
 */
export function documentDate(row: DatedSource): string {
  const entryDate = (row.metadata as { entryDate?: string }).entryDate;
  if (entryDate && ISO_DATE.test(entryDate)) return ISO_DATE.exec(entryDate)![1]!;
  const frontmatter = (row.metadata as { frontmatter?: Record<string, string> }).frontmatter ?? {};
  for (const candidate of [frontmatter.created, frontmatter.date, frontmatter.updated]) {
    if (candidate && ISO_DATE.test(candidate)) return ISO_DATE.exec(candidate)![1]!;
  }
  const relPath = (row.metadata as { relPath?: string }).relPath ?? "";
  const fromName = ISO_DATE.exec(`${relPath} ${row.title}`);
  if (fromName) return fromName[1]!;
  return ingestDate(row);
}

/** Transaction time: the day the row landed in the graph. */
export function ingestDate(row: DatedSource): string {
  return row.createdAt.slice(0, 10);
}

/**
 * Both readings of the same rows in one pass, each sorted oldest-first with
 * empty days absent (the dashboard fills its own window).
 */
export function sourceDaySeries(rows: DatedSource[]): SourceDaySeries {
  const byDocument = new Map<string, number>();
  const byIngest = new Map<string, number>();
  for (const row of rows) {
    const domain = documentDate(row);
    const ingest = ingestDate(row);
    byDocument.set(domain, (byDocument.get(domain) ?? 0) + 1);
    byIngest.set(ingest, (byIngest.get(ingest) ?? 0) + 1);
  }
  const series = (counts: Map<string, number>): DocumentsPerDay[] =>
    [...counts.entries()]
      .map(([date, documents]) => ({ date, documents }))
      .sort((left, right) => left.date.localeCompare(right.date));
  return { byDocumentDate: series(byDocument), byIngestDate: series(byIngest) };
}
