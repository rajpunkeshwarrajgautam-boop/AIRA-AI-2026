import test from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage environment
class MockLocalStorage {
  public store = new Map<string, string>();
  public shouldFailOnKey: string | null = null;
  public failCount = 0;

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.shouldFailOnKey && key === this.shouldFailOnKey) {
      this.failCount++;
      const err = new Error(`QuotaExceededError: Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`);
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

const mockStorage = new MockLocalStorage();
(globalThis as any).localStorage = mockStorage;
(globalThis as any).sessionStorage = new MockLocalStorage();

// Dynamically import storage after localStorage polyfill
const {
  loadConversations,
  saveConversations,
  loadSettings,
  saveSettings,
  saveProjects,
  exportAllStorageData,
  getStorageHealth,
} = await import('../src/utils/storage.js');

test.beforeEach(() => {
  mockStorage.clear();
  mockStorage.shouldFailOnKey = null;
  mockStorage.failCount = 0;
});

test('[Storage Normal] Saves and loads conversations normally', async () => {
  const convs = [
    {
      id: 'c-1',
      title: 'First Chat',
      messages: [{ id: 'm-1', role: 'user' as const, content: 'Hello', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  saveConversations(convs);
  const loaded = loadConversations();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'c-1');
  assert.equal(loaded[0].messages[0].content, 'Hello');
});

test('[Storage Isolation] Distinct users have strictly isolated conversation namespaces', async () => {
  const userAConv = [
    {
      id: 'c-user-a',
      title: 'User A Chat',
      messages: [{ id: 'm-a', role: 'user' as const, content: 'User A Private', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const userBConv = [
    {
      id: 'c-user-b',
      title: 'User B Chat',
      messages: [{ id: 'm-b', role: 'user' as const, content: 'User B Private', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  // Save for user A
  saveConversations(userAConv, 'usr_alpha');
  // Save for user B
  saveConversations(userBConv, 'usr_beta');

  // Verify user A cannot see user B
  const loadedA = loadConversations('usr_alpha');
  const loadedB = loadConversations('usr_beta');

  assert.equal(loadedA.length, 1);
  assert.equal(loadedA[0].id, 'c-user-a');
  assert.equal(loadedB.length, 1);
  assert.equal(loadedB[0].id, 'c-user-b');
});

test('[Storage Quota] Handles QuotaExceededError gracefully without dropping in-memory data', async () => {
  const convs = [
    {
      id: 'c-heavy',
      title: 'Heavy Payload Chat',
      messages: [
        { id: 'm-1', role: 'user' as const, content: 'A'.repeat(5000), timestamp: Date.now() },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  // Force QuotaExceededError on conversations save
  mockStorage.shouldFailOnKey = 'aira_conversations_v1';

  // Saving should NOT throw an uncaught exception
  assert.doesNotThrow(() => {
    saveConversations(convs);
  });

  // Verify that in-memory cache still returns the latest data even when localStorage threw
  const inMemoryRecovered = loadConversations();
  assert.equal(inMemoryRecovered.length, 1);
  assert.equal(inMemoryRecovered[0].id, 'c-heavy');
  assert.equal(inMemoryRecovered[0].messages[0].content.length, 5000);

  // Health report should indicate quota timestamp was recorded
  const health = getStorageHealth();
  assert.ok((health.lastQuotaErrorAt ?? 0) > 0, 'Quota error timestamp recorded in health state');
});

test('[Settings Quota Recovery] saveSettings evicts legacy blobs and retries safely under quota pressure', async () => {
  // Populate legacy bloated workspace synced keys
  mockStorage.setItem('aira_workspace_synced_v1_old_1', 'X'.repeat(50000));
  mockStorage.setItem('aira_workspace_synced_v1_old_2', 'Y'.repeat(50000));
  assert.equal(mockStorage.length, 2);

  // Set initial settings
  const settings = loadSettings();
  settings.userName = 'Production Tester';

  // Fail once on settings to trigger quota recovery branch, then allow retry to succeed
  mockStorage.shouldFailOnKey = 'aira_settings_v1';
  let attempts = 0;
  const originalSetItem = mockStorage.setItem.bind(mockStorage);
  mockStorage.setItem = (k, v) => {
    attempts++;
    if (k === 'aira_settings_v1' && attempts === 1) {
      const err = new Error("QuotaExceededError: Setting the value of 'aira_settings_v1' exceeded the quota.");
      err.name = 'QuotaExceededError';
      throw err;
    }
    return originalSetItem(k, v);
  };

  // Save settings succeeds and purges the bloated legacy keys
  saveSettings(settings);

  // Verify settings are saved
  const reloaded = loadSettings();
  assert.equal(reloaded.userName, 'Production Tester');

  // Verify bloated legacy keys were safely evicted to liberate quota
  assert.equal(mockStorage.getItem('aira_workspace_synced_v1_old_1'), null);
  assert.equal(mockStorage.getItem('aira_workspace_synced_v1_old_2'), null);
});

test('[Disaster Recovery] exportAllStorageData produces complete recoverable JSON dump', async () => {
  const convs = [
    {
      id: 'c-export-test',
      title: 'Exportable Conversation',
      messages: [{ id: 'm-exp', role: 'user' as const, content: 'Export me', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  saveConversations(convs);

  const projects = [
    {
      id: 'proj-1',
      name: 'Project Alpha',
      conversations: ['c-export-test'],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  saveProjects(projects);

  const dump = exportAllStorageData();
  assert.ok(dump.includes('"exportVersion": 2'));
  assert.ok(dump.includes('c-export-test'));
  assert.ok(dump.includes('Project Alpha'));

  const parsed = JSON.parse(dump);
  assert.equal(parsed.exportVersion, 2);
  assert.ok(Array.isArray(parsed.projects));
  assert.equal(parsed.projects.length, 1);
});

test('[Storage Safety Regression] Quota recovery NEVER evicts conversation keys from LocalStorage', async () => {
  // Pre-seed an existing conversation in localStorage
  const existingConv = [
    {
      id: 'c-critical-user',
      title: 'Do Not Delete Me',
      messages: [{ id: 'm-crit', role: 'user' as const, content: 'Priceless user discussion', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  mockStorage.setItem('aira_conversations_v1', JSON.stringify(existingConv));
  mockStorage.setItem('aira_conversations_user_usr_123', JSON.stringify(existingConv));
  mockStorage.setItem('aira_workspace_synced_v1_ephemeral', 'temp blob');

  // Trigger quota error on saveSettings
  const settings = loadSettings();
  settings.userName = 'Quota Stress Test';
  mockStorage.shouldFailOnKey = 'aira_settings_v1';
  let attempts = 0;
  const originalSetItem = mockStorage.setItem.bind(mockStorage);
  mockStorage.setItem = (k, v) => {
    attempts++;
    if (k === 'aira_settings_v1' && attempts === 1) {
      const err = new Error("QuotaExceededError: Setting the value of 'aira_settings_v1' exceeded the quota.");
      err.name = 'QuotaExceededError';
      throw err;
    }
    return originalSetItem(k, v);
  };

  saveSettings(settings);

  // Ephemeral workspace blob is evicted
  assert.equal(mockStorage.getItem('aira_workspace_synced_v1_ephemeral'), null);

  // CRITICAL CHECK: Conversation keys MUST remain untouched in localStorage!
  assert.notEqual(mockStorage.getItem('aira_conversations_v1'), null, 'aira_conversations_v1 must NEVER be evicted by quota cleanup');
  assert.notEqual(mockStorage.getItem('aira_conversations_user_usr_123'), null, 'User conversation keys must NEVER be evicted by quota cleanup');
  
  const preserved = JSON.parse(mockStorage.getItem('aira_conversations_v1')!);
  assert.equal(preserved[0].id, 'c-critical-user');
});
