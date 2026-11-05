import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMemory } from '../src/utils/agentMemoryEngine.js';
import { neonAuth } from '../src/lib/neonAuth.js';

test('client memory vault separates guest, Alice and Bob across account changes', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; }
  };
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const getCurrentUser = neonAuth.getCurrentUser.bind(neonAuth);
  let currentUser: string | null = null;

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  neonAuth.getCurrentUser = (() => currentUser ? { id: currentUser, name: currentUser, email: `${currentUser}@example.invalid` } : null) as typeof neonAuth.getCurrentUser;

  try {
    agentMemory.remember('Private guest preference: orange', { title: 'Guest preference' });
    currentUser = 'alice';
    assert.equal(agentMemory.getSnapshot().length, 0, 'Guest memory must not follow Alice');
    agentMemory.remember('Alice private architectural decision: violet', { title: 'Alice decision' });
    assert.match(agentMemory.assembleMemoryContext('violet architecture'), /Alice private architectural decision/);

    currentUser = 'bob';
    assert.equal(agentMemory.getSnapshot().length, 0, 'Alice memory must not appear in Bob vault');
    assert.equal(agentMemory.getStats().totalCount, 0);
    assert.doesNotMatch(agentMemory.assembleMemoryContext('violet architecture'), /Alice private/);
    agentMemory.remember('Bob prefers turquoise', { title: 'Bob preference' });

    const importResult = agentMemory.importVault(JSON.stringify([{ id: 'alice-import', tier: 'semantic', category: 'preference', title: 'Alice', content: 'Alice private', tags: [], userId: 'alice' }]));
    assert.equal(importResult.imported, 0, 'Bob cannot import a memory belonging to Alice');
    assert.equal(importResult.errors, 1);

    currentUser = 'alice';
    assert.match(agentMemory.assembleMemoryContext('violet architecture'), /Alice private architectural decision/);
    assert.doesNotMatch(agentMemory.assembleMemoryContext('turquoise'), /Bob prefers/);
    currentUser = null;
    assert.match(agentMemory.assembleMemoryContext('orange preference'), /Private guest preference/);
  } finally {
    neonAuth.getCurrentUser = getCurrentUser;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
  }
});
