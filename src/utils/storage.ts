import type { Conversation, Project, AppSettings } from '../types';
import { AVAILABLE_MODELS, DEFAULT_SETTINGS } from './constants';
import { idbGet, idbSet, openAiraDatabase, STORES, isIndexedDbSupported } from './indexedDbStorage';

export function normalizeStoredModelId(model: unknown): AppSettings['activeModel'] {
  // Existing users can carry formerly hosted models or legacy Claude alias IDs in localStorage.
  // Migrate explicit selections to the currently supported canonical routes.
  let migrated = model;
  if (
    model === 'meta/llama-3.1-405b-instruct' ||
    model === 'meta-llama/llama-3.1-405b-instruct' ||
    model === 'nvidia/nemotron-3-super-120b-a12b'
  ) {
    migrated = 'nvidia/llama-3.1-nemotron-70b-instruct';
  } else if (model === 'claude-3-7-sonnet') {
    migrated = 'aira-auto';
  } else if (model === 'claude-3-5-sonnet') {
    migrated = 'aira-pro';
  } else if (model === 'claude-3-5-haiku') {
    migrated = 'aira-fast';
  } else if (model === 'claude-3-opus') {
    migrated = 'aira-deep';
  }

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
  DEVICE_PREFERENCES: 'aira_device_preferences_v1',
  LEGACY_SETTINGS_ARCHIVE: 'aira_legacy_settings_archive_v1',
  PINNED_CHATS: 'aira_pinned_chats_v1',
  STORAGE_MIGRATION_VERSION: 'aira_storage_migrated_v2',
} as const;

export const DEVICE_PREFERENCE_KEYS = [
  'theme',
  'aestheticPreset',
  'reducedMotion',
  'highContrast',
  'fontSize',
  'soundEffects',
  'autoOpenArtifacts',
  'streamResponse',
  'telemetryOptOut',
  'notificationsEnabled',
  'announcementsEnabled',
  'productUpdatesEnabled',
  'tipsEnabled',
] as const;

export const ACCOUNT_SETTING_KEYS = [
  'activeModel',
  'extendedThinking',
  'thinkingBudget',
  'provider',
  'anthropicApiKey',
  'openRouterApiKey',
  'customInstructions',
  'userName',
  'email',
  'userBio',
  'responseStyle',
  'persistentMemoryEnabled',
  'autoConsolidateMemory',
  'privacyScrubbing',
  'memoryTokenBudget',
] as const;

export type DevicePreferenceKey = (typeof DEVICE_PREFERENCE_KEYS)[number];
export type AccountSettingKey = (typeof ACCOUNT_SETTING_KEYS)[number];
export type DevicePreferences = Pick<AppSettings, DevicePreferenceKey>;
export type AccountSettings = Pick<AppSettings, AccountSettingKey>;

export type SettingsOwnerIdentity =
  | string
  | { userId?: string | null; email?: string | null }
  | null
  | undefined;

interface ScopedAccountSettingsRecord {
  version: 2;
  ownerId: string;
  ownerEmail?: string;
  migratedFrom?: string;
  migratedAt?: number;
  updatedAt: number;
  data: AccountSettings;
}

interface QuarantinedLegacySettingsArchive {
  version: 1;
  quarantinedAt: number;
  ownerId?: string;
  ownerEmail?: string;
  data: Partial<AccountSettings>;
}

export const INITIAL_CONVERSATION: Conversation = {
  id: 'welcome-to-aira',
  title: 'New Aira workspace',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
};

// In-memory cache for synchronous reads and resilient fallback (strictly scoped by owner)
const inMemoryConversations = new Map<string, Conversation[]>();
const inMemoryProjects = new Map<string, Project[]>();
let inMemoryDevicePreferences: DevicePreferences | null = null;
const inMemoryAccountSettings = new Map<string, ScopedAccountSettingsRecord>();

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

export function getProjectsStorageKey(userId?: string): string {
  return userId ? `aira_projects_user_${userId}` : STORAGE_KEYS.PROJECTS;
}

