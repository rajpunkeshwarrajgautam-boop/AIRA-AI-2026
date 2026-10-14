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
  timeoutMs = 2500
): Promise<Response> {
  await ensureSearchSession();
  const makeRequest = () => fetch(input, {
    ...init,
    credentials: 'same-origin' as RequestCredentials,
    signal: composeRequestSignal(init?.signal, timeoutMs)
  });

  let response = await makeRequest();
  if (response.status === 401) {
    await ensureSearchSession(true);
    response = await makeRequest();
  }
  return response;
}

export async function syncConversationToServer(conversation: Conversation): Promise<boolean> {
  const payload = JSON.stringify({
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
  });

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
  const recent = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  // Keep pressure low on serverless/DB connections.
  for (let i = 0; i < recent.length; i += 4) {
    const batch = recent.slice(i, i + 4);
    await Promise.allSettled(batch.map(syncConversationToServer));
  }
}
