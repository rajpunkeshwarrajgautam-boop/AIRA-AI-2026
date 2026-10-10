import { db } from '../../db/src/index.js';
import type { ArtifactKind, ImmutableObjectRef } from './object-store.js';

const table = 'aira_app_build_object_refs';
const uuid = /^[a-f0-9-]{36}$/;
export class PostgresObjectRefStore {
  async save(queueJobId: string, ownerId: string, runId: string, kind: ArtifactKind,
    ref: ImmutableObjectRef): Promise<ImmutableObjectRef> {
    if (!uuid.test(queueJobId) || !ownerId || !runId || ownerId.length > 160 ||
        runId.length > 160 || !['source', 'compiled', 'test-evidence'].includes(kind) ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) || !ref.key.endsWith('/' + ref.sha256) ||
        ref.size <= 0 || ref.size > 32_000_000 || !Number.isSafeInteger(ref.size)) {
      throw new Error('INVALID_BUILD_OBJECT_REFERENCE');
    }
    await db.transaction(async trx => {
      const job = await trx('aira_app_build_jobs').where({
        id: queueJobId, owner_id: ownerId, project_id: runId
      }).first();
      if (!job) throw new Error('BUILD_OBJECT_OWNER_MISMATCH');
      await trx(table).insert({
        queue_job_id: queueJobId, owner_id: ownerId, run_id: runId, kind,
        object_key: ref.key, sha256: ref.sha256,
        byte_length: ref.size, content_type: ref.contentType
      }).onConflict(['queue_job_id', 'kind']).ignore();
      const row = await trx(table).where({ queue_job_id: queueJobId, kind }).first();
      if (!row || row.owner_id !== ownerId || row.run_id !== runId ||
          row.object_key !== ref.key || row.sha256 !== ref.sha256 ||
          Number(row.byte_length) !== ref.size || row.content_type !== ref.contentType) {
        throw new Error('BUILD_OBJECT_IMMUTABILITY_CONFLICT');
      }
    });
    return ref;
  }
  async get(queueJobId: string, ownerId: string, kind: ArtifactKind): Promise<ImmutableObjectRef | undefined> {
    if (!uuid.test(queueJobId) || !ownerId || ownerId.length > 160) return undefined;
    if (!['source', 'compiled', 'test-evidence'].includes(kind)) return undefined;
    const row = await db(table).where({
      queue_job_id: queueJobId, owner_id: ownerId, kind
    }).first();
    if (!row) return undefined;
    return {
      key: row.object_key, sha256: row.sha256,
      size: Number(row.byte_length), contentType: row.content_type
    };
  }
}
