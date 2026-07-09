/**
 * Backfill vault-imported graph nodes so their atom content holds the full
 * page body (Scribe depth), not the historical stub:
 *   "Imported from X.md. The source document remains the evidence layer."
 *
 * Two modes:
 *   1. Direct Postgres: DATABASE_URL=... npm run backfill:vault -- ~/path/to/vault
 *   2. Hosted HTTP:    TROVE_API_URL=https://mytrove.in TROVE_API_TOKEN=... \
 *                      npm run backfill:vault -- ~/path/to/vault
 *
 * Flags:
 *   --dry-run        report what would change, write nothing
 *   --force          rewrite even non-stub content when a vault page matches
 *   --limit=N        process at most N pages (for smoke tests)
 *   --with-evidence  re-ingest + re-annotate evidence units (slower; default off —
 *                    content alone is enough for Scribe-depth recall)
 */
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { remember } from "../src/agentOps.js";
import type { CaptureInput, TextUnit } from "../src/contracts.js";
import { ingestEpisodic, type GraphOperationContext, type GraphStore } from "../src/graphCore.js";
import { PgGraphStore } from "../src/pgStore.js";
import { slugify } from "../src/slug.js";
import { UserStore } from "../src/users.js";
import {
  evidenceRefsFromUnits,
  isStubContent,
  nodeTypeFromPath,
  pageSummary,
  parseFrontmatter,
  titleFromPath,
} from "../src/vaultImport.js";

type CliOptions = {
  vaultRoot: string;
  dryRun: boolean;
  force: boolean;
  withEvidence: boolean;
  limit: number | null;
  apiUrl: string | null;
  apiToken: string | null;
};

type GraphNodeLite = {
  id: string;
  slug: string;
  title: string;
  type: string;
  summary: string | null;
  content: string | null;
  revisionId?: string;
};

type Backend = {
  kind: "db" | "http";
  listNodes: () => Promise<GraphNodeLite[]>;
  remember: (input: {
    title: string;
    type: CaptureInput["type"];
    summary: string;
    content: string;
    /** When set, revises that slug; when omitted, creates (or matches by title). */
    slug?: string;
    evidence: Array<{ sourceId?: string; textUnitId?: string; selector: Record<string, unknown> }>;
  }) => Promise<{ action: string; slug: string }>;
  ingestPage: (input: {
    title: string;
    relPath: string;
    contentText: string;
    frontmatter: Record<string, string>;
  }) => Promise<{ sourceId: string; textUnits: TextUnit[] }>;
  close: () => Promise<void>;
};

const options = parseArgs(process.argv.slice(2));
const backend = options.apiUrl
  ? await createHttpBackend(options.apiUrl, options.apiToken)
  : await createDbBackend();

const markdownFiles = await findMarkdownFiles(options.vaultRoot);
console.log(
  `Backfill vault=${options.vaultRoot} files=${markdownFiles.length} mode=${backend.kind}` +
  `${options.dryRun ? " dry-run" : ""}${options.force ? " force" : ""}` +
  `${options.withEvidence ? " with-evidence" : " content-only"}` +
  `${options.limit ? ` limit=${options.limit}` : ""}`,
);

const existing = await backend.listNodes();
const bySlug = new Map(existing.map((node) => [node.slug, node]));
console.log(`Graph currently has ${existing.length} nodes (${[...bySlug.values()].filter((n) => isStubContent(n.content)).length} stubs).`);

let updated = 0;
let created = 0;
let skipped = 0;
let failed = 0;
let processed = 0;

try {
  for (const filePath of markdownFiles) {
    if (options.limit !== null && processed >= options.limit) break;

    const contentText = await readFile(filePath, "utf8");
    const relPath = relative(options.vaultRoot, filePath);
    // Skip schema/index/log bulk files from becoming single giant "beliefs" when
    // they already exist as episodic sources — still backfill if they are stubs.
    const parsed = parseFrontmatter(contentText);
    const title = parsed.frontmatter.title ?? titleFromPath(filePath);
    const type = nodeTypeFromPath(relPath);
    const slug = slugify(title);
    const body = parsed.body.length > 0 ? parsed.body : contentText;
    const summary = pageSummary(parsed.body, title);
    const existingNode = bySlug.get(slug);

    const needsWrite = options.force
      || !existingNode
      || isStubContent(existingNode.content)
      || (existingNode.content?.length ?? 0) < Math.min(body.length * 0.5, body.length - 200);

    if (!needsWrite) {
      skipped += 1;
      continue;
    }

    processed += 1;
    const action = existingNode ? "update" : "create";
    console.log(`[${action}] ${relPath} → ${slug} (${body.length} chars)`);

    if (options.dryRun) {
      if (existingNode) updated += 1;
      else created += 1;
      continue;
    }

    try {
      let evidence: Array<{ sourceId?: string; textUnitId?: string; selector: Record<string, unknown> }> = [];
      if (options.withEvidence) {
        const ingested = await backend.ingestPage({
          title,
          relPath,
          contentText,
          frontmatter: parsed.frontmatter,
        });
        evidence = evidenceRefsFromUnits(ingested.textUnits, ingested.sourceId).slice(0, 12);
      }
      const result = await backend.remember({
        title,
        type,
        summary,
        content: body,
        // Only pass slug when the node already exists — remember() errors on unknown slug.
        ...(existingNode ? { slug } : {}),
        evidence,
      });
      if (result.action === "created") created += 1;
      else updated += 1;
      bySlug.set(result.slug, {
        id: existingNode?.id ?? result.slug,
        slug: result.slug,
        title,
        type,
        summary,
        content: body,
      });
    } catch (error) {
      failed += 1;
      console.error(`  FAILED ${slug}:`, error instanceof Error ? error.message : error);
    }
  }
} finally {
  await backend.close();
}

