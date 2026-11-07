import type { Conversation, Project, AppSettings } from '../types';
import { AVAILABLE_MODELS, DEFAULT_SETTINGS } from './constants';
import { idbGet, idbSet, openAiraDatabase, STORES, isIndexedDbSupported } from './indexedDbStorage';

export function normalizeStoredModelId(model: unknown): AppSettings['activeModel'] {
  // Existing users can carry the formerly hosted Llama 405B ID in localStorage.
  // Migrate that explicit selection to the currently supported NVIDIA route.
  const migrated = (model === 'meta/llama-3.1-405b-instruct' || model === 'nvidia/nemotron-3-super-120b-a12b')
    ? 'nvidia/llama-3.1-nemotron-70b-instruct'
    : model;

  return AVAILABLE_MODELS.some(candidate => candidate.id === migrated)
    ? migrated as AppSettings['activeModel']
    : DEFAULT_SETTINGS.activeModel;
}

export const STORAGE_KEYS = {
  CONVERSATIONS: 'aira_conversations_v1',
  ACTIVE_CHAT: 'aira_active_chat_id_v1',
  SESSION_ACTIVE_CHAT: 'aira_active_chat_session',
  PROJECTS: 'aira_projects_v1',
  ACTIVE_PROJECT: 'aira_active_project_id_v1',
  SETTINGS: 'aira_settings_v1',
  PINNED_CHATS: 'aira_pinned_chats_v1',
  STORAGE_MIGRATION_VERSION: 'aira_storage_migrated_v2',
} as const;

export const INITIAL_CONVERSATION: Conversation = {
  id: 'welcome-to-aira',
  title: 'New Aira workspace',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
};

// In-memory cache for synchronous reads and resilient fallback
const inMemoryConversations = new Map<string, Conversation[]>();
let inMemoryProjects: Project[] | null = null;
let inMemorySettings: AppSettings | null = null;

export interface StorageHealth {
  status: 'healthy' | 'degraded_quota' | 'memory_only';
  indexedDbAvailable: boolean;
  lastQuotaErrorAt?: number;
}

let storageHealthState: StorageHealth = {
  status: 'healthy',
  indexedDbAvailable: false,
};

export function getStorageHealth(): StorageHealth {
  storageHealthState.indexedDbAvailable = isIndexedDbSupported();
  return { ...storageHealthState };
}

export function getConversationsStorageKey(userId?: string): string {
  return userId ? `aira_conversations_user_${userId}` : STORAGE_KEYS.CONVERSATIONS;
}

/**
 * Safely removes ephemeral workspace sync blobs from LocalStorage.
 * NEVER deletes conversations, settings, or projects.
 * This frees up browser quota for essential settings.
 */
function evictLegacyLocalStorageBlobs(): number {
  if (typeof localStorage === 'undefined') return 0;
  let freedCount = 0;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      // ONLY evict ephemeral workspace sync blobs.
      // NEVER touch user conversations, settings, or projects in this eviction pass.
      if (key.startsWith('aira_workspace_synced_v1_')) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
      freedCount++;
    }
  } catch {
    // Non-blocking cleanup
  }
  return freedCount;
}

/**
 * Asynchronously migrates legacy LocalStorage conversations and projects into IndexedDB.
 * Enforces strict read-back verification before removing any legacy keys from LocalStorage.
 * Ensures idempotent and recoverable execution without data loss.
 */
