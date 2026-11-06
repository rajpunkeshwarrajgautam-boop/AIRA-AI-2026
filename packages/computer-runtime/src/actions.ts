import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';
import { currentComputerAction } from './action-context.js';
import type { ComputerProvider } from './provider.js';
import { distributedRuntime } from './distributed.js';

const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
export class DurableComputerActions {
  async execute<T>(ownerId: string, botId: string, provider: string, operation: string, args: unknown, execute: () => Promise<T>): Promise<T> {
    const authority = currentComputerAction();
    if (!authority || authority.lease.ownerId !== ownerId || authority.lease.botId !== botId) throw new Error('COMPUTER_LEASE_LOST');
    const fingerprint = createHash('sha256').update(operation + '\n' + JSON.stringify(args)).digest('hex');
    const prepared = await db.transaction(async trx => {
      if (authority.runId) {
        const run = await trx('runs').where({ id: authority.runId }).forUpdate().first();
        const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
        if (!run || run.execution_owner !== authority.execution?.owner || Number(run.execution_fence) !== authority.execution?.fence ||
          Number(run.execution_lease_until) <= now || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state) || run.context_data?.humanTakeover) throw new Error('EXECUTION_LEASE_LOST');
        authority.execution!.leaseUntil = Number(run.execution_lease_until);
      }
      const lease = await trx('aira_computer_leases').where({ owner_id: ownerId }).forUpdate().first();
      const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
      if (!lease || lease.token !== authority.lease.token || Number(lease.fence) !== authority.lease.fence || Number(lease.lease_until) <= now) throw new Error('COMPUTER_LEASE_LOST');
      const existing = await trx('aira_computer_actions').where({ id: authority.actionId }).first();
      if (existing) {
        if (existing.owner_id !== ownerId || existing.bot_id !== botId || existing.fingerprint !== fingerprint) throw new Error('ACTION_ID_CONFLICT');
        if (existing.status === 'COMPLETED') return existing;
        throw new Error('COMPUTER_ACTION_UNCERTAIN');
      }
      if (await trx('aira_computer_actions').where({ owner_id: ownerId }).whereIn('status', ['STARTED', 'AMBIGUOUS']).first()) throw new Error('COMPUTER_ACTION_UNCERTAIN');
      await trx('aira_computer_actions').insert({
        id: authority.actionId, owner_id: ownerId, bot_id: botId, provider, operation, fingerprint,
        status: 'STARTED', lease_token: authority.lease.token, lease_fence: authority.lease.fence,
        run_id: authority.runId || null, execution_owner: authority.execution?.owner || null,
        execution_fence: authority.execution?.fence || null, created_at: now
      });
      return undefined;
    });
    if (prepared) {
      if (prepared.error) throw new Error(prepared.error);
      return json(prepared.result) as T;
    }
    try {
      const result = await execute();
      await this.complete(authority.actionId, result);
      return result;
    } catch (error) {
      // A transport or persistence failure cannot tell whether an external
      // effect happened. Keep the durable guard; never retry the effect here.
      await db('aira_computer_actions').where({ id: authority.actionId, status: 'STARTED' })
        .update({ status: 'AMBIGUOUS', error: (error as Error).message.slice(0, 4000) }).catch(() => {});
      throw error;
    }
  }

  async complete(id: string, result: unknown, error?: string): Promise<void> {
    await db.transaction(async trx => {
      const action = await trx('aira_computer_actions').where({ id }).forUpdate().first();
      if (!action || !['STARTED', 'AMBIGUOUS'].includes(action.status)) return;
      const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
      await trx('aira_computer_actions').where({ id }).update({
        status: 'COMPLETED', result: JSON.stringify(result ?? null), error: error?.slice(0, 4000) || null, completed_at: now
      });
      await trx('aira_runtime_outbox').insert({
        id: randomUUID(), topic: 'computer.action.completed', aggregate_id: action.owner_id,
        dedupe_key: 'action:' + id, payload: JSON.stringify({ ownerId: action.owner_id, botId: action.bot_id, actionId: id, operation: action.operation, error: error || null }),
        status: 'PENDING', attempts: 0, available_at: now, created_at: now
      }).onConflict('dedupe_key').ignore();
      await trx('aira_computer_leases').where({ owner_id: action.owner_id, token: action.lease_token, fence: action.lease_fence })
        .where('holder_id', 'like', 'control:%').update({ lease_until: 0 });
    });
  }

  async recover(provider: ComputerProvider): Promise<void> {
    if (!provider.actionReceipt) return;
    const actions = await db('aira_computer_actions').where({ provider: provider.kind || 'local' }).whereIn('status', ['STARTED', 'AMBIGUOUS']).limit(50);
    for (const action of actions) {
      try {
        const receipt = await provider.actionReceipt(action.owner_id, action.id);
        if (receipt?.status === 'COMPLETED') await this.complete(action.id, receipt.result, receipt.error);
      } catch { /* Leave uncertainty guarded while the runner is unreachable. */ }
    }
  }

  async unresolved(ownerId: string, botId: string) {
    return db('aira_computer_actions').where({ owner_id: ownerId, bot_id: botId }).whereIn('status', ['STARTED', 'AMBIGUOUS'])
      .select('id', 'operation', 'status', 'error', 'created_at');
  }

  async acknowledge(ownerId: string, botId: string, id: string, provider: ComputerProvider): Promise<boolean> {
    const action = await db('aira_computer_actions').where({ owner_id: ownerId, bot_id: botId, id }).first();
    if (!action || !['STARTED', 'AMBIGUOUS'].includes(action.status)) return false;
    // Durable runner revocation serializes with any active operation and rejects
    // delayed requests bearing this ID. Host-local execution cannot prove that.
    if (!provider.revokeAction) throw new Error('Runner revocation is required to acknowledge an uncertain action.');
    await provider.revokeAction(ownerId, id);
    return (await db('aira_computer_actions').where({ id }).whereIn('status', ['STARTED', 'AMBIGUOUS'])
      .update({ status: 'ABANDONED', error: 'Owner acknowledged possible side effect; runner revoked replay.' })) === 1;
  }
}
export const computerActions = new DurableComputerActions();

