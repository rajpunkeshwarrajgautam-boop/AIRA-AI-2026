import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { db } from '../../db/src/index.js';
import type { ExecutionPrincipal, Run } from '../../contracts/src/index.js';
import type { Bot } from './contracts.js';
import { BotRepository } from './repository.js';
import { PostgresRunRepository } from '../../agent-runtime/src/repositories.js';

const validTimezone = (value: string) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
};
const validCron = (value: string) => {
  try { CronExpressionParser.parse(value); return true; }
  catch { return false; }
};

export const DelegationInputSchema = z.object({
  targetBotId: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(16000)
}).strict();
export type DelegationInput = z.infer<typeof DelegationInputSchema>;

export const RoutineInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(16000),
  cronExpression: z.string().trim().min(1).max(120).refine(validCron, 'Invalid cron expression.'),
  timezone: z.string().trim().min(1).max(100).default('UTC').refine(validTimezone, 'Invalid IANA timezone.'),
  enabled: z.boolean().default(true)
}).strict();
export type RoutineInput = z.infer<typeof RoutineInputSchema>;

export interface BotDelegation {
  id: string;
  ownerId: string;
  parentBotId: string;
  targetBotId: string;
  parentRunId: string;
  childRunId: string;
  objective: string;
  status: 'STARTED' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BotRoutine extends RoutineInput {
  id: string;
  ownerId: string;
  botId: string;
  lastScheduledFor?: number;
  lastRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BotRoutineRun {
  dispatchSnapshot?: BotRoutine;
  dispatchToken?: string;
  dispatchFence?: number;
  id: string;
  routineId: string;
  ownerId: string;
  botId: string;
  runId?: string;
  scheduledFor: number;
  status: 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface BotNotification {
  id: string;
  ownerId: string;
  botId?: string;
  runId?: string;
  kind: 'routine_started' | 'routine_completed' | 'routine_failed' | 'delegation_started' | 'delegation_completed' | 'delegation_failed' | 'approval_required';
  title: string;
  message: string;
  readAt?: number;
  createdAt: number;
}

const runToDelegationStatus = (state: Run['state']): BotDelegation['status'] => {
  if (state === 'COMPLETED') return 'COMPLETED';
  if (state === 'FAILED') return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  if (state === 'WAITING_FOR_APPROVAL' || state === 'WAITING_FOR_TOOL') return 'WAITING';
  return 'STARTED';
};

export class BotOrchestrationRepository {
  async createDelegation(input: Omit<BotDelegation, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Promise<BotDelegation> {
    const now = Date.now();
    const record: BotDelegation = { ...input, id: `dlg_${randomUUID()}`, status: 'STARTED', createdAt: now, updatedAt: now };
    await db('aira_bot_delegations').insert({
      id: record.id, owner_id: record.ownerId, parent_bot_id: record.parentBotId, target_bot_id: record.targetBotId,
      parent_run_id: record.parentRunId, child_run_id: record.childRunId, objective: record.objective, status: record.status,
      created_at: now, updated_at: now
    });
    return record;
  }

  async getDelegation(ownerId: string, id: string): Promise<BotDelegation | undefined> {
    const row = await db('aira_bot_delegations').where({ owner_id: ownerId, id }).first();
    return row ? this.mapDelegation(row) : undefined;
  }

  async listDelegations(ownerId: string, botId: string): Promise<BotDelegation[]> {
    const rows = await db('aira_bot_delegations').where({ owner_id: ownerId }).andWhere(builder => builder.where('parent_bot_id', botId).orWhere('target_bot_id', botId)).orderBy('created_at', 'desc');
    return rows.map(row => this.mapDelegation(row));
  }

  async syncDelegation(ownerId: string, id: string, run: Run): Promise<BotDelegation | undefined> {
    const status = runToDelegationStatus(run.state);
    const now = Date.now();
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
    const rows = await db('aira_bot_delegations').where({ owner_id: ownerId, id }).update({ status, updated_at: now, completed_at: terminal ? now : null }).returning('*');
    return rows[0] ? this.mapDelegation(rows[0]) : undefined;
  }

  async createRoutine(ownerId: string, botId: string, input: RoutineInput): Promise<BotRoutine> {
    const now = Date.now();
    const routine: BotRoutine = { ...input, id: `routine_${randomUUID()}`, ownerId, botId, createdAt: now, updatedAt: now };
    await db('aira_bot_routines').insert({
      id: routine.id, owner_id: ownerId, bot_id: botId, name: input.name, objective: input.objective,
      cron_expression: input.cronExpression, timezone: input.timezone, enabled: input.enabled, created_at: now, updated_at: now
    });
    return routine;
  }

  async getRoutine(ownerId: string, id: string): Promise<BotRoutine | undefined> {
    const row = await db('aira_bot_routines').where({ owner_id: ownerId, id }).first();
    return row ? this.mapRoutine(row) : undefined;
  }

  async listRoutines(ownerId: string, botId?: string): Promise<BotRoutine[]> {
    let query = db('aira_bot_routines').where({ owner_id: ownerId });
    if (botId) query = query.andWhere({ bot_id: botId });
    const rows = await query.orderBy('created_at', 'desc');
    return rows.map(row => this.mapRoutine(row));
  }

  async listEnabledRoutines(): Promise<BotRoutine[]> {
    const rows = await db('aira_bot_routines').where({ enabled: true }).orderBy('created_at', 'asc');
    return rows.map(row => this.mapRoutine(row));
  }

  async updateRoutine(ownerId: string, id: string, input: RoutineInput): Promise<BotRoutine | undefined> {
    const rows = await db('aira_bot_routines').where({ owner_id: ownerId, id }).update({
      name: input.name, objective: input.objective, cron_expression: input.cronExpression, timezone: input.timezone,
      enabled: input.enabled, updated_at: Date.now()
    }).returning('*');
    return rows[0] ? this.mapRoutine(rows[0]) : undefined;
  }

  async deleteRoutine(ownerId: string, id: string): Promise<boolean> {
    return (await db('aira_bot_routines').where({ owner_id: ownerId, id }).delete()) > 0;
  }

  async claimRoutineSlot(routine: BotRoutine, scheduledFor: number): Promise<BotRoutineRun | undefined> {
    const record = {
      id: `rrun_${randomUUID()}`, routine_id: routine.id, owner_id: routine.ownerId, bot_id: routine.botId,
      scheduled_for: scheduledFor, status: 'CLAIMED', created_at: Date.now(), dispatch_snapshot: JSON.stringify(routine)
    };
    return db.transaction(async trx => {
      await trx('aira_bot_routine_runs').insert(record).onConflict(['routine_id', 'scheduled_for']).ignore();
      const slot = await trx('aira_bot_routine_runs').where({ routine_id: routine.id, scheduled_for: scheduledFor }).forUpdate().first();
      const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
      if (!slot || slot.status !== 'CLAIMED' || Number(slot.dispatch_until || 0) > now) return undefined;
      const dispatch = { dispatch_token: randomUUID(), dispatch_until: now + 30000, dispatch_fence: Number(slot.dispatch_fence || 0) + 1 };
      await trx('aira_bot_routine_runs').where({ id: slot.id }).update(dispatch);
      return this.mapRoutineRun({ ...slot, ...dispatch });
    });
  }

  async registerRoutineRun(claim: BotRoutineRun, routine: BotRoutine, run: Run): Promise<void> {
    await db.transaction(async trx => {
      const slot = await trx('aira_bot_routine_runs').where({ id: claim.id }).forUpdate().first();
      const now = Number((await trx.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
      if (!slot || slot.status !== 'CLAIMED' || slot.dispatch_token !== claim.dispatchToken ||
        Number(slot.dispatch_fence) !== claim.dispatchFence || Number(slot.dispatch_until) <= now) throw new Error('ROUTINE_DISPATCH_LEASE_LOST');
      await new PostgresRunRepository().saveRun(run, trx);
      await new BotRepository().recordTask(routine.ownerId, routine.botId, run.id, `[Routine: ${routine.name}] ${routine.objective}`, trx);
      await trx('aira_bot_routine_runs').where({ id: claim.id }).update({ run_id: run.id, status: 'RUNNING', dispatch_token: null, dispatch_until: null });
      await trx('aira_bot_routines').where({ id: routine.id, owner_id: routine.ownerId })
        .where(builder => builder.whereNull('last_scheduled_for').orWhere('last_scheduled_for', '<=', claim.scheduledFor))
        .update({ last_scheduled_for: claim.scheduledFor, last_run_id: run.id, updated_at: now });
    });
  }

  async attachRoutineRun(id: string, runId: string): Promise<void> {
    await db('aira_bot_routine_runs').where({ id }).update({ run_id: runId, status: 'RUNNING' });
  }

  async updateRoutineCursor(routine: BotRoutine, scheduledFor: number, runId?: string): Promise<void> {
    await db('aira_bot_routines').where({ id: routine.id, owner_id: routine.ownerId })
      .where(builder => builder.whereNull('last_scheduled_for').orWhere('last_scheduled_for', '<=', scheduledFor))
      .update({ last_scheduled_for: scheduledFor, last_run_id: runId || null, updated_at: Date.now() });
  }

  async failRoutineRun(id: string, error: string, claim?: BotRoutineRun): Promise<boolean> {
    let query = db('aira_bot_routine_runs').where({ id });
    if (claim) query = query.where({ status: 'CLAIMED', dispatch_token: claim.dispatchToken, dispatch_fence: claim.dispatchFence })
      .whereRaw('dispatch_until > floor(extract(epoch FROM clock_timestamp()) * 1000)');
    return (await query.update({ status: 'FAILED', error: error.slice(0, 4000), completed_at: Date.now() })) === 1;
  }

  async pendingRoutineSlots(routineId: string): Promise<number[]> {
    const rows = await db('aira_bot_routine_runs').where({ routine_id: routineId, status: 'CLAIMED' }).orderBy('scheduled_for');
    return rows.map(row => Number(row.scheduled_for));
  }

  async reconcileRoutineRun(id: string, run: Run): Promise<void> {
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    await db('aira_bot_routine_runs').where({ id }).update({ status: run.state, error: run.error || null, completed_at: run.completedAt || Date.now() });
  }

  async activeRoutineRuns(): Promise<BotRoutineRun[]> {
    const rows = await db('aira_bot_routine_runs').where({ status: 'RUNNING' }).whereNotNull('run_id');
    return rows.map(row => this.mapRoutineRun(row));
  }

  async routineRuns(ownerId: string, routineId: string): Promise<BotRoutineRun[]> {
    const rows = await db('aira_bot_routine_runs').where({ owner_id: ownerId, routine_id: routineId }).orderBy('scheduled_for', 'desc').limit(50);
    return rows.map(row => this.mapRoutineRun(row));
  }

  async notify(input: Omit<BotNotification, 'id' | 'createdAt'>): Promise<BotNotification> {
    const notification: BotNotification = { ...input, id: `note_${randomUUID()}`, createdAt: Date.now() };
    await db('aira_bot_notifications').insert({
      id: notification.id, owner_id: notification.ownerId, bot_id: notification.botId || null, run_id: notification.runId || null,
      kind: notification.kind, title: notification.title, message: notification.message, created_at: notification.createdAt
    });
    return notification;
  }

  async notifications(ownerId: string, unreadOnly = false): Promise<BotNotification[]> {
    let query = db('aira_bot_notifications').where({ owner_id: ownerId });
    if (unreadOnly) query = query.whereNull('read_at');
    const rows = await query.orderBy('created_at', 'desc').limit(100);
    return rows.map(row => ({
      id: row.id, ownerId: row.owner_id, botId: row.bot_id || undefined, runId: row.run_id || undefined,
      kind: row.kind, title: row.title, message: row.message, readAt: row.read_at ? Number(row.read_at) : undefined, createdAt: Number(row.created_at)
    }));
  }

  async markNotificationRead(ownerId: string, id: string): Promise<boolean> {
    return (await db('aira_bot_notifications').where({ owner_id: ownerId, id }).update({ read_at: Date.now() })) > 0;
  }

  private mapDelegation(row: any): BotDelegation {
    return { id: row.id, ownerId: row.owner_id, parentBotId: row.parent_bot_id, targetBotId: row.target_bot_id, parentRunId: row.parent_run_id, childRunId: row.child_run_id, objective: row.objective, status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), completedAt: row.completed_at ? Number(row.completed_at) : undefined };
  }
  private mapRoutine(row: any): BotRoutine {
    return { id: row.id, ownerId: row.owner_id, botId: row.bot_id, name: row.name, objective: row.objective, cronExpression: row.cron_expression, timezone: row.timezone, enabled: Boolean(row.enabled), lastScheduledFor: row.last_scheduled_for ? Number(row.last_scheduled_for) : undefined, lastRunId: row.last_run_id || undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  private mapRoutineRun(row: any): BotRoutineRun {
    return { id: row.id, routineId: row.routine_id, ownerId: row.owner_id, botId: row.bot_id, runId: row.run_id || undefined, scheduledFor: Number(row.scheduled_for), status: row.status, error: row.error || undefined, createdAt: Number(row.created_at), completedAt: row.completed_at ? Number(row.completed_at) : undefined, dispatchToken: row.dispatch_token || undefined, dispatchFence: Number(row.dispatch_fence || 0), dispatchSnapshot: typeof row.dispatch_snapshot === 'string' ? JSON.parse(row.dispatch_snapshot) : row.dispatch_snapshot };
  }
}

export interface BotRunExecutor {
  createAndExecuteRun(request: any, principal: ExecutionPrincipal, bot?: Bot, registerTask?: (run: Run) => Promise<void>, persist?: (run: Run) => Promise<void>): Promise<Run>;
  getRun(runId: string): Promise<Run | undefined>;
}

export class BotRoutineEngine {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly runtime: BotRunExecutor,
    private readonly repo = new BotOrchestrationRepository(),
    private readonly bots = new BotRepository(),
    private readonly isLeader?: () => Promise<boolean>
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => console.error('[BotRoutineEngine]', error)), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(now = Date.now()): Promise<void> {
    if (this.isLeader && !await this.isLeader()) return;
    await this.reconcile();
    for (const routine of await this.repo.listEnabledRoutines()) {
      try {
        const interval = CronExpressionParser.parse(routine.cronExpression, { currentDate: new Date(now), tz: routine.timezone });
        const latestSlot = interval.prev().getTime();
        const pending = await this.repo.pendingRoutineSlots(routine.id);
        for (const scheduledFor of [...new Set([...pending, latestSlot])].sort((a, b) => a - b)) {
        if (!pending.includes(scheduledFor) && routine.lastScheduledFor && routine.lastScheduledFor >= scheduledFor) continue;
        if (this.isLeader && !await this.isLeader()) return;
        const claim = await this.repo.claimRoutineSlot(routine, scheduledFor);
        if (!claim) continue;
        const dispatched = claim.dispatchSnapshot || routine;
        const bot = await this.bots.get(routine.ownerId, routine.botId);
        if (!bot) { await this.repo.failRoutineRun(claim.id, 'Routine bot no longer exists.', claim); continue; }
        try {
          const run = await this.runtime.createAndExecuteRun(
            { prompt: dispatched.objective, intent: 'AGENT_MISSION', modelPolicy: { model: bot.model }, context: { routineId: routine.id, scheduledFor } },
            { userId: routine.ownerId, sessionId: `routine:${routine.id}` },
            bot,
            undefined,
            async created => { await this.repo.registerRoutineRun(claim, dispatched, created); }
          );
          await this.repo.notify({ ownerId: routine.ownerId, botId: bot.id, runId: run.id, kind: 'routine_started', title: `${routine.name} started`, message: routine.objective });
        } catch (error) {
          const failed = await this.repo.failRoutineRun(claim.id, (error as Error).message, claim);
          if (!failed) continue;
          await this.repo.updateRoutineCursor(routine, scheduledFor);
          await this.repo.notify({ ownerId: routine.ownerId, botId: routine.botId, kind: 'routine_failed', title: `${routine.name} could not start`, message: (error as Error).message });
        }
        }
      } catch (error) { console.error(`[BotRoutineEngine] routine ${routine.id}:`, (error as Error).message); }
    }
  }

  private async reconcile(): Promise<void> {
    for (const record of await this.repo.activeRoutineRuns()) {
      if (!record.runId) continue;
      const run = await this.runtime.getRun(record.runId);
      if (!run || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) continue;
      await this.repo.reconcileRoutineRun(record.id, run);
      await this.repo.notify({
        ownerId: record.ownerId, botId: record.botId, runId: run.id,
        kind: run.state === 'COMPLETED' ? 'routine_completed' : 'routine_failed',
        title: run.state === 'COMPLETED' ? 'Routine completed' : 'Routine needs attention',
        message: run.state === 'COMPLETED' ? 'Scheduled Aira Bot work completed.' : (run.error || `Routine run ${run.state.toLowerCase()}.`)
      });
    }
  }
}
