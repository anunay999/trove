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
  invalidationReason: "superseded" | "invalidated" | "tombstoned" | null;
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
  /** Memories by the day each was first written — the timeline's own subject. */
  memoriesPerDay: Array<{ date: string; memories: number }>;
  /** Documents dated by domain time — the date each one claims for itself. */
  sourcesPerDay: Array<{ date: string; documents: number }>;
  /** The same documents dated by ingest time — the day Trove received them. */
  sourcesIngestedPerDay: Array<{ date: string; documents: number }>;
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
  /**
   * The last recall self-test: which notes the graph could not find when asked
   * about them in their own words. Null until the job has run once.
   */
  selfTest: {
    probed: number;
    found: number;
    skipped: number;
    blindSpots: Array<{
      nodeId: string;
      slug: string;
      title: string;
      shadowedBy: Array<{ id: string; title: string }>;
    }>;
    ranAt: string | null;
  } | null;
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

// Admin "view as user": while set, every request carries the target's Clerk id
// and the API answers with that account's graph and keys. Kept in localStorage
// so the choice survives a reload — switching users reloads the dashboard.
const IMPERSONATE_KEY = "trove_impersonate";

export function getImpersonation(): string | null {
  return window.localStorage.getItem(IMPERSONATE_KEY);
}

export function setImpersonation(clerkUserId: string | null): void {
  if (clerkUserId) window.localStorage.setItem(IMPERSONATE_KEY, clerkUserId);
  else window.localStorage.removeItem(IMPERSONATE_KEY);
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = sessionTokenProvider ? await sessionTokenProvider().catch(() => null) : null;
  const token = session ?? window.localStorage.getItem("trove_token");
  const impersonate = getImpersonation();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(impersonate ? { "X-Trove-Impersonate": impersonate } : {}),
  };
}

