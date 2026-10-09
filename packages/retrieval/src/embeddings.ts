export type EmbeddingPurpose = 'query' | 'passage';

export interface EmbeddingBatch {
  modelId: string;
  modelVersion: string;
  dimensions: number;
  vectors: number[][];
}

export interface EmbeddingProvider {
  readonly providerId: string;
  isConfigured(): boolean;
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<EmbeddingBatch>;
}

const DEFAULT_NVIDIA_EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b';

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 12000);
}

type NvidiaEmbeddingResponse = {
  data?: Array<{ embedding?: unknown; index?: number }>;
  model?: string;
};

export class NvidiaEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'nvidia';

  constructor(
    private apiKey = process.env.NVIDIA_API_KEY || '',
    private modelId = process.env.AIRA_EMBEDDING_MODEL || DEFAULT_NVIDIA_EMBEDDING_MODEL,
    private endpoint = process.env.AIRA_EMBEDDING_ENDPOINT || 'https://integrate.api.nvidia.com/v1/embeddings'
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey.trim()) && process.env.AIRA_SEMANTIC_SEARCH !== 'false';
  }

  private async requestEmbedding(
    input: string[],
    purpose: EmbeddingPurpose,
    modelId: string
  ): Promise<{ response: Response; body?: NvidiaEmbeddingResponse }> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: modelId,
        input,
        input_type: purpose,
        encoding_format: 'float',
        truncate: 'END'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return { response };
    }

    return {
      response,
      body: await response.json() as NvidiaEmbeddingResponse
    };
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<EmbeddingBatch> {
    if (!this.isConfigured()) {
      throw new Error('EMBEDDING_PROVIDER_NOT_CONFIGURED');
    }

    const input = texts.map(normalizeInput).filter(Boolean);
    if (input.length === 0) {
      throw new Error('EMBEDDING_INPUT_EMPTY');
    }

    let resolvedModelId = this.modelId;
    let result = await this.requestEmbedding(input, purpose, resolvedModelId);

    // NVIDIA returns 410 when an endpoint-backed model has been retired.
    // If an environment override still points at a retired model, fail over
    // once to Aira's current supported default rather than disabling search.
    if (
      (result.response.status === 404 || result.response.status === 410) &&
      resolvedModelId !== DEFAULT_NVIDIA_EMBEDDING_MODEL
    ) {
      resolvedModelId = DEFAULT_NVIDIA_EMBEDDING_MODEL;
      result = await this.requestEmbedding(input, purpose, resolvedModelId);
    }

    if (!result.response.ok || !result.body) {
      throw new Error(`EMBEDDING_PROVIDER_UNAVAILABLE:${result.response.status}`);
    }

    const ordered = [...(result.body.data || [])]
      .sort((a, b) => (a.index || 0) - (b.index || 0));

    const vectors = ordered.map(item => {
      if (
        !Array.isArray(item.embedding) ||
        !item.embedding.every(value => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE');
      }
      return item.embedding as number[];
    });

    if (vectors.length !== input.length || vectors.length === 0) {
      throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE');
    }

    const dimensions = vectors[0].length;
    if (!dimensions || vectors.some(vector => vector.length !== dimensions)) {
      throw new Error('EMBEDDING_DIMENSION_MISMATCH');
    }

    return {
      modelId: result.body.model || resolvedModelId,
      modelVersion: process.env.AIRA_EMBEDDING_VERSION || '1',
      dimensions,
      vectors
    };
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  return new NvidiaEmbeddingProvider();
}