/** A legacy key is only removable when every persisted record matches the source. */
export function isVerifiedMigrationCopy<T>(source: T, restored: unknown): restored is T {
  try {
    return Array.isArray(source) && Array.isArray(restored) &&
      JSON.stringify(source) === JSON.stringify(restored);
  } catch {
    return false;
  }
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
          if (isVerifiedMigrationCopy(parsed, verified)) {
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
    const projectKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key === STORAGE_KEYS.PROJECTS || key.startsWith('aira_projects_user_'))) {
        projectKeys.push(key);
      }
    }

    for (const key of projectKeys) {
      const rawProjects = localStorage.getItem(key);
      if (!rawProjects) continue;
      try {
        const parsedProjects = JSON.parse(rawProjects);
        if (Array.isArray(parsedProjects)) {
          await idbSet(STORES.PROJECTS, key, parsedProjects);
          if (key === STORAGE_KEYS.PROJECTS) {
            await idbSet(STORES.PROJECTS, 'projects', parsedProjects);
          }
          const verifiedProjects = await idbGet<Project[]>(STORES.PROJECTS, key);
          if (isVerifiedMigrationCopy(parsedProjects, verifiedProjects)) {
            inMemoryProjects.set(key, verifiedProjects);
            migratedAny = true;
            localStorage.removeItem(key);
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
 * Hydrates projects from IndexedDB asynchronously into in-memory cache.
 */
export async function hydrateProjectsFromIndexedDb(userId?: string): Promise<Project[] | null> {
  const key = getProjectsStorageKey(userId);

  if (isIndexedDbSupported()) {
    try {
      const idbData = await idbGet<Project[]>(STORES.PROJECTS, key);
      if (Array.isArray(idbData) && idbData.length > 0) {
        inMemoryProjects.set(key, idbData);
        return idbData;
      }
    } catch {
      // Continue to fallback
    }
    if (!userId) {
      try {
        const legacyData = await idbGet<Project[]>(STORES.PROJECTS, 'projects');
        if (Array.isArray(legacyData) && legacyData.length > 0) {
          inMemoryProjects.set(key, legacyData);
          return legacyData;
        }
      } catch {
        // Non-blocking
      }
    }
  }

  return inMemoryProjects.get(key) || null;
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

export function loadProjects(userId?: string): Project[] {
  const key = getProjectsStorageKey(userId);

  const cached = inMemoryProjects.get(key);
  if (cached) {
    return cached;
  }

  let projectsList: Project[] = [];
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          projectsList = parsed;
        }
      }
    }
  } catch {
    // Non-blocking
  }

  inMemoryProjects.set(key, projectsList);
  return projectsList;
}

export function saveProjects(projects: Project[], userId?: string): void {
  const key = getProjectsStorageKey(userId);
  inMemoryProjects.set(key, projects);

  if (isIndexedDbSupported()) {
    void idbSet(STORES.PROJECTS, key, projects).catch(() => {
      // Non-blocking
    });
    if (key === STORAGE_KEYS.PROJECTS) {
      void idbSet(STORES.PROJECTS, 'projects', projects).catch(() => {
        // Non-blocking
      });
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, JSON.stringify(projects));
    } catch {
      // Quota exceeded: data is safely retained in inMemoryProjects and IndexedDB
      evictLegacyLocalStorageBlobs();
    }
  }
}

interface NormalizedSettingsOwner {
  userId: string | null;
  email: string | null;
  scopeId: string;
  isGuest: boolean;
}

