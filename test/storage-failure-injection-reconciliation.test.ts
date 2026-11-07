import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory mock storage implementations
class MockStorage {
  public store = new Map<string, string>();
  public shouldThrowOnKeys = new Set<string>();
  public throwAll = false;

  getItem(key: string): string | null {
    if (this.throwAll) throw new Error('Storage unavailable');
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwAll) throw new Error('Storage unavailable');
    if (this.shouldThrowOnKeys.has(key)) {
      const err = new Error(`QuotaExceededError: Setting '${key}' exceeded quota`);
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throwAll) throw new Error('Storage unavailable');
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.shouldThrowOnKeys.clear();
    this.throwAll = false;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  get length(): number {
    return this.store.size;
  }
}

const mockLocal = new MockStorage();
const mockSession = new MockStorage();
(globalThis as any).localStorage = mockLocal;
(globalThis as any).sessionStorage = mockSession;

// Mock IndexedDB
class MockIDBStore {
  public data = new Map<string, any>();
}

class MockIDBDatabase {
  public stores = new Map<string, MockIDBStore>();
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(name: string) {
    const store = new MockIDBStore();
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames: string | string[], _mode: string) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const tx = {
      oncomplete: null as any,
      onerror: null as any,
      abort: () => {},
      objectStore: (name: string) => {
        let store = this.stores.get(name);
        if (!store) {
          store = new MockIDBStore();
          this.stores.set(name, store);
        }
        return {
          get: (key: string) => {
            const req = { result: store.data.get(key), onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (req.onsuccess) req.onsuccess({ target: req });
              if (tx.oncomplete) tx.oncomplete();
            });
            return req;
          },
          put: (value: any, key: string) => {
            store.data.set(key, value);
            const req = { onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (req.onsuccess) req.onsuccess({ target: req });
              if (tx.oncomplete) tx.oncomplete();
            });
            return req;
          },
          delete: (key: string) => {
            store.data.delete(key);
            const req = { onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (req.onsuccess) req.onsuccess({ target: req });
              if (tx.oncomplete) tx.oncomplete();
            });
            return req;
          },
        };
      },
    };
    return tx;
  }
}

let mockIdbDb: MockIDBDatabase | null = new MockIDBDatabase();
let idbShouldFailOpen = false;

(globalThis as any).window = {
  indexedDB: {
    open: (_name: string, _version?: number) => {
      const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (idbShouldFailOpen || !mockIdbDb) {
          if (req.onerror) req.onerror({ target: { error: new Error('IndexedDB blocked') } });
        } else {
          if (req.onupgradeneeded) {
            req.onupgradeneeded({ target: { result: mockIdbDb } });
          }
          if (req.onsuccess) {
            req.result = mockIdbDb;
            req.onsuccess({ target: req });
          }
        }
      });
      return req;
    },
  },
};

const {
  loadConversations,
  saveConversations,
  loadProjects,
  saveProjects,
  loadSettings,
  saveSettings,
  exportAllStorageData,
  getStorageHealth,
  reconcileConversations,
  reconcileProjects,
  hydrateStorageFromIndexedDb,
  evictVerifiedWorkspaceBlobs,
  markWorkspaceKeyVerifiedInIdb,
  resetStorageForTesting,
  STORAGE_KEYS,
} = await import('../src/utils/storage.js');

const {
  idbGet,
  idbSet,
  STORES,
  resetDbConnectionForTesting,
} = await import('../src/utils/indexedDbStorage.js');

test.beforeEach(() => {
  mockLocal.clear();
  mockSession.clear();
  mockIdbDb = new MockIDBDatabase();
  idbShouldFailOpen = false;
  resetDbConnectionForTesting();
  resetStorageForTesting();
});

