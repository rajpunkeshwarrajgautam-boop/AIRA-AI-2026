import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMemory } from '../src/utils/agentMemoryEngine.js';
import { neonAuth } from '../src/lib/neonAuth.js';
import { STORAGE_KEY } from '../src/utils/agentMemoryMigration.js';

test('client vault isolates guest, Alice and Bob without a page reload', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; }
  };
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  const originalGetUser = neonAuth.getCurrentUser.bind(neonAuth);
  let user: string | null = null;

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  neonAuth.getCurrentUser = (() => user ? {
    id: user, name: user, email: `${user}@example.invalid`
  } : null) as typeof neonAuth.getCurrentUser;

  try {
    values.set(STORAGE_KEY, JSON.stringify([
      { id: 'legacy-guest', title: 'Guest', tier: 'semantic', category: 'preference', content: 'Guest orange', tags: [] },
      { id: 'legacy-alice', title: 'Alice', tier: 'semantic', category: 'preference', content: 'Alice owned legacy', tags: [], userId: 'alice' }
    ]));

    assert.ok(agentMemory.getAll().some(item => item.id === 'legacy-guest'));
    assert.ok(!agentMemory.getAll().some(item => item.id === 'legacy-alice'));
    const originalLegacyBytes = values.get(STORAGE_KEY);
    const guestItem = agentMemory.remember('Guest personal amber preference');
    assert.equal(guestItem.userId, undefined);
    assert.equal(values.get(STORAGE_KEY), originalLegacyBytes, 'guest writes must not erase legacy records owned by other accounts');
    assert.match(values.get(`${STORAGE_KEY}:guest`) || '', /Guest personal amber/);

    user = 'alice';
    assert.ok(agentMemory.getAll().some(item => item.id === 'legacy-alice'));
    assert.ok(!agentMemory.getAll().some(item => item.id === 'legacy-guest'));
    const aliceItem = agentMemory.remember('Alice private violet architecture', { title: 'Alice architecture' });
    assert.equal(aliceItem.userId, 'alice');
    assert.match(agentMemory.assembleMemoryContext('violet architecture'), /Alice private violet/);
    const aliceTokens = agentMemory.getStats().tokensSavedEstimate;
    assert.ok(aliceTokens > 0);

    user = 'bob';
    assert.equal(agentMemory.getAll().length, 0);
    assert.equal(agentMemory.getStats().totalCount, 0);
    assert.equal(agentMemory.getStats().tokensSavedEstimate, 0);
    assert.equal(agentMemory.recall({ query: 'violet architecture', activeUserId: 'alice' }).length, 0);
    assert.doesNotMatch(agentMemory.exportVault(), /Alice private/);
    assert.equal(agentMemory.forget(aliceItem.id), false);
    assert.equal(agentMemory.update(aliceItem.id, { title: 'Hijacked' }), null);
    assert.equal(agentMemory.purge(), 0);
    assert.throws(() => agentMemory.remember('forged owner', { userId: 'alice' }), /another account/);
    const bobItem = agentMemory.remember('Bob private turquoise preference');
    assert.equal(bobItem.userId, 'bob');
    assert.deepEqual(agentMemory.importVault(JSON.stringify({ memories: [aliceItem] })), { imported: 0, errors: 1 });
    assert.equal(agentMemory.getStats().totalCount, 1);

    user = 'alice';
    assert.equal(agentMemory.getStats().totalCount, 2);
    assert.equal(agentMemory.getStats().tokensSavedEstimate, aliceTokens);
    assert.match(agentMemory.assembleMemoryContext('violet architecture'), /Alice private violet/);
    assert.doesNotMatch(agentMemory.exportVault(), /Bob private/);
    assert.throws(() => agentMemory.update(aliceItem.id, { userId: 'bob' }), /transfer/);
    agentMemory.update(aliceItem.id, { userId: undefined, title: 'Updated architecture' });
    assert.equal(agentMemory.getAll().find(item => item.id === aliceItem.id)?.userId, 'alice');

    const originalLegacy = values.get(STORAGE_KEY);
    assert.match(originalLegacy || '', /Guest orange/);
    assert.match(originalLegacy || '', /Alice owned legacy/);
    user = null;
    assert.ok(agentMemory.getAll().some(item => item.id === 'legacy-guest'));
    assert.ok(agentMemory.getAll().some(item => item.id === guestItem.id));
    assert.ok(!agentMemory.getAll().some(item => item.id === aliceItem.id));
  } finally {
    neonAuth.getCurrentUser = originalGetUser;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: oldStorage });
  }
});