function normalizeSettingsOwner(identity?: SettingsOwnerIdentity): NormalizedSettingsOwner {
  if (typeof identity === 'string') {
    const trimmed = identity.trim();
    const isGuest = !trimmed || trimmed === 'guest' || trimmed.startsWith('guest_');
    return {
      userId: trimmed && trimmed !== 'guest' ? trimmed : null,
      email: null,
      scopeId: trimmed && trimmed !== 'guest' ? trimmed : 'guest',
      isGuest,
    };
  }
  if (identity && typeof identity === 'object') {
    const rawId = typeof identity.userId === 'string' ? identity.userId.trim() : '';
    const rawEmail = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
    const isGuest = !rawId || rawId === 'guest' || rawId.startsWith('guest_');
    return {
      userId: rawId && rawId !== 'guest' ? rawId : null,
      email: rawEmail || null,
      scopeId: rawId && rawId !== 'guest' ? rawId : 'guest',
      isGuest,
    };
  }
  return { userId: null, email: null, scopeId: 'guest', isGuest: true };
}

export function getAccountSettingsStorageKey(userId?: string | null): string {
  const normalized = normalizeSettingsOwner(userId);
  return normalized.userId
    ? `aira_account_settings_user_${normalized.userId}`
    : 'aira_account_settings_guest';
}

const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  theme: DEFAULT_SETTINGS.theme,
  aestheticPreset: DEFAULT_SETTINGS.aestheticPreset,
  reducedMotion: DEFAULT_SETTINGS.reducedMotion,
  highContrast: DEFAULT_SETTINGS.highContrast,
  fontSize: DEFAULT_SETTINGS.fontSize,
  soundEffects: DEFAULT_SETTINGS.soundEffects,
  autoOpenArtifacts: DEFAULT_SETTINGS.autoOpenArtifacts,
  streamResponse: DEFAULT_SETTINGS.streamResponse,
  telemetryOptOut: DEFAULT_SETTINGS.telemetryOptOut,
  notificationsEnabled: DEFAULT_SETTINGS.notificationsEnabled,
  announcementsEnabled: DEFAULT_SETTINGS.announcementsEnabled,
  productUpdatesEnabled: DEFAULT_SETTINGS.productUpdatesEnabled,
  tipsEnabled: DEFAULT_SETTINGS.tipsEnabled,
};

function sanitizeAccountSettings(raw: Partial<AppSettings> | null | undefined): AccountSettings {
  const merged = raw || {};
  const thinkingBudget = typeof merged.thinkingBudget === 'number' && Number.isFinite(merged.thinkingBudget)
    ? Math.min(Math.max(Math.round(merged.thinkingBudget), 1024), 8192)
    : DEFAULT_SETTINGS.thinkingBudget;
  return {
    activeModel: normalizeStoredModelId(merged.activeModel),
    extendedThinking: Boolean(merged.extendedThinking),
    thinkingBudget,
    provider: (merged.provider === 'anthropic' || merged.provider === 'openrouter' || merged.provider === 'simulated')
      ? merged.provider
      : DEFAULT_SETTINGS.provider,
    anthropicApiKey: typeof merged.anthropicApiKey === 'string' ? merged.anthropicApiKey : '',
    openRouterApiKey: typeof merged.openRouterApiKey === 'string' ? merged.openRouterApiKey : '',
    customInstructions: typeof merged.customInstructions === 'string' ? merged.customInstructions : '',
    userName: typeof merged.userName === 'string' ? merged.userName : '',
    email: typeof merged.email === 'string' ? merged.email : '',
    userBio: typeof merged.userBio === 'string' ? merged.userBio : '',
    responseStyle: (
      merged.responseStyle === 'normal' ||
      merged.responseStyle === 'concise' ||
      merged.responseStyle === 'explanatory' ||
      merged.responseStyle === 'academic' ||
      merged.responseStyle === 'code-first'
    ) ? merged.responseStyle : DEFAULT_SETTINGS.responseStyle,
    persistentMemoryEnabled: merged.persistentMemoryEnabled !== false,
    autoConsolidateMemory: merged.autoConsolidateMemory !== false,
    privacyScrubbing: true, // Always enforced
    memoryTokenBudget: typeof merged.memoryTokenBudget === 'number' && Number.isFinite(merged.memoryTokenBudget)
      ? Math.min(Math.max(Math.round(merged.memoryTokenBudget), 200), 4000)
      : DEFAULT_SETTINGS.memoryTokenBudget,
  };
}

