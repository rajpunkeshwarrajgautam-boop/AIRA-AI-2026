import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '../src/types';

// ============================================================================
// MOCK ENVIRONMENT FOR STORAGE REGRESSION SUITE
// Provides complete polyfills for LocalStorage and IndexedDB in Node.js
// ============================================================================

class MockLocalStorage {
  public store = new Map<string, string>();
  public shouldFailOnKey: string | null = null;
  public failCount = 0;

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.shouldFailOnKey && (key === this.shouldFailOnKey || this.shouldFailOnKey === '*')) {
      this.failCount++;
      const err = new Error(`QuotaExceededError: Setting '${key}' exceeded storage quota.`);
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  get length(): number {
    return this.store.size;
  }
}

class MockIDBRequest {
  public result: any = null;
  public error: any = null;
  public onsuccess: ((e: any) => void) | null = null;
  public onerror: ((e: any) => void) | null = null;
  public onupgradeneeded: ((e: any) => void) | null = null;
  public onblocked: ((e: any) => void) | null = null;

  triggerSuccess(result?: any) {
    if (result !== undefined) this.result = result;
    if (this.onsuccess) {
      this.onsuccess({ target: this });
    }
  }

  triggerError(error?: any) {
    this.error = error || new Error('IDBRequest error');
    if (this.onerror) {
      this.onerror({ target: this });
    }
  }
}

class MockIDBObjectStore {
  constructor(
    public name: string,
    public storageMap: Map<string, any>,
    public parentTx: MockIDBTransaction
  ) {}

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      if (this.parentTx.shouldFailGet) {
        req.triggerError(new Error('IDB read error'));
      } else {
        try {
          const val = this.storageMap.get(key);
          req.triggerSuccess(val !== undefined ? structuredClone(val) : null);
        } catch (err) {
          req.triggerError(err);
        }
      }
    });
    return req;
  }

  put(value: any, key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      if (this.parentTx.shouldAbortPut) {
        this.parentTx.abort();
      } else if (this.parentTx.shouldFailPut) {
        req.triggerError(new Error('IDB write error'));
      } else {
        try {
          this.storageMap.set(key, structuredClone(value));
          req.triggerSuccess(true);
        } catch (err) {
          req.triggerError(err);
        }
      }
    });
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      this.storageMap.delete(key);
      req.triggerSuccess(true);
    });
    return req;
  }
}

class MockIDBTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: ((e: any) => void) | null = null;
  public onabort: (() => void) | null = null;
  public shouldAbortPut = false;
  public shouldFailPut = false;
  public shouldFailGet = false;

  constructor(
    public db: MockIDBDatabase,
    public storeName: string,
    public mode: string
  ) {}

  objectStore(name: string): MockIDBObjectStore {
    const storeMap = this.db.getStoreMap(name);
    return new MockIDBObjectStore(name, storeMap, this);
  }

  abort(): void {
    if (this.onabort) {
      this.onabort();
    }
  }
}

class MockIDBDatabase {
  public stores = new Map<string, Map<string, any>>();
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  };

  createObjectStore(name: string) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
  }

  getStoreMap(name: string): Map<string, any> {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return this.stores.get(name)!;
  }

  transaction(storeName: string, mode: string): MockIDBTransaction {
    return new MockIDBTransaction(this, storeName, mode);
  }
}

class MockIndexedDBFactory {
  public currentDb = new MockIDBDatabase();
  public shouldFailOpen = false;

  open(_name: string, _version?: number): MockIDBRequest {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      if (this.shouldFailOpen) {
        req.triggerError(new Error('IndexedDB open blocked'));
        return;
      }
      req.result = this.currentDb;
      if (req.onupgradeneeded) {
        req.onupgradeneeded({ target: { result: this.currentDb } });
      }
      req.triggerSuccess(this.currentDb);
    });
    return req;
  }
}

// Attach browser globals before importing storage modules
const mockStorage = new MockLocalStorage();
const mockIndexedDb = new MockIndexedDBFactory();

