import { randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';

export type BrowserLeaseMode = 'BOT' | 'HUMAN';
export interface BrowserLease {
  sessionId: string;
  ownerId: string;
  holder: string;
  mode: BrowserLeaseMode;
  fence: number;
  expiresAt: number;
}
const ttl = (ms: number) => {
  if (!Number.isInteger(ms) || ms < 1000 || ms > 120000) throw new Error('BROWSER_LEASE_TTL_INVALID');
  return ms;
};
function fromRow(row: any): BrowserLease {
  return {
    sessionId: row.id, ownerId: row.owner_id,
    holder: row.holder, mode: row.lease_mode,
    fence: Number(row.fence), expiresAt: Number(row.lease_until)
  };
}
/**
 * Persisted control plane for the existing AIRA Bot Docker browser provider.
 * No cookie/profile bytes or authentication secrets ever enter PostgreSQL.
 * The *worker* must also enforce the fence before each browser mutation:
 * checking here alone cannot prove a remote action was fenced.
 */
export class DurableBrowserSessions {
  async create(ownerId: string, runId: string, workspaceId?: string): Promise<string> {
    if (!ownerId || !runId) throw new Error('BROWSER_IDENTITY_REQUIRED');
    const run = await db('runs').select('principal_id','workspace_id').where({ id: runId }).first();
    if (!run || run.principal_id !== ownerId ||
        (workspaceId && run.workspace_id !== workspaceId)) {
      throw new Error('BROWSER_RUN_OWNER_MISMATCH');
    }
    const id = 'bs_' + randomUUID();
    const now = Date.now();
    await db('v2_browser_sessions').insert({
      id, owner_id: ownerId, workspace_id: workspaceId || run.workspace_id || null,
      state: 'STOPPED', fence: 0, created_at: now, updated_at: now
    });
    return id;
  }

  async read(ownerId: string, sessionId: string): Promise<{
    id: string; state: string; mode: string | null; fence: number;
    expiresAt: number | null; observedUrl: string | null
  } | undefined> {
    const row = await db('v2_browser_sessions').where({id: sessionId, owner_id: ownerId}).first();
    if (!row) return undefined;
    return {
      id: row.id, state: row.state, mode: row.lease_mode || null,
      fence: Number(row.fence), expiresAt: row.lease_until ? Number(row.lease_until) : null,
      observedUrl: row.observed_url || null
    };
  }

  async claimBot(ownerId: string, sessionId: string, worker: string, ttlMs = 30000): Promise<BrowserLease> {
    ttl(ttlMs);
    if (!worker || worker.length > 160) throw new Error('BROWSER_WORKER_REQUIRED');
    const now = Date.now();
    // UPDATE ... WHERE predicate is atomic across every API/worker process.
    const rows = await db('v2_browser_sessions')
      .where({ id: sessionId, owner_id: ownerId })
      .whereNot('state','CLOSED')
      .andWhere(q => q.whereNull('lease_until').orWhere('lease_until','<',now))
      .update({
        holder: worker, lease_mode:'BOT', lease_until:now+ttlMs,
        fence:db.raw('fence + 1'), state:'RUNNING', updated_at:now
      }).returning('*');
    if (rows.length !== 1) throw new Error('BROWSER_LEASE_HELD_OR_SESSION_UNAVAILABLE');
    return fromRow(rows[0]);
  }

  async takeover(ownerId: string, sessionId: string, authenticatedHuman: string, ttlMs = 60000): Promise<BrowserLease> {
    ttl(ttlMs);
    if (!authenticatedHuman || authenticatedHuman !== ownerId) throw new Error('BROWSER_HUMAN_OWNER_REQUIRED');
    const now=Date.now();
    const rows=await db('v2_browser_sessions')
      .where({id:sessionId,owner_id:ownerId})
      .whereNot('state','CLOSED')
      .update({
        holder:authenticatedHuman, lease_mode:'HUMAN', lease_until:now+ttlMs,
        fence:db.raw('fence + 1'), state:'SUSPENDED', updated_at:now
      }).returning('*');
    if(rows.length!==1)throw new Error('BROWSER_SESSION_NOT_FOUND');
    return fromRow(rows[0]);
  }

  async assertLease(lease: BrowserLease, mode: BrowserLeaseMode = lease.mode): Promise<void> {
    const row=await db('v2_browser_sessions')
      .where({id:lease.sessionId,owner_id:lease.ownerId,holder:lease.holder,lease_mode:mode,fence:lease.fence})
      .where('lease_until','>',Date.now()).whereNot('state','CLOSED').first();
    if(!row)throw new Error('BROWSER_STALE_OR_UNAUTHORIZED_LEASE');
  }

  async renew(lease: BrowserLease, ttlMs = 30000): Promise<BrowserLease> {
    ttl(ttlMs);
    const now=Date.now();
    const rows=await db('v2_browser_sessions').where({
      id:lease.sessionId,owner_id:lease.ownerId,holder:lease.holder,
      lease_mode:lease.mode,fence:lease.fence
    }).where('lease_until','>',now).whereNot('state','CLOSED')
      .update({lease_until:now+ttlMs,updated_at:now}).returning('*');
    if(rows.length!==1)throw new Error('BROWSER_STALE_OR_UNAUTHORIZED_LEASE');
    return fromRow(rows[0]);
  }

  async recordObservation(lease: BrowserLease, observedUrl: string): Promise<void> {
    if (typeof observedUrl !== 'string' || observedUrl.length > 2048 ||
      !/^https?:\/\//i.test(observedUrl)) throw new Error('BROWSER_INVALID_OBSERVATION');
    const now=Date.now();
    const updated=await db('v2_browser_sessions').where({
      id:lease.sessionId,owner_id:lease.ownerId,holder:lease.holder,
      lease_mode:lease.mode,fence:lease.fence
    }).where('lease_until','>',now).whereNot('state','CLOSED')
      .update({observed_url:observedUrl,updated_at:now});
    if(updated!==1)throw new Error('BROWSER_STALE_OR_UNAUTHORIZED_LEASE');
  }

  async release(lease: BrowserLease): Promise<void> {
    const updated=await db('v2_browser_sessions').where({
      id:lease.sessionId,owner_id:lease.ownerId,holder:lease.holder,
      fence:lease.fence,lease_mode:lease.mode
    }).where('lease_until','>',Date.now()).update({
      holder:null,lease_mode:null,lease_until:null,
      state:'SUSPENDED',fence:db.raw('fence + 1'),updated_at:Date.now()
    });
    if(updated!==1)throw new Error('BROWSER_STALE_OR_UNAUTHORIZED_LEASE');
  }

  async close(ownerId: string, sessionId: string): Promise<void> {
    const updated=await db('v2_browser_sessions').where({id:sessionId,owner_id:ownerId})
      .update({
        state:'CLOSED', holder:null,lease_mode:null,lease_until:null,
        fence:db.raw('fence + 1'),profile_ref:null,updated_at:Date.now()
      });
    if(updated!==1)throw new Error('BROWSER_SESSION_NOT_FOUND');
    // Closing the record is *not* evidence that a remote profile was deleted.
    // Worker-side profile deletion must be separately attested.
  }
}
