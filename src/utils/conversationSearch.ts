import type { Conversation } from '../types';
import { neonAuth, authenticatedApiFetch } from '../lib/neonAuth';

export interface ConversationSearchResult {
  conversationId: string;
  messageId: string;
  title: string;
  projectId?: string;
  role: 'user' | 'assistant';
  snippet: string;
  score: number;
  updatedAt: number;
  messageCreatedAt: number;
  isPinned: boolean;
  matchType: 'title' | 'exact' | 'lexical' | 'semantic' | 'hybrid';
}

export interface ConversationSearchResponse {
  query: string;
  mode: 'hybrid' | 'lexical';
  semanticAvailable: boolean;
  results: ConversationSearchResult[];
}

// Always enforce the request deadline, even when the search overlay supplies
// its own AbortController to cancel obsolete queries.
export function composeRequestSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  return authenticatedApiFetch(input, init, {
    signal: composeRequestSignal(init?.signal, timeoutMs)
  });
}

const inFlightSyncs = new Map<string, Promise<boolean>>();

export async function syncConversationToServer(conversation: Conversation): Promise<boolean> {
  const existing = inFlightSyncs.get(conversation.id);
  if (existing) {
    console.log(`[ConversationSync] conversationSyncDeduped=true conversationId=${conversation.id}`);
    return existing;
  }

  const syncPromise = (async () => {
    const stableMessages = conversation.messages.filter(message => !message.isStreaming);
    const payload = JSON.stringify({
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.projectId,
      isPinned: Boolean(conversation.isPinned),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: stableMessages.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.timestamp
      }))
    });

    try {
      // Sync is idempotent per principal/conversation/message ID on the server.
      // A bounded second attempt covers transient Neon wakeups without retrying
      // authorization or client-validation failures.
      for (let attempt = 0; attempt < 2; attempt++) {
        let delayMs = 1200;
        try {
          const response = await authenticatedFetch('/api/conversations/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
          }, 20000);
          if (response.ok) return true;
          if (response.status !== 503 && response.status !== 429) return false;

          const retryAfter = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            delayMs = Math.min(Math.max(retryAfter * 1000, 500), 3000);
          }
        } catch (error) {
          // The request uses its own deadline; there is no external cancellation
          // for this additive background sync. Retry only network/timeout failures.
          const retryable = error instanceof TypeError ||
            (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
          if (!retryable) return false;
        }

        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // Existing local conversation history remains usable if persistence is down.
      return false;
    } finally {
      inFlightSyncs.delete(conversation.id);
    }
  })();

  inFlightSyncs.set(conversation.id, syncPromise);
  return syncPromise;
}

export async function fetchConversationFromServer(
  conversationId: string
): Promise<Conversation | null> {
  try {
    const response = await authenticatedFetch(
      `/api/conversations/${encodeURIComponent(conversationId)}`
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Conversation hydration failed (${response.status})`);

    const body = await response.json() as {
      conversation?: {
        id: string;
        title: string;
        projectId?: string;
        isPinned?: boolean;
        createdAt: number;
        updatedAt: number;
        messages?: Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
          createdAt: number;
        }>;
      };
    };

    const conversation = body.conversation;
    if (!conversation) return null;

    return {
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.projectId,
      isPinned: Boolean(conversation.isPinned),
      createdAt: Number(conversation.createdAt),
      updatedAt: Number(conversation.updatedAt),
      messages: (conversation.messages || []).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: Number(message.createdAt)
      }))
    };
  } catch {
    return null;
  }
}

export async function deleteConversationFromServer(conversationId: string): Promise<boolean> {
  try {
    const response = await authenticatedFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE'
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function searchConversationsServer(
  query: string,
  options: {
    limit?: number;
    projectId?: string;
    role?: 'user' | 'assistant';
    signal?: AbortSignal;
  } = {}
): Promise<ConversationSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    limit: String(options.limit || 20)
  });
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.role) params.set('role', options.role);

  const response = await authenticatedFetch(
    `/api/search/conversations?${params.toString()}`,
    { signal: options.signal },
    12000
  );
  if (!response.ok) {
    throw new Error(`Search failed (${response.status})`);
  }
  return response.json();
}

export async function backfillConversationsBestEffort(
  conversations: Conversation[],
  limit = 100
): Promise<void> {
  const populated = conversations.filter(c => c.messages.some(m => !m.isStreaming));
  if (populated.length === 0) return;

  const recent = [...populated]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  // Keep pressure low on serverless/DB connections.
  for (let i = 0; i < recent.length; i += 2) {
    const batch = recent.slice(i, i + 2);
    await Promise.allSettled(batch.map(syncConversationToServer));
  }
}

/**
 * Fetch all conversations owned by the authenticated principal from Postgres.
 */
export async function fetchAllConversationsFromServer(): Promise<Conversation[]> {
  try {
    const response = await authenticatedFetch('/api/conversations', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }, 15000);
    if (!response.ok) {
      console.warn('[fetchAllConversationsFromServer] response not ok:', response.status);
      return [];
    }

    const body = await response.json() as {
      conversations?: Array<{
        id: string;
        title: string;
        projectId?: string;
        isPinned?: boolean;
        createdAt: number;
        updatedAt: number;
        messages?: Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
          createdAt: number;
        }>;
      }>;
    };

    if (!Array.isArray(body?.conversations)) return [];
    console.log('[fetchAllConversationsFromServer] hydrated count:', body.conversations.length);

    return body.conversations.map(c => ({
      id: c.id,
      title: c.title,
      projectId: c.projectId,
      isPinned: Boolean(c.isPinned),
      createdAt: Number(c.createdAt),
      updatedAt: Number(c.updatedAt),
      messages: (c.messages || []).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: Number(m.createdAt)
      }))
    }));
  } catch (err) {
    console.error('[fetchAllConversationsFromServer error]', err);
    return [];
  }
}