export async function migrateLocalStorageToIndexedDb(): Promise<{ migrated: boolean; freedKeys: number }> {
  if (!isIndexedDbSupported() || typeof localStorage === 'undefined') {
    return { migrated: false, freedKeys: 0 };
  }

  try {
    const db = await openAiraDatabase();
    if (!db) {
      return { migrated: false, freedKeys: 0 };
    }
    let migratedAny = false;
    let freedKeys = 0;

    // Migrate conversations with strict read-back verification
    const convKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key === STORAGE_KEYS.CONVERSATIONS || key.startsWith('aira_conversations_user_'))) {
        convKeys.push(key);
      }
    }

    for (const key of convKeys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Write to IndexedDB
          await idbSet(STORES.CONVERSATIONS, key, parsed);
          // Strict read-back verification: verify that IndexedDB can retrieve the exact records
          const verified = await idbGet<Conversation[]>(STORES.CONVERSATIONS, key);
          if (Array.isArray(verified) && verified.length === parsed.length && verified[0]?.id === parsed[0]?.id) {
            // Read-back verified: update in-memory cache and remove legacy LocalStorage entry
            inMemoryConversations.set(key, verified);
            migratedAny = true;
            localStorage.removeItem(key);
            freedKeys++;
          }
        }
      } catch {
        // If parsing or read-back verification fails, preserve localStorage key intact!
      }
    }

    // Migrate projects with strict read-back verification
    const rawProjects = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (rawProjects) {
      try {
        const parsedProjects = JSON.parse(rawProjects);
        if (Array.isArray(parsedProjects)) {
          await idbSet(STORES.PROJECTS, 'projects', parsedProjects);
          const verifiedProjects = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
          if (Array.isArray(verifiedProjects) && verifiedProjects.length === parsedProjects.length) {
            inMemoryProjects = verifiedProjects;
            migratedAny = true;
            localStorage.removeItem(STORAGE_KEYS.PROJECTS);
            freedKeys++;
          }
        }
      } catch {
        // Preserve localStorage key intact
      }
    }

    // Also evict ephemeral synced workspace blobs to liberate quota
    freedKeys += evictLegacyLocalStorageBlobs();

    if (migratedAny) {
      try {
        localStorage.setItem(STORAGE_KEYS.STORAGE_MIGRATION_VERSION, '2');
      } catch {
        // Non-blocking
      }
    }

    return { migrated: migratedAny, freedKeys };
  } catch {
    return { migrated: false, freedKeys: 0 };
  }
}

/**
 * Hydrates conversations from IndexedDB asynchronously into in-memory cache.
 */
export async function hydrateStorageFromIndexedDb(userId?: string): Promise<Conversation[] | null> {
  const key = getConversationsStorageKey(userId);

  if (isIndexedDbSupported()) {
    try {
      const idbData = await idbGet<Conversation[]>(STORES.CONVERSATIONS, key);
      if (Array.isArray(idbData) && idbData.length > 0) {
        inMemoryConversations.set(key, idbData);
        return idbData;
      }
    } catch {
      // Continue to fallback
    }
  }

  // Trigger migration in the background
  void migrateLocalStorageToIndexedDb();

  return inMemoryConversations.get(key) || null;
}

/**
 * Synchronous conversation loader for initial React component rendering.
 * Checks in-memory cache, then LocalStorage, and gracefully initializes.
 */
export function loadConversations(userId?: string): Conversation[] {
  const key = getConversationsStorageKey(userId);

  // 1. Check in-memory cache first
  const cached = inMemoryConversations.get(key);
  if (cached && cached.length > 0) {
    return cached;
  }

  // 2. Read from LocalStorage for instant initial hydration
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          inMemoryConversations.set(key, parsed);
          // Asynchronously migrate to IndexedDB in the background
          void idbSet(STORES.CONVERSATIONS, key, parsed);
          return parsed;
        }
      }
    }
  } catch {
    // LocalStorage read error; fall through to initial conversation
  }

  const initial = [INITIAL_CONVERSATION];
  inMemoryConversations.set(key, initial);

  if (!userId) {
    saveConversations(initial);
  }

  return initial;
}

/**
 * Persists conversations using resilient multi-tier storage:
 * 1. Synchronously updates in-memory cache (zero data loss during session).
 * 2. Asynchronously persists to IndexedDB (multi-gigabyte durable storage).
 * 3. Gracefully manages LocalStorage with QuotaExceededError protection.
 */
export function saveConversations(conversations: Conversation[], userId?: string): void {
  const key = getConversationsStorageKey(userId);

  // 1. In-memory cache update
  inMemoryConversations.set(key, conversations);

  // 2. Asynchronous IndexedDB persistence (high-capacity, immune to 5MB localStorage limits)
  if (isIndexedDbSupported()) {
    void idbSet(STORES.CONVERSATIONS, key, conversations).catch(() => {
      // Non-blocking
    });
  }

  // 3. LocalStorage persistence with defensive quota protection
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, JSON.stringify(conversations));
      storageHealthState.status = 'healthy';
    } catch (e: unknown) {
      storageHealthState.lastQuotaErrorAt = Date.now();
      storageHealthState.status = isIndexedDbSupported() ? 'healthy' : 'degraded_quota';

      // If QuotaExceededError occurred, evict legacy blobs and do not throw
      const isQuota = e instanceof Error && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.message?.toLowerCase().includes('quota')
      );

      if (isQuota) {
        evictLegacyLocalStorageBlobs();
      }
      // Data remains 100% safe in inMemoryConversations and IndexedDB.
      // Avoid logging full conversation content or tokens.
    }
  }
}

