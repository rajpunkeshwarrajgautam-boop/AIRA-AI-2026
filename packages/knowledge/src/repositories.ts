import { db } from '../../db/src/index.js';
import { 
  KnowledgeSource, 
  KnowledgeChunk, 
  KnowledgeEntity, 
  KnowledgeEdge, 
  MemoryRecord 
} from './index.js';

export interface KnowledgeRepository {
  upsertSource(source: KnowledgeSource): Promise<void>;
  getSource(id: string): Promise<KnowledgeSource | undefined>;
  listSources(): Promise<KnowledgeSource[]>;
  findSourceByUriOrHash(uri: string, hash: string): Promise<KnowledgeSource | undefined>;

  replaceChunks(sourceId: string, chunks: KnowledgeChunk[]): Promise<void>;
  listChunksForSource(sourceId: string): Promise<KnowledgeChunk[]>;
  searchChunks(query: string, limit: number): Promise<KnowledgeChunk[]>;

  upsertEntity(entity: KnowledgeEntity): Promise<void>;
  listEntities(): Promise<KnowledgeEntity[]>;
  
  saveEdge(edge: KnowledgeEdge): Promise<void>;
  listEdges(): Promise<KnowledgeEdge[]>;

  saveMemory(memory: MemoryRecord): Promise<void>;
  listMemories(): Promise<MemoryRecord[]>;
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  async upsertSource(source: KnowledgeSource): Promise<void> {
    await db('knowledge_sources').insert({
      id: source.id,
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

  async getSource(id: string): Promise<KnowledgeSource | undefined> {
    const row = await db('knowledge_sources').where({ id }).first();
    if (!row) return undefined;
    return this.mapSource(row);
  }

  async listSources(): Promise<KnowledgeSource[]> {
    const rows = await db('knowledge_sources').select('*');
    return rows.map(this.mapSource);
  }

  async findSourceByUriOrHash(uri: string, hash: string): Promise<KnowledgeSource | undefined> {
    const row = await db('knowledge_sources').where({ uri }).orWhere({ hash }).first();
    if (!row) return undefined;
    return this.mapSource(row);
  }

  async replaceChunks(sourceId: string, chunks: KnowledgeChunk[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('knowledge_chunks').where({ source_id: sourceId }).delete();
      if (chunks.length > 0) {
        const rows = chunks.map(c => ({
          id: c.id,
          source_id: c.sourceId,
          content: c.text,
          hash: c.contentHash,
          index: c.chunkIndex,
          metadata: JSON.stringify({ tokenCount: c.tokenCount })
        }));
        await trx('knowledge_chunks').insert(rows);
      }
    });
  }

  async listChunksForSource(sourceId: string): Promise<KnowledgeChunk[]> {
    const rows = await db('knowledge_chunks').where({ source_id: sourceId }).orderBy('index', 'asc');
    return rows.map(this.mapChunk);
  }

  async searchChunks(query: string, limit: number): Promise<KnowledgeChunk[]> {
    const rows = await db('knowledge_chunks')
      .where('content', 'ilike', `%${query}%`)
      .limit(limit);
    return rows.map(this.mapChunk);
  }

  async upsertEntity(entity: KnowledgeEntity): Promise<void> {
    await db('knowledge_entities').insert({
      id: entity.id,
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

  async listEntities(): Promise<KnowledgeEntity[]> {
    const rows = await db('knowledge_entities').select('*');
    return rows.map(row => {
      const desc = typeof row.description === 'string' ? JSON.parse(row.description) : (row.description || {});
      return {
        id: row.id,
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

  async listEdges(): Promise<KnowledgeEdge[]> {
    const rows = await db('knowledge_edges').select('*');
    return rows.map(row => {
      const prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : (row.provenance || {});
      return {
        id: row.id,
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
      agent_id: memory.key, // store key in agent_id or context
      type: memory.category, // store category in type
      content: memory.value, // store value in content
      context: JSON.stringify({
        confidence: memory.confidence,
        provenance: memory.provenance,
        stale: memory.stale,
        updatedAt: memory.updatedAt
      }),
      created_at: memory.createdAt
    }).onConflict('id').merge();
  }

  async listMemories(): Promise<MemoryRecord[]> {
    const rows = await db('memory_records').select('*').orderBy('created_at', 'asc');
    return rows.map(row => {
      const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {});
      return {
        id: row.id,
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
      text: row.content,
      contentHash: row.hash,
      chunkIndex: row.index,
      tokenCount: meta.tokenCount || 1
    };
  }
}