export class RuntimeOutboxPublisher {
  readonly workerId = 'publisher:' + randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => console.error('[RuntimeOutbox]', error)), 750);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const record of await distributedRuntime.claimOutbox(this.workerId)) {
        try {
          if (!['computer.action.completed', 'computer.reconciled'].includes(record.topic)) throw new Error('Unsupported outbox topic: ' + record.topic);
          const payload = record.payload as any;
          await db.transaction(async trx => {
            // The outbox row serializes redelivery. source_key keeps delivery
            // idempotent even if the acknowledgement is lost or reclaimed.
            await trx('aira_runtime_outbox').where({ id: record.id }).forUpdate().first();
            if (await trx('aira_computer_events').where({ source_key: record.dedupeKey }).first()) return;
            const result = await trx.raw('INSERT INTO aira_computer_event_sequences(owner_id, sequence) VALUES (?, 1) ON CONFLICT(owner_id) DO UPDATE SET sequence=aira_computer_event_sequences.sequence+1 RETURNING sequence', [payload.ownerId]);
            const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
            await trx('aira_computer_events').insert({
              owner_id: payload.ownerId, bot_id: payload.botId || '__reconciler__',
              sequence: Number(result.rows[0].sequence), type: record.topic,
              data: JSON.stringify(payload), created_at: now, source_key: record.dedupeKey
            });
          });
          await distributedRuntime.completeOutbox(record.id, this.workerId, record.attempts);
        } catch (error) {
          const now = Number((await db.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
          await distributedRuntime.failOutbox(record.id, this.workerId, record.attempts, (error as Error).message, now + Math.min(60000, 1000 * 2 ** Math.min(record.attempts, 6)));
        }
      }
    } finally { this.running = false; }
  }
}