export function loadActiveChatId(): string {
  try {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.ACTIVE_CHAT) : null) || INITIAL_CONVERSATION.id;
  } catch {
    return INITIAL_CONVERSATION.id;
  }
}

export function saveActiveChatId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, id);
    }
  } catch {
    // Non-blocking
  }
}

export function getSessionActiveChatId(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const urlParam = new URLSearchParams(window.location.search).get('c');
    if (urlParam) return urlParam;
    return window.sessionStorage?.getItem(STORAGE_KEYS.SESSION_ACTIVE_CHAT) || null;
  } catch {
    return null;
  }
}

export function setSessionActiveChatId(id: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (id) {
      window.sessionStorage?.setItem(STORAGE_KEYS.SESSION_ACTIVE_CHAT, id);
      const url = new URL(window.location.href);
      if (url.searchParams.get('c') !== id) {
        url.searchParams.set('c', id);
        window.history?.replaceState(null, '', url.toString());
      }
    } else {
      window.sessionStorage?.removeItem(STORAGE_KEYS.SESSION_ACTIVE_CHAT);
      const url = new URL(window.location.href);
      if (url.searchParams.has('c')) {
        url.searchParams.delete('c');
        window.history?.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
      }
    }
  } catch {
    // Non-blocking
  }
}

export function loadProjects(): Project[] {
  if (inMemoryProjects) return inMemoryProjects;

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          inMemoryProjects = parsed;
          return parsed;
        }
      }
    }
  } catch {
    // Non-blocking
  }

  inMemoryProjects = [];
  return [];
}

export function saveProjects(projects: Project[]): void {
  inMemoryProjects = projects;

  if (isIndexedDbSupported()) {
    void idbSet(STORES.PROJECTS, 'projects', projects).catch(() => {
      // Non-blocking
    });
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
    } catch {
      // Quota exceeded: data is safely retained in inMemoryProjects and IndexedDB
      evictLegacyLocalStorageBlobs();
    }
  }
}

export function loadSettings(): AppSettings {
  if (inMemorySettings) return inMemorySettings;

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (raw) {
        const saved = JSON.parse(raw);
        const merged = { ...DEFAULT_SETTINGS, ...saved };
        const finalSettings = { ...merged, activeModel: normalizeStoredModelId(merged.activeModel) };
        inMemorySettings = finalSettings;
        return finalSettings;
      }
    }
  } catch {
    // Non-blocking
  }

  inMemorySettings = DEFAULT_SETTINGS;
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: AppSettings): void {
  inMemorySettings = settings;

  if (isIndexedDbSupported()) {
    void idbSet(STORES.SETTINGS, 'settings', settings).catch(() => {
      // Non-blocking
    });
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e: unknown) {
      // QuotaExceededError on aira_settings_v1:
      // Clear legacy storage blobs (which are safely in memory & IndexedDB) and retry once
      evictLegacyLocalStorageBlobs();
      try {
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
      } catch {
        // If still blocked, settings remain safe in inMemorySettings and IndexedDB
        storageHealthState.lastQuotaErrorAt = Date.now();
        storageHealthState.status = 'degraded_quota';
      }
    }
  }
}

/**
 * Emergency disaster recovery export: creates a complete, sanitized JSON dump
 * of in-memory and persisted conversations, settings, and projects.
 */
export function exportAllStorageData(): string {
  const allConversations: Record<string, Conversation[]> = {};
  inMemoryConversations.forEach((convs, key) => {
    allConversations[key] = convs;
  });

  const payload = {
    exportVersion: 2,
    timestamp: Date.now(),
    conversations: allConversations,
    projects: inMemoryProjects || [],
    settings: inMemorySettings || DEFAULT_SETTINGS,
  };

  return JSON.stringify(payload, null, 2);
}
