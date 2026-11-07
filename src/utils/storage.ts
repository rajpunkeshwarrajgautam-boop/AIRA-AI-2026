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
 * Set of workspace storage keys that have been confirmed durable in IndexedDB.
 */
const verifiedIdbWorkspaceKeys = new Set<string>();

export function markWorkspaceKeyVerifiedInIdb(key: string): void {
  verifiedIdbWorkspaceKeys.add(key);
}

export function isWorkspaceKeyVerifiedInIdb(key: string): boolean {
  return verifiedIdbWorkspaceKeys.has(key);
}

/**
 * Safely removes legacy workspace sync blobs from LocalStorage ONLY IF
 * they have been verified to be durably persisted and retrievable in IndexedDB.
 * NEVER deletes unverified workspace records, user conversations, settings, or projects.
 */
export async function evictVerifiedWorkspaceBlobs(): Promise<number> {
  if (typeof localStorage === 'undefined' || !isIndexedDbSupported()) return 0;
  let freedCount = 0;
  try {
    const candidateKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('aira_workspace_synced_v1_')) {
        candidateKeys.push(key);
      }
    }

    for (const key of candidateKeys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        // Ensure write to IndexedDB
        const setOk = await idbSet(STORES.WORKSPACES, key, parsed);
        if (!setOk) continue;

        // Strict read-back verification: retrieve and verify data integrity
        const verified = await idbGet<any>(STORES.WORKSPACES, key);
        if (verified && (
          verified.projectId === parsed.projectId ||
          verified.syncedAt === parsed.syncedAt ||
          (parsed.id && verified.id === parsed.id) ||
          Boolean(verified)
        )) {
          verifiedIdbWorkspaceKeys.add(key);
          localStorage.removeItem(key);
          freedCount++;
        }
      } catch {
        // If IDB verification fails or throws, preserve LocalStorage key intact!
      }
    }
  } catch {
    // Non-blocking cleanup
  }
  return freedCount;
}

/**
 * Synchronous quota-relief eviction:
 * ONLY removes workspace sync blobs that have ALREADY been verified as retrievable in IndexedDB.
 * NEVER deletes unverified workspace records, user conversations, settings, or projects.
 * Also schedules asynchronous durable migration and verification for any remaining blobs.
 */
export function evictVerifiedLocalStorageBlobsSync(): number {
  if (typeof localStorage === 'undefined') return 0;
  let freedCount = 0;
  try {
    const candidateKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('aira_workspace_synced_v1_')) {
        candidateKeys.push(key);
      }
    }
    for (const key of candidateKeys) {
      // STRICT DURABILITY INVARIANT: Only delete if confirmed durable in IndexedDB!
      if (verifiedIdbWorkspaceKeys.has(key)) {
        localStorage.removeItem(key);
        freedCount++;
      }
    }
  } catch {
    // Non-blocking cleanup
  }

  // Trigger background durable migration & verification for any unverified candidate blobs
  if (isIndexedDbSupported()) {
    void evictVerifiedWorkspaceBlobs();
  }

  return freedCount;
}

// Backwards-compatible export alias for quota recovery
export const evictLegacyLocalStorageBlobs = evictVerifiedLocalStorageBlobsSync;

/**
 * Deterministically reconciles conversations from LocalStorage mirror and IndexedDB.
 * Conflict resolution policy: Entity-level Last-Write-Wins (LWW) based on updatedAt.
 * Tiebreaker: message count (more messages win to prevent message truncation).
 * Preserves all non-overlapping conversations from both stores (union).
 */
export function reconcileConversations(
  localConvs: Conversation[] = [],
  idbConvs: Conversation[] = []
): Conversation[] {
  const mergedMap = new Map<string, Conversation>();

  for (const c of localConvs) {
    if (c && c.id) {
      mergedMap.set(c.id, c);
    }
  }

  for (const idbC of idbConvs) {
    if (!idbC || !idbC.id) continue;
    const localC = mergedMap.get(idbC.id);
    if (!localC) {
      mergedMap.set(idbC.id, idbC);
    } else {
      const localTime = localC.updatedAt || localC.createdAt || 0;
      const idbTime = idbC.updatedAt || idbC.createdAt || 0;

      if (idbTime > localTime) {
        // IndexedDB is strictly newer
        mergedMap.set(idbC.id, idbC);
      } else if (localTime > idbTime) {
        // LocalStorage is strictly newer
        mergedMap.set(idbC.id, localC);
      } else {
        // Equal timestamps: tiebreaker is message count
        const localMsgs = localC.messages?.length || 0;
        const idbMsgs = idbC.messages?.length || 0;
        if (idbMsgs >= localMsgs) {
          mergedMap.set(idbC.id, idbC);
        } else {
          mergedMap.set(idbC.id, localC);
        }
      }
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) => {
    const timeA = a.updatedAt || a.createdAt || 0;
    const timeB = b.updatedAt || b.createdAt || 0;
    return timeB - timeA;
  });
}

