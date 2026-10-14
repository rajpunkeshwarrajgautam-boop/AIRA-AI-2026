import * as crypto from 'crypto';
import type {
  KnowledgeSource,
  KnowledgeChunk,
  KnowledgeEntity,
  KnowledgeEdge,
  MemoryRecord,
  Citation,
  PrincipalScope
} from '../../contracts/src/index.js';
import { PrincipalScopeSchema } from '../../contracts/src/index.js';
import { KnowledgeRepository, PostgresKnowledgeRepository, InMemoryKnowledgeRepository } from './repositories.js';

export * from './repositories.js';
export type { PrincipalScope };
export { PrincipalScopeSchema };

export class BrainV2KnowledgeEngine {
  private repo: KnowledgeRepository;

  constructor(repo?: KnowledgeRepository) {
    this.repo = repo || new PostgresKnowledgeRepository();
    // Default seed is now handled asynchronously or by migration, but we can fire and forget if empty
    this.seedDefaultKnowledge().catch(console.error);
  }

  public getRepository(): KnowledgeRepository {
    return this.repo;
  }

  public computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  public async ingestDocument(
    title: string,
    rawContent: string,
    mimeType = 'text/markdown',
    uri?: string,
    projectId?: string,
    scope?: PrincipalScope
  ): Promise<{ source: KnowledgeSource; chunks: KnowledgeChunk[] }> {
    const sourceId = `src_${crypto.randomUUID().slice(0, 8)}`;
    const contentHash = this.computeSha256(rawContent);
    const now = Date.now();

    const isSystem = scope !== undefined ? Boolean(scope.isSystem) : true;
    const principalId = scope?.principalId || (isSystem ? 'system' : 'anonymous');
    const workspaceId = scope?.workspaceId;
    const visibility = isSystem ? 'system' : (workspaceId ? 'workspace' : 'private');

    const source: KnowledgeSource = {
      id: sourceId,
      principalId,
      workspaceId,
      isSystem,
      visibility: visibility as any,
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
        principalId,
        isSystem,
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

    await this.extractEntitiesFromContent(sourceId, rawContent, scope);

    return { source, chunks: createdChunks };
  }

  public async search(
    query: string,
    limit = 5,
    scope?: PrincipalScope
  ): Promise<{ chunk: KnowledgeChunk; score: number; citation: Citation }[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return [];
    
    const searchResults = await this.repo.searchChunks(terms[0], 50, scope);
    const results: { chunk: KnowledgeChunk; score: number; citation: Citation }[] = [];

    for (const chunk of searchResults) {
      let matchCount = 0;
      const lower = chunk.text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) matchCount++;
      }

      if (matchCount > 0) {
        const score = Math.min(1.0, matchCount / Math.max(1, terms.length));
        const src = await this.repo.getSource(chunk.sourceId, scope);
        if (!src) continue; // Denied / inaccessible under principal scope

        results.push({
          chunk,
          score,
          citation: {
            id: `cite_${chunk.id}`,
            sourceId: chunk.sourceId,
            sourceTitle: src.title || 'System Source',
            uri: src.uri,
            snippet: chunk.text.slice(0, 160) + (chunk.text.length > 160 ? '...' : ''),
            score
          }
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public async addEntity(
    name: string,
    type: string,
    sourceId: string,
    scope?: PrincipalScope
  ): Promise<KnowledgeEntity> {
    const isSystem = Boolean(scope?.isSystem);
    const principalId = scope?.principalId || (isSystem ? 'system' : 'anonymous');
    const workspaceId = scope?.workspaceId;
    const id = `ent_${principalId ? `${principalId}_` : ''}${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const now = Date.now();
    
    const entities = await this.repo.listEntities(scope);
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
      principalId,
      workspaceId,
      isSystem,
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
    confidence = 1.0,
    scope?: PrincipalScope
  ): Promise<KnowledgeEdge> {
    const isSystem = Boolean(scope?.isSystem);
    const principalId = scope?.principalId || (isSystem ? 'system' : 'anonymous');
    const edge: KnowledgeEdge = {
      id: `edge_${crypto.randomUUID().slice(0, 8)}`,
      principalId,
      isSystem,
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

  public async getKnowledgeGraph(scope?: PrincipalScope) {
    return {
      entities: await this.repo.listEntities(scope),
      edges: await this.repo.listEdges(scope)
    };
  }

  public async getSources(scope?: PrincipalScope): Promise<KnowledgeSource[]> {
    return await this.repo.listSources(scope);
  }

  public async getSource(id: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined> {
    return await this.repo.getSource(id, scope);
  }

  public async deleteSource(id: string, scope?: PrincipalScope): Promise<boolean> {
    return await this.repo.deleteSource(id, scope);
  }

  public async getMemories(scope?: PrincipalScope): Promise<MemoryRecord[]> {
    return await this.repo.listMemories(scope);
  }

  public async saveMemory(
    key: string,
    value: string,
    category: 'fact' | 'decision' | 'preference' | 'pattern' | 'constraint' = 'fact',
    provenance = 'system',
    scope?: PrincipalScope
  ): Promise<MemoryRecord> {
    const id = `mem_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const isSystem = Boolean(scope?.isSystem);
    const principalId = scope?.principalId || (isSystem ? 'system' : 'anonymous');
    const workspaceId = scope?.workspaceId;

    const item: MemoryRecord = {
      id,
      principalId,
      workspaceId,
      isSystem,
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

  private async extractEntitiesFromContent(sourceId: string, content: string, scope?: PrincipalScope): Promise<void> {
    const srcEnt = await this.addEntity(`src_${sourceId}`, 'source', sourceId, scope);
    const keywords = ['AIRA', 'Rowboat', 'ModelRouter', 'ToolRuntime', 'Approvals', 'BrainV2', 'SSE', 'Vite'];
    for (const kw of keywords) {
      if (content.includes(kw)) {
        const ent = await this.addEntity(kw, 'concept', sourceId, scope);
        await this.addEdge(srcEnt.id, ent.id, 'REFERENCES', sourceId, 0.95, scope);
      }
    }
  }

  private async seedDefaultKnowledge(): Promise<void> {
    const systemScope: PrincipalScope = { isSystem: true, principalId: 'system' };
    const sources = await this.repo.listSources(systemScope);
    if (sources.length === 0) {
      await this.ingestDocument(
        'AIRA Architecture Guide',
        'Aira AI is an autonomous operating workspace uniting intelligence, deterministic run execution, and human oversight. Subsystems include Model Router, Tool Runtime with permission isolation, Approval Kernel, MCP Host, and Brain v2 Knowledge Engine.',
        'text/markdown',
        'aira://system/docs/architecture',
        undefined,
        systemScope
      );
      await this.saveMemory('workspace_identity', 'Aira AI — One workspace. Every intelligence.', 'pattern', 'system', systemScope);
      await this.saveMemory('execution_boundary', 'Zero client-side secrets. Server-authoritative runs only.', 'constraint', 'system', systemScope);
    }
  }
}
