import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { sha256, type GraphEvent, type GraphSnapshot } from "./graphCore.js";

export type ObsidianManifestFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ObsidianManifest = {
  formatVersion: 1;
  generatedAt: string;
  fileCount: number;
  contentSha256: string;
  files: ObsidianManifestFile[];
};

export type ObsidianVaultExport = {
  manifest: ObsidianManifest;
  files: Record<string, string>;
};

export function buildObsidianVaultExport(
  nodeMarkdownFiles: Record<string, string>,
  timeline: GraphEvent[],
  graph?: GraphSnapshot,
  generatedAt = new Date().toISOString(),
): ObsidianVaultExport {
  const files: Record<string, string> = {};
  const nodePaths = Object.keys(nodeMarkdownFiles).sort().map((fileName) => {
    const safeName = safeRelativePath(fileName);
    const path = `nodes/${safeName}`;
    files[path] = nodeMarkdownFiles[fileName] ?? "";
    return path;
  });

  files["Trove Index.md"] = renderIndex(nodePaths);
  files["Trove Log.md"] = renderLog(timeline);
  if (graph) {
    files["Trove.canvas"] = renderCanvas(graph);
    files["Trove Views.md"] = renderViewsIndex(graph.views ?? []);
    for (const view of graph.views ?? []) {
      const viewNodes = graph.nodes.filter((node) => view.includedNodeIds.includes(node.id));
      const viewNodeIds = new Set(viewNodes.map((node) => node.id));
      const viewEdges = graph.edges.filter((edge) =>
        view.includedEdgeIds.includes(edge.id) &&
        viewNodeIds.has(edge.fromNodeId) &&
        viewNodeIds.has(edge.toNodeId)
      );
      files[`views/${safeRelativePath(`${view.slug}.canvas`)}`] = renderCanvas({
        nodes: viewNodes,
        edges: viewEdges,
      });
    }
  }

  const manifest = buildManifest(files, generatedAt);
  files[".trove/manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  return {
    manifest: buildManifest(files, generatedAt),
    files: sortRecord(files),
  };
}

export async function writeObsidianVaultExport(
  outputDir: string,
  vaultExport: ObsidianVaultExport,
): Promise<{ outputDir: string; written: number; removed: number }> {
  const previousManifestPath = join(outputDir, ".trove", "manifest.json");
  const previousManifest = await readPreviousManifest(previousManifestPath);
  const nextPaths = new Set(Object.keys(vaultExport.files));
  let removed = 0;

  for (const file of previousManifest?.files ?? []) {
    if (nextPaths.has(file.path)) continue;
    await rm(join(outputDir, safeRelativePath(file.path)), { force: true });
    removed += 1;
  }

  for (const [relativePath, content] of Object.entries(vaultExport.files)) {
    const safePath = safeRelativePath(relativePath);
    const absolutePath = join(outputDir, safePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return { outputDir, written: Object.keys(vaultExport.files).length, removed };
}

function renderIndex(nodePaths: string[]): string {
  return [
    "---",
    "trove_projection: obsidian",
    "trove_role: index",
    "---",
    "",
    "# Trove Index",
    "",
    ...nodePaths.map((path) => {
      const basename = path.split("/").at(-1)?.replace(/\.md$/, "") ?? path;
      return `- [[${basename}]]`;
    }),
    "",
  ].join("\n");
}

function renderLog(timeline: GraphEvent[]): string {
  return [
    "---",
    "trove_projection: obsidian",
    "trove_role: log",
    "---",
    "",
    "# Trove Log",
    "",
    ...timeline.slice(0, 100).map((event) => {
      const actor = event.actorHandle ? ` by ${event.actorHandle}` : "";
      const iface = event.interfaceId ? ` via ${event.interfaceId}` : "";
      const request = event.requestId ? ` (${event.requestId})` : "";
      return `- ${event.createdAt} - ${event.action} ${event.entityId}${actor}${iface}${request}`;
    }),
    "",
  ].join("\n");
}

function renderViewsIndex(views: NonNullable<GraphSnapshot["views"]>): string {
  return [
    "---",
    "trove_projection: obsidian",
    "trove_role: views",
    "---",
    "",
    "# Trove Views",
    "",
    ...views
      .slice()
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((view) => {
        const root = view.rootNodeId ? ` root=${view.rootNodeId}` : "";
        const query = view.query ? ` query="${view.query}"` : "";
        return `- [[views/${view.slug}.canvas|${view.title}]] - ${view.includedNodeIds.length} nodes, ${view.includedEdgeIds.length} edges${root}${query}`;
      }),
    "",
  ].join("\n");
}

function renderCanvas(graph: GraphSnapshot): string {
  const sortedNodes = [...graph.nodes].sort((left, right) => left.slug.localeCompare(right.slug));
  const nodeIds = new Set(sortedNodes.map((node) => node.id));
  const columns = Math.max(1, Math.ceil(Math.sqrt(sortedNodes.length)));
  const canvasNodes = sortedNodes.map((node, index) => ({
    id: node.id,
    type: "file",
    file: `nodes/${safeRelativePath(`${node.slug}.md`)}`,
    x: (index % columns) * 520,
    y: Math.floor(index / columns) * 360,
    width: 420,
    height: 260,
  }));
  const canvasEdges = graph.edges
    .filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
    .sort((left, right) => `${left.predicate}:${left.id}`.localeCompare(`${right.predicate}:${right.id}`))
    .map((edge) => ({
      id: edge.id,
      fromNode: edge.fromNodeId,
      fromSide: "right",
      toNode: edge.toNodeId,
      toSide: "left",
      label: edge.predicate,
    }));

  return `${JSON.stringify({ nodes: canvasNodes, edges: canvasEdges }, null, 2)}\n`;
}

function buildManifest(files: Record<string, string>, generatedAt: string): ObsidianManifest {
  const manifestFiles = Object.entries(files)
    .filter(([path]) => path !== ".trove/manifest.json")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({
      path,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    }));

  const contentSha256 = sha256(JSON.stringify(manifestFiles));
  return {
    formatVersion: 1,
    generatedAt,
    fileCount: manifestFiles.length,
    contentSha256,
    files: manifestFiles,
  };
}

async function readPreviousManifest(path: string): Promise<ObsidianManifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ObsidianManifest;
  } catch {
    return null;
  }
}

function safeRelativePath(path: string): string {
  const normalized = normalize(path).replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    throw new Error(`Unsafe export path: ${path}`);
  }
  return normalized;
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}