test('[Failure Injection: IndexedDB open failure] Clean fallback to LocalStorage without uncaught exceptions', async () => {
  idbShouldFailOpen = true;

  const conv = [
    {
      id: 'c-idb-fail-1',
      title: 'Fallback Conversation',
      messages: [{ id: 'm-1', role: 'user' as const, content: 'Fallback message', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  // Saving should NOT throw even when IndexedDB fails to open
  assert.doesNotThrow(() => {
    saveConversations(conv);
  });

  // LocalStorage should receive the data
  const rawLocal = mockLocal.getItem('aira_conversations_v1');
  assert.ok(rawLocal, 'LocalStorage must receive data as fallback');
  const parsed = JSON.parse(rawLocal!);
  assert.equal(parsed[0].id, 'c-idb-fail-1');

  // Loading should return the saved conversation cleanly
  const loaded = loadConversations();
  assert.equal(loaded[0].id, 'c-idb-fail-1');
  assert.equal(loaded[0].messages[0].content, 'Fallback message');
});

test('[Failure Injection: Total Storage Unavailability] In-memory mode survives with disaster recovery export', async () => {
  idbShouldFailOpen = true;
  mockLocal.throwAll = true;

  const conv = [
    {
      id: 'c-total-fail',
      title: 'Memory Only Conversation',
      messages: [{ id: 'm-mem', role: 'user' as const, content: 'Memory preserved content', timestamp: 1500 }],
      createdAt: 1500,
      updatedAt: 1500,
    },
  ];

  // Save should update in-memory cache without throwing
  assert.doesNotThrow(() => {
    saveConversations(conv);
  });

  // In-memory data is retrievable within session
  const loaded = loadConversations();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'c-total-fail');
  assert.equal(loaded[0].messages[0].content, 'Memory preserved content');

  // Disaster recovery export creates valid JSON dump
  const dump = exportAllStorageData();
  assert.ok(dump.includes('Memory preserved content'));
  assert.ok(dump.includes('c-total-fail'));
});

test('[Failure Injection: Quota pressure] Unverified workspace records are NEVER deleted upon quota exhaustion', async () => {
  // Pre-seed an unverified workspace record in LocalStorage
  mockLocal.setItem('aira_workspace_synced_v1_critical_user_code', JSON.stringify({
    projectId: 'user-proj-1',
    files: { 'index.html': { content: '<h1>My App</h1>' } },
  }));

  // Force QuotaExceededError on settings
  const settings = loadSettings();
  settings.theme = 'dark';
  mockLocal.shouldThrowOnKeys.add(STORAGE_KEYS.SETTINGS);

  saveSettings(settings);

  // CRITICAL P1 INVARIANT: Unverified workspace record MUST NOT be deleted
  const rawWorkspace = mockLocal.getItem('aira_workspace_synced_v1_critical_user_code');
  assert.ok(rawWorkspace, 'Unverified workspace blob must NOT be deleted during quota recovery');
  assert.ok(rawWorkspace!.includes('My App'));
});

test('[Durability: Read-back Verification] evictVerifiedWorkspaceBlobs deletes ONLY verified records', async () => {
  // Pre-seed two workspace records in LocalStorage
  mockLocal.setItem('aira_workspace_synced_v1_app_1', JSON.stringify({
    projectId: 'p-1',
    syncedAt: 1000,
  }));
  mockLocal.setItem('aira_workspace_synced_v1_app_2', JSON.stringify({
    projectId: 'p-2',
    syncedAt: 2000,
  }));

  // Execute read-back verified eviction
  const freed = await evictVerifiedWorkspaceBlobs();
  assert.equal(freed, 2);

  // Both should now be retrievable from IndexedDB
  const idbApp1 = await idbGet(STORES.WORKSPACES, 'aira_workspace_synced_v1_app_1');
  const idbApp2 = await idbGet(STORES.WORKSPACES, 'aira_workspace_synced_v1_app_2');
  assert.ok(idbApp1, 'App 1 must be present in IndexedDB');
  assert.ok(idbApp2, 'App 2 must be present in IndexedDB');

  // Both have been safely evicted from LocalStorage
  assert.equal(mockLocal.getItem('aira_workspace_synced_v1_app_1'), null);
  assert.equal(mockLocal.getItem('aira_workspace_synced_v1_app_2'), null);
});

test('[Conflict Resolution: Stale LocalStorage] Newer IndexedDB data survives stale LocalStorage mirror', async () => {
  const staleLocal = [
    {
      id: 'c-divergent',
      title: 'Stale Title in LocalStorage',
      messages: [{ id: 'm-1', role: 'user' as const, content: 'Initial question', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000, // Older timestamp
    },
  ];

  const newerIdb = [
    {
      id: 'c-divergent',
      title: 'Newer Title in IndexedDB',
      messages: [
        { id: 'm-1', role: 'user' as const, content: 'Initial question', timestamp: 1000 },
        { id: 'm-2', role: 'assistant' as const, content: 'Synthesized comprehensive response', timestamp: 2000 },
      ],
      createdAt: 1000,
      updatedAt: 2000, // Strictly newer timestamp
    },
  ];

  // Reconcile: IndexedDB must win
  const reconciled = reconcileConversations(staleLocal, newerIdb);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].title, 'Newer Title in IndexedDB');
  assert.equal(reconciled[0].updatedAt, 2000);
  assert.equal(reconciled[0].messages.length, 2);
  assert.equal(reconciled[0].messages[1].content, 'Synthesized comprehensive response');

  // Test full hydration cycle
  mockLocal.setItem('aira_conversations_v1', JSON.stringify(staleLocal));
  await idbSet(STORES.CONVERSATIONS, 'aira_conversations_v1', newerIdb);

  const hydrationResult = await hydrateStorageFromIndexedDb();
  assert.ok(hydrationResult.conversations);
  assert.equal(hydrationResult.conversations![0].title, 'Newer Title in IndexedDB');
  assert.equal(hydrationResult.conversations![0].messages.length, 2);

  // LocalStorage mirror should now be updated with the newer data
  const updatedMirror = JSON.parse(mockLocal.getItem('aira_conversations_v1')!);
  assert.equal(updatedMirror[0].title, 'Newer Title in IndexedDB');
});

test('[Conflict Resolution: Newer LocalStorage] Newer LocalStorage data successfully updates older IndexedDB', async () => {
  const newerLocal = [
    {
      id: 'c-local-wins',
      title: 'Newest Discussion',
      messages: [
        { id: 'm-1', role: 'user' as const, content: 'Step 1', timestamp: 1000 },
        { id: 'm-2', role: 'assistant' as const, content: 'Step 2', timestamp: 3000 },
      ],
      createdAt: 1000,
      updatedAt: 3000, // Strictly newer
    },
  ];

  const olderIdb = [
    {
      id: 'c-local-wins',
      title: 'Older Discussion',
      messages: [{ id: 'm-1', role: 'user' as const, content: 'Step 1', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  const reconciled = reconcileConversations(newerLocal, olderIdb);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].title, 'Newest Discussion');
  assert.equal(reconciled[0].updatedAt, 3000);
  assert.equal(reconciled[0].messages.length, 2);

  // Test full hydration cycle: LocalStorage newer updates IndexedDB
  mockLocal.setItem('aira_conversations_v1', JSON.stringify(newerLocal));
  await idbSet(STORES.CONVERSATIONS, 'aira_conversations_v1', olderIdb);

  await hydrateStorageFromIndexedDb();

  const idbFinal = await idbGet<any[]>(STORES.CONVERSATIONS, 'aira_conversations_v1');
  assert.ok(idbFinal);
  assert.equal(idbFinal![0].title, 'Newest Discussion');
  assert.equal(idbFinal![0].updatedAt, 3000);
});

test('[Conflict Resolution: Union] Non-overlapping conversations and projects are preserved without data loss', async () => {
  const localConvs = [
    {
      id: 'c-local-only',
      title: 'Local Only',
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  const idbConvs = [
    {
      id: 'c-idb-only',
      title: 'IDB Only',
      messages: [],
      createdAt: 2000,
      updatedAt: 2000,
    },
  ];

  const mergedConvs = reconcileConversations(localConvs, idbConvs);
  assert.equal(mergedConvs.length, 2);
  const ids = mergedConvs.map(c => c.id);
  assert.ok(ids.includes('c-local-only'));
  assert.ok(ids.includes('c-idb-only'));

  // Projects Union
  const localProjects = [
    {
      id: 'p-local',
      name: 'Local Project',
      description: '',
      instructions: '',
      docs: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  const idbProjects = [
    {
      id: 'p-idb',
      name: 'IDB Project',
      description: '',
      instructions: '',
      docs: [],
      createdAt: 2000,
      updatedAt: 2000,
    },
  ];

  const mergedProjects = reconcileProjects(localProjects, idbProjects);
  assert.equal(mergedProjects.length, 2);
  const pIds = mergedProjects.map(p => p.id);
  assert.ok(pIds.includes('p-local'));
  assert.ok(pIds.includes('p-idb'));
});

test('[Project Conflict Resolution] Newer project in IndexedDB survives stale LocalStorage mirror', async () => {
  const staleLocalProjects = [
    {
      id: 'p-conflict',
      name: 'Old Project Name',
      description: 'Old Description',
      instructions: 'Old',
      docs: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  const newerIdbProjects = [
    {
      id: 'p-conflict',
      name: 'New Project Name',
      description: 'New Description',
      instructions: 'New Instructions',
      docs: [{ id: 'd-1', name: 'guide.md', content: '# Guide', size: '100', createdAt: 2000 }],
      createdAt: 1000,
      updatedAt: 2000, // Newer
    },
  ];

  mockLocal.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(staleLocalProjects));
  await idbSet(STORES.PROJECTS, 'projects', newerIdbProjects);

  // Calling loadProjects must NOT overwrite the newer IndexedDB project
  loadProjects();

  const hydrationResult = await hydrateStorageFromIndexedDb();
  assert.ok(hydrationResult.projects);
  assert.equal(hydrationResult.projects![0].name, 'New Project Name');
  assert.equal(hydrationResult.projects![0].docs.length, 1);

  // Confirm IndexedDB was NOT overwritten with stale data
  const idbAfter = await idbGet<any[]>(STORES.PROJECTS, 'projects');
  assert.ok(idbAfter);
  assert.equal(idbAfter![0].name, 'New Project Name');
});
