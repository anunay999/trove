import { createHash } from "node:crypto";

export type EmbeddingProvider = {
  model: string;
  dimensions: number;
  embed(input: string[]): Promise<number[][]>;
};

export function createEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  const provider = process.env.TROVE_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "none") return null;
  if (provider === "fake") return new FakeEmbeddingProvider();
  // Anything but openai/fake leaves semantic search disabled rather than
  // crashing callers that probe for a provider.
  if (provider !== "openai") return null;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return new OpenAiEmbeddingProvider({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.TROVE_EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.TROVE_EMBEDDING_DIMENSIONS ?? "1536"),
  });
}

/** Per-request ceiling for an embeddings call. See the fetch in OpenAiEmbeddingProvider. */
const EMBEDDING_TIMEOUT_MS = 60_000;

function embeddingTimeoutMs(): number {
  return EMBEDDING_TIMEOUT_MS;
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => {
    if (!Number.isFinite(value)) throw new Error("Embedding contained a non-finite value.");
    return String(value);
  }).join(",")}]`;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

/**
 * Deterministic offline provider for tests and local development: each
 * lowercase alphanumeric token maps to a sha256-seeded pseudo-random vector,
 * a text is the L2-normalized average of its token vectors. Stable across
 * processes (no Math.random, no network); texts sharing tokens land closer
 * together, so cosine thresholds behave meaningfully.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fake";
  readonly dimensions = 1536;
  private readonly tokenVectors = new Map<string, number[]>();

  async embed(input: string[]): Promise<number[][]> {
    const normalized = input.map(normalizeEmbeddingInput);
    if (normalized.length !== input.length || normalized.some((value) => value.length === 0)) {
      throw new Error("Embedding input cannot be empty.");
    }
    return normalized.map((text) => this.embedText(text));
  }

  private embedText(text: string): number[] {
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [text.toLowerCase()];
    const accumulator = Array.from({ length: this.dimensions }, () => 0);
    for (const token of tokens) {
      const vector = this.vectorForToken(token);
      for (let index = 0; index < this.dimensions; index += 1) {
        accumulator[index] = (accumulator[index] ?? 0) + (vector[index] ?? 0);
      }
    }
    let sumSquares = 0;
    for (const value of accumulator) sumSquares += value * value;
    const norm = Math.sqrt(sumSquares);
    if (norm === 0) return accumulator;
    return accumulator.map((value) => value / norm);
  }

  private vectorForToken(token: string): number[] {
    const cached = this.tokenVectors.get(token);
    if (cached) return cached;
    const vector = Array.from({ length: this.dimensions }, () => 0);
    let filled = 0;
    let counter = 0;
    while (filled < this.dimensions) {
      const block = createHash("sha256").update(`trove-fake-embedding:${token}:${counter}`).digest();
      for (let offset = 0; offset + 4 <= block.length && filled < this.dimensions; offset += 4) {
        vector[filled] = (block.readUInt32LE(offset) / 0xffffffff) * 2 - 1;
        filled += 1;
      }
      counter += 1;
    }
    this.tokenVectors.set(token, vector);
    return vector;
  }
}

function normalizeEmbeddingInput(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 24_000);
}

class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string; dimensions: number }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.dimensions = options.dimensions;
    if (this.dimensions !== 1536) {
      throw new Error("Trove embedding table currently requires 1536-dimensional vectors.");
    }
  }

  async embed(input: string[]): Promise<number[][]> {
    const normalized = input.map(normalizeEmbeddingInput).filter(Boolean);
    if (normalized.length !== input.length) {
      throw new Error("Embedding input cannot be empty.");
    }

    // A bare fetch() has no timeout: if the connection stalls, the promise
    // never settles. Inside a job that means runJob() never reaches finishJob(),
    // so the row stays 'running' forever and its dedupe key blocks every later
    // job of that kind. That is exactly how embedding refresh froze in
    // production for six days. Failing is recoverable (the job retries with
    // backoff); hanging is not.
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: normalized,
        model: this.model,
        dimensions: this.dimensions,
      }),
      signal: AbortSignal.timeout(embeddingTimeoutMs()),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed with ${response.status}: ${await response.text()}`);
    }

    const json = await response.json() as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const embeddings = [...(json.data ?? [])].sort((left, right) => left.index - right.index).map((item) => item.embedding);
    if (embeddings.length !== input.length) {
      throw new Error(`Embedding response length mismatch: expected ${input.length}, got ${embeddings.length}.`);
    }
    for (const embedding of embeddings) {
      if (embedding.length !== this.dimensions) {
        throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}.`);
      }
    }
    return embeddings;
  }
}
