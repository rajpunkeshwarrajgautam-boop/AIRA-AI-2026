import { createHash } from 'node:crypto';
import { db } from '../../db/src/index.js';

export interface WorkspaceAuthorityRepository {
  /** Resolve the principal's server-owned personal workspace, provisioning it once if absent. */
  resolveWorkspace(principalId: string): Promise<string>;
  /** Check live authorization; unlike resolveWorkspace, this never provisions missing authority. */
  isWorkspaceActive(principalId: string, workspaceId: string): Promise<boolean>;
  /** Administrative revocation primitive. Revoked records are never recreated by resolveWorkspace. */
  revokeWorkspace(principalId: string): Promise<boolean>;
}

export function derivePersonalWorkspaceId(principalId: string): string {
  if (typeof principalId !== 'string' || !principalId.trim() || principalId.length > 255) {
    throw new Error('Workspace authority requires a valid authenticated principal ID.');
  }
  const digest = createHash('sha256').update(principalId).digest('hex');
  return `ws_personal_${digest}`;
}

function assertActiveAuthority(row: any): string {
  if (!row || row.state !== 'ACTIVE' || row.revoked_at != null || !row.workspace_id) {
    throw new Error('Authenticated principal has no active workspace authority.');
  }
  return String(row.workspace_id);
}

export class PostgresWorkspaceAuthorityRepository implements WorkspaceAuthorityRepository {
  async resolveWorkspace(principalId: string): Promise<string> {
    const derivedWorkspaceId = derivePersonalWorkspaceId(principalId);
    const existing = await db('principal_workspace_authorities').where({ principal_id: principalId }).first();
    if (existing) return assertActiveAuthority(existing);

    const now = Date.now();
    await db('principal_workspace_authorities').insert({
      principal_id: principalId,
      workspace_id: derivedWorkspaceId,
      state: 'ACTIVE',
      created_at: now,
      updated_at: now,
      revoked_at: null
    }).onConflict('principal_id').ignore();

    // Re-read after insert to handle concurrent first-authentication requests. A
    // concurrent revocation or a conflicting workspace binding fails closed.
    const persisted = await db('principal_workspace_authorities').where({ principal_id: principalId }).first();
    const workspaceId = assertActiveAuthority(persisted);
    if (workspaceId !== derivedWorkspaceId) {
      throw new Error('Authenticated principal workspace authority conflicts with its server-derived personal workspace.');
    }
    return workspaceId;
  }

  async isWorkspaceActive(principalId: string, workspaceId: string): Promise<boolean> {
    if (!principalId || !workspaceId) return false;
    const row = await db('principal_workspace_authorities')
      .where({ principal_id: principalId, workspace_id: workspaceId, state: 'ACTIVE' })
      .whereNull('revoked_at')
      .first('principal_id');
    return Boolean(row);
  }

  async revokeWorkspace(principalId: string): Promise<boolean> {
    if (!principalId) return false;
    const workspaceId = derivePersonalWorkspaceId(principalId);
    const now = Date.now();
    // Use one upsert so revocation wins a first-provision race and leaves a
    // tombstone even when this principal did not yet have an authority row.
    const result = await db.raw(`
      INSERT INTO principal_workspace_authorities
        (principal_id, workspace_id, state, created_at, updated_at, revoked_at)
      VALUES (?, ?, 'REVOKED', ?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET
        state = 'REVOKED', revoked_at = EXCLUDED.revoked_at, updated_at = EXCLUDED.updated_at
      WHERE principal_workspace_authorities.state <> 'REVOKED'
      RETURNING principal_id
    `, [principalId, workspaceId, now, now, now]);
    return (result.rows?.length || 0) === 1;
  }
}

/** In-memory authority store for isolated unit tests and database-free local development only. */
export class InMemoryWorkspaceAuthorityRepository implements WorkspaceAuthorityRepository {
  private readonly authorities = new Map<string, { workspaceId: string; revokedAt?: number }>();

  async resolveWorkspace(principalId: string): Promise<string> {
    const existing = this.authorities.get(principalId);
    if (existing) {
      if (existing.revokedAt !== undefined) throw new Error('Authenticated principal has no active workspace authority.');
      return existing.workspaceId;
    }
    const workspaceId = derivePersonalWorkspaceId(principalId);
    this.authorities.set(principalId, { workspaceId });
    return workspaceId;
  }

  async isWorkspaceActive(principalId: string, workspaceId: string): Promise<boolean> {
    const authority = this.authorities.get(principalId);
    return Boolean(authority && authority.revokedAt === undefined && authority.workspaceId === workspaceId);
  }

  async revokeWorkspace(principalId: string): Promise<boolean> {
    const authority = this.authorities.get(principalId);
    if (authority?.revokedAt !== undefined) return false;
    if (authority) authority.revokedAt = Date.now();
    else this.authorities.set(principalId, { workspaceId: derivePersonalWorkspaceId(principalId), revokedAt: Date.now() });
    return true;
  }
}

const requiresPersistentWorkspaceAuthority = Boolean(
  process.env.NODE_ENV === 'production' ||
  process.env.VERCEL_ENV ||
  process.env.AIRA_PERSISTENT_WORKSPACE_AUTHORITY === 'true' ||
  (process.env.NODE_ENV !== 'test' && process.env.DATABASE_URL?.trim())
);

/** Shared API/runtime authority resolver. Production always uses PostgreSQL and fails closed on DB errors. */
export const workspaceAuthority: WorkspaceAuthorityRepository = requiresPersistentWorkspaceAuthority
  ? new PostgresWorkspaceAuthorityRepository()
  : new InMemoryWorkspaceAuthorityRepository();