(globalThis as any).localStorage = mockStorage;
(globalThis as any).sessionStorage = new MockLocalStorage();
(globalThis as any).window = {
  localStorage: mockStorage,
  sessionStorage: (globalThis as any).sessionStorage,
  indexedDB: mockIndexedDb,
};

// Dynamically import storage modules
const {
  saveProjects,
  loadProjects,
  hydrateProjectsFromIndexedDb,
  getProjectsStorageKey,
  exportAllStorageData,
} = await import('../src/utils/storage.js');

const {
  idbGet,
  idbSet,
  STORES,
  resetDbConnectionForTesting
} = await import('../src/utils/indexedDbStorage.js');

// ============================================================================
// 12-POINT DETERMINISTIC STORAGE REGRESSION TEST SUITE (ORIGINAL_REQUEST.md §2)
// ============================================================================

test('1. Repeated loadProjects() calls with an empty cached array', () => {
  const userId = 'user-empty-cache-test';

  // 1st synchronous call
  const p1 = loadProjects(userId);
  assert.ok(Array.isArray(p1), 'First call must return an array');
  assert.equal(p1.length, 0, 'First call with empty store must have length 0');

  // 2nd synchronous call (reads from cache)
  const p2 = loadProjects(userId);
  assert.ok(Array.isArray(p2), 'Second call must return an array');
  assert.equal(p2.length, 0, 'Second call from cache must have length 0');

  // Repeated synchronous calls in loop
  for (let i = 0; i < 5; i++) {
    const pLoop = loadProjects(userId);
    assert.ok(Array.isArray(pLoop), `Call ${i + 3} must return an array`);
    assert.equal(pLoop.length, 0, `Call ${i + 3} must have length 0`);
    assert.deepEqual(pLoop.map(p => p.id), [], 'Array mapping must work');
    assert.deepEqual(pLoop.filter(Boolean), [], 'Array filtering must work');
  }
});

test('2. Repeated calls with populated project arrays', () => {
  const userId = 'user-pop-cache-test';
  const projects: Project[] = [
    {
      id: 'proj-pop-1',
      name: 'Populated Alpha',
      description: 'Alpha description',
      instructions: 'Alpha instructions',
      docs: [
        {
          id: 'doc-alpha-1',
          name: 'alpha-doc.md',
          content: '# Alpha Doc',
          size: '11 B',
          createdAt: 1700000000000,
        }
      ],
      createdAt: 1700000000000,
    },
    {
      id: 'proj-pop-2',
      name: 'Populated Beta',
      description: 'Beta description',
      instructions: 'Beta instructions',
      docs: [],
      createdAt: 1700000001000,
    }
  ];

  saveProjects(projects, userId);

  // 1st call
  const loaded1 = loadProjects(userId);
  assert.ok(Array.isArray(loaded1), 'Must return an array');
  assert.equal(loaded1.length, 2, 'Must have 2 projects');
  assert.equal(loaded1[0].id, 'proj-pop-1');
  assert.equal(loaded1[0].docs.length, 1);
  assert.equal(loaded1[1].id, 'proj-pop-2');

  // 2nd call (cached)
  const loaded2 = loadProjects(userId);
  assert.ok(Array.isArray(loaded2), 'Must return an array');
  assert.equal(loaded2.length, 2, 'Must retain 2 projects on second call');
  assert.equal(loaded2[0].name, 'Populated Alpha');

  // Repeated calls in loop
  for (let i = 0; i < 5; i++) {
    const loopProjects = loadProjects(userId);
    assert.equal(loopProjects.length, 2);
    assert.equal(loopProjects[0].id, 'proj-pop-1');
    assert.equal(loopProjects[1].id, 'proj-pop-2');
  }
});

