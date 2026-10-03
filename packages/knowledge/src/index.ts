import * as crypto from 'crypto';
import {
  KnowledgeSource,
  KnowledgeChunk,
  KnowledgeEntity,
  KnowledgeEdge,
  MemoryRecord,
  Citation
} from '../../contracts/src/index.js';

export class BrainV2KnowledgeEngine {
  private sources: Map<string, KnowledgeSource> = new Map();
  private chunks: Map<string, KnowledgeChunk> = new Map();
  private entities: Map<string, KnowledgeEntity> = new Map();
  private edges: KnowledgeEdge[] = [];
  private memories: Map<string, MemoryRecord> = new Map();

  constructor() {
    this.seedDefaultKnowledge();
  }

  public computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  public ingestDocument(
    title: string,
    rawContent: string,
    mimeType = 'text/markdown',
    uri?: string,
    projectId?: string
  ): { source: KnowledgeSource; chunks: KnowledgeChunk[] } {
    const sourceId = `src_${crypto.randomUUID().slice(0, 8)}`;
    const contentHash = this.computeSha256(rawContent);
    const now = Date.now();

    const source: KnowledgeSource = {
      id: sourceId,
      projectId,
      title,
      uri: uri || `aira://knowledge/sources/${sourceId}`,
      mimeType,
      contentHash,
      rawContent,
      createdAt: now,
      updatedAt: now
    };

    // Deterministic sliding window chunking
    const chunkSize = 500;
    const overlap = 50;
    const createdChunks: KnowledgeChunk[] = [];
    let chunkIndex = 0;

    for (let i = 0; i < rawContent.length; i += (chunkSize - overlap)) {
      const text = rawContent.slice(i, i + chunkSize).trim();
      if (!text) continue;

      const chunkHash = this.computeSha256(text);
      const chunkId = `chk_${sourceId}_${chunkIndex}`;

      const chunk: KnowledgeChunk = {
        id: chunkId,
        sourceId,
        chunkIndex,
        text,
        tokenCount: Math.max(1, Math.ceil(text.length / 4)),
        contentHash: chunkHash
      };

      this.chunks.set(chunkId, chunk);
      createdChunks.push(chunk);
      chunkIndex++;
    }

    this.sources.set(sourceId, source);

    // Extract basic semantic entities
    this.extractEntitiesFromContent(sourceId, rawContent);

    return { source, chunks: createdChunks };
  }

  public search(query: string, limit = 5): { chunk: KnowledgeChunk; score: number; citation: Citation }[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const results: { chunk: KnowledgeChunk; score: number; citation: Citation }[] = [];

    for (const chunk of this.chunks.values()) {
      let matchCount = 0;
      const lower = chunk.text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) matchCount++;
      }

      if (matchCount > 0) {
        const score = Math.min(1.0, matchCount / Math.max(1, terms.length));
        const src = this.sources.get(chunk.sourceId);
        results.push({
          chunk,
          score,
          citation: {
            id: `cite_${chunk.id}`,
            sourceId: chunk.sourceId,
            sourceTitle: src?.title || 'System Source',
            uri: src?.uri,
            snippet: chunk.text.slice(0, 160) + (chunk.text.length > 160 ? '...' : ''),
            score
          }
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public addEntity(name: string, type: string, sourceId: string): KnowledgeEntity {
    const id = `ent_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const now = Date.now();
    const existing = this.entities.get(id);
    if (existing) {
      if (!existing.sourceIds.includes(sourceId)) {
        existing.sourceIds.push(sourceId);
        existing.updatedAt = now;
      }
      return existing;
    }

    const entity: KnowledgeEntity = {
      id,
      name,
      type,
      confidence: 0.95,
      sourceIds: [sourceId],
      needsReview: false,
      contested: false,
      createdAt: now,
      updatedAt: now
    };
    this.entities.set(id, entity);
    return entity;
  }

  public addEdge(
    sourceEntityId: string,
    targetEntityId: string,
    relation: string,
    provenanceSourceId: string,
    confidence = 1.0
  ): KnowledgeEdge {
    const edge: KnowledgeEdge = {
      id: `edge_${crypto.randomUUID().slice(0, 8)}`,
      sourceEntityId,
      targetEntityId,
      relation,
      confidence,
      provenanceSourceId,
      createdAt: Date.now()
    };
    this.edges.push(edge);
    return edge;
  }

  public getKnowledgeGraph() {
    return {
      entities: Array.from(this.entities.values()),
      edges: [...this.edges]
    };
  }

  public getSources(): KnowledgeSource[] {
    return Array.from(this.sources.values());
  }

  public getMemories(): MemoryRecord[] {
    return Array.from(this.memories.values());
  }

  public saveMemory(
    key: string,
    value: string,
    category: 'fact' | 'decision' | 'preference' | 'pattern' | 'constraint' = 'fact',
    provenance = 'system'
  ): MemoryRecord {
    const id = `mem_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const item: MemoryRecord = {
      id,
      key,
      value,
      category,
      confidence: 1.0,
      provenance,
      stale: false,
      createdAt: now,
      updatedAt: now
    };
    this.memories.set(key, item);
    return item;
  }

  private extractEntitiesFromContent(sourceId: string, content: string): void {
    const keywords = ['AIRA', 'Rowboat', 'ModelRouter', 'ToolRuntime', 'Approvals', 'BrainV2', 'SSE', 'Vite'];
    for (const kw of keywords) {
      if (content.includes(kw)) {
        const ent = this.addEntity(kw, 'concept', sourceId);
        this.addEdge(`ent_source_${sourceId}`, ent.id, 'REFERENCES', sourceId, 0.95);
      }
    }
  }

  private seedDefaultKnowledge(): void {
    this.ingestDocument(
      'AIRA Architecture Guide',
      'Aira AI is an autonomous operating workspace uniting intelligence, deterministic run execution, and human oversight. Subsystems include Model Router, Tool Runtime with permission isolation, Approval Kernel, MCP Host, and Brain v2 Knowledge Engine.',
      'text/markdown',
      'aira://system/docs/architecture'
    );
    this.saveMemory('workspace_identity', 'Aira AI — One workspace. Every intelligence.', 'pattern');
    this.saveMemory('execution_boundary', 'Zero client-side secrets. Server-authoritative runs only.', 'constraint');
  }
}
