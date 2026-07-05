import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { ingestEpisodic, splitLogicalSegments } from "../src/graphCore.js";
import { suiteStore, closeStore } from "./helpers.js";

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

describe("episodic ingest", () => {
  const { store, context, stamp } = suiteStore("episodes");
  const logV2 = [logV1, "", "## [2026-06-04] capture | fourth entry", "", "Delta entry appended later."].join("\n");
  const uri = `obsidian://log-${stamp}.md`;

  after(async () => {
    await closeStore(store);
  });

  it("splits dated log files into a preamble plus one segment per entry", () => {
    const split = splitLogicalSegments(logV1, `log-${stamp}.md`);
    assert.ok(split && split.mode === "dated" && split.segments.length === 4, "dated log files must split per entry");
    assert.equal(split.segments[1]?.date, "2026-06-01", "segments must carry their entry date");
  });

  it("splits registry files into sections", () => {
    const registry = "# Index\n\n## Active\n\n- one\n\n## Completed\n\n- two\n";
    const registrySplit = splitLogicalSegments(registry, `${stamp}/index.md`);
    assert.ok(
      registrySplit && registrySplit.mode === "sectional" && registrySplit.segments.length >= 2,
      "registry files must split into sections",
    );
  });

  it("ingests each dated entry as its own source", async () => {
    const first = await ingestEpisodic(store, {
      kind: "markdown_page",
      title: `Log ${stamp}`,
      uri,
      relPath: `log-${stamp}.md`,
      contentText: logV1,
    }, context);
    assert.equal(first.newSegments, 4, "first episodic ingest must create 4 sources");
  });

  it("re-ingest only creates sources for newly appended entries", async () => {
    const second = await ingestEpisodic(store, {
      kind: "markdown_page",
      title: `Log ${stamp}`,
      uri,
      relPath: `log-${stamp}.md`,
      contentText: logV2,
    }, context);
    assert.equal(second.newSegments, 1, "re-ingest with one appended entry must create exactly 1 new source");
  });

  it("reconstructs the logical document in order", async () => {
    const reconstructed = await store.readDocument({ uri });
    assert.ok(reconstructed, "readDocument must reconstruct the logical file");
    assert.ok(reconstructed.contentText.includes("Alpha entry body"), "must contain the first entry");
    assert.ok(reconstructed.contentText.includes("Delta entry appended later"), "must contain the appended entry");
    assert.ok(
      reconstructed.contentText.indexOf("Alpha entry body") < reconstructed.contentText.indexOf("Delta entry appended later"),
      "reconstructed document must preserve entry order",
    );
    assert.ok(reconstructed.segmentCount >= 4, "reconstructed document must report its segment count");
  });
});
