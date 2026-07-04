export type NodeType =
  | "entity" | "project" | "pattern" | "domain" | "person" | "infrastructure"
  | "claim" | "decision" | "task" | "question" | "community" | "view";

export type GraphNode = {
  id: string;
  type: NodeType;
  slug: string;
  title: string;
  summary: string | null;
  content: string | null;
  revisionId: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt: string | null;
};

export type GraphEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  predicate: string;
  weight: number;
  recordedAt: string;
  validFrom: string | null;
  validUntil: string | null;
  expiredAt: string | null;
  invalidatedBy: string | null;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type CountRow = { key: string; count: number };

export type Stats = {
  totals: {
    nodes: number;
    edges: number;
    views: number;
    events: number;
    eventsTruncated: boolean;
    ingests: number;
    totalRecalls: number;
  };
  nodeTypes: CountRow[];
  predicates: CountRow[];
  actions: CountRow[];
  eventsPerDay: Array<{ date: string; total: number; writes: number }>;
  sourcesPerDay: Array<{ date: string; documents: number }>;
  topAccessed: Array<{
    id: string;
    slug: string;
    title: string;
    type: NodeType;
    accessCount: number;
    lastAccessedAt: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    action: string;
    entityTable: string;
    entityId: string;
    actorHandle: string | null;
    interfaceId: string | null;
    createdAt: string;
  }>;
  jobs: CountRow[];
  lint: {
    summary: { nodes: number; edges: number; findings: number; errors: number; warnings: number };
    findings: Array<{ severity: "info" | "warning" | "error"; code: string; message: string }>;
  };
};

export type TextUnitEvidence = {
  id: string;
  sourceId: string;
  text: string;
};

export type NodeDetail = {
  node: GraphNode & {
    evidence: Array<TextUnitEvidence | { id: string; title: string; kind: string }>;
    annotations: Array<{ id: string; motivation: string; sourceId: string | null; textUnitId: string | null }>;
  };
};

async function getJson<T>(path: string): Promise<T> {
  const token = window.localStorage.getItem("graphmind_token");
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const fetchStats = (): Promise<Stats> => getJson<Stats>("/v1/stats");
export const fetchGraph = (): Promise<GraphSnapshot> => getJson<GraphSnapshot>("/v1/graph");

export type SourceDocument = {
  id: string;
  kind: string;
  title: string;
  uri: string | null;
  createdAt: string;
  contentText: string;
  metadata?: Record<string, unknown>;
};

export type LogicalDocument = {
  uri: string;
  title: string;
  contentText: string;
  segmentCount: number;
};

export async function fetchDocument(uri: string): Promise<LogicalDocument> {
  const token = window.localStorage.getItem("graphmind_token");
  const response = await fetch("/v1/document", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ uri }),
  });
  if (!response.ok) throw new Error(`document failed: ${response.status}`);
  const body = (await response.json()) as { document: LogicalDocument };
  return body.document;
}

export async function fetchSource(sourceId: string): Promise<SourceDocument> {
  const token = window.localStorage.getItem("graphmind_token");
  const response = await fetch("/v1/source", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ sourceId }),
  });
  if (!response.ok) throw new Error(`source failed: ${response.status}`);
  const body = (await response.json()) as { source: SourceDocument };
  return body.source;
}

export async function fetchNode(nodeId: string): Promise<NodeDetail> {
  const token = window.localStorage.getItem("graphmind_token");
  const response = await fetch("/v1/read", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ nodeId }),
  });
  if (!response.ok) throw new Error(`read failed: ${response.status}`);
  return response.json() as Promise<NodeDetail>;
}
