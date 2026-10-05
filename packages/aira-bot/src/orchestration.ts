import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { db } from '../../db/src/index.js';
import { insertOutbox, RuntimeLeaseRepository, runtimeNodeId, type RuntimeLease } from '../../runtime-reliability/src/index.js';
import type { ExecutionPrincipal, Run } from '../../contracts/src/index.js';
import type { Bot } from './contracts.js';
import { BotRepository } from './repository.js';

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
  id: string;
  routineId: string;
  ownerId: string;
  botId: string;
  runId?: string;
  scheduledFor: number;
  status: 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error?: string;
  schedulerOwner?: string;
  schedulerFence?: number;
  claimedAt?: number;
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

export interface BotRoutineEngineStatus {
  nodeId: string;
  isLeader: boolean;
  leaderFence?: number;
  leaseUntil?: number;
  lastTickAt?: number;
  lastLeadershipAt?: number;
  lastError?: string;
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

  async claimRoutineSlot(routine: BotRoutine, scheduledFor: number, schedulerOwner = 'manual', schedulerFence = 0): Promise<BotRoutineRun | undefined> {
    const now = Date.now();
    const record = {
      id: `rrun_${randomUUID()}`, routine_id: routine.id, owner_id: routine.ownerId, bot_id: routine.botId,
      scheduled_for: scheduledFor, status: 'CLAIMED', scheduler_owner: schedulerOwner, scheduler_fence: schedulerFence,
      claimed_at: now, created_at: now
    };
    const rows = await db('aira_bot_routine_runs').insert(record).onConflict(['routine_id', 'scheduled_for']).ignore().returning('*');
    return rows[0] ? this.mapRoutineRun(rows[0]) : undefined;
  }

  async recoverableRoutineClaims(staleBefore: number): Promise<BotRoutineRun[]> {
    const rows = await db('aira_bot_routine_runs')
      .where({ status: 'CLAIMED' })
      .whereNull('run_id')
      .andWhere('claimed_at', '<', staleBefore)
      .orderBy('claimed_at', 'asc');
    return rows.map(row => this.mapRoutineRun(row));
  }

  async claimStaleRoutineRun(id: string, schedulerOwner: string, schedulerFence: number, staleBefore: number): Promise<BotRoutineRun | undefined> {
    const rows = await db('aira_bot_routine_runs')
      .where({ id, status: 'CLAIMED' })
      .whereNull('run_id')
      .andWhere('claimed_at', '<', staleBefore)
      .update({ scheduler_owner: schedulerOwner, scheduler_fence: schedulerFence, claimed_at: Date.now() })
      .returning('*');
    return rows[0] ? this.mapRoutineRun(rows[0]) : undefined;
  }

  async findRoutineExecution(routineId: string, scheduledFor: number): Promise<string | undefined> {
    const row = await db('runs')
      .whereRaw("context_data->>'routineId' = ?", [routineId])
      .andWhereRaw("context_data->>'scheduledFor' = ?", [String(scheduledFor)])
      .orderBy('createdAt', 'asc')
      .first('id');
    return row?.id;
  }

  async attachRoutineRun(id: string, runId: string, schedulerOwner?: string, schedulerFence?: number): Promise<boolean> {
    let query = db('aira_bot_routine_runs').where({ id, status: 'CLAIMED' });
    if (schedulerOwner !== undefined) query = query.andWhere({ scheduler_owner: schedulerOwner });
    if (schedulerFence !== undefined) query = query.andWhere({ scheduler_fence: schedulerFence });
    return (await query.update({ run_id: runId, status: 'RUNNING' })) > 0;
  }

  async updateRoutineCursor(routine: BotRoutine, scheduledFor: number, runId?: string): Promise<void> {
    await db('aira_bot_routines').where({ id: routine.id, owner_id: routine.ownerId }).update({ last_scheduled_for: scheduledFor, last_run_id: runId || null, updated_at: Date.now() });
  }

  async failRoutineRun(id: string, error: string): Promise<void> {
    await db('aira_bot_routine_runs').where({ id }).update({ status: 'FAILED', error: error.slice(0, 4000), completed_at: Date.now() });
  }

