import type { MultiFileArtifactBundle, WorkspaceSyncResult } from '../types/multiFileArtifact';
import { neonAuth } from '../lib/neonAuth';
import { normalizeAndValidateArtifactPath } from './artifactPathSecurity';

const WORKSPACE_STORAGE_KEY_PREFIX = 'aira_workspace_synced_v1_';

/**
 * Persists an artifact bundle into the local workspace storage with strict identity isolation.
 * In local prototype mode, this operates on client-side sandboxed storage.
 * Direct remote database and worker mutations remain strictly guarded and blocked.
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

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(payload));
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
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
