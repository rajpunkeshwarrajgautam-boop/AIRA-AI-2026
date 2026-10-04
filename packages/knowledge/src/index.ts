import * as crypto from 'crypto';
import {
  KnowledgeSource,
  KnowledgeChunk,
  KnowledgeEntity,
  KnowledgeEdge,
  MemoryRecord,
  Citation
} from '../../contracts/src/index.js';
import { KnowledgeRepository, PostgresKnowledgeRepository } from './repositories.js';

export * from './repositories.js';

export class BrainV2KnowledgeEngine {
  private repo: KnowledgeRepository;

  constructor(repo?: KnowledgeRepository) {
    this.repo = repo || new PostgresKnowledgeRepository();
    // Default seed is now handled asynchronously or by migration, but we can fire and forget if empty
    this.seedDefaultKnowledge().catch(console.error);
  }

  public computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  public async ingestDocument(
    title: string,
    rawContent: string,
    mimeType = 'text/markdown',
    uri?: string,
    projectId?: string
  ): Promise<{ source: KnowledgeSource; chunks: KnowledgeChunk[] }> {
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

      createdChunks.push(chunk);
      chunkIndex++;
    }

    await this.repo.upsertSource(source);
    await this.repo.replaceChunks(sourceId, createdChunks);

    await this.extractEntitiesFromContent(sourceId, rawContent);

    return { source, chunks: createdChunks };
  }

  public async search(query: string, limit = 5): Promise<{ chunk: KnowledgeChunk; score: number; citation: Citation }[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return [];
    
    // We can just grab all chunks and do in-memory scoring for now, 
    // or use searchChunks. We'll use searchChunks with the first term to limit, then score.
    const searchResults = await this.repo.searchChunks(terms[0], 50);
    const results: { chunk: KnowledgeChunk; score: number; citation: Citation }[] = [];

    for (const chunk of searchResults) {
      let matchCount = 0;
      const lower = chunk.text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) matchCount++;
      }

      if (matchCount > 0) {
        const score = Math.min(1.0, matchCount / Math.max(1, terms.length));
        const src = await this.repo.getSource(chunk.sourceId);
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

  public async addEntity(name: string, type: string, sourceId: string): Promise<KnowledgeEntity> {
    const id = `ent_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const now = Date.now();
    
    const entities = await this.repo.listEntities();
    let existing = entities.find(e => e.id === id);
    
    if (existing) {
      if (!existing.sourceIds.includes(sourceId)) {
        existing.sourceIds.push(sourceId);
        existing.updatedAt = now;
        await this.repo.upsertEntity(existing);
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
    await this.repo.upsertEntity(entity);
    return entity;
  }

  public async addEdge(
    sourceEntityId: string,
    targetEntityId: string,
    relation: string,
    provenanceSourceId: string,
    confidence = 1.0
  ): Promise<KnowledgeEdge> {
    const edge: KnowledgeEdge = {
      id: `edge_${crypto.randomUUID().slice(0, 8)}`,
      sourceEntityId,
      targetEntityId,
      relation,
      confidence,
      provenanceSourceId,
      createdAt: Date.now()
    };
    await this.repo.saveEdge(edge);
    return edge;
  }

  public async getKnowledgeGraph() {
    return {
      entities: await this.repo.listEntities(),
      edges: await this.repo.listEdges()
    };
  }

  public async getSources(): Promise<KnowledgeSource[]> {
    return await this.repo.listSources();
  }

  public async getMemories(): Promise<MemoryRecord[]> {
    return await this.repo.listMemories();
  }

  public async saveMemory(
    key: string,
    value: string,
    category: 'fact' | 'decision' | 'preference' | 'pattern' | 'constraint' = 'fact',
    provenance = 'system'
  ): Promise<MemoryRecord> {
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
    await this.repo.saveMemory(item);
    return item;
  }

  private async extractEntitiesFromContent(sourceId: string, content: string): Promise<void> {
    const srcEnt = await this.addEntity(`src_${sourceId}`, 'source', sourceId);
    const keywords = ['AIRA', 'Rowboat', 'ModelRouter', 'ToolRuntime', 'Approvals', 'BrainV2', 'SSE', 'Vite'];
    for (const kw of keywords) {
      if (content.includes(kw)) {
        const ent = await this.addEntity(kw, 'concept', sourceId);
        await this.addEdge(srcEnt.id, ent.id, 'REFERENCES', sourceId, 0.95);
      }
    }
  }

  private async seedDefaultKnowledge(): Promise<void> {
    const sources = await this.repo.listSources();
    if (sources.length === 0) {
      await this.ingestDocument(
        'AIRA Architecture Guide',
        'Aira AI is an autonomous operating workspace uniting intelligence, deterministic run execution, and human oversight. Subsystems include Model Router, Tool Runtime with permission isolation, Approval Kernel, MCP Host, and Brain v2 Knowledge Engine.',
        'text/markdown',
        'aira://system/docs/architecture'
      );
      await this.saveMemory('workspace_identity', 'Aira AI — One workspace. Every intelligence.', 'pattern');
      await this.saveMemory('execution_boundary', 'Zero client-side secrets. Server-authoritative runs only.', 'constraint');
    }
  }
}