test('3. Promise.resolve(loadProjects()) completing successfully', { timeout: 10000 }, () => {
  const storageUrl = pathToFileURL(path.resolve('src/utils/storage.ts')).href;
  const childScript = `
class MockLocalStorage {
  public store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  get length(): number { return this.store.size; }
}

(globalThis as any).localStorage = new MockLocalStorage();
(globalThis as any).sessionStorage = new MockLocalStorage();
(globalThis as any).window = {
  localStorage: (globalThis as any).localStorage,
  sessionStorage: (globalThis as any).sessionStorage
};

const { loadProjects, saveProjects } = await import('${storageUrl}');

const userId = 'child-user-resolve-scenario-3';
saveProjects([{
  id: 'child-p-res-1',
  name: 'Promise Resolve Test',
  description: '',
  instructions: '',
  docs: [],
  createdAt: Date.now()
}], userId);

// 1st synchronous call
loadProjects(userId);
// 2nd synchronous call (causes thenable recursion on buggy code)
loadProjects(userId);

// Keep event loop active while awaiting resolution
const timer = setInterval(() => {}, 1000);

// Scenario 3: Promise.resolve(loadProjects())
const resolved = await Promise.resolve(loadProjects(userId));

clearInterval(timer);
if (!Array.isArray(resolved) || resolved.length !== 1) {
  process.exit(2);
}
console.log('PROMISE_RESOLVE_COMPLETED_SUCCESS');
process.exit(0);
`;

  const res = spawnSync(process.execPath, ['--import', 'tsx'], {
    input: childScript,
    encoding: 'utf8',
    timeout: 3000,
  });

  const timedOut = Boolean(res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM' || res.status === null);
  if (timedOut) {
    assert.fail('Detected microtask queue deadlock / thenable assimilation starvation');
  }
  assert.equal(res.status, 0, `Child process exited with non-zero status: ${res.status}, stderr: ${res.stderr}`);
  assert.match(res.stdout, /PROMISE_RESOLVE_COMPLETED_SUCCESS/);
});

test('4. await loadProjects() completing without microtask starvation', { timeout: 10000 }, () => {
  const storageUrl = pathToFileURL(path.resolve('src/utils/storage.ts')).href;
  const childScript = `
class MockLocalStorage {
  public store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  get length(): number { return this.store.size; }
}

(globalThis as any).localStorage = new MockLocalStorage();
(globalThis as any).sessionStorage = new MockLocalStorage();
(globalThis as any).window = {
  localStorage: (globalThis as any).localStorage,
  sessionStorage: (globalThis as any).sessionStorage
};

const { loadProjects, saveProjects } = await import('${storageUrl}');

const userId = 'child-user-await-scenario-4';
saveProjects([{
  id: 'child-p-await-1',
  name: 'Await Microtask Test',
  description: '',
  instructions: '',
  docs: [],
  createdAt: Date.now()
}], userId);

// 1st synchronous call
loadProjects(userId);
// 2nd synchronous call (causes thenable recursion on buggy code)
loadProjects(userId);

// Keep event loop active while awaiting resolution
const timer = setInterval(() => {}, 1000);

// Scenario 4: await loadProjects()
const awaited = await loadProjects(userId);

clearInterval(timer);
if (!Array.isArray(awaited) || awaited.length !== 1) {
  process.exit(2);
}
console.log('AWAIT_COMPLETED_SUCCESS');
process.exit(0);
`;

  const res = spawnSync(process.execPath, ['--import', 'tsx'], {
    input: childScript,
    encoding: 'utf8',
    timeout: 3000,
  });

  const timedOut = Boolean(res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM' || res.status === null);
  if (timedOut) {
    assert.fail('Detected microtask queue deadlock / thenable assimilation starvation');
  }
  assert.equal(res.status, 0, `Child process exited with non-zero status: ${res.status}, stderr: ${res.stderr}`);
  assert.match(res.stdout, /AWAIT_COMPLETED_SUCCESS/);
});

test('5. Repeated hydration from IndexedDB', async () => {
  const userId = 'user-idb-repeat-hydrate';
  const key = getProjectsStorageKey(userId);

  const idbProjects: Project[] = [
    {
      id: 'proj-idb-5',
      name: 'IndexedDB Durable 5',
      description: 'Stored in IDB store',
      instructions: '',
      docs: [],
      createdAt: 50000000,
    }
  ];

  await idbSet(STORES.PROJECTS, key, idbProjects);

  // 1st hydration call
  const h1 = await hydrateProjectsFromIndexedDb(userId);
  assert.ok(h1, 'Hydration 1 must return project array');
  assert.equal(h1.length, 1);
  assert.equal(h1[0].id, 'proj-idb-5');

  // Verify memory cache is populated
  const sync1 = loadProjects(userId);
  assert.equal(sync1.length, 1);
  assert.equal(sync1[0].id, 'proj-idb-5');

  // 2nd hydration call
  const h2 = await hydrateProjectsFromIndexedDb(userId);
  assert.ok(h2, 'Hydration 2 must return project array');
  assert.equal(h2.length, 1);
  assert.equal(h2[0].id, 'proj-idb-5');

  // 3rd hydration call
  const h3 = await hydrateProjectsFromIndexedDb(userId);
  assert.ok(h3, 'Hydration 3 must return project array');
  assert.equal(h3.length, 1);
  assert.equal(h3[0].id, 'proj-idb-5');
});

test('6. Concurrent asynchronous hydration and synchronous reads', async () => {
  const userId = 'user-conc-reads-6';
  const key = getProjectsStorageKey(userId);

  // LocalStorage has version 1
  const v1Projects: Project[] = [{
    id: 'p-conc-6',
    name: 'Version 1 LocalStorage',
    description: 'v1',
    instructions: '',
    docs: [],
    createdAt: 1000
  }];
  mockStorage.setItem(key, JSON.stringify(v1Projects));

  // IndexedDB has version 2
  const v2Projects: Project[] = [{
    id: 'p-conc-6',
    name: 'Version 2 IndexedDB',
    description: 'v2',
    instructions: '',
    docs: [],
    createdAt: 2000
  }];
  await idbSet(STORES.PROJECTS, key, v2Projects);

  // Synchronous read before hydration starts
  const syncBefore = loadProjects(userId);
  assert.equal(syncBefore.length, 1);
  assert.equal(syncBefore[0].name, 'Version 1 LocalStorage');

  // Trigger background asynchronous hydration
  const hydrationPromise = hydrateProjectsFromIndexedDb(userId);

  // Concurrent synchronous reads while hydration is pending
  const readsDuring: Project[][] = [];
  for (let i = 0; i < 5; i++) {
    readsDuring.push(loadProjects(userId));
  }
  for (const r of readsDuring) {
    assert.ok(Array.isArray(r), 'Concurrent sync read must return an array');
    assert.equal(r.length, 1);
  }

  // Await hydration completion
  const hydratedResult = await hydrationPromise;
  assert.ok(hydratedResult);
  assert.equal(hydratedResult[0].name, 'Version 2 IndexedDB');

  // Synchronous read after hydration reflects newly hydrated state
  const syncAfter = loadProjects(userId);
  assert.equal(syncAfter.length, 1);
  assert.equal(syncAfter[0].name, 'Version 2 IndexedDB');
});

test('7. Switching Account A -> Account B -> Account A', async () => {
  const userA = 'user-switch-a';
  const userB = 'user-switch-b';

  const projA: Project[] = [{
    id: 'proj-switch-a1',
    name: 'Project Account A',
    description: 'Owned strictly by user A',
    instructions: '',
    docs: [],
    createdAt: 100000
  }];

  const projB: Project[] = [{
    id: 'proj-switch-b1',
    name: 'Project Account B',
    description: 'Owned strictly by user B',
    instructions: '',
    docs: [],
    createdAt: 200000
  }];

  // Save Account A projects
  saveProjects(projA, userA);
  // Save Account B projects
  saveProjects(projB, userB);
  await new Promise(r => setTimeout(r, 20));

  // Read Account A
  const loadedA1 = loadProjects(userA);
  assert.equal(loadedA1.length, 1);
  assert.equal(loadedA1[0].id, 'proj-switch-a1');
  assert.equal(loadedA1[0].name, 'Project Account A');

  // Switch to Account B
  const loadedB = loadProjects(userB);
  assert.equal(loadedB.length, 1);
  assert.equal(loadedB[0].id, 'proj-switch-b1');
  assert.equal(loadedB[0].name, 'Project Account B');

  // Switch back to Account A
  const loadedA2 = loadProjects(userA);
  assert.equal(loadedA2.length, 1);
  assert.equal(loadedA2[0].id, 'proj-switch-a1');
  assert.equal(loadedA2[0].name, 'Project Account A');

  // Check IndexedDB storage separation
  const keyA = getProjectsStorageKey(userA);
  const keyB = getProjectsStorageKey(userB);
  const idbA = await idbGet<Project[]>(STORES.PROJECTS, keyA);
  const idbB = await idbGet<Project[]>(STORES.PROJECTS, keyB);
  assert.equal(idbA?.[0].id, 'proj-switch-a1');
  assert.equal(idbB?.[0].id, 'proj-switch-b1');
});

test('8. Guest -> authenticated -> guest transitions', () => {
  const guestProj: Project[] = [{
    id: 'proj-guest-initial',
    name: 'Guest Workspace Project',
    description: 'Public unauthenticated project',
    instructions: '',
    docs: [],
    createdAt: 1000
  }];

  const authProj: Project[] = [{
    id: 'proj-auth-user',
    name: 'Authenticated User Project',
    description: 'Private user project',
    instructions: '',
    docs: [],
    createdAt: 2000
  }];

  const authUserId = 'user-auth-transition-8';

  // 1. Initial guest mode
  saveProjects(guestProj, undefined);
  const loadedGuest1 = loadProjects();
  assert.equal(loadedGuest1.length, 1);
  assert.equal(loadedGuest1[0].id, 'proj-guest-initial');

  // 2. User logs in (authenticated transition)
  saveProjects(authProj, authUserId);
  const loadedAuth = loadProjects(authUserId);
  assert.equal(loadedAuth.length, 1);
  assert.equal(loadedAuth[0].id, 'proj-auth-user');

  // Verify guest storage is untouched while user is logged in
  const guestCheck = loadProjects();
  assert.equal(guestCheck.length, 1);
  assert.equal(guestCheck[0].id, 'proj-guest-initial');

  // 3. User logs out (transition back to guest)
  const loadedGuest2 = loadProjects(undefined);
  assert.equal(loadedGuest2.length, 1);
  assert.equal(loadedGuest2[0].id, 'proj-guest-initial');
  assert.notEqual(loadedGuest2[0].id, 'proj-auth-user', 'Guest state must never contain authenticated project');
});

test('9. Project updates and deletions during account changes', async () => {
  const userA = 'user-mut-a';
  const userB = 'user-mut-b';

  const initialA: Project[] = [
    { id: 'p-a-keep', name: 'Project A Keep', description: '', instructions: '', docs: [], createdAt: 100 },
    { id: 'p-a-delete', name: 'Project A Delete', description: '', instructions: '', docs: [], createdAt: 200 },
  ];
  const initialB: Project[] = [
    { id: 'p-b-safe', name: 'Project B Safe', description: '', instructions: '', docs: [], createdAt: 300 },
  ];

  saveProjects(initialA, userA);
  saveProjects(initialB, userB);
  await new Promise(r => setTimeout(r, 20));

  // Update Project A: mutate 'p-a-keep' (rename and add document) and delete 'p-a-delete'
  const updatedA: Project[] = [
    {
      id: 'p-a-keep',
      name: 'Project A Updated Title',
      description: 'Modified during session',
      instructions: 'Updated instructions',
      docs: [{ id: 'doc-new', name: 'notes.txt', content: 'Updated notes', size: '13 B', createdAt: 400 }],
      createdAt: 100,
    }
  ];
  saveProjects(updatedA, userA);
  await new Promise(r => setTimeout(r, 20));

  // Verify User A reflects update and deletion
  const checkA = loadProjects(userA);
  assert.equal(checkA.length, 1);
  assert.equal(checkA[0].id, 'p-a-keep');
  assert.equal(checkA[0].name, 'Project A Updated Title');
  assert.equal(checkA[0].docs.length, 1);
  assert.ok(!checkA.some(p => p.id === 'p-a-delete'), 'Deleted project must not exist');

  // Switch to User B: confirm B is intact
  const checkB = loadProjects(userB);
  assert.equal(checkB.length, 1);
  assert.equal(checkB[0].id, 'p-b-safe');
  assert.equal(checkB[0].name, 'Project B Safe');

  // Switch back to User A
  const checkA2 = loadProjects(userA);
  assert.equal(checkA2.length, 1);
  assert.equal(checkA2[0].name, 'Project A Updated Title');

  // Check IndexedDB persistence for User A
  const keyA = getProjectsStorageKey(userA);
  const idbDataA = await idbGet<Project[]>(STORES.PROJECTS, keyA);
  assert.ok(idbDataA);
  assert.equal(idbDataA.length, 1);
  assert.equal(idbDataA[0].id, 'p-a-keep');
  assert.equal(idbDataA[0].name, 'Project A Updated Title');
});

test('10. Browser reload and cold browser restart persistence', { timeout: 10000 }, async () => {
  const userId = 'user-cold-restart-10';
  const key = getProjectsStorageKey(userId);

  const durableProject: Project = {
    id: 'proj-restart-durable',
    name: 'Cold Restart Durable Project',
    description: 'Survives browser reload and cold process restart',
    instructions: 'Comprehensive instruction set for durable storage',
    docs: [
      {
        id: 'doc-durable-1',
        name: 'spec.md',
        content: '# Cold Restart Verification\nNested markdown content intact.',
        size: '56 B',
        createdAt: 1700000000000,
      },
      {
        id: 'doc-durable-2',
        name: 'config.json',
        content: '{"persistence": "verified"}',
        size: '27 B',
        createdAt: 1700000001000,
      }
    ],
    createdAt: 1700000000000,
  };

  saveProjects([durableProject], userId);
  await new Promise(r => setTimeout(r, 20));

  // 1. Verify LocalStorage contains serialized project with exact nested docs
  const rawLs = mockStorage.getItem(key);
  assert.ok(rawLs, 'LocalStorage must hold serialized project');
  const parsedLs = JSON.parse(rawLs);
  assert.equal(parsedLs.length, 1);
  assert.equal(parsedLs[0].name, durableProject.name);
  assert.equal(parsedLs[0].docs.length, 2);
  assert.equal(parsedLs[0].docs[0].content, durableProject.docs[0].content);

  // 2. Verify IndexedDB contains exact clone
  const idbRecord = await idbGet<Project[]>(STORES.PROJECTS, key);
  assert.ok(idbRecord, 'IndexedDB must hold durable project');
  assert.equal(idbRecord.length, 1);
  assert.deepEqual(idbRecord[0].docs, durableProject.docs);

  // 3. Cold browser restart simulation:
  // Execute a separate, isolated node child process with fresh module loader
  // that initializes its own memory space from the seeded LocalStorage
  const storageUrl = pathToFileURL(path.resolve('src/utils/storage.ts')).href;
  const childScript = `
class MockLocalStorage {
  public store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  get length(): number { return this.store.size; }
}

const mockLs = new MockLocalStorage();
mockLs.setItem('${key}', ${JSON.stringify(rawLs)});

(globalThis as any).localStorage = mockLs;
(globalThis as any).sessionStorage = new MockLocalStorage();
(globalThis as any).window = {
  localStorage: mockLs,
  sessionStorage: (globalThis as any).sessionStorage
};

// Cold process import (no pre-existing in-memory cache)
const { loadProjects } = await import('${storageUrl}');

// Cold synchronous read (must restore from LocalStorage)
const restored = loadProjects('${userId}');
if (!Array.isArray(restored) || restored.length !== 1) {
  console.error('Cold start loadProjects returned invalid array');
  process.exit(2);
}
if (restored[0].id !== '${durableProject.id}' || restored[0].docs.length !== 2) {
  console.error('Cold start data mismatch');
  process.exit(3);
}
if (restored[0].docs[0].content !== ${JSON.stringify(durableProject.docs[0].content)}) {
  console.error('Cold start doc content mismatch');
  process.exit(4);
}

console.log('COLD_RESTART_RESTORED_OK');
process.exit(0);
`;

  const childRes = spawnSync(process.execPath, ['--import', 'tsx'], {
    input: childScript,
    encoding: 'utf8',
    timeout: 3000,
  });

  assert.equal(childRes.status, 0, `Cold restart child process failed: ${childRes.stderr}`);
  assert.match(childRes.stdout, /COLD_RESTART_RESTORED_OK/);
});

test('11. IndexedDB failures and LocalStorage fallback', async () => {
  const userId = 'user-fallback-test-11';
  const key = getProjectsStorageKey(userId);

  const fallbackProj: Project[] = [{
    id: 'p-fallback-11',
    name: 'Fallback Project',
    description: 'Saves even when IndexedDB fails',
    instructions: '',
    docs: [],
    createdAt: 12345
  }];

  // Seed IndexedDB failure
  mockIndexedDb.shouldFailOpen = true;
  resetDbConnectionForTesting();

  try {
    // saveProjects must not throw synchronously or crash on IDB failure
    saveProjects(fallbackProj, userId);

    // LocalStorage must still receive the project data
    const raw = mockStorage.getItem(key);
    assert.ok(raw, 'LocalStorage must receive data even when IndexedDB fails');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'Fallback Project');

    // Synchronous loadProjects works cleanly via LocalStorage fallback
    const syncLoaded = loadProjects(userId);
    assert.ok(Array.isArray(syncLoaded));
    assert.equal(syncLoaded.length, 1);
    assert.equal(syncLoaded[0].name, 'Fallback Project');
  } finally {
    // Restore IndexedDB mock
    mockIndexedDb.shouldFailOpen = false;
    resetDbConnectionForTesting();
  }
});

test('12. Existing user-scoped project data remaining accessible without cross-account leakage', async () => {
  const userAlpha = 'user-alpha-tenant';
  const userBeta = 'user-beta-tenant';
  const userGamma = 'user-gamma-tenant';

  const projAlpha: Project[] = [{
    id: 'p-alpha',
    name: 'Project Alpha Confidential',
    description: 'Secret Alpha Data: ALPHA_TOKEN_XYZ_111',
    instructions: '',
    docs: [{ id: 'd-a', name: 'secret-a.txt', content: 'ALPHA_SECRET_PAYLOAD', size: '20 B', createdAt: 100 }],
    createdAt: 100,
  }];

  const projBeta: Project[] = [{
    id: 'p-beta',
    name: 'Project Beta Confidential',
    description: 'Secret Beta Data: BETA_TOKEN_UVW_222',
    instructions: '',
    docs: [{ id: 'd-b', name: 'secret-b.txt', content: 'BETA_SECRET_PAYLOAD', size: '19 B', createdAt: 200 }],
    createdAt: 200,
  }];

  const projGamma: Project[] = [{
    id: 'p-gamma',
    name: 'Project Gamma Confidential',
    description: 'Secret Gamma Data: GAMMA_TOKEN_RST_333',
    instructions: '',
    docs: [{ id: 'd-g', name: 'secret-g.txt', content: 'GAMMA_SECRET_PAYLOAD', size: '20 B', createdAt: 300 }],
    createdAt: 300,
  }];

  const projGuest: Project[] = [{
    id: 'p-guest-pub',
    name: 'Guest Public Project',
    description: 'Public guest data: GUEST_DATA_OPEN',
    instructions: '',
    docs: [],
    createdAt: 400,
  }];

  // Save all distinct tenant projects
  saveProjects(projAlpha, userAlpha);
  saveProjects(projBeta, userBeta);
  saveProjects(projGamma, userGamma);
  saveProjects(projGuest, undefined);
  await new Promise(r => setTimeout(r, 20));

  // 1. Validate Alpha isolation
  const alphaProjects = loadProjects(userAlpha);
  const alphaJson = JSON.stringify(alphaProjects);
  assert.equal(alphaProjects.length, 1);
  assert.ok(alphaJson.includes('ALPHA_SECRET_PAYLOAD'));
  assert.ok(!alphaJson.includes('BETA_SECRET_PAYLOAD'), 'Alpha must not contain Beta secrets');
  assert.ok(!alphaJson.includes('GAMMA_SECRET_PAYLOAD'), 'Alpha must not contain Gamma secrets');
  assert.ok(!alphaJson.includes('GUEST_DATA_OPEN'), 'Alpha must not contain Guest data');

  // 2. Validate Beta isolation
  const betaProjects = loadProjects(userBeta);
  const betaJson = JSON.stringify(betaProjects);
  assert.equal(betaProjects.length, 1);
  assert.ok(betaJson.includes('BETA_SECRET_PAYLOAD'));
  assert.ok(!betaJson.includes('ALPHA_SECRET_PAYLOAD'), 'Beta must not contain Alpha secrets');
  assert.ok(!betaJson.includes('GAMMA_SECRET_PAYLOAD'), 'Beta must not contain Gamma secrets');
  assert.ok(!betaJson.includes('GUEST_DATA_OPEN'), 'Beta must not contain Guest data');

  // 3. Validate Gamma isolation
  const gammaProjects = loadProjects(userGamma);
  const gammaJson = JSON.stringify(gammaProjects);
  assert.equal(gammaProjects.length, 1);
  assert.ok(gammaJson.includes('GAMMA_SECRET_PAYLOAD'));
  assert.ok(!gammaJson.includes('ALPHA_SECRET_PAYLOAD'), 'Gamma must not contain Alpha secrets');
  assert.ok(!gammaJson.includes('BETA_SECRET_PAYLOAD'), 'Gamma must not contain Beta secrets');
  assert.ok(!gammaJson.includes('GUEST_DATA_OPEN'), 'Gamma must not contain Guest data');

  // 4. Validate Guest isolation
  const guestProjects = loadProjects();
  const guestJson = JSON.stringify(guestProjects);
  assert.equal(guestProjects.length, 1);
  assert.ok(guestJson.includes('GUEST_DATA_OPEN'));
  assert.ok(!guestJson.includes('ALPHA_SECRET_PAYLOAD'), 'Guest must not contain Alpha secrets');
  assert.ok(!guestJson.includes('BETA_SECRET_PAYLOAD'), 'Guest must not contain Beta secrets');
  assert.ok(!guestJson.includes('GAMMA_SECRET_PAYLOAD'), 'Guest must not contain Gamma secrets');

  // 5. Validate Disaster Recovery Export partition fidelity
  const exported = exportAllStorageData();
  const exportParsed = JSON.parse(exported);
  assert.ok(exportParsed.projectsByUser, 'Export must have projectsByUser partition');

  const alphaKey = getProjectsStorageKey(userAlpha);
  const betaKey = getProjectsStorageKey(userBeta);
  const gammaKey = getProjectsStorageKey(userGamma);

  assert.equal(exportParsed.projectsByUser[alphaKey][0].id, 'p-alpha');
  assert.equal(exportParsed.projectsByUser[betaKey][0].id, 'p-beta');
  assert.equal(exportParsed.projectsByUser[gammaKey][0].id, 'p-gamma');
  assert.equal(exportParsed.projects[0].id, 'p-guest-pub');
});
