import test, { beforeEach, after } from 'node:test';
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
  public shouldFailTransaction = false;
  public shouldAbortTransaction = false;
  public corruptReadBackKeys = new Set<string>();

  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(name: string) {
    const store = new MockIDBStore();
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames: string | string[], _mode: string) {
    const tx = {
      oncomplete: null as any,
      onerror: null as any,
      onabort: null as any,
      abort: () => {
        if (tx.onabort) tx.onabort();
      },
      objectStore: (name: string) => {
        let store = this.stores.get(name);
        if (!store) {
          store = new MockIDBStore();
          this.stores.set(name, store);
        }
        return {
          get: (key: string) => {
            const isCorrupted = this.corruptReadBackKeys.has(key);
            const rawResult = store.data.get(key);
            const result = isCorrupted ? { corrupted: true, alteredPayload: 'corrupt-bytes' } : rawResult;
            const req = { result, onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (req.onsuccess) req.onsuccess({ target: req });
              if (tx.oncomplete) tx.oncomplete();
            });
            return req;
          },
          put: (value: any, key: string) => {
            const req = { onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (this.shouldFailTransaction) {
                if (req.onerror) req.onerror({ target: { error: new Error('Commit failed') } });
                if (tx.onerror) tx.onerror({ target: { error: new Error('Transaction error') } });
              } else if (this.shouldAbortTransaction) {
                if (tx.onabort) tx.onabort({ target: { error: new Error('Transaction aborted') } });
              } else {
                store.data.set(key, value);
                if (req.onsuccess) req.onsuccess({ target: req });
                if (tx.oncomplete) tx.oncomplete();
              }
            });
            return req;
          },
          delete: (key: string) => {
            const req = { onsuccess: null as any, onerror: null as any };
            queueMicrotask(() => {
              if (this.shouldFailTransaction) {
                if (req.onerror) req.onerror({ target: { error: new Error('Delete failed') } });
                if (tx.onerror) tx.onerror({ target: { error: new Error('Transaction error') } });
              } else if (this.shouldAbortTransaction) {
                if (tx.onabort) tx.onabort({ target: { error: new Error('Transaction aborted') } });
              } else {
                store.data.delete(key);
                if (req.onsuccess) req.onsuccess({ target: req });
                if (tx.oncomplete) tx.oncomplete();
              }
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
  addEventListener: () => {},
  removeEventListener: () => {},
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

// Suppress unhandled network restoration fetch in headless Node
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('/api/auth/session')) {
    return new Response(JSON.stringify({ status: 'ANONYMOUS', user: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return originalFetch ? originalFetch(input, init) : new Response('{}', { status: 200 });
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
  hydrateProjectsFromIndexedDb,
  evictVerifiedWorkspaceBlobs,
  evictVerifiedLocalStorageBlobsSync,
  markWorkspaceKeyVerifiedInIdb,
  isWorkspaceKeyVerifiedInIdb,
  computePayloadHash,
  recordEntityDeletion,
  isEntityDeleted,
  deleteConversationRecord,
  deleteProjectRecord,
  resetStorageForTesting,
  STORAGE_KEYS,
} = await import('../src/utils/storage.js');

const {
  idbGet,
  idbSet,
  STORES,
  resetDbConnectionForTesting,
} = await import('../src/utils/indexedDbStorage.js');

const { syncBundleToWorkspace } = await import('../src/utils/artifactWorkspaceSync.js');
const { createMultiFileBundle } = await import('../src/utils/artifactBundleEngine.js');

beforeEach(() => {
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

test('[Regression: Failed Writes] Transaction error or abort resolves false and is NEVER marked durable', async () => {
  // Test transaction error
  mockIdbDb!.shouldFailTransaction = true;
  const setFailedError = await idbSet(STORES.WORKSPACES, 'test-key-fail', { value: 123 });
  assert.equal(setFailedError, false, 'idbSet must resolve false on transaction error');

  // Test transaction abort
  mockIdbDb!.shouldFailTransaction = false;
  mockIdbDb!.shouldAbortTransaction = true;
  const setFailedAbort = await idbSet(STORES.WORKSPACES, 'test-key-abort', { value: 456 });
  assert.equal(setFailedAbort, false, 'idbSet must resolve false on transaction abort');

  // Verify that evictVerifiedWorkspaceBlobs does not evict or mark durable when transaction aborts
  const workspaceKey = 'aira_workspace_synced_v1_fail_test';
  const workspacePayload = { projectId: 'p-fail', files: [{ path: 'app.js', content: 'console.log(1);' }] };
  mockLocal.setItem(workspaceKey, JSON.stringify(workspacePayload));

  const freed = await evictVerifiedWorkspaceBlobs();
  assert.equal(freed, 0, 'No keys must be freed when transaction fails');
  assert.equal(isWorkspaceKeyVerifiedInIdb(workspaceKey), false, 'Key must NOT be marked verified on failure');
  assert.ok(mockLocal.getItem(workspaceKey), 'LocalStorage key must remain intact');
});

test('[Regression: Mismatched Read-Backs] Corrupted or mismatched read-back payload prevents eviction and retains LocalStorage data', async () => {
  const workspaceKey = 'aira_workspace_synced_v1_mismatch_test';
  const workspacePayload = { projectId: 'p-mismatch', files: [{ path: 'index.html', content: '<h1>Original</h1>' }] };
  mockLocal.setItem(workspaceKey, JSON.stringify(workspacePayload));

  // Instruct Mock IDB to return corrupted payload on read-back
  mockIdbDb!.corruptReadBackKeys.add(workspaceKey);

  const freed = await evictVerifiedWorkspaceBlobs();
  assert.equal(freed, 0, 'Mismatched read-back must prevent eviction');
  assert.equal(isWorkspaceKeyVerifiedInIdb(workspaceKey), false, 'Mismatched key must NOT be marked verified');
  assert.ok(mockLocal.getItem(workspaceKey), 'LocalStorage payload must be preserved intact');
});

test('[Regression: Changed Workspace Payload] LocalStorage payload mutated after verification is preserved from eviction', async () => {
  const workspaceKey = 'aira_workspace_synced_v1_mutation_test';
  const v1Payload = { projectId: 'p-mut', version: 1, content: 'Initial version' };
  mockLocal.setItem(workspaceKey, JSON.stringify(v1Payload));

  // 1. Verify v1 to IndexedDB
  const freedInitial = await evictVerifiedWorkspaceBlobs();
  assert.equal(freedInitial, 1, 'v1 should be successfully verified and evicted');

  // 2. User makes a new edit in the workspace, writing v2 to LocalStorage
  const v2Payload = { projectId: 'p-mut', version: 2, content: 'Updated version with unsaved edits' };
  const v2Raw = JSON.stringify(v2Payload);
  mockLocal.setItem(workspaceKey, v2Raw);

  // 3. Quota recovery runs synchronously via evictVerifiedLocalStorageBlobsSync
  const freedSync = evictVerifiedLocalStorageBlobsSync();
  assert.equal(freedSync, 0, 'Mutated v2 payload MUST NOT be evicted using stale v1 verification hash');
  assert.equal(mockLocal.getItem(workspaceKey), v2Raw, 'Mutated v2 payload must remain intact in LocalStorage');
});

test('[Regression: Deleted Records with Tombstones] Deleted conversation and project records are not resurrected by older IndexedDB state', async () => {
  // 1. Create and save conversation C1
  const conv1 = {
    id: 'c-tombstone-1',
    title: 'To Be Deleted',
    messages: [{ id: 'm-1', role: 'user' as const, content: 'Sensitive chat', timestamp: 1000 }],
    createdAt: 1000,
    updatedAt: 1000,
  };
  saveConversations([conv1]);
  await idbSet(STORES.CONVERSATIONS, 'aira_conversations_v1', [conv1]);

  // 2. Delete conversation C1
  deleteConversationRecord('c-tombstone-1');
  assert.ok(isEntityDeleted('c-tombstone-1', 'conversation'), 'Tombstone must be recorded');

  // 3. Stale sync / older IndexedDB contains C1
  const idbStaleConvs = [conv1];
  const localEmpty: any[] = [];
  const reconciled = reconcileConversations(localEmpty, idbStaleConvs);
  assert.equal(reconciled.length, 0, 'Tombstoned conversation must NOT be resurrected by reconcileConversations');

  // 4. Test full hydration with tombstones
  const hydration = await hydrateStorageFromIndexedDb();
  assert.ok(hydration.conversations !== null);
  assert.equal(hydration.conversations!.some(c => c.id === 'c-tombstone-1'), false, 'Tombstoned conversation must NOT be resurrected during hydration');

  // 5. Test project deletion with tombstones
  const proj1 = {
    id: 'p-tombstone-1',
    name: 'To Be Deleted Project',
    description: '',
    instructions: '',
    docs: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
  saveProjects([proj1]);
  await idbSet(STORES.PROJECTS, 'projects', [proj1]);

  deleteProjectRecord('p-tombstone-1');
  assert.ok(isEntityDeleted('p-tombstone-1', 'project'), 'Project tombstone must be recorded');

  const projHydration = await hydrateProjectsFromIndexedDb();
  assert.ok(projHydration !== null);
  assert.equal(projHydration!.some(p => p.id === 'p-tombstone-1'), false, 'Tombstoned project must NOT be resurrected during hydration');

  // 6. Intentional re-creation: entity created with timestamp AFTER deletion is accepted
  const recreatedTime = Date.now() + 5000;
  const recreatedConv = {
    ...conv1,
    title: 'Re-created Conversation',
    createdAt: recreatedTime,
    updatedAt: recreatedTime, // Newer than deletion
  };
  assert.equal(isEntityDeleted(recreatedConv.id, 'conversation', recreatedConv.updatedAt), false, 'Entity re-created after deletion must be accepted');
  const reconciledRecreated = reconcileConversations([recreatedConv], idbStaleConvs);
  assert.equal(reconciledRecreated.length, 1);
  assert.equal(reconciledRecreated[0].title, 'Re-created Conversation');
});

test('[Regression: Simultaneous / Concurrent Updates] Deterministic Last-Write-Wins and tiebreaker resolution prevent message loss', async () => {
  // Scenario A: Same timestamp, tiebreaker selects the one with more messages
  const updateLocal = {
    id: 'c-concurrent-1',
    title: 'Concurrent Chat',
    messages: [
      { id: 'm-1', role: 'user' as const, content: 'Message 1', timestamp: 1000 },
      { id: 'm-2', role: 'assistant' as const, content: 'Message 2', timestamp: 1001 },
    ],
    createdAt: 1000,
    updatedAt: 5000,
  };

  const updateIdbMoreMsgs = {
    id: 'c-concurrent-1',
    title: 'Concurrent Chat IDB',
    messages: [
      { id: 'm-1', role: 'user' as const, content: 'Message 1', timestamp: 1000 },
      { id: 'm-2', role: 'assistant' as const, content: 'Message 2', timestamp: 1001 },
      { id: 'm-3', role: 'user' as const, content: 'Message 3', timestamp: 1002 },
      { id: 'm-4', role: 'assistant' as const, content: 'Message 4', timestamp: 1003 },
    ],
    createdAt: 1000,
    updatedAt: 5000, // Identical timestamp
  };

  const reconciledTiebreak = reconcileConversations([updateLocal], [updateIdbMoreMsgs]);
  assert.equal(reconciledTiebreak.length, 1);
  assert.equal(reconciledTiebreak[0].messages.length, 4, 'Tiebreaker must select candidate with more messages to prevent data truncation');

  // Scenario B: Local is strictly newer (6000 vs 5000)
  const strictlyNewerLocal = { ...updateLocal, updatedAt: 6000 };
  const reconciledLocalNewer = reconcileConversations([strictlyNewerLocal], [updateIdbMoreMsgs]);
  assert.equal(reconciledLocalNewer.length, 1);
  assert.equal(reconciledLocalNewer[0].updatedAt, 6000);
  assert.equal(reconciledLocalNewer[0].messages.length, 2);

  // Scenario C: IDB is strictly newer (7000 vs 6000)
  const strictlyNewerIdb = { ...updateIdbMoreMsgs, updatedAt: 7000 };
  const reconciledIdbNewer = reconcileConversations([strictlyNewerLocal], [strictlyNewerIdb]);
  assert.equal(reconciledIdbNewer.length, 1);
  assert.equal(reconciledIdbNewer[0].updatedAt, 7000);
  assert.equal(reconciledIdbNewer[0].messages.length, 4);
});

test('[Regression: Workspace Sync False-Durability Prevention] syncBundleToWorkspace does NOT mark verified when idbSet fails', async () => {
  const bundle = createMultiFileBundle({
    id: 'bundle-fail-durability',
    title: 'Fail Durability Bundle',
    entryPoint: 'index.html',
    files: [
      { path: 'index.html', content: '<h1>Sync Content</h1>' },
      { path: 'app.js', content: 'console.log("hello");' }
    ]
  });

  const wsId = 'ws_fail_durability_test';
  const expectedKey = 'aira_workspace_synced_v1_guest_ws_fail_durability_test';

  // 1. Force idbSet to fail via transaction abort
  mockIdbDb!.shouldAbortTransaction = true;

  const result = await syncBundleToWorkspace(bundle, wsId);
  assert.equal(result.success, true, 'syncBundleToWorkspace succeeds gracefully via in-memory and local fallbacks');

  // CRITICAL SECURITY ASSERTION: Must NOT be marked as verified when idbSet failed!
  assert.equal(isWorkspaceKeyVerifiedInIdb(expectedKey), false, 'Failed idbSet must NEVER mark workspace key as verified');

  // Verify that LocalStorage holds the payload
  const localCopy = mockLocal.getItem(expectedKey);
  assert.ok(localCopy, 'LocalStorage must hold the workspace copy');

  // Quota pressure eviction runs synchronously
  const freedSync = evictVerifiedLocalStorageBlobsSync();
  assert.equal(freedSync, 0, 'Synchronous quota eviction MUST NOT delete unverified workspace key');
  assert.ok(mockLocal.getItem(expectedKey), 'LocalStorage workspace copy MUST remain intact under quota pressure');

  // Asynchronous eviction also attempts verification and fails safely
  const freedAsync = await evictVerifiedWorkspaceBlobs();
  assert.equal(freedAsync, 0, 'Asynchronous eviction must also refuse to delete unverified key');
  assert.ok(mockLocal.getItem(expectedKey), 'LocalStorage workspace copy MUST remain intact');

  // 2. Positive verification path: Reset mock to succeed
  mockIdbDb!.shouldAbortTransaction = false;
  mockIdbDb!.shouldFailTransaction = false;

  const wsSuccessId = 'ws_success_durability_test';
  const expectedSuccessKey = 'aira_workspace_synced_v1_guest_ws_success_durability_test';

  const successResult = await syncBundleToWorkspace(bundle, wsSuccessId);
  assert.equal(successResult.success, true);

  // Positive assertion: With successful write + read-back, hash is registered
  assert.equal(isWorkspaceKeyVerifiedInIdb(expectedSuccessKey), true, 'Successful committed write + read-back must register verified hash');

  // Now synchronous quota eviction safely cleans up the verified key
  const freedSuccess = evictVerifiedLocalStorageBlobsSync();
  assert.equal(freedSuccess, 1, 'Verified key can be safely evicted to relieve quota pressure');
});

test('[Regression: UI Project Deletion & Stale Reconciliation Lifecycle] Real application project deletion records tombstones and prevents resurrection across restarts', async () => {
  // 1. Seed a project P1 in storage (simulating active user workspace)
    const proj1 = {
      id: 'p-ui-lifecycle-1',
      name: 'Executive Dashboard',
      description: 'Mission critical project',
      instructions: 'TypeScript only',
      docs: [{ id: 'd-1', name: 'readme.md', content: '# Docs', size: '10', createdAt: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    };
    saveProjects([proj1]);
    await idbSet(STORES.PROJECTS, 'projects', [proj1]);

    // Verify project is loaded into memory and persistent stores
    const initialLoad = await hydrateProjectsFromIndexedDb();
    assert.ok(initialLoad !== null);
    assert.equal(initialLoad!.some(p => p.id === 'p-ui-lifecycle-1'), true, 'Project must exist before deletion');

    // 2. Execute application project deletion (the exact handler wired in App.tsx: handleDeleteProject)
    deleteProjectRecord('p-ui-lifecycle-1');

    // Verify tombstone is recorded
    assert.ok(isEntityDeleted('p-ui-lifecycle-1', 'project'), 'Tombstone must be recorded for deleted project');

    // Verify immediate in-memory and LocalStorage state is cleared
    const afterDeleteProjects = loadProjects();
    assert.equal(afterDeleteProjects.some(p => p.id === 'p-ui-lifecycle-1'), false, 'Project must be removed from local store');

    // 3. Stale IndexedDB synchronization scenario:
    // Another tab, background worker, or stale replica contains proj1
    const staleIdbProjects = [proj1];

    // Reconcile against stale IndexedDB data
    const reconciled = reconcileProjects([], staleIdbProjects);
    assert.equal(reconciled.length, 0, 'Tombstone MUST prevent stale IndexedDB project from being resurrected');

    // 4. Simulate complete browser restart:
    // Reset in-memory cache, leaving only on-disk LocalStorage & IndexedDB
    resetStorageForTesting();

    // Re-hydrate from storage
  const rehydrated = await hydrateProjectsFromIndexedDb();
  assert.ok(rehydrated !== null);
  assert.equal(rehydrated!.some(p => p.id === 'p-ui-lifecycle-1'), false, 'Project must remain deleted across complete browser restart');
});

test('[Regression: Truthful Durability Failure Reporting] syncBundleToWorkspace returns success: false and durable: false when both IndexedDB and LocalStorage fail', async () => {
  const bundle = createMultiFileBundle({
    id: 'bundle-dual-fail-test',
    title: 'Dual Failure Test',
    entryPoint: 'index.html',
    files: [
      { path: 'index.html', content: '<h1>Sync Content</h1>' }
    ]
  });

  const wsId = 'ws_dual_fail_test';
  const expectedKey = 'aira_workspace_synced_v1_guest_ws_dual_fail_test';

  // 1. Force idbSet to fail via transaction abort
  mockIdbDb!.shouldAbortTransaction = true;

  // 2. Force LocalStorage to fail (simulate quota exceeded or blocked storage)
  const originalSetItem = mockLocal.setItem;
  mockLocal.setItem = () => {
    const quotaErr = new Error('QuotaExceededError');
    quotaErr.name = 'QuotaExceededError';
    throw quotaErr;
  };

  try {
    const result = await syncBundleToWorkspace(bundle, wsId);
    assert.equal(result.success, false, 'syncBundleToWorkspace MUST report success: false when durable persistence fails');
    assert.equal(result.durable, false, 'Must report durable: false');
    assert.equal(result.persistenceTier, 'memory-only', 'Must report persistenceTier: memory-only');
    assert.ok(result.error?.includes('Durable storage unavailable'), 'Must truthfully report durable storage unavailable');

    // Never mark as verified
    assert.equal(isWorkspaceKeyVerifiedInIdb(expectedKey), false);
  } finally {
    mockLocal.setItem = originalSetItem;
    mockIdbDb!.shouldAbortTransaction = false;
  }
});

after(() => {
  setTimeout(() => process.exit(0), 100).unref();
});