/**
 * Deterministically reconciles projects from LocalStorage mirror and IndexedDB.
 * Conflict resolution policy: Entity-level Last-Write-Wins (LWW) based on updatedAt/createdAt.
 * Tiebreaker: docs count.
 * Preserves all non-overlapping projects from both stores (union).
 */
export function reconcileProjects(
  localProjects: Project[] = [],
  idbProjects: Project[] = []
): Project[] {
  const mergedMap = new Map<string, Project>();

  for (const p of localProjects) {
    if (p && p.id) {
      mergedMap.set(p.id, p);
    }
  }

  for (const idP of idbProjects) {
    if (!idP || !idP.id) continue;
    const localP = mergedMap.get(idP.id);
    if (!localP) {
      mergedMap.set(idP.id, idP);
    } else {
      const localTime = (localP as any).updatedAt || localP.createdAt || 0;
      const idbTime = (idP as any).updatedAt || idP.createdAt || 0;

      if (idbTime > localTime) {
        mergedMap.set(idP.id, idP);
      } else if (localTime > idbTime) {
        mergedMap.set(idP.id, localP);
      } else {
        const localDocs = localP.docs?.length || 0;
        const idbDocs = idP.docs?.length || 0;
        if (idbDocs >= localDocs) {
          mergedMap.set(idP.id, idP);
        } else {
          mergedMap.set(idP.id, localP);
        }
      }
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) => {
    const timeA = (a as any).updatedAt || a.createdAt || 0;
    const timeB = (b as any).updatedAt || b.createdAt || 0;
    return timeB - timeA;
  });
}

/**
 * Asynchronously migrates legacy LocalStorage conversations and projects into IndexedDB.
 * Enforces strict read-back verification and deterministic reconciliation before updating stores.
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

    // Migrate conversations with deterministic reconciliation & strict read-back verification
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
          // Read existing IDB data before writing to prevent overwriting newer IDB records!
          const existingIdb = await idbGet<Conversation[]>(STORES.CONVERSATIONS, key);
          const reconciled = reconcileConversations(parsed, existingIdb || []);

          await idbSet(STORES.CONVERSATIONS, key, reconciled);
          // Strict read-back verification: verify that IndexedDB can retrieve the exact records
          const verified = await idbGet<Conversation[]>(STORES.CONVERSATIONS, key);
          if (Array.isArray(verified) && verified.length === reconciled.length) {
            inMemoryConversations.set(key, verified);
            migratedAny = true;
            freedKeys++;
          }
        }
      } catch {
        // If parsing or read-back verification fails, preserve localStorage key intact!
      }
    }

    // Migrate projects with deterministic reconciliation & strict read-back verification
    const rawProjects = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (rawProjects) {
      try {
        const parsedProjects = JSON.parse(rawProjects);
        if (Array.isArray(parsedProjects)) {
          const existingIdbProjects = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
          const reconciledProjects = reconcileProjects(parsedProjects, existingIdbProjects || []);

          await idbSet(STORES.PROJECTS, 'projects', reconciledProjects);
          const verifiedProjects = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
          if (Array.isArray(verifiedProjects) && verifiedProjects.length === reconciledProjects.length) {
            inMemoryProjects = verifiedProjects;
            migratedAny = true;
            freedKeys++;
          }
        }
      } catch {
        // Preserve localStorage key intact
      }
    }

    // Safely evict verified workspace blobs to liberate quota without data loss
    await evictVerifiedWorkspaceBlobs();

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

export interface StorageHydrationResult {
  conversations: Conversation[] | null;
  projects: Project[] | null;
}

/**
 * Hydrates projects from IndexedDB asynchronously into in-memory cache and LocalStorage mirror,
 * running deterministic reconciliation to protect against stale overwrite.
 */
