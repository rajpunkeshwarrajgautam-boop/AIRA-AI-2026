import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../db/src/index.js';
import { PostgresObjectRefStore } from './object-ref-store.js';

const grantTable = 'aira_app_preview_grants';
const sha256 = (x: string) => createHash('sha256').update(x).digest('hex');
const uuid = /^[0-9a-f-]{36}$/;
const ticketPattern = /^[a-f0-9]{64}$/;

export interface PreviewGrant {
  queueJobId: string; ownerId: string; compiledSha256: string;
}

export class PreviewGrantStore {
  /** Caller must already have verified a real authenticated principal. */
  async issue(queueJobId: string, ownerId: string): Promise<string> {
    if (!uuid.test(queueJobId) || !ownerId || ownerId.length > 160) throw new Error('INVALID_PREVIEW_REQUEST');
    const job = await db('aira_app_build_jobs').where({ id: queueJobId, owner_id: ownerId }).first();
    if (!job || job.state !== 'COMPLETED') throw new Error('PREVIEW_BUILD_NOT_COMPLETE');
    const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
    if (!result || result.buildStatus !== 'BUILD_PASSED') throw new Error('PREVIEW_BUILD_NOT_VERIFIED');
    const compiled = await new PostgresObjectRefStore().get(queueJobId, ownerId, 'compiled');
    if (!compiled) throw new Error('PREVIEW_COMPILED_ARTIFACT_MISSING');
    const ticket = randomBytes(32).toString('hex');
    await db(grantTable).insert({
      ticket_hash: sha256(ticket), queue_job_id: queueJobId,
      owner_id: ownerId, compiled_sha256: compiled.sha256,
      expires_at: new Date(Date.now() + 5 * 60_000)
    });
    return ticket;
  }
  /** Gateway can resolve only an existing unrevoked, unexpired ticket. */
  async resolve(ticket: string): Promise<PreviewGrant | undefined> {
    if (!ticketPattern.test(ticket)) return undefined;
    const row = await db(grantTable).where({ ticket_hash: sha256(ticket) })
      .whereNull('revoked_at').andWhere('expires_at', '>', db.fn.now()).first();
    if (!row) return undefined;
    const job = await db('aira_app_build_jobs').where({
      id: row.queue_job_id, owner_id: row.owner_id, state: 'COMPLETED'
    }).first();
    if (!job) return undefined;
    const compiled = await new PostgresObjectRefStore().get(row.queue_job_id, row.owner_id, 'compiled');
    if (!compiled || compiled.sha256 !== row.compiled_sha256) return undefined;
    return {
      queueJobId: row.queue_job_id, ownerId: row.owner_id,
      compiledSha256: row.compiled_sha256
    };
  }
  async revoke(queueJobId: string, ownerId: string): Promise<number> {
    if (!uuid.test(queueJobId) || !ownerId || ownerId.length > 160) return 0;
    return db(grantTable).where({ queue_job_id: queueJobId, owner_id: ownerId })
      .whereNull('revoked_at').update({ revoked_at: db.fn.now() });
  }
}