function pickDevicePreferences(raw: Partial<AppSettings> | null | undefined): DevicePreferences {
  const src = raw || {};
  return {
    theme: (src.theme === 'light' || src.theme === 'dark' || src.theme === 'system')
      ? src.theme
      : DEFAULT_DEVICE_PREFERENCES.theme,
    aestheticPreset: src.aestheticPreset ?? DEFAULT_DEVICE_PREFERENCES.aestheticPreset,
    reducedMotion: src.reducedMotion ?? DEFAULT_DEVICE_PREFERENCES.reducedMotion,
    highContrast: src.highContrast ?? DEFAULT_DEVICE_PREFERENCES.highContrast,
    fontSize: src.fontSize ?? DEFAULT_DEVICE_PREFERENCES.fontSize,
    soundEffects: src.soundEffects ?? DEFAULT_DEVICE_PREFERENCES.soundEffects,
    autoOpenArtifacts: src.autoOpenArtifacts ?? DEFAULT_DEVICE_PREFERENCES.autoOpenArtifacts,
    streamResponse: src.streamResponse ?? DEFAULT_DEVICE_PREFERENCES.streamResponse,
    telemetryOptOut: src.telemetryOptOut ?? DEFAULT_DEVICE_PREFERENCES.telemetryOptOut,
    notificationsEnabled: src.notificationsEnabled ?? DEFAULT_DEVICE_PREFERENCES.notificationsEnabled,
    announcementsEnabled: src.announcementsEnabled ?? DEFAULT_DEVICE_PREFERENCES.announcementsEnabled,
    productUpdatesEnabled: src.productUpdatesEnabled ?? DEFAULT_DEVICE_PREFERENCES.productUpdatesEnabled,
    tipsEnabled: src.tipsEnabled ?? DEFAULT_DEVICE_PREFERENCES.tipsEnabled,
  };
}

function hasAnyAccountSettingKey(obj: Record<string, unknown>): boolean {
  return ACCOUNT_SETTING_KEYS.some(key => Object.prototype.hasOwnProperty.call(obj, key));
}

function isPlaceholderEmail(email?: string | null): boolean {
  if (!email) return true;
  const cleaned = email.trim().toLowerCase();
  return !cleaned || cleaned === 'user@aira.internal' || !cleaned.includes('@');
}

function writeLocalStorageWithQuotaRetry(key: string, payload: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(key, payload);
    storageHealthState.status = 'healthy';
    return true;
  } catch {
    evictLegacyLocalStorageBlobs();
    try {
      localStorage.setItem(key, payload);
      storageHealthState.lastQuotaErrorAt = Date.now();
      storageHealthState.status = 'healthy';
      return true;
    } catch {
      storageHealthState.lastQuotaErrorAt = Date.now();
      storageHealthState.status = 'degraded_quota';
      return false;
    }
  }
}

let lastSettingsQuotaFallbackScope: string | null = null;
let lastDevicePrefsQuotaFallback = false;

