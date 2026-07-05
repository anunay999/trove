import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryGraphStore } from "../src/store.js";
import { sha256 } from "../src/graphCore.js";
import { buildObsidianVaultExport, writeObsidianVaultExport } from "../src/obsidianExport.js";

describe("obsidian vault export", () => {
  const store = new InMemoryGraphStore();
  let vaultExport: ReturnType<typeof buildObsidianVaultExport>;
  let outputDir: string;
  let result: Awaited<ReturnType<typeof writeObsidianVaultExport>>;

  before(async () => {
    vaultExport = buildObsidianVaultExport(
      store.exportMarkdown(),
      store.timeline(),
      store.exportGraph(),
      "2026-07-04T00:00:00.000Z",
    );
    outputDir = await mkdtemp(join(tmpdir(), "trove-obsidian-"));
    result = await writeObsidianVaultExport(outputDir, vaultExport);
  });

  it("writes every file in the vault export", () => {
    assert.equal(result.written, Object.keys(vaultExport.files).length);
  });

  it("produces the index, log, and canvas files", () => {
    assert.ok(vaultExport.files["Trove Index.md"]?.includes("# Trove Index"));
    assert.ok(vaultExport.files["Trove Log.md"]?.includes("# Trove Log"));
    assert.ok(vaultExport.files["Trove.canvas"]?.includes("\"nodes\""));
    assert.ok(vaultExport.files["Trove.canvas"]?.includes("\"edges\""));
    assert.ok(
      Object.keys(vaultExport.files).some((path) => path.startsWith("nodes/") && path.endsWith(".md")),
    );
  });

  it("writes a manifest that matches the in-memory export", async () => {
    const manifestRaw = await readFile(join(outputDir, ".trove", "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as typeof vaultExport.manifest;
    assert.equal(manifest.contentSha256, vaultExport.manifest.contentSha256);
    assert.equal(manifest.fileCount, vaultExport.manifest.fileCount);
  });

  it("hashes and sizes each written file to match the manifest", async () => {
    const manifestRaw = await readFile(join(outputDir, ".trove", "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as typeof vaultExport.manifest;
    for (const file of manifest.files) {
      const content = await readFile(join(outputDir, file.path), "utf8");
      assert.equal(sha256(content), file.sha256);
      assert.equal(Buffer.byteLength(content, "utf8"), file.bytes);
    }
  });
});
