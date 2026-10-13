import assert from 'node:assert/strict';
import test from 'node:test';
import { getSessionActiveChatId, setSessionActiveChatId } from '../src/utils/storage.js';

test('conversation persistence: getSessionActiveChatId and setSessionActiveChatId lifecycle', () => {
  // Mock window and sessionStorage
  const storageMap = new Map<string, string>();
  let currentSearch = '';
  let currentPath = '/';

  const mockWindow = {
    sessionStorage: {
      getItem: (key: string) => storageMap.get(key) || null,
      setItem: (key: string, val: string) => storageMap.set(key, val),
      removeItem: (key: string) => storageMap.delete(key),
    },
    location: {
      get search() { return currentSearch; },
      get href() { return `https://aira.app${currentPath}${currentSearch}`; },
      pathname: currentPath,
    },
    history: {
      replaceState: (_data: any, _unused: string, url: string) => {
        try {
          const parsed = new URL(url, 'https://aira.app');
          currentSearch = parsed.search;
          currentPath = parsed.pathname;
        } catch {
          // relative path
          const [path, search] = url.split('?');
          currentPath = path || '/';
          currentSearch = search ? `?${search}` : '';
        }
      }
    }
  };

  (globalThis as any).window = mockWindow;
  (globalThis as any).sessionStorage = mockWindow.sessionStorage;

  try {
    // 1. Fresh session with no search and no storage -> returns null
    assert.equal(getSessionActiveChatId(), null, 'Fresh session should return null');

    // 2. Set active conversation in session
    setSessionActiveChatId('chat-alpha-123');
    assert.equal(storageMap.get('aira_active_chat_session'), 'chat-alpha-123');
    assert.match(currentSearch, /c=chat-alpha-123/, 'URL search must contain ?c=chat-alpha-123');
    assert.equal(getSessionActiveChatId(), 'chat-alpha-123', 'Should retrieve active chat id from session/URL');

    // 3. Browser reload simulation: sessionStorage preserved even if search is reset or present
    assert.equal(getSessionActiveChatId(), 'chat-alpha-123', 'Should persist active conversation on simulated reload');

    // 4. URL query param overrides sessionStorage if different
    currentSearch = '?c=chat-beta-456';
    assert.equal(getSessionActiveChatId(), 'chat-beta-456', 'URL query param should take precedence');

    // 5. Clear session on "New chat"
    setSessionActiveChatId(null);
    assert.equal(storageMap.has('aira_active_chat_session'), false, 'Session key must be deleted');
    assert.doesNotMatch(currentSearch, /c=/, 'URL search must not contain c parameter after clearing');
    assert.equal(getSessionActiveChatId(), null, 'Must return null after clearing');

  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).sessionStorage;
  }
});
