import { db } from '../../db/src/index.js';

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
  matchType: 'title' | 'exact' | 'lexical';
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

/**
 * Server-authoritative persistence and retrieval for conversation search.
 *
 * The frontend remains free to keep its existing local cache. This repository
 * is additive and principal-scoped so it can be introduced without replacing
 * the existing chat path.
 */
export class ConversationSearchRepository {
  async syncConversation(principalId: string, input: ConversationSyncInput): Promise<void> {
    if (!principalId) throw new Error('principalId is required');
    if (!input.id?.trim()) throw new Error('conversation id is required');

    const title = input.title?.trim() || 'Untitled conversation';
    const messages = Array.isArray(input.messages) ? input.messages : [];

    await db.transaction(async trx => {
      const existing = await trx('conversations').where({ id: input.id }).first();
      if (existing && existing.principal_id !== principalId) {
        throw new Error('Conversation ownership mismatch');
      }

      await trx('conversations')
        .insert({
          id: input.id,
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
          project_id: input.projectId || null,
          title,
          is_pinned: Boolean(input.isPinned),
          updated_at: input.updatedAt,
          deleted_at: null,
          metadata: JSON.stringify(input.metadata || {})
        });

      const incomingIds = messages.map(message => message.id);

      if (incomingIds.length === 0) {
        await trx('conversation_search_documents')
          .where({ conversation_id: input.id, principal_id: principalId })
          .delete();
        await trx('conversation_messages')
          .where({ conversation_id: input.id, principal_id: principalId })
          .delete();
      } else {
        const staleRows = await trx('conversation_messages')
          .where({ conversation_id: input.id, principal_id: principalId })
          .whereNotIn('id', incomingIds)
          .select('id');

        const staleIds = staleRows.map(row => row.id);
        if (staleIds.length > 0) {
          await trx('conversation_search_documents')
            .where({ conversation_id: input.id, principal_id: principalId })
            .whereIn('message_id', staleIds)
            .delete();
          await trx('conversation_messages')
            .where({ conversation_id: input.id, principal_id: principalId })
            .whereIn('id', staleIds)
            .delete();
        }
      }

      for (const message of messages) {
        if (!message.id?.trim()) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;

        const messageExisting = await trx('conversation_messages').where({ id: message.id }).first();
        if (messageExisting && messageExisting.principal_id !== principalId) {
          throw new Error('Conversation message ownership mismatch');
        }

        const content = String(message.content || '');
        const updatedAt = Math.max(message.createdAt || input.updatedAt, input.updatedAt);

        await trx('conversation_messages')
          .insert({
            id: message.id,
            conversation_id: input.id,
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
            run_id: message.runId || null,
            role: message.role,
            content,
            updated_at: updatedAt,
            metadata: JSON.stringify(message.metadata || {})
          });

        await trx('conversation_search_documents')
          .insert({
            id: `search_${message.id}`,
            conversation_id: input.id,
            message_id: message.id,
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
          .merge({
            project_id: input.projectId || null,
            role: message.role,
            content,
            normalized_content: normalizeForSearch(content),
            updated_at: updatedAt,
            // Content changed: any previous semantic embedding is stale.
            embedding_model: null,
            embedding_version: null,
            embedding_dimensions: null,
            embedding_status: 'NOT_INDEXED',
            embedding_indexed_at: null
          });
      }
    });
  }

  async deleteConversation(principalId: string, conversationId: string): Promise<boolean> {
    return db.transaction(async trx => {
      const conversation = await trx('conversations')
        .where({ id: conversationId, principal_id: principalId })
        .whereNull('deleted_at')
        .first();

      if (!conversation) return false;

      await trx('conversation_search_documents')
        .where({ conversation_id: conversationId, principal_id: principalId })
        .delete();

      await trx('conversation_messages')
        .where({ conversation_id: conversationId, principal_id: principalId })
        .delete();

      await trx('conversations')
        .where({ id: conversationId, principal_id: principalId })
        .update({
          deleted_at: Date.now(),
          updated_at: Date.now()
        });

      return true;
    });
  }

  async search(principalId: string, options: ConversationSearchQuery): Promise<ConversationSearchResult[]> {
    const query = String(options.query || '').trim();
    if (!query) return [];

    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const candidateLimit = Math.min(limit * 5, 200);
    const like = `%${query.toLowerCase()}%`;

    const builder = db('conversation_search_documents as d')
      .join('conversations as c', 'c.id', 'd.conversation_id')
      .where('d.principal_id', principalId)
      .andWhere('c.principal_id', principalId)
      .whereNull('c.deleted_at');

    if (options.projectId) {
      builder.andWhere('c.project_id', options.projectId);
    }
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
        'd.conversation_id',
        'd.message_id',
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
}
