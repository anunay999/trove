import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryGraphStore } from "../src/store.js";
import { sha256 } from "../src/graphCore.js";
import { buildObsidianVaultExport, writeObsidianVaultExport } from "../src/obsidianExport.js";

const store = new InMemoryGraphStore();
const vaultExport = buildObsidianVaultExport(
  store.exportMarkdown(),
  store.timeline(),
  store.exportGraph(),
  "2026-07-04T00:00:00.000Z",
);
const outputDir = await mkdtemp(join(tmpdir(), "graphmind-obsidian-"));
const result = await writeObsidianVaultExport(outputDir, vaultExport);

assert.equal(result.written, Object.keys(vaultExport.files).length);
assert.ok(vaultExport.files["GraphMind Index.md"]?.includes("# GraphMind Index"));
assert.ok(vaultExport.files["GraphMind Log.md"]?.includes("# GraphMind Log"));
assert.ok(vaultExport.files["GraphMind.canvas"]?.includes("\"nodes\""));
assert.ok(vaultExport.files["GraphMind.canvas"]?.includes("\"edges\""));
assert.ok(Object.keys(vaultExport.files).some((path) => path.startsWith("nodes/") && path.endsWith(".md")));

const manifestRaw = await readFile(join(outputDir, ".graphmind", "manifest.json"), "utf8");
const manifest = JSON.parse(manifestRaw) as typeof vaultExport.manifest;
assert.equal(manifest.contentSha256, vaultExport.manifest.contentSha256);
assert.equal(manifest.fileCount, vaultExport.manifest.fileCount);

for (const file of manifest.files) {
  const content = await readFile(join(outputDir, file.path), "utf8");
  assert.equal(sha256(content), file.sha256);
  assert.equal(Buffer.byteLength(content, "utf8"), file.bytes);
}

console.log(JSON.stringify({
  ok: true,
  outputDir,
  written: result.written,
  fileCount: manifest.fileCount,
  contentSha256: manifest.contentSha256,
}, null, 2));
