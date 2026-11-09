import type { GraphEdge, GraphNode, TextUnit } from "./contracts.js";

export function renderMarkdownProjection(
  node: GraphNode,
  evidence: TextUnit[],
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[] },
): string {
  const related = neighborhood.nodes.filter((neighbor) => neighbor.id !== node.id);
  return [
    "---",
    `trove_id: ${node.id}`,
    `revision_id: ${node.revisionId}`,
    `type: ${node.type}`,
    `updated_at: ${node.updatedAt}`,
    "---",
    "",
    `# ${node.title}`,
    "",
    node.summary ?? "",
    "",
    node.content ?? "",
    "",
    "## Evidence",
    ...evidence.map((unit) => `- ${unit.text}`),
    "",
    "## Related",
    ...related.map((neighbor) => `- [[${neighbor.slug}|${neighbor.title}]]`),
  ].join("\n").trimEnd();
}

export function renderAgentContext(
  node: GraphNode,
  evidence: TextUnit[],
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[] },
): string {
  const edges = neighborhood.edges.map((edge) => `${edge.fromNodeId} -[${edge.predicate}]-> ${edge.toNodeId}`);
  return [
    `Node: ${node.title} (${node.type})`,
    `Updated: ${node.updatedAt}`,
    `Summary: ${node.summary ?? ""}`,
    node.content ? `Content: ${node.content}` : "",
    "Evidence:",
    ...evidence.map((unit) => `- ${unit.text}`),
    "Edges:",
    ...edges,
  ].filter(Boolean).join("\n");
}
