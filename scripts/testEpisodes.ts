import { createGraphStore } from "../src/createStore.js";
import { ingestEpisodic, splitLogicalSegments } from "../src/graphCore.js";

const { store, driver } = createGraphStore();
const stamp = Date.now();
const context = {
  actorId: "episodes-smoke",
  interfaceId: "episodes-smoke",
  requestId: `episodes-smoke-${stamp}`,
};

const logV1 = [
  "# Log",
  "",
  "## [2026-06-01] ingest | first entry",
  "",
  "Alpha entry body with enough text to matter.",
  "",
  "## [2026-06-02] pr | second entry",
  "",
  "Beta entry body, also meaningful.",
  "",
  "## [2026-06-03] decision | third entry",
  "",
  "Gamma entry body closes the file.",
].join("\n");

const logV2 = [
  logV1,
  "",
  "## [2026-06-04] capture | fourth entry",
  "",
  "Delta entry appended later.",
].join("\n");

try {
  const split = splitLogicalSegments(logV1, `log-${stamp}.md`);
  if (!split || split.mode !== "dated" || split.segments.length !== 4) {
    throw new Error("Dated log files must split into preamble plus one segment per entry.");
  }
  if (split.segments[1]?.date !== "2026-06-01") {
    throw new Error("Segments must carry their entry date.");
  }

  const registry = "# Index\n\n## Active\n\n- one\n\n## Completed\n\n- two\n";
  const registrySplit = splitLogicalSegments(registry, `${stamp}/index.md`);
  if (!registrySplit || registrySplit.mode !== "sectional" || registrySplit.segments.length < 2) {
    throw new Error("Registry files must split into sections.");
  }

  const uri = `obsidian://log-${stamp}.md`;
  const first = await ingestEpisodic(store, {
    kind: "markdown_page",
    title: `Log ${stamp}`,
    uri,
    relPath: `log-${stamp}.md`,
    contentText: logV1,
  }, context);
  if (first.newSegments !== 4) {
    throw new Error(`First episodic ingest must create 4 sources, created ${first.newSegments}.`);
  }

  const second = await ingestEpisodic(store, {
    kind: "markdown_page",
    title: `Log ${stamp}`,
    uri,
    relPath: `log-${stamp}.md`,
    contentText: logV2,
  }, context);
  if (second.newSegments !== 1) {
    throw new Error(`Re-ingest with one appended entry must create exactly 1 new source, created ${second.newSegments}.`);
  }

  const reconstructed = await store.readDocument({ uri });
  if (!reconstructed) throw new Error("readDocument must reconstruct the logical file.");
  if (!reconstructed.contentText.includes("Alpha entry body") || !reconstructed.contentText.includes("Delta entry appended later")) {
    throw new Error("Reconstructed document must contain all entries in order.");
  }
  if (reconstructed.contentText.indexOf("Alpha entry body") > reconstructed.contentText.indexOf("Delta entry appended later")) {
    throw new Error("Reconstructed document must preserve entry order.");
  }
  if (reconstructed.segmentCount < 4) {
    throw new Error("Reconstructed document must report its segment count.");
  }

  console.log(JSON.stringify({
    ok: true,
    driver,
    firstIngest: first.newSegments,
    secondIngest: second.newSegments,
    segments: reconstructed.segmentCount,
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