function quarantineLegacyGlobalSettingsIfPresent(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const rawLegacy = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!rawLegacy) return;
    const parsed = JSON.parse(rawLegacy);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (!hasAnyAccountSettingKey(parsed as Record<string, unknown>)) return;

    const devicePrefs = pickDevicePreferences(parsed);
    if (!localStorage.getItem(STORAGE_KEYS.DEVICE_PREFERENCES)) {
      const serializedDevice = JSON.stringify(devicePrefs);
      if (writeLocalStorageWithQuotaRetry(STORAGE_KEYS.DEVICE_PREFERENCES, serializedDevice)) {
        const verifiedDevice = localStorage.getItem(STORAGE_KEYS.DEVICE_PREFERENCES);
        if (!verifiedDevice || JSON.stringify(JSON.parse(verifiedDevice)) !== serializedDevice) {
          return;
        }
      }
    }

    const accountFields = sanitizeAccountSettings(parsed);
    const legacyEmail = typeof parsed.email === 'string' && !isPlaceholderEmail(parsed.email)
      ? parsed.email.trim().toLowerCase()
      : undefined;
    const legacyOwnerId = typeof parsed.ownerId === 'string' && parsed.ownerId.trim()
      ? parsed.ownerId.trim()
      : (typeof parsed.userId === 'string' && parsed.userId.trim() ? parsed.userId.trim() : undefined);

    if (!localStorage.getItem(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE)) {
      const archive: QuarantinedLegacySettingsArchive = {
        version: 1,
        quarantinedAt: Date.now(),
        ...(legacyOwnerId ? { ownerId: legacyOwnerId } : {}),
        ...(legacyEmail ? { ownerEmail: legacyEmail } : {}),
        data: accountFields,
      };
      const serializedArchive = JSON.stringify(archive);
      if (!writeLocalStorageWithQuotaRetry(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE, serializedArchive)) {
        return;
      }
      const readBack = localStorage.getItem(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE);
      if (!readBack || JSON.stringify(JSON.parse(readBack)) !== serializedArchive) {
        return;
      }
    }

    // Both device prefs and legacy account archive are verified; scrub account fields from global key.
    writeLocalStorageWithQuotaRetry(STORAGE_KEYS.SETTINGS, JSON.stringify(devicePrefs));
  } catch {
    // Non-blocking: preserve existing data rather than discarding on corrupt JSON
  }
}

function doesArchiveMatchOwner(archive: QuarantinedLegacySettingsArchive, owner: NormalizedSettingsOwner): boolean {
  const archiveOwnerId = typeof archive.ownerId === 'string' ? archive.ownerId.trim() : '';
  const archiveEmail = typeof archive.ownerEmail === 'string' && !isPlaceholderEmail(archive.ownerEmail)
    ? archive.ownerEmail.trim().toLowerCase()
    : '';

  if (owner.isGuest) {
    // Unowned anonymous/guest legacy fixtures may only migrate to guest when free of external identity claims.
    return !archiveOwnerId && !archiveEmail;
  }

  if (!owner.userId) return false;
  if (archiveOwnerId) {
    return archiveOwnerId === owner.userId;
  }
  if (archiveEmail && owner.email) {
    return archiveEmail === owner.email;
  }
  return false;
}

function tryClaimQuarantinedArchive(owner: NormalizedSettingsOwner): ScopedAccountSettingsRecord | null {
  if (typeof localStorage === 'undefined') return null;
  const scopedKey = getAccountSettingsStorageKey(owner.userId);
  if (localStorage.getItem(scopedKey)) {
    return null;
  }
  try {
    const rawArchive = localStorage.getItem(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE);
    if (!rawArchive) return null;
    const archive = JSON.parse(rawArchive) as QuarantinedLegacySettingsArchive;
    if (!archive || typeof archive !== 'object' || !archive.data) return null;
    if (!doesArchiveMatchOwner(archive, owner)) {
      return null;
    }

    const migratedRecord: ScopedAccountSettingsRecord = {
      version: 2,
      ownerId: owner.scopeId,
      ...(owner.email ? { ownerEmail: owner.email } : {}),
      migratedFrom: STORAGE_KEYS.SETTINGS,
      migratedAt: Date.now(),
      updatedAt: Date.now(),
      data: sanitizeAccountSettings(archive.data),
    };
    const serialized = JSON.stringify(migratedRecord);
    if (!writeLocalStorageWithQuotaRetry(scopedKey, serialized)) {
      return null;
    }
    const readBackRaw = localStorage.getItem(scopedKey);
    if (!readBackRaw) return null;
    const readBack = JSON.parse(readBackRaw) as ScopedAccountSettingsRecord;
    if (
      readBack.ownerId !== owner.scopeId ||
      JSON.stringify(readBack.data) !== JSON.stringify(migratedRecord.data)
    ) {
      return null;
    }

    // Verified read-back: remove legacy quarantine archive once claimed by its rightful owner
    localStorage.removeItem(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE);
    if (isIndexedDbSupported()) {
      void idbSet(STORES.SETTINGS, scopedKey, migratedRecord).catch(() => {});
    }
    return readBack;
  } catch {
    return null;
  }
}