  async reconcileRoutineRun(id: string, run: Run): Promise<void> {
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    await db('aira_bot_routine_runs').where({ id, status: 'RUNNING' }).update({ status: run.state, error: run.error || null, completed_at: run.completedAt || Date.now() });
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
    await db.transaction(async trx => {
      await trx('aira_bot_notifications').insert({
        id: notification.id, owner_id: notification.ownerId, bot_id: notification.botId || null, run_id: notification.runId || null,
        kind: notification.kind, title: notification.title, message: notification.message, created_at: notification.createdAt
      });
      await insertOutbox(trx, {
        topic: 'notification.created',
        aggregateType: 'notification',
        aggregateId: notification.id,
        ownerId: notification.ownerId,
        dedupeKey: `notification:${notification.id}`,
        payload: notification as unknown as Record<string, unknown>
      });
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
    return {
      id: row.id, routineId: row.routine_id, ownerId: row.owner_id, botId: row.bot_id, runId: row.run_id || undefined,
      scheduledFor: Number(row.scheduled_for), status: row.status, error: row.error || undefined,
      schedulerOwner: row.scheduler_owner || undefined, schedulerFence: row.scheduler_fence === null || row.scheduler_fence === undefined ? undefined : Number(row.scheduler_fence),
      claimedAt: row.claimed_at ? Number(row.claimed_at) : undefined,
      createdAt: Number(row.created_at), completedAt: row.completed_at ? Number(row.completed_at) : undefined
    };
  }
}

export interface BotRunExecutor {
  createAndExecuteRun(request: any, principal: ExecutionPrincipal, bot?: Bot, registerTask?: (run: Run) => Promise<void>): Promise<Run>;
  getRun(runId: string): Promise<Run | undefined>;
}

function schedulerLeaseTtl(): number {
  const parsed = Number(process.env.AIRA_BOT_SCHEDULER_LEASE_TTL_MS || 90_000);
  return Number.isFinite(parsed) ? Math.max(15_000, Math.min(parsed, 10 * 60_000)) : 90_000;
}

export class BotRoutineEngine {
  private timer?: NodeJS.Timeout;
  private leader?: RuntimeLease;
  private lastTickAt?: number;
  private lastLeadershipAt?: number;
  private lastError?: string;
  readonly nodeId: string;
  readonly leaseTtlMs: number;

  constructor(
    private readonly runtime: BotRunExecutor,
    private readonly repo = new BotOrchestrationRepository(),
    private readonly bots = new BotRepository(),
    private readonly leases = new RuntimeLeaseRepository(),
    nodeId = process.env.AIRA_BOT_SCHEDULER_ID?.trim() || runtimeNodeId('bot-scheduler'),
    leaseTtlMs = schedulerLeaseTtl()
  ) {
    this.nodeId = nodeId;
    this.leaseTtlMs = leaseTtlMs;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => { this.lastError = (error as Error).message; console.error('[BotRoutineEngine]', error); }), Math.max(1_000, intervalMs));
    this.timer.unref?.();
    void this.tick().catch(error => { this.lastError = (error as Error).message; console.error('[BotRoutineEngine]', error); });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const leader = this.leader;
    this.leader = undefined;
    if (leader) void this.leases.release('aira-bot-routines', this.nodeId, leader.fence).catch(() => false);
  }

  status(): BotRoutineEngineStatus {
    return {
      nodeId: this.nodeId,
      isLeader: Boolean(this.leader && this.leader.leaseUntil >= Date.now()),
      leaderFence: this.leader?.fence,
      leaseUntil: this.leader?.leaseUntil,
      lastTickAt: this.lastTickAt,
      lastLeadershipAt: this.lastLeadershipAt,
      lastError: this.lastError
    };
  }

  async currentLeader(): Promise<RuntimeLease | undefined> { return this.leases.current('aira-bot-routines'); }

  private async assertLeadership(expected: RuntimeLease): Promise<void> {
    const current = await this.leases.current('aira-bot-routines');
    if (!current || current.owner !== this.nodeId || current.fence !== expected.fence || current.leaseUntil < Date.now()) {
      this.leader = undefined;
      throw new Error('SCHEDULER_LEASE_LOST');
    }
  }

