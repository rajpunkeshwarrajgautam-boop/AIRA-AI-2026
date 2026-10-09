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

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 12000);
}

export class NvidiaEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'nvidia';

  constructor(
    private apiKey = process.env.NVIDIA_API_KEY || '',
    private modelId = process.env.AIRA_EMBEDDING_MODEL || 'nvidia/nv-embedqa-e5-v5',
    private endpoint = process.env.AIRA_EMBEDDING_ENDPOINT || 'https://integrate.api.nvidia.com/v1/embeddings'
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey.trim()) && process.env.AIRA_SEMANTIC_SEARCH !== 'false';
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<EmbeddingBatch> {
    if (!this.isConfigured()) {
      throw new Error('EMBEDDING_PROVIDER_NOT_CONFIGURED');
    }

    const input = texts.map(normalizeInput).filter(Boolean);
    if (input.length === 0) {
      throw new Error('EMBEDDING_INPUT_EMPTY');
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: this.modelId,
        input,
        input_type: purpose,
        encoding_format: 'float'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`EMBEDDING_PROVIDER_UNAVAILABLE:${response.status}`);
    }

    const body = await response.json() as {
      data?: Array<{ embedding?: unknown; index?: number }>;
      model?: string;
    };

    const ordered = [...(body.data || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
    const vectors = ordered.map(item => {
      if (!Array.isArray(item.embedding) || !item.embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
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
      modelId: body.model || this.modelId,
      modelVersion: process.env.AIRA_EMBEDDING_VERSION || '1',
      dimensions,
      vectors
    };
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  return new NvidiaEmbeddingProvider();
}