export function loadDevicePreferences(): DevicePreferences {
  quarantineLegacyGlobalSettingsIfPresent();

  if (typeof localStorage !== 'undefined') {
    try {
      const rawDevice = localStorage.getItem(STORAGE_KEYS.DEVICE_PREFERENCES);
      if (rawDevice) {
        const parsed = pickDevicePreferences(JSON.parse(rawDevice));
        inMemoryDevicePreferences = parsed;
        return { ...parsed };
      }
      const rawLegacy = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (rawLegacy) {
        const parsed = pickDevicePreferences(JSON.parse(rawLegacy));
        inMemoryDevicePreferences = parsed;
        return { ...parsed };
      }
    } catch {
      // Non-blocking
    }
    if (lastDevicePrefsQuotaFallback && inMemoryDevicePreferences) {
      return { ...inMemoryDevicePreferences };
    }
  } else if (inMemoryDevicePreferences) {
    return { ...inMemoryDevicePreferences };
  }

  return { ...DEFAULT_DEVICE_PREFERENCES };
}

export function saveDevicePreferences(prefs: DevicePreferences): void {
  const clean = pickDevicePreferences(prefs);
  inMemoryDevicePreferences = clean;
  const serialized = JSON.stringify(clean);

  if (isIndexedDbSupported()) {
    void idbSet(STORES.SETTINGS, 'device_preferences', clean).catch(() => {});
  }

  if (typeof localStorage !== 'undefined') {
    // Only scrub legacy global key if no unquarantined account data sits inside it
    quarantineLegacyGlobalSettingsIfPresent();
    const okDevice = writeLocalStorageWithQuotaRetry(STORAGE_KEYS.DEVICE_PREFERENCES, serialized);
    const okCompat = writeLocalStorageWithQuotaRetry(STORAGE_KEYS.SETTINGS, serialized);
    lastDevicePrefsQuotaFallback = !okDevice && !okCompat;
  }
}

export function loadSettings(identity?: SettingsOwnerIdentity): AppSettings {
  const owner = normalizeSettingsOwner(identity);
  const devicePrefs = loadDevicePreferences();
  const scopedKey = getAccountSettingsStorageKey(owner.userId);

  let accountData: AccountSettings | null = null;

  if (typeof localStorage !== 'undefined') {
    try {
      const rawScoped = localStorage.getItem(scopedKey);
      if (rawScoped) {
        const parsed = JSON.parse(rawScoped);
        if (parsed && parsed.version === 2 && parsed.data) {
          if (parsed.ownerId === owner.scopeId) {
            accountData = sanitizeAccountSettings(parsed.data);
            inMemoryAccountSettings.set(owner.scopeId, {
              ...parsed,
              data: accountData,
            });
          }
        } else if (parsed && typeof parsed === 'object') {
          accountData = sanitizeAccountSettings(parsed);
        }
      }
    } catch {
      // Non-blocking
    }

    if (!accountData) {
      const claimed = tryClaimQuarantinedArchive(owner);
      if (claimed) {
        accountData = claimed.data;
        inMemoryAccountSettings.set(owner.scopeId, claimed);
      }
    }

    if (!accountData && lastSettingsQuotaFallbackScope === owner.scopeId) {
      const cached = inMemoryAccountSettings.get(owner.scopeId);
      if (cached && cached.ownerId === owner.scopeId) {
        accountData = cached.data;
      }
    }
  } else {
    const cached = inMemoryAccountSettings.get(owner.scopeId);
    if (cached && cached.ownerId === owner.scopeId) {
      accountData = cached.data;
    }
  }

  const finalAccount = accountData || sanitizeAccountSettings(DEFAULT_SETTINGS);
  return {
    ...devicePrefs,
    ...finalAccount,
    activeModel: normalizeStoredModelId(finalAccount.activeModel),
  };
}

