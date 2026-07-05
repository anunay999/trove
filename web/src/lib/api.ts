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

// When the user is signed in with Clerk, the App registers a provider that
// yields a fresh session JWT; otherwise we fall back to the stored API key.
let sessionTokenProvider: (() => Promise<string | null>) | null = null;
export function setSessionTokenProvider(provider: (() => Promise<string | null>) | null): void {
  sessionTokenProvider = provider;
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = sessionTokenProvider ? await sessionTokenProvider().catch(() => null) : null;
  const token = session ?? window.localStorage.getItem("trove_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: await authHeaders() });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function sendJson<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "POST",
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(await authHeaders()),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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
  const body = await sendJson<{ document: LogicalDocument }>("/v1/document", { body: { uri } });
  return body.document;
}

export async function fetchSource(sourceId: string): Promise<SourceDocument> {
  const body = await sendJson<{ source: SourceDocument }>("/v1/source", { body: { sourceId } });
  return body.source;
}

export async function fetchNode(nodeId: string): Promise<NodeDetail> {
  return sendJson<NodeDetail>("/v1/read", { body: { nodeId } });
}

// ---- Identity, API keys, admin ----

export type Me = {
  actorId: string;
  mode: "disabled" | "token" | "api_key" | "clerk";
  scopes: string[];
  identity: {
    userId: string;
    clerkUserId: string;
    email: string | null;
    role: "admin" | "member";
    status: "waitlisted" | "active" | "suspended";
  } | null;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  secret: string | null;
};

export type AppUser = {
  id: string;
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  role: "admin" | "member";
  status: "waitlisted" | "active" | "suspended";
  createdAt: string;
  approvedAt: string | null;
};

export const fetchMe = (): Promise<Me> => getJson<Me>("/v1/me");
export type ServiceTokenSummary = { actorId: string; scopes: string[]; tokenPreview: string; token: string };
export const fetchKeys = (): Promise<{ keys: ApiKeySummary[]; serviceTokens?: ServiceTokenSummary[] }> =>
  getJson<{ keys: ApiKeySummary[]; serviceTokens?: ServiceTokenSummary[] }>("/v1/keys");
export const createKey = (name: string, scopes: string[]): Promise<{ key: ApiKeySummary; secret: string }> =>
  sendJson("/v1/keys", { body: { name, scopes } });
export const revokeKey = (id: string): Promise<{ revoked: boolean }> =>
  sendJson(`/v1/keys/${id}`, { method: "DELETE" });
export const fetchUsers = (): Promise<{ users: AppUser[] }> => getJson<{ users: AppUser[] }>("/v1/admin/users");
export const approveUser = (clerkUserId: string): Promise<{ user: AppUser }> =>
  sendJson("/v1/admin/users/approve", { body: { clerkUserId } });

export const setUserStatus = (clerkUserId: string, status: AppUser["status"]): Promise<{ user: AppUser }> =>
  sendJson("/v1/admin/users/status", { body: { clerkUserId, status } });
