import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentDate, ingestDate, sourceDaySeries, type DatedSource } from "../src/sourceStats.js";

/**
 * The dashboard's document chart used to know one date per document: the one
 * the document claims for itself. Two thirds of a real vault carry an older
 * self-declared date, so notes imported this week landed months in the past and
 * the recent window read as a flat zero — indistinguishable from a broken
 * chart. The stats route now returns both readings of the same rows, and these
 * pin the pair: the domain-dated series stays exactly as it was, and the new
 * ingest-dated series puts every document on the day it actually arrived.
 */

function source(overrides: Partial<DatedSource> & { createdAt: string }): DatedSource {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    kind: "markdown_page",
    title: "A note",
    uri: null,
    contentSha256: "sha",
    metadata: {},
    ...overrides,
  };
}

describe("source day series", () => {
  it("dates a document by what it claims, and by when it arrived", () => {
    const row = source({
      createdAt: "2026-09-03T10:00:00.000Z",
      metadata: { frontmatter: { created: "2026-04-22" } },
    });

    assert.equal(documentDate(row), "2026-04-22");
    assert.equal(ingestDate(row), "2026-09-03");
  });

  it("prefers entryDate, then frontmatter, then a date in the path or title", () => {
    const entry = source({
      createdAt: "2026-09-03T10:00:00.000Z",
      metadata: { entryDate: "2026-01-05", frontmatter: { created: "2026-04-22" } },
    });
    const path = source({
      createdAt: "2026-09-03T10:00:00.000Z",
      title: "Standup",
      metadata: { relPath: "journal/2026-02-11-standup.md" },
    });
    const bare = source({ createdAt: "2026-09-03T10:00:00.000Z" });

    assert.equal(documentDate(entry), "2026-01-05");
    assert.equal(documentDate(path), "2026-02-11");
    assert.equal(documentDate(bare), "2026-09-03", "a silent document falls back to ingest time");
  });

  it("returns both series from one pass, oldest first, empty days absent", () => {
    const rows = [
      source({ createdAt: "2026-09-01T09:00:00.000Z", metadata: { frontmatter: { created: "2026-04-22" } } }),
      source({ createdAt: "2026-09-01T11:00:00.000Z", metadata: { frontmatter: { date: "2026-04-22" } } }),
      source({ createdAt: "2026-09-03T08:00:00.000Z", metadata: { entryDate: "2026-06-10" } }),
      source({ createdAt: "2026-09-03T09:00:00.000Z" }),
    ];

    const { byDocumentDate, byIngestDate } = sourceDaySeries(rows);

    assert.deepEqual(byDocumentDate, [
      { date: "2026-04-22", documents: 2 },
      { date: "2026-06-10", documents: 1 },
      { date: "2026-09-03", documents: 1 },
    ]);
    assert.deepEqual(byIngestDate, [
      { date: "2026-09-01", documents: 2 },
      { date: "2026-09-03", documents: 2 },
    ]);

    const documents = (series: Array<{ documents: number }>) =>
      series.reduce((sum, row) => sum + row.documents, 0);
    assert.equal(documents(byDocumentDate), rows.length, "domain series lost a document");
    assert.equal(documents(byIngestDate), rows.length, "ingest series lost a document");
  });
});