export function saveSettings(settings: AppSettings, identity?: SettingsOwnerIdentity): void {
  const owner = normalizeSettingsOwner(identity);
  const devicePrefs = pickDevicePreferences(settings);
  const accountData = sanitizeAccountSettings(settings);
  const scopedKey = getAccountSettingsStorageKey(owner.userId);

  const record: ScopedAccountSettingsRecord = {
    version: 2,
    ownerId: owner.scopeId,
    ...(owner.email ? { ownerEmail: owner.email } : {}),
    updatedAt: Date.now(),
    data: accountData,
  };

  saveDevicePreferences(devicePrefs);
  inMemoryAccountSettings.set(owner.scopeId, record);

  if (isIndexedDbSupported()) {
    void idbSet(STORES.SETTINGS, scopedKey, record).catch(() => {});
  }

  if (typeof localStorage !== 'undefined') {
    const okScoped = writeLocalStorageWithQuotaRetry(scopedKey, JSON.stringify(record));
    lastSettingsQuotaFallbackScope = okScoped ? null : owner.scopeId;
  }
}

export async function hydrateSettingsFromIndexedDb(identity?: SettingsOwnerIdentity): Promise<AppSettings | null> {
  if (!isIndexedDbSupported()) return null;
  const owner = normalizeSettingsOwner(identity);
  const scopedKey = getAccountSettingsStorageKey(owner.userId);

  let devicePrefs = loadDevicePreferences();
  try {
    const idbDevice = await idbGet<Partial<AppSettings>>(STORES.SETTINGS, 'device_preferences');
    if (idbDevice && typeof idbDevice === 'object') {
      devicePrefs = pickDevicePreferences(idbDevice);
      inMemoryDevicePreferences = devicePrefs;
    }
  } catch {
    // Non-blocking
  }

  let accountData: AccountSettings | null = null;
  try {
    const idbScoped = await idbGet<ScopedAccountSettingsRecord>(STORES.SETTINGS, scopedKey);
    if (idbScoped && idbScoped.version === 2 && idbScoped.ownerId === owner.scopeId && idbScoped.data) {
      accountData = sanitizeAccountSettings(idbScoped.data);
      inMemoryAccountSettings.set(owner.scopeId, { ...idbScoped, data: accountData });
    }
  } catch {
    // Non-blocking
  }

  if (!accountData) {
    try {
      const legacyIdb = await idbGet<any>(STORES.SETTINGS, 'settings');
      if (legacyIdb && typeof legacyIdb === 'object' && hasAnyAccountSettingKey(legacyIdb)) {
        const archive: QuarantinedLegacySettingsArchive = {
          version: 1,
          quarantinedAt: Date.now(),
          ownerId: typeof legacyIdb.ownerId === 'string' ? legacyIdb.ownerId : undefined,
          ownerEmail: typeof legacyIdb.email === 'string' && !isPlaceholderEmail(legacyIdb.email)
            ? legacyIdb.email.trim().toLowerCase()
            : undefined,
          data: sanitizeAccountSettings(legacyIdb),
        };
        if (doesArchiveMatchOwner(archive, owner)) {
          accountData = sanitizeAccountSettings(archive.data);
          const migrated: ScopedAccountSettingsRecord = {
            version: 2,
            ownerId: owner.scopeId,
            ...(owner.email ? { ownerEmail: owner.email } : {}),
            migratedFrom: 'idb:settings',
            migratedAt: Date.now(),
            updatedAt: Date.now(),
            data: accountData,
          };
          await idbSet(STORES.SETTINGS, scopedKey, migrated);
          const readBack = await idbGet<ScopedAccountSettingsRecord>(STORES.SETTINGS, scopedKey);
          if (readBack && JSON.stringify(readBack.data) === JSON.stringify(migrated.data)) {
            await idbSet(STORES.SETTINGS, 'settings', pickDevicePreferences(legacyIdb));
          }
        }
      }
    } catch {
      // Non-blocking
    }
  }

  if (!accountData) return null;
  return { ...devicePrefs, ...accountData };
}

