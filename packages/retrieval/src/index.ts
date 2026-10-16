import { createHash } from 'node:crypto';
import { db } from '../../db/src/index.js';
import type { EmbeddingProvider } from './embeddings.js';

export {
  createEmbeddingProvider,
  NvidiaEmbeddingProvider,
  type EmbeddingBatch,
  type EmbeddingProvider,
  type EmbeddingPurpose
} from './embeddings.js';

export type ConversationMessageRole = 'user' | 'assistant';

export interface ConversationSyncMessage {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt: number;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationSyncInput {
  id: string;
  title: string;
  projectId?: string;
  isPinned?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ConversationSyncMessage[];
  metadata?: Record<string, unknown>;
}

export interface ConversationSearchQuery {
  query: string;
  limit?: number;
  projectId?: string;
  role?: ConversationMessageRole;
}

export type ConversationSearchMatchType =
  | 'title'
  | 'exact'
  | 'lexical'
  | 'semantic'
  | 'hybrid';

export interface ConversationSearchResult {
  conversationId: string;
  messageId: string;
  title: string;
  projectId?: string;
  role: ConversationMessageRole;
  snippet: string;
  score: number;
  updatedAt: number;
  messageCreatedAt: number;
  isPinned: boolean;
  matchType: ConversationSearchMatchType;
}

export interface HybridConversationSearchResult {
  query: string;
  mode: 'hybrid' | 'lexical';
  semanticAvailable: boolean;
  results: ConversationSearchResult[];
}

export interface VectorCapability {
  extensionEnabled: boolean;
  vectorColumnPresent: boolean;
  ready: boolean;
}

export interface PendingEmbeddingDocument {
  id: string;
  conversationId: string;
  messageId: string;
  content: string;
}

export interface DurableConversationResult {
  id: string;
  title: string;
  projectId?: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ConversationSyncMessage[];
}

export interface ConversationIndexingResult {
  semanticAvailable: boolean;
  indexed: number;
  pending: number;
  reason?: string;
}

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function makeSnippet(content: string, query: string, maxLength = 280): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;

  const lower = clean.toLowerCase();
  const queryLower = query.toLowerCase();
  let index = lower.indexOf(queryLower);

  if (index < 0) {
    const terms = normalizeForSearch(query)
      .split(' ')
      .filter(term => term.length >= 3);
    index = terms.reduce((best, term) => {
      const found = lower.indexOf(term);
      if (found < 0) return best;
      return best < 0 ? found : Math.min(best, found);
    }, -1);
  }

  if (index < 0) return clean.slice(0, maxLength - 1) + '…';

  const radius = Math.floor(maxLength / 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(clean.length, start + maxLength);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

function storageId(kind: 'conversation' | 'message' | 'search', principalId: string, clientId: string): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(principalId)
    .update('\0')
    .update(clientId)
    .digest('hex');
  return `${kind === 'conversation' ? 'conv' : kind === 'message' ? 'msg' : 'search'}_${digest}`;
}

function vectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('EMPTY_EMBEDDING_VECTOR');
  if (!vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('INVALID_EMBEDDING_VECTOR');
  }
  return '[' + vector.join(',') + ']';
}

/**
 * Server-authoritative persistence and retrieval for conversation search.
 *
 * Existing frontend/localStorage behavior is deliberately untouched. Search
 * persistence and semantic indexing are additive and principal-scoped.
 */
