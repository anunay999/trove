import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

describe("sources", () => {
  const { store, context, stamp } = suiteStore("sources");
  let sourceId: string;

  after(async () => {
    await closeStore(store);
  });

  it("ingests a domain-dated markdown document", async () => {
    const ingested = await store.ingest({
      kind: "markdown_page",
      title: `Sources smoke ${stamp}`,
      contentText: "---\ncreated: 2026-05-13\n---\n\n# Sources smoke\n\nDomain-dated document body.",
      metadata: { relPath: `worklog-${stamp}.md`, frontmatter: { created: "2026-05-13" } },
    }, context);
    sourceId = ingested.source.id;
  });

  it("lists the source with its ingest metadata preserved", async () => {
    const listed = await store.sources({ limit: 1000 });
    const mine = listed.find((row) => row.id === sourceId);
    assert.ok(mine, "sources() must list the ingested source");
    assert.ok(mine.createdAt, "sources() rows must carry createdAt");
    const frontmatter = (mine.metadata as { frontmatter?: { created?: string } }).frontmatter;
    assert.equal(frontmatter?.created, "2026-05-13", "sources() rows must preserve ingest frontmatter");
  });

  it("reads back the full document text", async () => {
    const document = await store.readSource({ sourceId });
    assert.ok(document, "readSource() must return the ingested source");
    assert.ok(document.contentText.includes("Domain-dated document body."), "readSource() must return the full text");
  });
});