export function clearAccountSettings(identity?: SettingsOwnerIdentity): void {
  const owner = normalizeSettingsOwner(identity);
  const scopedKey = getAccountSettingsStorageKey(owner.userId);
  inMemoryAccountSettings.delete(owner.scopeId);
  if (lastSettingsQuotaFallbackScope === owner.scopeId) {
    lastSettingsQuotaFallbackScope = null;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(scopedKey);
    } catch {
      // Non-blocking
    }
  }
  if (isIndexedDbSupported()) {
    void idbSet(STORES.SETTINGS, scopedKey, null).catch(() => {});
  }
}

export function resetSettingsCacheForTesting(): void {
  inMemoryDevicePreferences = null;
  inMemoryAccountSettings.clear();
  lastSettingsQuotaFallbackScope = null;
  lastDevicePrefsQuotaFallback = false;
}

/**
 * Account-scoped export: exports strictly the specified owner's
 * conversations, projects, and redacted settings (never leaks foreign accounts).
 */
export function exportAccountStorageData(identity?: SettingsOwnerIdentity): string {
  const owner = normalizeSettingsOwner(identity);
  const convKey = getConversationsStorageKey(owner.userId || undefined);
  const projKey = getProjectsStorageKey(owner.userId || undefined);

  const scopedConversations = inMemoryConversations.get(convKey) || loadConversations(owner.userId || undefined);
  const scopedProjects = inMemoryProjects.get(projKey) || loadProjects(owner.userId || undefined);
  const scopedSettings = loadSettings(owner);

  const payload = {
    exportVersion: 2,
    timestamp: Date.now(),
    ownerScope: owner.scopeId,
    conversations: { [convKey]: scopedConversations },
    projects: scopedProjects,
    projectsByUser: { [projKey]: scopedProjects },
    settings: {
      ...scopedSettings,
      anthropicApiKey: scopedSettings.anthropicApiKey ? '[REDACTED]' : '',
      openRouterApiKey: scopedSettings.openRouterApiKey ? '[REDACTED]' : '',
    },
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Disaster recovery export. When an owner identity is provided, restricts the
 * export strictly to that account; when omitted (explicit device-level recovery),
 * exports partitioned conversation/project maps plus guest/device settings with
 * API keys redacted and zero foreign user personalization keys.
 */
export function exportAllStorageData(identity?: SettingsOwnerIdentity): string {
  if (identity !== undefined) {
    return exportAccountStorageData(identity);
  }

  const guestProjKey = getProjectsStorageKey(undefined);
  const guestProjects = inMemoryProjects.get(guestProjKey) || loadProjects(undefined);
  const guestConvKey = getConversationsStorageKey(undefined);
  const conversationsMap =
    inMemoryConversations.size > 0
      ? Object.fromEntries(inMemoryConversations.entries())
      : { [guestConvKey]: loadConversations(undefined) };
  const projectsByUserMap =
    inMemoryProjects.size > 0
      ? Object.fromEntries(inMemoryProjects.entries())
      : { [guestProjKey]: guestProjects };
  const guestSettings = loadSettings(null);

  const payload = {
    exportVersion: 2,
    timestamp: Date.now(),
    ownerScope: 'device_recovery',
    conversations: conversationsMap,
    projects: guestProjects,
    projectsByUser: projectsByUserMap,
    settings: {
      ...guestSettings,
      anthropicApiKey: guestSettings.anthropicApiKey ? '[REDACTED]' : '',
      openRouterApiKey: guestSettings.openRouterApiKey ? '[REDACTED]' : '',
    },
  };

  return JSON.stringify(payload, null, 2);
}
