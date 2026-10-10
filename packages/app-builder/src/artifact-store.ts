import { createHash } from 'node:crypto';
import { db } from '../../db/src/index.js';

const MAX_ARCHIVE = 1_500_000;
const table = 'aira_app_build_archives';
export interface StoredSourceArchive {
  queueJobId: string;
  ownerId: string;
  runId: string;
  workerJobId: string;
  sha256: string;
  archive: Buffer;
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const validOwner = (value: string) => /^[a-zA-Z0-9_:.-]{1,160}$/.test(value);

/** Immutable, DB-backed source export for bounded staging artifacts.
 * This is not a scalable replacement for an encrypted object store.
 */
export class PostgresBuildArchiveStore {
  async save(input: Omit<StoredSourceArchive, 'sha256'>): Promise<StoredSourceArchive> {
    if (!validId(input.queueJobId) || !validId(input.workerJobId) ||
        !validOwner(input.ownerId) || !validOwner(input.runId) ||
        !Buffer.isBuffer(input.archive) || input.archive.byteLength === 0 ||
        input.archive.byteLength > MAX_ARCHIVE) throw new Error('INVALID_BUILD_ARCHIVE_INPUT');
    const sha256 = digest(input.archive);
    return db.transaction(async trx => {
      await trx(table).insert({
        queue_job_id: input.queueJobId, owner_id: input.ownerId,
        run_id: input.runId, worker_job_id: input.workerJobId,
        sha256, archive: input.archive, byte_length: input.archive.byteLength
      }).onConflict('queue_job_id').ignore();
      const row = await trx(table).where({ queue_job_id: input.queueJobId }).first();
      if (!row || row.owner_id !== input.ownerId || row.worker_job_id !== input.workerJobId ||
          row.run_id !== input.runId || row.sha256 !== sha256 ||
          Number(row.byte_length) !== input.archive.byteLength) {
        throw new Error('BUILD_ARCHIVE_IMMUTABILITY_CONFLICT');
      }
      const existing = Buffer.from(row.archive);
      if (digest(existing) !== sha256) throw new Error('BUILD_ARCHIVE_INTEGRITY_FAILED');
      return { ...input, sha256, archive: existing };
    });
  }
  async get(queueJobId: string, ownerId: string): Promise<StoredSourceArchive | undefined> {
    if (!validId(queueJobId) || !validOwner(ownerId)) return undefined;
    const row = await db(table).where({ queue_job_id: queueJobId, owner_id: ownerId }).first();
    if (!row) return undefined;
    const archive = Buffer.from(row.archive);
    if (archive.byteLength !== Number(row.byte_length) || digest(archive) !== row.sha256) {
      throw new Error('BUILD_ARCHIVE_INTEGRITY_FAILED');
    }
    return {
      queueJobId, ownerId, runId: row.run_id, workerJobId: row.worker_job_id,
      sha256: row.sha256, archive
    };
  }
}
