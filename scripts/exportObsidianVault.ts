import { resolve } from "node:path";
import { createGraphStore } from "../src/createStore.js";
import { buildObsidianVaultExport, writeObsidianVaultExport } from "../src/obsidianExport.js";

const outputDir = resolve(process.argv[2] ?? "exports/obsidian");
const { store, driver } = createGraphStore();

try {
  const vaultExport = buildObsidianVaultExport(
    await store.exportMarkdown(),
    await store.timeline(),
    await store.exportGraph(),
  );
  const result = await writeObsidianVaultExport(outputDir, vaultExport);
  console.log(JSON.stringify({
    ...result,
    driver,
    fileCount: vaultExport.manifest.fileCount,
    contentSha256: vaultExport.manifest.contentSha256,
  }, null, 2));
} finally {
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
}
