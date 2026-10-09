import type { Conversation } from '../types';

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

let sessionPromise: Promise<void> | null = null;

async function ensureSearchSession(force = false): Promise<void> {
  if (force) sessionPromise = null;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) throw new Error(`Session bootstrap failed (${response.status})`);
  })();

  try {
    await sessionPromise;
  } catch (error) {
    sessionPromise = null;
    throw error;
  }
}

async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  await ensureSearchSession();
  const withTimeout = { ...init, credentials: 'same-origin' as RequestCredentials, signal: init?.signal || AbortSignal.timeout(2500) };
  let response = await fetch(input, withTimeout);
  if (response.status === 401) {
    await ensureSearchSession(true);
    response = await fetch(input, withTimeout);
  }
  return response;
}

export async function syncConversationToServer(conversation: Conversation): Promise<boolean> {
  try {
    const response = await authenticatedFetch('/api/conversations/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: conversation.id,
        title: conversation.title,
        projectId: conversation.projectId,
        isPinned: Boolean(conversation.isPinned),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages
          .filter(message => !message.isStreaming)
          .map(message => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.timestamp
          }))
      })
    });
    return response.ok;
  } catch {
    // Search persistence is additive. Existing local conversation behavior must
    // remain functional if the server/search subsystem is temporarily down.
    return false;
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
  options: { limit?: number; projectId?: string; role?: 'user' | 'assistant' } = {}
): Promise<ConversationSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    limit: String(options.limit || 20)
  });
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.role) params.set('role', options.role);

  const response = await authenticatedFetch(`/api/search/conversations?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Search failed (${response.status})`);
  }
  return response.json();
}

export async function backfillConversationsBestEffort(
  conversations: Conversation[],
  limit = 100
): Promise<void> {
  const recent = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  // Keep pressure low on serverless/DB connections.
  for (let i = 0; i < recent.length; i += 4) {
    const batch = recent.slice(i, i + 4);
    await Promise.allSettled(batch.map(syncConversationToServer));
  }
}
