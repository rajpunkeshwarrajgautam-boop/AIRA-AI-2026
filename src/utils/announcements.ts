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
 * and first-view popup evaluation.
 */

const LEGACY_STORAGE_KEY = 'aira_seen_announcements';

export function getAnnouncementStorageKey(userId?: string | null): string {
  const scope = (userId && typeof userId === 'string' && userId.trim()) ? userId.trim() : 'guest';
  return `aira_dismissed_announcements_${scope}`;
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

  // Best-effort asynchronous server sync
  void (async () => {
    try {
      await fetch('/api/announcements/dismiss', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userId ? { 'x-user-id': userId } : {})
        },
        body: JSON.stringify({ id })
      });
    } catch {
      // Offline or server unavailable - local persistence already succeeded
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
    if (isGuest) {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('[Announcements] Failed to clear dismissed announcements:', err);
  }
}

/**
 * Calculate the count of unread announcements applicable to the given tier.
 */
export function getUnreadAnnouncementCount(tier: PlanTier = 'free', userId?: string | null): number {
  const dismissed = new Set(getDismissedAnnouncementIds(userId));
  const available = getAnnouncementsForTier(tier);
  const now = Date.now();

  return available.filter(a => {
    if (dismissed.has(a.id)) return false;
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
  announcementsEnabled: boolean = true
): Announcement | null {
  if (!announcementsEnabled) return null;

  const available = getAnnouncementsForTier(tier);
  if (!available || available.length === 0) return null;

  const dismissed = new Set(getDismissedAnnouncementIds(userId));
  const now = Date.now();

  // Sort available newest first
  const sorted = [...available]
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