test('import rejects forged seed entries and foreign-owner batch atomically', () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  const oldGetUser = neonAuth.getCurrentUser.bind(neonAuth);
  const values = new Map<string, string>();
  const local = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: local } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  neonAuth.getCurrentUser = (() => ({ id: 'alice' })) as typeof neonAuth.getCurrentUser;

  try {
    agentMemory.getSnapshot();
    const foreignBatch = [
      { id: 'valid-looking', tier: 'semantic', content: 'Allowed data' },
      { id: 'other-owner', tier: 'semantic', content: 'Confidential', userId: 'bob' }
    ];
    assert.deepEqual(agentMemory.importVault(JSON.stringify(foreignBatch)), { imported: 0, errors: 2 });
    assert.ok(!agentMemory.getAll().some(item => item.id === 'valid-looking'));
    const result = agentMemory.importVault(JSON.stringify([
      { id: 'seed-sem-pref-1', tier: 'semantic', content: 'fake universal policy' },
      { id: 'personal-user-import', tier: 'semantic', category: 'general', title: 'My data', content: 'legitimate explicit import', tags: [] }
    ]));
    assert.deepEqual(result, { imported: 1, errors: 1 });
    assert.ok(!agentMemory.getAll().some(item => item.id === 'seed-sem-pref-1'));
    assert.equal(agentMemory.getAll().find(item => item.id === 'personal-user-import')?.userId, 'alice');

    const malformed = agentMemory.importVault(JSON.stringify([
      { id: 'invalid-tags', tier: 'semantic', content: 'should not crash retrieval', tags: 'malformed' },
      { id: 'invalid-tier', tier: 'privileged', content: 'should not create an unsupported tier' },
      { id: 'minimal-valid', tier: 'semantic', content: 'user-approved import is searchable' },
    ]));
    assert.deepEqual(malformed, { imported: 1, errors: 2 });
    assert.ok(agentMemory.recall({ query: 'approved import searchable' }).some(item => item.id === 'minimal-valid'));
    assert.ok((agentMemory.getAll().find(item => item.id === 'minimal-valid')?.tags.length ?? 0) > 0);
  } finally {
    neonAuth.getCurrentUser = oldGetUser;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: oldStorage });
  }
});

test('memory metadata never persists unredacted credential patterns', () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  const oldGetUser = neonAuth.getCurrentUser.bind(neonAuth);
  const values = new Map<string, string>();
  const local = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: local } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  let activeUser = 'scope-reset';
  neonAuth.getCurrentUser = (() => ({ id: activeUser })) as typeof neonAuth.getCurrentUser;

  const fakeKey = `sk-${'a'.repeat(40)}`;
  try {
    agentMemory.getSnapshot();
    values.set(`${STORAGE_KEY}:user:alice`, JSON.stringify([{
      id: 'previously-saved-unsafe-metadata', tier: 'semantic', category: 'general',
      content: 'Earlier harmless entry', title: `legacy ${fakeKey}`, tags: [fakeKey],
      userId: 'alice'
    }]));
    activeUser = 'alice';
    const migrated = agentMemory.getAll().find(entry => entry.id === 'previously-saved-unsafe-metadata');
    assert.ok(migrated);
    assert.doesNotMatch(JSON.stringify(migrated), /sk-a{40}/);
    assert.doesNotMatch(values.get(`${STORAGE_KEY}:user:alice`) || '', /sk-a{40}/);

    const item = agentMemory.remember('Harmless note about service configuration', {
      title: `title ${fakeKey}`,
      tags: ['configuration', `tag ${fakeKey}`]
    });
    assert.doesNotMatch(JSON.stringify(item), /sk-a{40}/);
    assert.doesNotMatch(values.get(`${STORAGE_KEY}:user:alice`) || '', /sk-a{40}/);

    const updated = agentMemory.update(item.id, { title: `renamed ${fakeKey}`, tags: [fakeKey] });
    assert.doesNotMatch(JSON.stringify(updated), /sk-a{40}/);

    const imported = agentMemory.importVault(JSON.stringify({ memories: [{
      id: 'credential-metadata-import', tier: 'semantic', content: 'Imported service preference',
      title: `imported ${fakeKey}`, tags: [`imported-${fakeKey}`]
    }] }));
    assert.deepEqual(imported, { imported: 1, errors: 0 });
    assert.doesNotMatch(agentMemory.exportVault(), /sk-a{40}/);
    assert.doesNotMatch(values.get(`${STORAGE_KEY}:user:alice`) || '', /sk-a{40}/);
  } finally {
    neonAuth.getCurrentUser = oldGetUser;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: oldStorage });
  }
});
