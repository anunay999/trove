import { createGraphStore } from "../src/createStore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "sources-smoke",
  interfaceId: "sources-smoke",
  requestId: `sources-smoke-${stamp}`,
};

try {
  const ingested = await store.ingest({
    kind: "markdown_page",
    title: `Sources smoke ${stamp}`,
    contentText: "---\ncreated: 2026-05-13\n---\n\n# Sources smoke\n\nDomain-dated document body.",
    metadata: { relPath: `worklog-${stamp}.md`, frontmatter: { created: "2026-05-13" } },
  }, context);

  const listed = await store.sources({ limit: 1000 });
  const mine = listed.find((row) => row.id === ingested.source.id);
  if (!mine) throw new Error("sources() must list the ingested source.");
  if (!mine.createdAt) throw new Error("sources() rows must carry createdAt.");
  const frontmatter = (mine.metadata as { frontmatter?: { created?: string } }).frontmatter;
  if (frontmatter?.created !== "2026-05-13") {
    throw new Error("sources() rows must preserve ingest metadata (frontmatter dates).");
  }

  const document = await store.readSource({ sourceId: ingested.source.id });
  if (!document) throw new Error("readSource() must return the ingested source.");
  if (!document.contentText.includes("Domain-dated document body.")) {
    throw new Error("readSource() must return the full document text.");
  }

  console.log(JSON.stringify({ ok: true, driver, listed: listed.length }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
