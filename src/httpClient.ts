import type {
  CaptureInput,
  CreateViewInput,
  DeleteViewInput,
  EnqueueJobInput,
  EventFeedInput,
  ListJobsInput,
  ListViewsInput,
  ReadViewInput,
  RunJobInput,
  SearchInput,
} from "./contracts.js";
import type { GraphEventFeed, GraphJob, GraphLintReport, GraphViewSnapshot, SearchResult } from "./graphCore.js";
import type { GraphView } from "./contracts.js";
import type { ObsidianVaultExport } from "./obsidianExport.js";

export type GraphMindHttpClientOptions = {
  baseUrl: string;
  token?: string;
  interfaceId?: string;
};

export class GraphMindHttpClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly interfaceId: string;

  constructor(options: GraphMindHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.interfaceId = options.interfaceId ?? "cli";
  }

  ready(): Promise<{ ok: boolean; service: string; store: string }> {
    return this.request("GET", "/ready");
  }

  search(input: SearchInput): Promise<SearchResult> {
    return this.request("POST", "/v1/scribe/query", input);
  }

  capture(input: CaptureInput): Promise<{ node: unknown }> {
    return this.request("POST", "/v1/capture", input);
  }

  lint(): Promise<GraphLintReport> {
    return this.request("GET", "/v1/scribe/lint");
  }

  events(input: Partial<EventFeedInput> = {}): Promise<GraphEventFeed> {
    const params = new URLSearchParams();
    if (input.afterCursor) params.set("afterCursor", input.afterCursor);
    if (input.limit) params.set("limit", String(input.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/v1/events${suffix}`);
  }

  jobs(input: Partial<ListJobsInput> = {}): Promise<{ jobs: GraphJob[] }> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.kind) params.set("kind", input.kind);
    if (input.limit) params.set("limit", String(input.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/v1/jobs${suffix}`);
  }

  views(input: Partial<ListViewsInput> = {}): Promise<{ views: GraphView[] }> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.limit) params.set("limit", String(input.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/v1/views${suffix}`);
  }

  createView(input: CreateViewInput): Promise<{ view: GraphViewSnapshot }> {
    return this.request("POST", "/v1/views", input);
  }

  readView(input: ReadViewInput): Promise<{ view: GraphViewSnapshot }> {
    return this.request("POST", "/v1/views/read", input);
  }

  deleteView(input: DeleteViewInput): Promise<{ deleted: boolean; view: GraphView | null }> {
    return this.request("POST", "/v1/views/delete", input);
  }

  enqueueJob(input: EnqueueJobInput): Promise<{ job: GraphJob }> {
    return this.request("POST", "/v1/jobs", input);
  }

  runJob(input: RunJobInput = {}): Promise<{ job: GraphJob | null; message?: string }> {
    return this.request("POST", "/v1/jobs/run", input);
  }

  exportObsidian(): Promise<ObsidianVaultExport> {
    return this.request("GET", "/v1/scribe/export/obsidian");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        "content-type": "application/json",
        "x-graphmind-interface": this.interfaceId,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await fetch(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
    }

    return await response.json() as T;
  }
}