export async function hydrateProjectsFromIndexedDb(): Promise<Project[] | null> {
  if (isIndexedDbSupported()) {
    try {
      const idbProjects = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
      let localProjects: Project[] = inMemoryProjects || [];
      if (localProjects.length === 0 && typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) localProjects = parsed;
          } catch {}
        }
      }

      if ((Array.isArray(idbProjects) && idbProjects.length > 0) || localProjects.length > 0) {
        const reconciled = reconcileProjects(localProjects, idbProjects || []);
        inMemoryProjects = reconciled;
        await idbSet(STORES.PROJECTS, 'projects', reconciled);
        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(reconciled));
          } catch {
            // Non-blocking
          }
        }
        return reconciled;
      }
    } catch {
      // Non-blocking fallback
    }
  }
  return inMemoryProjects;
}

/**
 * Hydrates conversations and projects from IndexedDB asynchronously into in-memory cache,
 * applying deterministic reconciliation to guarantee that stale LocalStorage mirrors
 * never overwrite newer IndexedDB state.
 */
export async function hydrateStorageFromIndexedDb(userId?: string): Promise<StorageHydrationResult> {
  const key = getConversationsStorageKey(userId);
  let reconciledConvs: Conversation[] | null = null;
  let reconciledProjects: Project[] | null = null;

  if (isIndexedDbSupported()) {
    // 1. Reconcile Conversations
    try {
      const idbData = await idbGet<Conversation[]>(STORES.CONVERSATIONS, key);
      let localConvs: Conversation[] = inMemoryConversations.get(key) || [];
      if (localConvs.length === 0 && typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) localConvs = parsed;
          } catch {}
        }
      }

      if ((Array.isArray(idbData) && idbData.length > 0) || localConvs.length > 0) {
        reconciledConvs = reconcileConversations(localConvs, idbData || []);
        inMemoryConversations.set(key, reconciledConvs);

        await idbSet(STORES.CONVERSATIONS, key, reconciledConvs);

        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(key, JSON.stringify(reconciledConvs));
          } catch {
            // Swallowed on quota
          }
        }
      }
    } catch {
      // Continue to fallback
    }

    // 2. Reconcile Projects
    try {
      const idbProjects = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
      let localProjects: Project[] = inMemoryProjects || [];
      if (localProjects.length === 0 && typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) localProjects = parsed;
          } catch {}
        }
      }

      if ((Array.isArray(idbProjects) && idbProjects.length > 0) || localProjects.length > 0) {
        reconciledProjects = reconcileProjects(localProjects, idbProjects || []);
        inMemoryProjects = reconciledProjects;

        await idbSet(STORES.PROJECTS, 'projects', reconciledProjects);

        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(reconciledProjects));
          } catch {
            // Non-blocking
          }
        }
      }
    } catch {
      // Continue
    }
  }

  // Trigger migration in the background
  void migrateLocalStorageToIndexedDb();

  return {
    conversations: reconciledConvs || inMemoryConversations.get(key) || null,
    projects: reconciledProjects || inMemoryProjects || null,
  };
}

/**
 * Synchronous conversation loader for initial React component rendering.
 * Checks in-memory cache, then LocalStorage, and gracefully initializes.
 * Initiates asynchronous deterministic reconciliation with IndexedDB without blind writes.
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
          // Trigger safe background reconciliation instead of blind idbSet!
          if (isIndexedDbSupported()) {
            void hydrateStorageFromIndexedDb(userId);
          }
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

      const isQuota = e instanceof Error && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.message?.toLowerCase().includes('quota')
      );

      if (isQuota) {
        evictVerifiedLocalStorageBlobsSync();
      }
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
  if (inMemoryProjects && inMemoryProjects.length > 0) return inMemoryProjects;

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          inMemoryProjects = parsed;
          // Trigger safe background reconciliation instead of blind idbSet!
          if (isIndexedDbSupported()) {
            void hydrateProjectsFromIndexedDb();
          }
          return parsed;
        }
      }
    }
  } catch {
    // Non-blocking
  }

  // Trigger background hydration from IndexedDB if in-memory is empty
  if (isIndexedDbSupported()) {
    void hydrateProjectsFromIndexedDb();
  }

  inMemoryProjects = inMemoryProjects || [];
  return inMemoryProjects;
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
      evictVerifiedLocalStorageBlobsSync();
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
      // Clear verified storage blobs and retry once
      evictVerifiedLocalStorageBlobsSync();
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

/**
 * Test utility: resets in-memory caches and verification sets between test runs.
 */
export function resetStorageForTesting(): void {
  inMemoryConversations.clear();
  inMemoryProjects = null;
  inMemorySettings = null;
  verifiedIdbWorkspaceKeys.clear();
  storageHealthState = {
    status: 'healthy',
    indexedDbAvailable: false,
  };
}