  async tick(now = Date.now()): Promise<void> {
    this.lastTickAt = now;
    const leadership = await this.leases.claimOrRenew('aira-bot-routines', this.nodeId, this.leaseTtlMs);
    if (!leadership) { this.leader = undefined; return; }
    this.leader = leadership;
    this.lastLeadershipAt = now;
    this.lastError = undefined;

    try {
      await this.recoverStaleClaims(now, leadership);
      await this.reconcile();
      for (const routine of await this.repo.listEnabledRoutines()) {
        await this.assertLeadership(leadership);
        try {
          const interval = CronExpressionParser.parse(routine.cronExpression, { currentDate: new Date(now), tz: routine.timezone });
          const scheduledFor = interval.prev().getTime();
          if (routine.lastScheduledFor && routine.lastScheduledFor >= scheduledFor) continue;
          const claim = await this.repo.claimRoutineSlot(routine, scheduledFor, this.nodeId, leadership.fence);
          if (!claim) continue;
          await this.executeClaim(routine, claim, leadership);
        } catch (error) {
          if ((error as Error).message === 'SCHEDULER_LEASE_LOST') throw error;
          console.error(`[BotRoutineEngine] routine ${routine.id}:`, (error as Error).message);
        }
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      if (this.lastError === 'SCHEDULER_LEASE_LOST') this.leader = undefined;
      else throw error;
    }
  }

  private async recoverStaleClaims(now: number, leadership: RuntimeLease): Promise<void> {
    const staleBefore = now - this.leaseTtlMs;
    for (const candidate of await this.repo.recoverableRoutineClaims(staleBefore)) {
      await this.assertLeadership(leadership);
      const claim = await this.repo.claimStaleRoutineRun(candidate.id, this.nodeId, leadership.fence, staleBefore);
      if (!claim) continue;
      const routine = await this.repo.getRoutine(claim.ownerId, claim.routineId);
      if (!routine || !routine.enabled) {
        await this.repo.failRoutineRun(claim.id, 'Routine is unavailable or disabled during scheduler recovery.');
        continue;
      }
      const existingRunId = await this.repo.findRoutineExecution(claim.routineId, claim.scheduledFor);
      if (existingRunId) {
        if (await this.repo.attachRoutineRun(claim.id, existingRunId, this.nodeId, leadership.fence)) {
          await this.repo.updateRoutineCursor(routine, claim.scheduledFor, existingRunId);
        }
        continue;
      }
      await this.executeClaim(routine, claim, leadership);
    }
  }

  private async executeClaim(routine: BotRoutine, claim: BotRoutineRun, leadership: RuntimeLease): Promise<void> {
    await this.assertLeadership(leadership);
    const bot = await this.bots.get(routine.ownerId, routine.botId);
    if (!bot) { await this.repo.failRoutineRun(claim.id, 'Routine bot no longer exists.'); return; }
    try {
      const run = await this.runtime.createAndExecuteRun(
        {
          prompt: routine.objective,
          intent: 'AGENT_MISSION',
          modelPolicy: { model: bot.model },
          context: { routineId: routine.id, routineRunId: claim.id, scheduledFor: claim.scheduledFor, schedulerFence: leadership.fence }
        },
        { userId: routine.ownerId, sessionId: `routine:${routine.id}` },
        bot,
        async created => { await this.bots.recordTask(routine.ownerId, bot.id, created.id, `[Routine: ${routine.name}] ${routine.objective}`); }
      );
      await this.assertLeadership(leadership);
      if (!await this.repo.attachRoutineRun(claim.id, run.id, this.nodeId, leadership.fence)) throw new Error('Routine claim fencing rejected run attachment.');
      await this.repo.updateRoutineCursor(routine, claim.scheduledFor, run.id);
      await this.repo.notify({ ownerId: routine.ownerId, botId: bot.id, runId: run.id, kind: 'routine_started', title: `${routine.name} started`, message: routine.objective });
    } catch (error) {
      if ((error as Error).message === 'SCHEDULER_LEASE_LOST') throw error;
      await this.repo.failRoutineRun(claim.id, (error as Error).message);
      await this.repo.updateRoutineCursor(routine, claim.scheduledFor);
      await this.repo.notify({ ownerId: routine.ownerId, botId: routine.botId, kind: 'routine_failed', title: `${routine.name} could not start`, message: (error as Error).message });
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