console.log(
  `Done. updated=${updated} created=${created} skipped=${skipped} failed=${failed}` +
  (options.dryRun ? " (dry-run)" : ""),
);

function parseArgs(argv: string[]): CliOptions {
  let vaultRoot = "/Users/anunay/Documents/obsidian/claude";
  let dryRun = false;
  let force = false;
  let withEvidence = false;
  let limit: number | null = null;
  const apiUrl = process.env.TROVE_API_URL?.replace(/\/$/, "") || null;
  const apiToken = process.env.TROVE_API_TOKEN || extractAdminTokenFromEnv() || null;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--with-evidence") withEvidence = true;
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    else if (!arg.startsWith("-")) vaultRoot = arg;
  }

  if (apiUrl && !apiToken) {
    throw new Error("TROVE_API_URL set but no TROVE_API_TOKEN (or admin service token in .env).");
  }

  return { vaultRoot, dryRun, force, withEvidence, limit, apiUrl, apiToken };
}

function extractAdminTokenFromEnv(): string | null {
  // Prefer TROVE_API_TOKEN; fall back to an admin entry in TROVE_SERVICE_TOKENS / .env.
  const raw = process.env.TROVE_SERVICE_TOKENS ?? readEnvFileValue("TROVE_SERVICE_TOKENS") ?? "";
  for (const entry of raw.split(";")) {
    const [token, , scopesRaw] = entry.split("|").map((part) => part?.trim());
    if (token && scopesRaw?.includes("graph:admin")) return token;
    if (token && scopesRaw?.includes("graph:write")) return token;
  }
  const bare = raw.match(/(?:gm_admin_|trove_)[A-Za-z0-9_]+/);
  return bare?.[0] ?? null;
}

function readEnvFileValue(key: string): string | null {
  try {
    const path = fileURLToPath(new URL("../.env", import.meta.url));
    const text = readFileSync(path, "utf8");
    const match = new RegExp(`^${key}=(.*)$`, "m").exec(text);
    if (!match) return null;
    return match[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
  } catch {
    return null;
  }
}

async function createDbBackend(): Promise<Backend> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TROVE_API_URL is not set.");
  }
  const store = new PgGraphStore({ connectionString: databaseUrl });
  const userStore = new UserStore({ connectionString: databaseUrl });
  const ownerId = await userStore.ownerForServiceToken(process.env.TROVE_SERVICE_OWNER_EMAIL?.trim() || undefined);
  await userStore.close();
  const context: GraphOperationContext = ownerId
    ? { actorId: "vault-backfill", interfaceId: "vault-backfill", ownerId }
    : { actorId: "vault-backfill", interfaceId: "vault-backfill", superuser: true };
  console.log(ownerId ? `DB backfill as owner ${ownerId}` : "DB backfill as superuser");

  return {
    kind: "db",
    async listNodes() {
      const graph = await store.exportGraph(context);
      return graph.nodes.map((node) => ({
        id: node.id,
        slug: node.slug,
        title: node.title,
        type: node.type,
        summary: node.summary,
        content: node.content,
        revisionId: node.revisionId,
      }));
    },
    async remember(input) {
      const result = await remember(store as GraphStore, {
        title: input.title,
        type: input.type,
        summary: input.summary,
        content: input.content,
        slug: input.slug,
        evidence: input.evidence,
      }, context);
      return { action: result.action, slug: result.node.slug };
    },
    async ingestPage(input) {
      const episodic = await ingestEpisodic(store, {
        kind: "markdown_page",
        title: input.title,
        uri: `obsidian://${input.relPath}`,
        relPath: input.relPath,
        contentText: input.contentText,
        metadata: { frontmatter: input.frontmatter },
      }, context);
      const first = episodic.results[0];
      if (!first) throw new Error(`ingest produced no result for ${input.relPath}`);
      return { sourceId: first.source.id, textUnits: first.textUnits };
    },
    async close() {
      await store.close();
    },
  };
}

async function createHttpBackend(apiUrl: string, apiToken: string | null): Promise<Backend> {
  if (!apiToken) throw new Error("TROVE_API_TOKEN required for HTTP backfill.");
  console.log(`HTTP backfill → ${apiUrl}`);

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "X-Trove-Interface": "vault-backfill",
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${apiUrl}${path}`, init);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    }
    return await response.json() as T;
  }

  return {
    kind: "http",
    async listNodes() {
      const graph = await request<{ nodes: GraphNodeLite[] }>("GET", "/v1/graph");
      return graph.nodes;
    },
    async remember(input) {
      const result = await request<{ action: string; node: { slug: string } }>("POST", "/v1/remember", {
        title: input.title,
        type: input.type,
        summary: input.summary,
        content: input.content,
        slug: input.slug,
        evidence: input.evidence,
      });
      return { action: result.action, slug: result.node.slug };
    },
    async ingestPage(input) {
      const result = await request<{ source: { id: string }; textUnits: TextUnit[] }>("POST", "/v1/ingest", {
        kind: "markdown_page",
        title: input.title,
        uri: `obsidian://${input.relPath}`,
        contentText: input.contentText,
        metadata: { frontmatter: input.frontmatter, relPath: input.relPath },
      });
      return { sourceId: result.source.id, textUnits: result.textUnits };
    },
    async close() {
      // nothing
    },
  };
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root);
  for (const entry of entries) {
    if (entry === ".obsidian" || entry === ".stversions" || entry === ".stfolder" || entry === "node_modules") {
      continue;
    }
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
