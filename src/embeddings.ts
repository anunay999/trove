export type EmbeddingProvider = {
  model: string;
  dimensions: number;
  embed(input: string[]): Promise<number[][]>;
};

export function createEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  const provider = process.env.TROVE_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "none") return null;
  if (provider !== "openai") {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return new OpenAiEmbeddingProvider({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.TROVE_EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.TROVE_EMBEDDING_DIMENSIONS ?? "1536"),
  });
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => {
    if (!Number.isFinite(value)) throw new Error("Embedding contained a non-finite value.");
    return String(value);
  }).join(",")}]`;
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