/**
 * A failed request that still knows what the server said.
 *
 * The status is the difference between "you are not signed in yet" and "that
 * was refused", and callers that recover from one must not recover from the
 * other. Losing it to a formatted string is how a 401 came to be treated as a
 * rejected impersonation.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} failed: ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: await authHeaders() });
  if (!response.ok) {
    throw new HttpError(path, response.status);
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

/** A companion skill's markdown, frontmatter stripped. Public route; no auth. */
export async function fetchSkillBody(name: string): Promise<string> {
  const response = await fetch(`/skills/${name}.md`);
  if (!response.ok) throw new Error(`/skills/${name}.md failed: ${response.status}`);
  const raw = await response.text();
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
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

// ---- Graph chat (streamed retrieval) ----
//
// The wire protocol of POST /v1/graph-chat (src/graphChat.ts). Every event is
// something retrieval really did, in the order it did it — the graph view
// lights nodes straight from these, so nothing here may be invented, reordered
// or replayed on a timer.

export type ChatNodeRef = {
  id: string;
  slug: string;
  title: string;
  type: NodeType;
};

export type ChatPackAtom = ChatNodeRef & {
  hops: number;
  score: number;
  tokens: number;
  provenance: "citation" | "agent_inference";
  summary: string | null;
};

export type GraphChatEvent =
  | { type: "start"; query: string; elapsedMs: number }
  | { type: "seeds"; arm: "lexical" | "semantic" | "grep"; nodes: ChatNodeRef[]; elapsedMs: number }
  | { type: "fused"; nodes: ChatNodeRef[]; elapsedMs: number }
  | { type: "expand"; seedNodeId: string; nodes: Array<ChatNodeRef & { hops: number }>; elapsedMs: number }
  | { type: "rank"; reranked: boolean; total: number; nodes: Array<{ id: string; score: number }>; elapsedMs: number }
  | {
    type: "pack";
    atoms: ChatPackAtom[];
    tokenBudget: number;
    spentTokens: number;
    truncated: boolean;
    elapsedMs: number;
  }
  | { type: "answer_start"; model: string | null; elapsedMs: number }
  | { type: "token"; text: string; elapsedMs: number }
  | { type: "notice"; code: "model_not_configured" | "no_results"; message: string; elapsedMs: number }
  | { type: "error"; code: "recall_failed" | "model_failed"; message: string; elapsedMs: number }
  | {
    type: "done";
    finish: "ok" | "no_model" | "no_results" | "error";
    citations: Array<{ nodeId: string | null; sourceId: string | null; textUnitId: string | null }>;
    citedNodeIds: string[];
    answer: string;
    elapsedMs: number;
  };

/**
 * Ask the graph, and yield the retrieval as the server performs it.
 *
 * EventSource can neither POST nor carry an Authorization header, so this
 * reads the SSE frames off a fetch body itself. Aborting `signal` cancels the
 * reader, which is what tells the server to abort the model call.
 */
export async function* streamGraphChat(
  query: string,
  signal: AbortSignal,
): AsyncGenerator<GraphChatEvent> {
  const response = await fetch("/v1/graph-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    let message = `Graph chat failed (${response.status}).`;
    try {
      const parsed = JSON.parse(detail) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // A non-JSON body (a proxy's error page) keeps the generic message.
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        // `: keepalive` comment frames only exist to stop a proxy closing an
        // idle stream; they carry nothing.
        if (frame.startsWith("data:")) {
          yield JSON.parse(frame.slice(5).trim()) as GraphChatEvent;
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ---- Identity, API keys, admin ----

export type Identity = {
  userId: string;
  clerkUserId: string;
  email: string | null;
  role: "admin" | "member";
  status: "waitlisted" | "active" | "suspended";
};

export type Me = {
  actorId: string;
  mode: "disabled" | "token" | "api_key" | "clerk";
  scopes: string[];
  /** Always the signed-in human, even while viewing as someone else. */
  identity: Identity | null;
  /** The account being viewed, when an admin is impersonating. */
  impersonating: Identity | null;
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

/**
 * `/v1/me` answers for everyone, waitlisted included, so a failure while a
 * "view as" header is attached indicts the header — and leaves the dashboard
 * with no identity, hence no banner and no way back. Drop it and reload as
 * yourself rather than wedging the session behind a devtools-only fix.
 */
export const IMPERSONATION_BOUNCE_KEY = "trove_impersonate_error";

export async function fetchMe(): Promise<Me> {
  try {
    return await getJson<Me>("/v1/me");
  } catch (cause) {
    const target = getImpersonation();
    // ONLY a 403. Every way the server can refuse an impersonation is a 403 —
    // insufficient_scope, unknown_user, inactive_user — while a 401 means the
    // request carried no session at all, which is not the impersonation's
    // fault and must not be blamed on it.
    //
    // That distinction is the whole bug this guard exists for. The dashboard
    // probes /v1/me once at mount to learn the server's auth mode, and that
    // probe runs BEFORE Clerk has restored the session, so it 401s on every
    // load — while still carrying the impersonate header out of localStorage.
    // Bouncing on it meant: pick an account, reload, the probe 401s, the choice
    // is cleared as though it had been rejected, reload again, and you are
    // yourself. Switching accounts appeared to do nothing at all.
    if (target && cause instanceof HttpError && cause.status === 403) {
      // Leave a note across the reload. Without one this recovery is silent
      // and indistinguishable from "the switcher did nothing": the page
      // reloads, you are still yourself, and nothing says why.
      window.sessionStorage.setItem(
        IMPERSONATION_BOUNCE_KEY,
        `Could not view as ${target}: ${cause instanceof Error ? cause.message : "the request failed"}.`,
      );
      setImpersonation(null);
      window.location.reload();
    }
    throw cause;
  }
}

/** Read and clear the note above, for the one render after the bounce. */
export function takeImpersonationBounce(): string | null {
  const message = window.sessionStorage.getItem(IMPERSONATION_BOUNCE_KEY);
  if (message) window.sessionStorage.removeItem(IMPERSONATION_BOUNCE_KEY);
  return message;
}
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
