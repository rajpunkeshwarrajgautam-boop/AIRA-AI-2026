import {
  type Announcement,
  ANNOUNCEMENT_REGISTRY,
  getAnnouncementsForTier,
  getLatestAnnouncement,
  type PlanTier
} from '../../packages/contracts/src/index';

/**
 * Announcement Storage & Delivery Utilities
 * Manages user-isolated dismissal state, unread badge calculation,
 * first-view popup evaluation, and resilient offline/online synchronization.
 */

const LEGACY_STORAGE_KEY = 'aira_seen_announcements';

export function getAnnouncementStorageKey(userId?: string | null): string {
  const scope = (userId && typeof userId === 'string' && userId.trim()) ? userId.trim() : 'guest';
  return `aira_dismissed_announcements_${scope}`;
}

export function getPendingStorageKey(userId?: string | null): string {
  const scope = (userId && typeof userId === 'string' && userId.trim()) ? userId.trim() : 'guest';
  return `aira_pending_announcements_sync_${scope}`;
}

export function getPendingAnnouncementSyncIds(userId?: string | null): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(getPendingStorageKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string');
    }
  } catch {}
  return [];
}

export function addPendingAnnouncementSync(id: string, userId?: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const key = getPendingStorageKey(userId);
  const existing = new Set(getPendingAnnouncementSyncIds(userId));
  existing.add(id);
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(existing)));
  } catch {}
}

export function removePendingAnnouncementSync(id: string, userId?: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const key = getPendingStorageKey(userId);
  const existing = new Set(getPendingAnnouncementSyncIds(userId));
  existing.delete(id);
  try {
    if (existing.size === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(Array.from(existing)));
    }
  } catch {}
}

export function clearPendingAnnouncementSync(userId?: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(getPendingStorageKey(userId));
  } catch {}
}

/**
 * Retrieve dismissed announcement IDs for a user account, with fallback to legacy seen list only in guest mode.
 */
export function getDismissedAnnouncementIds(userId?: string | null): string[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }

  const primaryKey = getAnnouncementStorageKey(userId);
  try {
    const raw = window.localStorage.getItem(primaryKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(item => typeof item === 'string');
      }
    }
  } catch (err) {
    console.warn(`[Announcements] Failed to parse primary storage key ${primaryKey}:`, err);
  }

  // Fallback to legacy shared key only if unauthenticated/guest mode (!userId)
  const isGuest = !userId || typeof userId !== 'string' || !userId.trim();
  if (isGuest) {
    try {
      const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw) {
        const parsedLegacy = JSON.parse(legacyRaw);
        if (Array.isArray(parsedLegacy)) {
          return parsedLegacy.filter(item => typeof item === 'string');
        }
      }
    } catch {
      // Ignore legacy parsing errors
    }
  }

  return [];
}

/**
 * Dismiss an announcement for the active user, writing to user-scoped storage
 * (and mirroring into legacy storage only for guest mode), and syncing with the server if online.
 */
export function dismissAnnouncement(id: string, userId?: string | null): void {
  if (!id || typeof id !== 'string') return;
  if (typeof window === 'undefined' || !window.localStorage) return;

  const primaryKey = getAnnouncementStorageKey(userId);
  const current = new Set(getDismissedAnnouncementIds(userId));
  current.add(id);

  const updatedArray = Array.from(current);
  const isGuest = !userId || typeof userId !== 'string' || !userId.trim();
  try {
    window.localStorage.setItem(primaryKey, JSON.stringify(updatedArray));
    // Only mirror into legacy key for unauthenticated/guest mode
    if (isGuest) {
      window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(updatedArray));
    }
  } catch (err) {
    console.warn('[Announcements] Failed to write dismissed announcement to localStorage:', err);
  }

  // Queue for resilient background server synchronization
  addPendingAnnouncementSync(id, userId);

  // Asynchronous server synchronization with resilient queue clearing on success
  void (async () => {
    try {
      const res = await fetch('/api/announcements/dismiss', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userId ? { 'x-user-id': userId } : {})
        },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        removePendingAnnouncementSync(id, userId);
      }
    } catch {
      // Offline or network error: item remains safely queued in pending sync for next hydration
    }
  })();
}

/**
 * Reset all dismissed announcements for the target user.
 */
export function resetDismissedAnnouncements(userId?: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const primaryKey = getAnnouncementStorageKey(userId);
  const isGuest = !userId || typeof userId !== 'string' || !userId.trim();
  try {
    window.localStorage.removeItem(primaryKey);
    clearPendingAnnouncementSync(userId);
    if (isGuest) {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('[Announcements] Failed to clear dismissed announcements:', err);
  }

  // Best-effort remote server reset
  void (async () => {
    try {
      await fetch('/api/announcements/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userId ? { 'x-user-id': userId } : {})
        }
      });
    } catch {
      // Local reset succeeded
    }
  })();
}

