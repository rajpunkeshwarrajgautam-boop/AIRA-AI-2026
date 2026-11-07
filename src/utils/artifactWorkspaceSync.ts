import type { MultiFileArtifactBundle, WorkspaceSyncResult } from '../types/multiFileArtifact';
import { neonAuth } from '../lib/neonAuth';
import { normalizeAndValidateArtifactPath } from './artifactPathSecurity';
import { idbGet, idbSet, STORES, isIndexedDbSupported } from './indexedDbStorage';
import { markWorkspaceKeyVerifiedInIdb } from './storage';

const WORKSPACE_STORAGE_KEY_PREFIX = 'aira_workspace_synced_v1_';

const inMemoryWorkspaces = new Map<string, unknown>();

/**
 * Persists an artifact bundle into the local workspace storage with strict identity isolation.
 * Uses high-capacity IndexedDB to prevent LocalStorage quota exhaustion while maintaining
 * in-memory fallback and safe LocalStorage compatibility.
 */
export async function syncBundleToWorkspace(
  bundle: MultiFileArtifactBundle,
  targetWorkspaceId?: string
): Promise<WorkspaceSyncResult> {
  const timestamp = Date.now();
  const currentUser = neonAuth.getCurrentUser();
  const userId = currentUser?.id || 'guest';
  const effectiveWorkspaceId = targetWorkspaceId || `ws_${bundle.id}`;

  try {
    // 1. Verify all file paths before sync
    const validatedFiles: Record<string, { path: string; sizeBytes: number; lastModified: number }> = {};
    for (const [path, file] of Object.entries(bundle.files)) {
      const validPath = normalizeAndValidateArtifactPath(path);
      validatedFiles[validPath] = {
        path: validPath,
        sizeBytes: file.sizeBytes,
        lastModified: file.lastModified,
      };
    }

    // 2. Client-side isolated persistence
    const key = `${WORKSPACE_STORAGE_KEY_PREFIX}${userId}_${effectiveWorkspaceId}`;
    const payload = {
      projectId: bundle.id,
      title: bundle.title,
      entryPoint: bundle.entryPoint,
      files: bundle.files,
      manifest: bundle.manifest,
      syncedAt: timestamp,
      userId,
    };

    // Cache in memory for immediate access
    inMemoryWorkspaces.set(key, payload);

    // Save to high-capacity IndexedDB
    if (isIndexedDbSupported()) {
      await idbSet(STORES.WORKSPACES, key, payload);
      markWorkspaceKeyVerifiedInIdb(key);
    }

    // Optional safe LocalStorage attempt (swallows QuotaExceededError without data loss)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // Quota exceeded: safely ignore because payload is already stored in IndexedDB and in-memory cache
      }
    }

    return {
      success: true,
      syncedFilesCount: Object.keys(validatedFiles).length,
      targetWorkspaceId: effectiveWorkspaceId,
      timestamp,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err || 'Unknown sync error');
    return {
      success: false,
      syncedFilesCount: 0,
      targetWorkspaceId: effectiveWorkspaceId,
      timestamp,
      error: message,
    };
  }
}

/**
 * Reads any previously synced workspace payload for inspection.
 */
export function getSyncedWorkspace(workspaceId: string): unknown | null {
  const currentUser = neonAuth.getCurrentUser();
  const userId = currentUser?.id || 'guest';
  const key = `${WORKSPACE_STORAGE_KEY_PREFIX}${userId}_${workspaceId}`;

  // Check in-memory cache first
  if (inMemoryWorkspaces.has(key)) {
    return inMemoryWorkspaces.get(key) || null;
  }

  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      inMemoryWorkspaces.set(key, parsed);
      return parsed;
    }
  } catch {
    // Non-blocking
  }
  return null;
}

/**
 * Asynchronously retrieves synced workspace with IndexedDB lookup.
 */
export async function getSyncedWorkspaceAsync(workspaceId: string): Promise<unknown | null> {
  const currentUser = neonAuth.getCurrentUser();
  const userId = currentUser?.id || 'guest';
  const key = `${WORKSPACE_STORAGE_KEY_PREFIX}${userId}_${workspaceId}`;

  const cached = getSyncedWorkspace(workspaceId);
  if (cached) return cached;

  if (isIndexedDbSupported()) {
    try {
      const idbData = await idbGet(STORES.WORKSPACES, key);
      if (idbData) {
        inMemoryWorkspaces.set(key, idbData);
        return idbData;
      }
    } catch {
      // Non-blocking
    }
  }

  return null;
}
