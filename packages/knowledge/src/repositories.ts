import { db } from '../../db/src/index.js';
import type { 
  KnowledgeSource, 
  KnowledgeChunk, 
  KnowledgeEntity, 
  KnowledgeEdge, 
  MemoryRecord,
  PrincipalScope
} from '../../contracts/src/index.js';

export interface KnowledgeRepository {
  upsertSource(source: KnowledgeSource): Promise<void>;
  getSource(id: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined>;
  listSources(scope?: PrincipalScope): Promise<KnowledgeSource[]>;
  findSourceByUriOrHash(uri: string, hash: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined>;
  deleteSource(id: string, scope?: PrincipalScope): Promise<boolean>;

  replaceChunks(sourceId: string, chunks: KnowledgeChunk[]): Promise<void>;
  listChunksForSource(sourceId: string, scope?: PrincipalScope): Promise<KnowledgeChunk[]>;
  searchChunks(query: string, limit: number, scope?: PrincipalScope): Promise<KnowledgeChunk[]>;

  upsertEntity(entity: KnowledgeEntity): Promise<void>;
  listEntities(scope?: PrincipalScope): Promise<KnowledgeEntity[]>;
  
  saveEdge(edge: KnowledgeEdge): Promise<void>;
  listEdges(scope?: PrincipalScope): Promise<KnowledgeEdge[]>;

  saveMemory(memory: MemoryRecord): Promise<void>;
  listMemories(scope?: PrincipalScope): Promise<MemoryRecord[]>;
}

/**
 * Evaluates whether a record with principal/system ownership metadata is accessible under the given scope.
 * Fail closed: if no principalId is provided, ONLY system records are accessible.
 */
export function isRecordAccessible(
  item: { principalId?: string; workspaceId?: string; isSystem?: boolean },
  scope?: PrincipalScope
): boolean {
  if (scope === undefined) {
    // Internal caller with no scope constraint
    return true;
  }
  if (scope.isSystem || scope.principalId === 'system') {
    return true;
  }
  if (item.isSystem) {
    return true;
  }
  if (!scope.principalId) {
    // Unauthenticated/unscoped public access: ONLY system records allowed (FAIL CLOSED)
    return false;
  }
  if (item.principalId === scope.principalId) {
    return true;
  }
  if (scope.workspaceId && item.workspaceId && item.workspaceId === scope.workspaceId) {
    return true;
  }
  return false;
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  private applyScopeFilter(queryBuilder: any, scope?: PrincipalScope) {
    if (scope === undefined || scope.isSystem || scope.principalId === 'system') {
      return queryBuilder;
    }
    if (scope.principalId) {
      return queryBuilder.where((builder: any) => {
        builder.where('principal_id', scope.principalId)
          .orWhere('is_system', true);
        if (scope.workspaceId) {
          builder.orWhere('workspace_id', scope.workspaceId);
        }
      });
    }
    // Unauthenticated / public query fails closed to system records only
    return queryBuilder.where('is_system', true);
  }

  async upsertSource(source: KnowledgeSource): Promise<void> {
    await db('knowledge_sources').insert({
      id: source.id,
      principal_id: source.principalId || (source.isSystem ? 'system' : 'anonymous'),
      workspace_id: source.workspaceId || null,
      is_system: Boolean(source.isSystem),
      visibility: source.visibility || (source.isSystem ? 'system' : 'private'),
      type: source.mimeType,
      uri: source.uri || '',
      hash: source.contentHash,
      metadata: JSON.stringify({
        title: source.title,
        projectId: source.projectId,
        rawContent: source.rawContent,
        updatedAt: source.updatedAt
      }),
      created_at: source.createdAt
    }).onConflict('id').merge();
  }

  async getSource(id: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined> {
    let q = db('knowledge_sources').where({ id });
    q = this.applyScopeFilter(q, scope);
    const row = await q.first();
    if (!row) return undefined;
    return this.mapSource(row);
  }

  async listSources(scope?: PrincipalScope): Promise<KnowledgeSource[]> {
    let q = db('knowledge_sources').select('*');
    q = this.applyScopeFilter(q, scope);
    const rows = await q.orderBy('created_at', 'desc');
    return rows.map(this.mapSource);
  }

  async findSourceByUriOrHash(uri: string, hash: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined> {
    let q = db('knowledge_sources').where((builder) => {
      builder.where({ uri }).orWhere({ hash });
    });
    q = this.applyScopeFilter(q, scope);
    const row = await q.first();
    if (!row) return undefined;
    return this.mapSource(row);
  }

  async deleteSource(id: string, scope?: PrincipalScope): Promise<boolean> {
    const existing = await this.getSource(id, scope);
    if (!existing) return false;
    // System records cannot be deleted by standard principals
    if (existing.isSystem && scope?.principalId !== 'system') {
      return false;
    }
    await db.transaction(async (trx) => {
      await trx('knowledge_chunks').where({ source_id: id }).delete();
      await trx('knowledge_sources').where({ id }).delete();
    });
    return true;
  }

  async replaceChunks(sourceId: string, chunks: KnowledgeChunk[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('knowledge_chunks').where({ source_id: sourceId }).delete();
      if (chunks.length > 0) {
        const rows = chunks.map(c => ({
          id: c.id,
          source_id: c.sourceId,
          principal_id: c.principalId || (c.isSystem ? 'system' : 'anonymous'),
          is_system: Boolean(c.isSystem),
          content: c.text,
          hash: c.contentHash,
          index: c.chunkIndex,
          metadata: JSON.stringify({ tokenCount: c.tokenCount })
        }));
        await trx('knowledge_chunks').insert(rows);
      }
    });
  }

  async listChunksForSource(sourceId: string, scope?: PrincipalScope): Promise<KnowledgeChunk[]> {
    let q = db('knowledge_chunks').where({ source_id: sourceId });
    q = this.applyScopeFilter(q, scope);
    const rows = await q.orderBy('index', 'asc');
    return rows.map(this.mapChunk);
  }

  async searchChunks(query: string, limit: number, scope?: PrincipalScope): Promise<KnowledgeChunk[]> {
    let q = db('knowledge_chunks').where('content', 'ilike', `%${query}%`);
    q = this.applyScopeFilter(q, scope);
    const rows = await q.limit(limit);
    return rows.map(this.mapChunk);
  }

  async upsertEntity(entity: KnowledgeEntity): Promise<void> {
    await db('knowledge_entities').insert({
      id: entity.id,
      principal_id: entity.principalId || (entity.isSystem ? 'system' : 'anonymous'),
      workspace_id: entity.workspaceId || null,
      is_system: Boolean(entity.isSystem),
      name: entity.name,
      type: entity.type,
      description: JSON.stringify({
        confidence: entity.confidence,
        sourceIds: entity.sourceIds,
        needsReview: entity.needsReview,
        contested: entity.contested,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt
      })
    }).onConflict('id').merge();
  }

  async listEntities(scope?: PrincipalScope): Promise<KnowledgeEntity[]> {
    let q = db('knowledge_entities').select('*');
    q = this.applyScopeFilter(q, scope);
    const rows = await q;
    return rows.map(row => {
      const desc = typeof row.description === 'string' ? JSON.parse(row.description) : (row.description || {});
      return {
        id: row.id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        isSystem: Boolean(row.is_system),
        name: row.name,
        type: row.type,
        confidence: desc.confidence || 1.0,
        sourceIds: desc.sourceIds || [],
        needsReview: desc.needsReview || false,
        contested: desc.contested || false,
        createdAt: desc.createdAt || Date.now(),
        updatedAt: desc.updatedAt || Date.now()
      };
    });
  }

  async saveEdge(edge: KnowledgeEdge): Promise<void> {
    await db('knowledge_edges').insert({
      id: edge.id,
      principal_id: edge.principalId || (edge.isSystem ? 'system' : 'anonymous'),
      is_system: Boolean(edge.isSystem),
      source_entity_id: edge.sourceEntityId,
      target_entity_id: edge.targetEntityId,
      relation: edge.relation,
      provenance: JSON.stringify({
        confidence: edge.confidence,
        provenanceSourceId: edge.provenanceSourceId,
        createdAt: edge.createdAt
      })
    }).onConflict('id').merge();
  }

  async listEdges(scope?: PrincipalScope): Promise<KnowledgeEdge[]> {
    let q = db('knowledge_edges').select('*');
    q = this.applyScopeFilter(q, scope);
    const rows = await q;
    return rows.map(row => {
      const prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : (row.provenance || {});
      return {
        id: row.id,
        principalId: row.principal_id,
        isSystem: Boolean(row.is_system),
        sourceEntityId: row.source_entity_id,
        targetEntityId: row.target_entity_id,
        relation: row.relation,
        confidence: prov.confidence || 1.0,
        provenanceSourceId: prov.provenanceSourceId || '',
        createdAt: prov.createdAt || Date.now()
      };
    });
  }

  async saveMemory(memory: MemoryRecord): Promise<void> {
    await db('memory_records').insert({
      id: memory.id,
      principal_id: memory.principalId || (memory.isSystem ? 'system' : 'anonymous'),
      workspace_id: memory.workspaceId || null,
      is_system: Boolean(memory.isSystem),
      agent_id: memory.key,
      type: memory.category,
      content: memory.value,
      context: JSON.stringify({
        confidence: memory.confidence,
        provenance: memory.provenance,
        stale: memory.stale,
        updatedAt: memory.updatedAt
      }),
      created_at: memory.createdAt
    }).onConflict('id').merge();
  }

  async listMemories(scope?: PrincipalScope): Promise<MemoryRecord[]> {
    let q = db('memory_records').select('*');
    q = this.applyScopeFilter(q, scope);
    const rows = await q.orderBy('created_at', 'asc');
    return rows.map(row => {
      const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {});
      return {
        id: row.id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        isSystem: Boolean(row.is_system),
        key: row.agent_id || '',
        value: row.content,
        category: row.type as any,
        confidence: ctx.confidence || 1.0,
        provenance: ctx.provenance || '',
        stale: ctx.stale || false,
        createdAt: parseInt(row.created_at, 10),
        updatedAt: ctx.updatedAt || Date.now()
      };
    });
  }

  private mapSource(row: any): KnowledgeSource {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    return {
      id: row.id,
      principalId: row.principal_id,
      workspaceId: row.workspace_id,
      isSystem: Boolean(row.is_system),
      visibility: row.visibility || (row.is_system ? 'system' : 'private'),
      mimeType: row.type,
      uri: row.uri,
      contentHash: row.hash,
      title: meta.title || '',
      projectId: meta.projectId,
      rawContent: meta.rawContent || '',
      updatedAt: meta.updatedAt || parseInt(row.created_at, 10),
      createdAt: parseInt(row.created_at, 10)
    };
  }

  private mapChunk(row: any): KnowledgeChunk {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    return {
      id: row.id,
      sourceId: row.source_id,
      principalId: row.principal_id,
      isSystem: Boolean(row.is_system),
      text: row.content,
      contentHash: row.hash,
      chunkIndex: row.index,
      tokenCount: meta.tokenCount || 1
    };
  }
}

/**
 * In-memory repository implementing the exact same KnowledgeRepository interface and
 * principal-scoped isolation semantics for fast, deterministic unit and regression testing.
 */
export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private sources = new Map<string, KnowledgeSource>();
  private chunks = new Map<string, KnowledgeChunk>();
  private entities = new Map<string, KnowledgeEntity>();
  private edges = new Map<string, KnowledgeEdge>();
  private memories = new Map<string, MemoryRecord>();

  async upsertSource(source: KnowledgeSource): Promise<void> {
    this.sources.set(source.id, { ...source });
  }

  async getSource(id: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined> {
    const src = this.sources.get(id);
    if (!src) return undefined;
    if (!isRecordAccessible(src, scope)) return undefined;
    return { ...src };
  }

  async listSources(scope?: PrincipalScope): Promise<KnowledgeSource[]> {
    return Array.from(this.sources.values())
      .filter(s => isRecordAccessible(s, scope))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findSourceByUriOrHash(uri: string, hash: string, scope?: PrincipalScope): Promise<KnowledgeSource | undefined> {
    const found = Array.from(this.sources.values()).find(
      s => (s.uri === uri || s.contentHash === hash) && isRecordAccessible(s, scope)
    );
    return found ? { ...found } : undefined;
  }

  async deleteSource(id: string, scope?: PrincipalScope): Promise<boolean> {
    const src = await this.getSource(id, scope);
    if (!src) return false;
    if (src.isSystem && scope?.principalId !== 'system') {
      return false;
    }
    this.sources.delete(id);
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.sourceId === id) {
        this.chunks.delete(chunkId);
      }
    }
    return true;
  }

  async replaceChunks(sourceId: string, chunks: KnowledgeChunk[]): Promise<void> {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.sourceId === sourceId) {
        this.chunks.delete(chunkId);
      }
    }
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { ...chunk });
    }
  }

  async listChunksForSource(sourceId: string, scope?: PrincipalScope): Promise<KnowledgeChunk[]> {
    return Array.from(this.chunks.values())
      .filter(c => c.sourceId === sourceId && isRecordAccessible(c, scope))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async searchChunks(query: string, limit: number, scope?: PrincipalScope): Promise<KnowledgeChunk[]> {
    const lower = query.toLowerCase();
    return Array.from(this.chunks.values())
      .filter(c => c.text.toLowerCase().includes(lower) && isRecordAccessible(c, scope))
      .slice(0, limit);
  }

  async upsertEntity(entity: KnowledgeEntity): Promise<void> {
    this.entities.set(entity.id, { ...entity });
  }

  async listEntities(scope?: PrincipalScope): Promise<KnowledgeEntity[]> {
    return Array.from(this.entities.values())
      .filter(e => isRecordAccessible(e, scope));
  }

  async saveEdge(edge: KnowledgeEdge): Promise<void> {
    this.edges.set(edge.id, { ...edge });
  }

  async listEdges(scope?: PrincipalScope): Promise<KnowledgeEdge[]> {
    return Array.from(this.edges.values())
      .filter(e => isRecordAccessible(e, scope));
  }

  async saveMemory(memory: MemoryRecord): Promise<void> {
    this.memories.set(memory.id, { ...memory });
  }

  async listMemories(scope?: PrincipalScope): Promise<MemoryRecord[]> {
    return Array.from(this.memories.values())
      .filter(m => isRecordAccessible(m, scope))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}