/**
 * Calculate the count of unread announcements applicable to the given tier.
 */
export function getUnreadAnnouncementCount(
  tier: PlanTier = 'free',
  userId?: string | null,
  options?: { announcementsEnabled?: boolean; productUpdatesEnabled?: boolean }
): number {
  if (options?.announcementsEnabled === false) return 0;
  const dismissed = new Set(getDismissedAnnouncementIds(userId));
  const available = getAnnouncementsForTier(tier);
  const now = Date.now();

  return available.filter(a => {
    if (dismissed.has(a.id)) return false;
    if (options?.productUpdatesEnabled === false && a.category === 'model') return false;
    const pubTime = new Date(a.publishedAt).getTime();
    return !isNaN(pubTime) && pubTime <= now;
  }).length;
}

/**
 * Determine if a first-view popup announcement should be presented to the user on initial load.
 * Returns the latest unread announcement, or null if all are seen or feature is disabled in settings.
 */
export function shouldShowFirstViewPopup(
  tier: PlanTier = 'free',
  userId?: string | null,
  announcementsEnabled: boolean = true,
  productUpdatesEnabled: boolean = true
): Announcement | null {
  if (!announcementsEnabled) return null;

  const available = getAnnouncementsForTier(tier);
  if (!available || available.length === 0) return null;

  const dismissed = new Set(getDismissedAnnouncementIds(userId));
  const now = Date.now();

  // Filter out model/product updates if disabled by preference
  const filtered = available.filter(a => {
    if (a.category === 'model' && !productUpdatesEnabled) return false;
    return true;
  });

  // Sort available newest first
  const sorted = [...filtered]
    .filter(a => {
      const pubTime = new Date(a.publishedAt).getTime();
      return !isNaN(pubTime) && pubTime <= now;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  if (sorted.length === 0) return null;

  const latest = sorted[0];
  if (!dismissed.has(latest.id)) {
    return latest;
  }

  return null;
}

/**
 * Fetch announcements and server-side dismissed state.
 */
export async function fetchAnnouncementsFromServer(
  userId?: string | null
): Promise<{ announcements: Announcement[]; unreadCount: number; dismissedIds: string[] } | null> {
  try {
    const res = await fetch('/api/announcements', {
      headers: userId ? { 'x-user-id': userId } : {}
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      announcements: data.announcements || [],
      unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
      dismissedIds: Array.isArray(data.dismissedIds) ? data.dismissedIds : []
    };
  } catch {
    return null;
  }
}

/**
 * Synchronize announcements between local storage and authoritative server state.
 * - Hydrates server-persisted dismissals into localStorage.
 * - Merges locally dismissed announcements with server state without data loss.
 * - Reconciles any pending offline dismissals with the server.
 * - Returns updated announcements, unread count, and dismissed IDs.
 */
export async function syncAnnouncementsWithServer(
  userId?: string | null
): Promise<{ announcements: Announcement[]; unreadCount: number; dismissedIds: string[] } | null> {
  const isGuest = !userId || typeof userId !== 'string' || !userId.trim();
  const serverData = await fetchAnnouncementsFromServer(userId);
  if (!serverData) return null;

  const primaryKey = getAnnouncementStorageKey(userId);
  const localDismissed = getDismissedAnnouncementIds(userId);
  const serverDismissed = serverData.dismissedIds;

  // Union merge of local and remote state
  const mergedSet = new Set([...serverDismissed, ...localDismissed]);
  const mergedList = Array.from(mergedSet);

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(primaryKey, JSON.stringify(mergedList));
      if (isGuest) {
        window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(mergedList));
      }
    } catch {}
  }

  // For authenticated accounts, reconcile local dismissals that have not yet reached the server
  if (!isGuest) {
    const missingOnServer = localDismissed.filter(id => !serverDismissed.includes(id));
    const pendingIds = Array.from(new Set([...getPendingAnnouncementSyncIds(userId), ...missingOnServer]));

    for (const pendingId of pendingIds) {
      try {
        const res = await fetch('/api/announcements/dismiss', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(userId ? { 'x-user-id': userId } : {})
          },
          body: JSON.stringify({ id: pendingId })
        });
        if (res.ok) {
          removePendingAnnouncementSync(pendingId, userId);
        }
      } catch {
        // Preserved in pending queue for future retry
      }
    }
  }

  const unreadCount = serverData.announcements.filter(a => !mergedSet.has(a.id)).length;
  return {
    announcements: serverData.announcements,
    unreadCount,
    dismissedIds: mergedList
  };
}
