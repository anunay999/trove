import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { ingestEpisodic, type GraphOperationContext } from "../src/graphCore.js";
import { PgGraphStore } from "../src/pgStore.js";
import { UserStore } from "../src/users.js";
import { slugify } from "../src/slug.js";
import type { CaptureInput, GraphSource, TextUnit } from "../src/contracts.js";
import {
  evidenceRefsFromUnits,
  extractWikilinkSlugs,
  nodeTypeFromPath,
  pageSummary,
  parseFrontmatter,
  titleFromPath,
} from "../src/vaultImport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const vaultRoot = process.argv[2] ?? "/Users/anunay/Documents/obsidian/claude";
const store = new PgGraphStore({ connectionString: databaseUrl });

// Import as an owner so the vault lands in that user's graph (not unowned).
// Defaults to TROVE_SERVICE_OWNER_EMAIL, else the founding admin; falls back to
// superuser (unowned) only on an instance with no users yet.
const userStore = new UserStore({ connectionString: databaseUrl });
const ownerId = await userStore.ownerForServiceToken(process.env.TROVE_SERVICE_OWNER_EMAIL?.trim() || undefined);
await userStore.close();
const importContext: GraphOperationContext = ownerId
  ? { actorId: "vault-import", interfaceId: "vault-import", ownerId }
  : { actorId: "vault-import", interfaceId: "vault-import", superuser: true };
console.log(ownerId ? `Importing as owner ${ownerId}` : "Importing as superuser (no users yet; rows unowned)");
const markdownFiles = await findMarkdownFiles(vaultRoot);
let imported = 0;
let skipped = 0;
let linked = 0;
const episodeStats = { files: 0, newSegments: 0, totalSegments: 0 };

try {
  for (const filePath of markdownFiles) {
    const contentText = await readFile(filePath, "utf8");
    const relPath = relative(vaultRoot, filePath);
    const parsed = parseFrontmatter(contentText);
    const title = parsed.frontmatter.title ?? titleFromPath(filePath);
    const type = nodeTypeFromPath(relPath);
    const nodeSlug = slugify(title);
    const episodic = await ingestEpisodic(store, {
      kind: "markdown_page",
      title,
      uri: `obsidian://${relPath}`,
      relPath,
      contentText,
      metadata: { frontmatter: parsed.frontmatter },
    }, importContext);
    const firstResult = episodic.results[0];
    if (!firstResult) continue;
    const { source, textUnits } = firstResult;
    if (episodic.episodic) {
      episodeStats.files += 1;
      episodeStats.newSegments += episodic.newSegments;
      episodeStats.totalSegments += episodic.totalSegments;
    }

    const existing = await store.read({ slug: nodeSlug }, importContext);
    if (existing) {
      skipped += 1;
      continue;
    }

    // Full page body is the belief content so recall/grep/read match Scribe depth.
    // Sources remain the immutable evidence layer; evidence annotations cite units.
    await capturePageNode(store, {
      title,
      type,
      summary: pageSummary(parsed.body, title),
      content: parsed.body.length > 0 ? parsed.body : contentText,
      source,
      textUnits,
    }, importContext);
    imported += 1;
  }

  for (const filePath of markdownFiles) {
    const contentText = await readFile(filePath, "utf8");
    const relPath = relative(vaultRoot, filePath);
    const parsed = parseFrontmatter(contentText);
    const title = parsed.frontmatter.title ?? titleFromPath(filePath);
    const fromSlug = slugify(title);

    for (const targetSlug of extractWikilinkSlugs(parsed.body)) {
      const edge = await store.link({
        fromSlug,
        toSlug: targetSlug,
        predicate: "mentions",
        weight: 1,
      }, importContext);
      if (edge) linked += 1;
    }
  }

  console.log(
    `Imported ${imported} markdown files from ${vaultRoot}; skipped ${skipped}; linked ${linked}; ` +
    `episodic files ${episodeStats.files} (${episodeStats.newSegments} new of ${episodeStats.totalSegments} segments)`,
  );
} finally {
  await store.close();
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root);
  for (const entry of entries) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      found.push(...await findMarkdownFiles(path));
      continue;
    }
    if (info.isFile() && extname(path) === ".md" && !basename(path).includes(".sync-conflict-")) {
      found.push(path);
    }
  }
  return found.sort();
}

async function capturePageNode(
  store: PgGraphStore,
  input: {
    title: string;
    type: CaptureInput["type"];
    summary: string;
    content: string;
    source: GraphSource;
    textUnits: TextUnit[];
  },
  context?: GraphOperationContext,
): Promise<void> {
  await store.capture({
    title: input.title,
    type: input.type,
    summary: input.summary,
    content: input.content,
    evidence: evidenceRefsFromUnits(input.textUnits, input.source.id),
    links: [],
  }, context);
}