export class ConversationSearchRepository {
  async syncConversation(principalId: string, input: ConversationSyncInput): Promise<void> {
    if (!principalId) throw new Error('principalId is required');
    const clientConversationId = input.id?.trim();
    if (!clientConversationId) throw new Error('conversation id is required');

    const title = input.title?.trim() || 'Untitled conversation';
    const messages = Array.isArray(input.messages) ? input.messages : [];

    await db.transaction(async trx => {
      // Serialize concurrent snapshots for one principal/conversation. A delayed
      // retry must never delete messages introduced by a newer successful sync.
      // Use a deterministic key without exposing principal identifiers to SQL logs.
      const lockKey = storageId('conversation', principalId, clientConversationId);
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey]);

      const existingConversation = await trx('conversations')
        .where({ principal_id: principalId, client_id: clientConversationId })
        .first();

      // Older snapshots cannot erase newer data. Millisecond timestamp collisions
      // still allow strict append-only message supersets, without overwriting
      // existing messages or metadata. Ambiguous equal-version edits are rejected.
      let equalTimestampAppend = false;
      if (existingConversation) {
        const storedVersion = Number(existingConversation.updated_at);
        if (storedVersion > input.updatedAt) return;
        if (storedVersion === input.updatedAt) {
          if (existingConversation.deleted_at != null) return;
          const stored = await trx('conversation_messages')
            .where({ principal_id: principalId, conversation_id: existingConversation.id })
            .select('client_message_id');
          const existingIds = new Set(stored.map(row => String(row.client_message_id)));
          const incomingIds = new Set(messages
            .filter(message => message.role === 'user' || message.role === 'assistant')
            .map(message => message.id?.trim())
            .filter((id): id is string => Boolean(id)));
          equalTimestampAppend = incomingIds.size > existingIds.size &&
            [...existingIds].every(id => incomingIds.has(id));
          if (!equalTimestampAppend) return;
        }
      }

      const conversationStorageId =
        existingConversation?.id || lockKey;

      if (!equalTimestampAppend) await trx('conversations')
        .insert({
          id: conversationStorageId,
          client_id: clientConversationId,
          principal_id: principalId,
          project_id: input.projectId || null,
          title,
          is_pinned: Boolean(input.isPinned),
          created_at: input.createdAt,
          updated_at: input.updatedAt,
          deleted_at: null,
          metadata: JSON.stringify(input.metadata || {})
        })
        .onConflict('id')
        .merge({
          client_id: clientConversationId,
          project_id: input.projectId || null,
          title,
          is_pinned: Boolean(input.isPinned),
          updated_at: input.updatedAt,
          deleted_at: null,
          metadata: JSON.stringify(input.metadata || {})
        });

      const incomingClientIds = messages
        .map(message => message.id?.trim())
        .filter((id): id is string => Boolean(id));

      if (incomingClientIds.length === 0) {
        await trx('conversation_search_documents')
          .where({ conversation_id: conversationStorageId, principal_id: principalId })
          .delete();
        await trx('conversation_messages')
          .where({ conversation_id: conversationStorageId, principal_id: principalId })
          .delete();
      } else {
        const staleRows = await trx('conversation_messages')
          .where({ conversation_id: conversationStorageId, principal_id: principalId })
          .whereNotIn('client_message_id', incomingClientIds)
          .select('id');

        const staleStorageIds = staleRows.map(row => row.id);
        if (staleStorageIds.length > 0) {
          await trx('conversation_search_documents')
            .where({ conversation_id: conversationStorageId, principal_id: principalId })
            .whereIn('message_id', staleStorageIds)
            .delete();
          await trx('conversation_messages')
            .where({ conversation_id: conversationStorageId, principal_id: principalId })
            .whereIn('id', staleStorageIds)
            .delete();
        }
      }

      for (const message of messages) {
        const clientMessageId = message.id?.trim();
        if (!clientMessageId) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;

        const existingMessage = await trx('conversation_messages')
          .where({
            principal_id: principalId,
            conversation_id: conversationStorageId,
            client_message_id: clientMessageId
          })
          .first();

        // Preserve existing content, embeddings and provenance on same-version
        // retries; only genuinely new message IDs are eligible for appending.
        if (equalTimestampAppend && existingMessage) continue;

        const messageStorageId =
          existingMessage?.id || storageId('message', principalId, clientMessageId);

        const searchExisting = await trx('conversation_search_documents')
          .where({ message_id: messageStorageId, principal_id: principalId })
          .first();

        const content = String(message.content || '');
        const updatedAt = Math.max(message.createdAt || input.updatedAt, input.updatedAt);
        const contentChanged =
          !searchExisting ||
          String(searchExisting.content || '') !== content ||
          String(searchExisting.project_id || '') !== String(input.projectId || '') ||
          String(searchExisting.role || '') !== message.role;

        await trx('conversation_messages')
          .insert({
            id: messageStorageId,
            client_message_id: clientMessageId,
            conversation_id: conversationStorageId,
            principal_id: principalId,
            run_id: message.runId || null,
            role: message.role,
            content,
            created_at: message.createdAt,
            updated_at: updatedAt,
            metadata: JSON.stringify(message.metadata || {})
          })
          .onConflict('id')
          .merge({
            client_message_id: clientMessageId,
            run_id: message.runId || null,
            role: message.role,
            content,
            updated_at: updatedAt,
            metadata: JSON.stringify(message.metadata || {})
          });

        const mergePayload: Record<string, unknown> = {
          project_id: input.projectId || null,
          role: message.role,
          content,
          normalized_content: normalizeForSearch(content),
          updated_at: updatedAt
        };

        if (contentChanged) {
          Object.assign(mergePayload, {
            embedding_model: null,
            embedding_version: null,
            embedding_dimensions: null,
            embedding_status: 'NOT_INDEXED',
            embedding_indexed_at: null
          });
        }

        await trx('conversation_search_documents')
          .insert({
            id: storageId('search', principalId, clientMessageId),
            conversation_id: conversationStorageId,
            message_id: messageStorageId,
            principal_id: principalId,
            project_id: input.projectId || null,
            role: message.role,
            content,
            normalized_content: normalizeForSearch(content),
            created_at: message.createdAt,
            updated_at: updatedAt,
            embedding_status: 'NOT_INDEXED',
            metadata: JSON.stringify({})
          })
          .onConflict('message_id')
          .merge(mergePayload);
      }
    });
  }


  async getConversation(
    principalId: string,
    conversationId: string
  ): Promise<DurableConversationResult | null> {
    const conversation = await db('conversations')
      .where({ principal_id: principalId, client_id: conversationId })
      .whereNull('deleted_at')
      .first();

    if (!conversation) return null;

    const messages = await db('conversation_messages')
      .where({
        principal_id: principalId,
        conversation_id: conversation.id
      })
      .orderBy('created_at', 'asc')
      .select(
        'client_message_id',
        'role',
        'content',
        'created_at',
        'run_id',
        'metadata'
      );

    return {
      id: conversation.client_id,
      title: conversation.title,
      projectId: conversation.project_id || undefined,
      isPinned: Boolean(conversation.is_pinned),
      createdAt: Number(conversation.created_at),
      updatedAt: Number(conversation.updated_at),
      messages: messages.map(message => ({
        id: message.client_message_id,
        role: message.role,
        content: message.content || '',
        createdAt: Number(message.created_at),
        runId: message.run_id || undefined,
        metadata: message.metadata || undefined
      }))
    };
  }

  async deleteConversation(principalId: string, conversationId: string): Promise<boolean> {
    return db.transaction(async trx => {
      const conversation = await trx('conversations')
        .where({ client_id: conversationId, principal_id: principalId })
        .whereNull('deleted_at')
        .first();

      if (!conversation) return false;

      await trx('conversation_search_documents')
        .where({ conversation_id: conversation.id, principal_id: principalId })
        .delete();

      await trx('conversation_messages')
        .where({ conversation_id: conversation.id, principal_id: principalId })
        .delete();

      await trx('conversations')
        .where({ id: conversation.id, principal_id: principalId })
        .update({
          deleted_at: Date.now(),
          updated_at: Date.now()
        });

      return true;
    });
  }

  async listConversations(principalId: string): Promise<DurableConversationResult[]> {
    if (!principalId) return [];

    const rows = await db('conversations')
      .where({ principal_id: principalId })
      .whereNull('deleted_at')
      .orderBy('updated_at', 'desc');

    if (rows.length === 0) return [];

    const conversationStorageIds = rows.map(r => r.id);
    const messages = await db('conversation_messages')
      .where({ principal_id: principalId })
      .whereIn('conversation_id', conversationStorageIds)
      .orderBy('created_at', 'asc')
      .select('conversation_id', 'client_message_id', 'role', 'content', 'created_at', 'run_id', 'metadata');

    const messagesByConv = new Map<string, ConversationSyncMessage[]>();
    for (const msg of messages) {
      const list = messagesByConv.get(msg.conversation_id) || [];
      list.push({
        id: msg.client_message_id,
        role: msg.role as ConversationMessageRole,
        content: msg.content || '',
        createdAt: Number(msg.created_at),
        runId: msg.run_id || undefined,
        metadata: msg.metadata || undefined
      });
      messagesByConv.set(msg.conversation_id, list);
    }

    return rows.map(conv => ({
      id: conv.client_id,
      title: conv.title,
      projectId: conv.project_id || undefined,
      isPinned: Boolean(conv.is_pinned),
      createdAt: Number(conv.created_at),
      updatedAt: Number(conv.updated_at),
      messages: messagesByConv.get(conv.id) || []
    }));
  }

  async transferGuestData(
    guestPrincipalId: string,
    targetPrincipalId: string
  ): Promise<{ transferredConversations: number }> {
    if (!guestPrincipalId || !targetPrincipalId || guestPrincipalId === targetPrincipalId) {
      throw new Error('INVALID_TRANSFER_PRINCIPALS');
    }

    return db.transaction(async trx => {
      const guestRows = await trx('conversations')
        .where({ principal_id: guestPrincipalId })
        .whereNull('deleted_at');

      let transferredCount = 0;
      for (const conv of guestRows) {
        const existingTarget = await trx('conversations')
          .where({ principal_id: targetPrincipalId, client_id: conv.client_id })
          .first();

        if (existingTarget) {
          continue;
        }

        await trx('conversations')
          .where({ id: conv.id, principal_id: guestPrincipalId })
          .update({ principal_id: targetPrincipalId, updated_at: Date.now() });

        await trx('conversation_messages')
          .where({ conversation_id: conv.id, principal_id: guestPrincipalId })
          .update({ principal_id: targetPrincipalId });

        await trx('conversation_search_documents')
          .where({ conversation_id: conv.id, principal_id: guestPrincipalId })
          .update({ principal_id: targetPrincipalId });

        transferredCount++;
      }

      return { transferredConversations: transferredCount };
    });
  }

  async getVectorCapability(): Promise<VectorCapability> {
    const extension = await db.raw(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled"
    );
    const column = await db.raw(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'conversation_search_documents'
          AND column_name = 'embedding_vector'
      ) AS present
    `);

    const extensionEnabled = Boolean(extension.rows?.[0]?.enabled);
    const vectorColumnPresent = Boolean(column.rows?.[0]?.present);
    return {
      extensionEnabled,
      vectorColumnPresent,
      ready: extensionEnabled && vectorColumnPresent
    };
  }

  async listPendingEmbeddingDocuments(
    principalId: string,
    conversationId: string,
    limit = 64
  ): Promise<PendingEmbeddingDocument[]> {
    const rows = await db('conversation_search_documents as d')
      .join('conversations as c', 'c.id', 'd.conversation_id')
      .join('conversation_messages as m', 'm.id', 'd.message_id')
      .where('d.principal_id', principalId)
      .andWhere('c.principal_id', principalId)
      .andWhere('m.principal_id', principalId)
      .andWhere('c.client_id', conversationId)
      .whereNull('c.deleted_at')
      .andWhere(builder => {
        builder.whereNull('d.embedding_status').orWhereNot('d.embedding_status', 'READY');
      })
      .select(
        'd.id',
        'c.client_id as conversation_id',
        'm.client_message_id as message_id',
        'd.content'
      )
      .orderBy('d.created_at', 'asc')
      .limit(Math.min(Math.max(limit, 1), 128));

    return rows.map(row => ({
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      content: row.content || ''
    }));
  }

  async saveEmbedding(
    principalId: string,
    documentId: string,
    vector: number[],
    modelId: string,
    modelVersion: string
  ): Promise<void> {
    const capability = await this.getVectorCapability();
    if (!capability.ready) throw new Error('PGVECTOR_NOT_READY');

    const literal = vectorLiteral(vector);
    await db('conversation_search_documents')
      .where({ id: documentId, principal_id: principalId })
      .update({
        embedding_model: modelId,
        embedding_version: modelVersion,
        embedding_dimensions: vector.length,
        embedding_status: 'READY',
        embedding_indexed_at: Date.now(),
        embedding_vector: db.raw('?::vector', [literal])
      });
  }

  async searchLexical(
    principalId: string,
    options: ConversationSearchQuery
  ): Promise<ConversationSearchResult[]> {
    const query = String(options.query || '').trim();
    if (!query) return [];

    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const candidateLimit = Math.min(limit * 5, 200);
    const like = `%${query.toLowerCase()}%`;

    const builder = db('conversation_search_documents as d')
      .join('conversations as c', 'c.id', 'd.conversation_id')
      .join('conversation_messages as m', 'm.id', 'd.message_id')
      .where('d.principal_id', principalId)
      .andWhere('m.principal_id', principalId)
      .andWhere('c.principal_id', principalId)
      .whereNull('c.deleted_at');

    if (options.projectId) builder.andWhere('c.project_id', options.projectId);
    if (options.role === 'user' || options.role === 'assistant') {
      builder.andWhere('d.role', options.role);
    }

    builder.andWhere(function() {
      this.whereRaw(
        "to_tsvector('simple', coalesce(c.title, '') || ' ' || coalesce(d.content, '')) @@ websearch_to_tsquery('simple', ?)",
        [query]
      )
        .orWhereRaw('lower(c.title) like ?', [like])
        .orWhereRaw('lower(d.content) like ?', [like]);
    });

    const rows = await builder
      .select(
        'c.client_id as conversation_id',
        'm.client_message_id as message_id',
        'd.role',
        'd.content',
        'd.created_at as message_created_at',
        'c.title',
        'c.project_id',
        'c.updated_at',
        'c.is_pinned',
        db.raw(
          `(
            ts_rank_cd(
              to_tsvector('simple', coalesce(c.title, '') || ' ' || coalesce(d.content, '')),
              websearch_to_tsquery('simple', ?)
            ) * 1.2
            + CASE
                WHEN lower(c.title) = lower(?) THEN 1.20
                WHEN lower(c.title) LIKE ? THEN 0.70
                ELSE 0
              END
            + CASE WHEN lower(d.content) LIKE ? THEN 0.55 ELSE 0 END
            + CASE WHEN c.is_pinned THEN 0.05 ELSE 0 END
          ) AS score`,
          [query, query, like, like]
        )
      )
      .orderByRaw('score DESC, c.updated_at DESC')
      .limit(candidateLimit);

    const byConversation = new Map<string, ConversationSearchResult>();

    for (const row of rows) {
      const score = Number(row.score) || 0;
      const titleMatch = String(row.title || '').toLowerCase().includes(query.toLowerCase());
      const exactContentMatch = String(row.content || '').toLowerCase().includes(query.toLowerCase());
      const result: ConversationSearchResult = {
        conversationId: row.conversation_id,
        messageId: row.message_id,
        title: row.title,
        projectId: row.project_id || undefined,
        role: row.role,
        snippet: makeSnippet(row.content || '', query),
        score,
        updatedAt: Number(row.updated_at),
        messageCreatedAt: Number(row.message_created_at),
        isPinned: Boolean(row.is_pinned),
        matchType: titleMatch ? 'title' : exactContentMatch ? 'exact' : 'lexical'
      };

      const current = byConversation.get(result.conversationId);
      if (!current || result.score > current.score) {
        byConversation.set(result.conversationId, result);
      }
    }

    return Array.from(byConversation.values())
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async searchSemantic(
    principalId: string,
    options: ConversationSearchQuery,
    vector: number[],
    modelId: string,
    modelVersion: string
  ): Promise<ConversationSearchResult[]> {
    const capability = await this.getVectorCapability();
    if (!capability.ready) return [];

    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const literal = vectorLiteral(vector);

    const builder = db('conversation_search_documents as d')
      .join('conversations as c', 'c.id', 'd.conversation_id')
      .join('conversation_messages as m', 'm.id', 'd.message_id')
      .where('d.principal_id', principalId)
      .andWhere('m.principal_id', principalId)
      .andWhere('c.principal_id', principalId)
      .whereNull('c.deleted_at')
      .andWhere('d.embedding_status', 'READY')
      .andWhere('d.embedding_model', modelId)
      .andWhere('d.embedding_version', modelVersion)
      .andWhere('d.embedding_dimensions', vector.length)
      .whereNotNull('d.embedding_vector');

    if (options.projectId) builder.andWhere('c.project_id', options.projectId);
    if (options.role === 'user' || options.role === 'assistant') {
      builder.andWhere('d.role', options.role);
    }

    const rows = await builder
      .select(
        'c.client_id as conversation_id',
        'm.client_message_id as message_id',
        'd.role',
        'd.content',
        'd.created_at as message_created_at',
        'c.title',
        'c.project_id',
        'c.updated_at',
        'c.is_pinned',
        db.raw('(1 - (d.embedding_vector <=> ?::vector)) AS score', [literal])
      )
      .orderByRaw('d.embedding_vector <=> ?::vector ASC', [literal])
      .limit(Math.min(limit * 5, 200));

    const minSemanticScore = Math.min(
      Math.max(Number(process.env.AIRA_SEMANTIC_MIN_SCORE) || 0.35, -1),
      1
    );
    const byConversation = new Map<string, ConversationSearchResult>();
    for (const row of rows) {
      const score = Number(row.score) || 0;
      if (score < minSemanticScore) continue;
      const result: ConversationSearchResult = {
        conversationId: row.conversation_id,
        messageId: row.message_id,
        title: row.title,
        projectId: row.project_id || undefined,
        role: row.role,
        snippet: makeSnippet(row.content || '', options.query),
        score,
        updatedAt: Number(row.updated_at),
        messageCreatedAt: Number(row.message_created_at),
        isPinned: Boolean(row.is_pinned),
        matchType: 'semantic'
      };
      const current = byConversation.get(result.conversationId);
      if (!current || result.score > current.score) {
        byConversation.set(result.conversationId, result);
      }
    }

    return Array.from(byConversation.values())
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  // Backward-compatible lexical API used by the first search certification.
  async search(
    principalId: string,
    options: ConversationSearchQuery
  ): Promise<ConversationSearchResult[]> {
    return this.searchLexical(principalId, options);
  }
}

export class ConversationEmbeddingIndexer {
  constructor(
    private repository: ConversationSearchRepository,
    private embeddingProvider: EmbeddingProvider
  ) {}

  async indexConversation(
    principalId: string,
    conversationId: string,
    limit = 64
  ): Promise<ConversationIndexingResult> {
    const capability = await this.repository.getVectorCapability();
    if (!capability.ready) {
      return { semanticAvailable: false, indexed: 0, pending: 0, reason: 'PGVECTOR_NOT_READY' };
    }
    if (!this.embeddingProvider.isConfigured()) {
      return { semanticAvailable: false, indexed: 0, pending: 0, reason: 'EMBEDDING_PROVIDER_NOT_CONFIGURED' };
    }

    const pending = await this.repository.listPendingEmbeddingDocuments(principalId, conversationId, limit);
    if (pending.length === 0) {
      return { semanticAvailable: true, indexed: 0, pending: 0 };
    }

    try {
      const batch = await this.embeddingProvider.embed(
        pending.map(document => document.content),
        'passage'
      );

      for (let index = 0; index < pending.length; index++) {
        await this.repository.saveEmbedding(
          principalId,
          pending[index].id,
          batch.vectors[index],
          batch.modelId,
          batch.modelVersion
        );
      }

      const remaining = await this.repository.listPendingEmbeddingDocuments(principalId, conversationId, 1);
      return {
        semanticAvailable: true,
        indexed: pending.length,
        pending: remaining.length > 0 ? 1 : 0
      };
    } catch (error) {
      return {
        semanticAvailable: false,
        indexed: 0,
        pending: pending.length,
        reason: error instanceof Error ? error.message : 'EMBEDDING_INDEXING_FAILED'
      };
    }
  }
}

export class HybridConversationSearchService {
  constructor(
    private repository: ConversationSearchRepository,
    private embeddingProvider: EmbeddingProvider
  ) {}

  async search(
    principalId: string,
    options: ConversationSearchQuery
  ): Promise<HybridConversationSearchResult> {
    const query = String(options.query || '').trim();
    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const candidateLimit = Math.min(Math.max(limit * 4, 20), 50);

    const lexical = await this.repository.searchLexical(principalId, {
      ...options,
      query,
      limit: candidateLimit
    });

    const capability = await this.repository.getVectorCapability();
    const canUseSemantic = capability.ready && this.embeddingProvider.isConfigured();

    let semantic: ConversationSearchResult[] = [];
    let semanticOperational = canUseSemantic;
    if (canUseSemantic) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed([query], 'query');
        semantic = await this.repository.searchSemantic(
          principalId,
          { ...options, query, limit: candidateLimit },
          queryEmbedding.vectors[0],
          queryEmbedding.modelId,
          queryEmbedding.modelVersion
        );
      } catch {
        // Fail open to lexical search, and report degraded capability accurately.
        // An unreachable embedding provider is NOT semantically available.
        semantic = [];
        semanticOperational = false;
      }
    }

    if (semantic.length === 0) {
      return {
        query,
        mode: 'lexical',
        semanticAvailable: semanticOperational,
        results: lexical.slice(0, limit)
      };
    }

    const fused = new Map<string, {
      result: ConversationSearchResult;
      rrf: number;
      lexical: boolean;
      semantic: boolean;
    }>();

    const add = (
      results: ConversationSearchResult[],
      source: 'lexical' | 'semantic'
    ) => {
      results.forEach((result, index) => {
        const existing = fused.get(result.conversationId);
        const contribution = 1 / (60 + index + 1);
        if (!existing) {
          fused.set(result.conversationId, {
            result: { ...result },
            rrf: contribution,
            lexical: source === 'lexical',
            semantic: source === 'semantic'
          });
          return;
        }

        existing.rrf += contribution;
        existing.lexical ||= source === 'lexical';
        existing.semantic ||= source === 'semantic';

        // Prefer the exact/title lexical snippet when available; otherwise keep
        // the stronger semantic candidate.
        const incomingIsExact = result.matchType === 'title' || result.matchType === 'exact';
        const existingIsExact =
          existing.result.matchType === 'title' || existing.result.matchType === 'exact';
        if (incomingIsExact || (!existingIsExact && result.score > existing.result.score)) {
          existing.result = { ...result };
        }
      });
    };

    add(lexical, 'lexical');
    add(semantic, 'semantic');

    const now = Date.now();
    const ranked = Array.from(fused.values())
      .map(entry => {
        const ageDays = Math.max(0, (now - entry.result.updatedAt) / 86_400_000);
        // RRF is the primary rank signal. Contextual boosts are deliberately
        // small so recency/pinning can break close ties but never overpower a
        // clearly stronger semantic match.
        const recencyBoost = Math.max(0, 0.001 * (1 - Math.min(ageDays, 30) / 30));
        const exactBoost =
          entry.result.matchType === 'title' ? 0.003 :
          entry.result.matchType === 'exact' ? 0.002 : 0;
        const pinBoost = entry.result.isPinned ? 0.0005 : 0;

        return {
          ...entry.result,
          score: entry.rrf + recencyBoost + exactBoost + pinBoost,
          matchType: entry.lexical && entry.semantic
            ? 'hybrid' as const
            : entry.semantic
              ? 'semantic' as const
              : entry.result.matchType
        };
      })
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);

    return {
      query,
      mode: 'hybrid',
      semanticAvailable: true,
      results: ranked
    };
  }
}
