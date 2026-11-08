import {
  AutonomousAgentTask,
  AutonomousTaskState,
  AgentObservation,
  canAutonomousStateTransition
} from '../../../contracts/src/index.js';
import { db } from '../../../db/src/index.js';

export interface AutonomousTaskClaimResult {
  success: boolean;
  task?: AutonomousAgentTask;
  error?: string;
}

export interface IAutonomousTaskRepository {
  createTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask>;
  getTask(taskId: string): Promise<AutonomousAgentTask | null>;
  getTaskByIdempotencyKey?(principalId: string, idempotencyKey: string): Promise<AutonomousAgentTask | null>;
  listTasksByPrincipal(principalId: string, limit?: number): Promise<AutonomousAgentTask[]>;
  updateTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask>;
  updateState(
    taskId: string,
    newState: AutonomousTaskState,
    reason?: string,
    checkpoint?: string,
    expectedFencingToken?: number
  ): Promise<AutonomousAgentTask>;
  addObservation(taskId: string, observation: AgentObservation): Promise<void>;
  addArtifact(taskId: string, artifact: AutonomousAgentTask['artifacts'][0]): Promise<void>;
  claimTask?(taskId: string, workerId: string, leaseDurationMs: number): Promise<AutonomousTaskClaimResult>;
  renewLease?(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean>;
  findRecoverableTasks?(now: number, limit?: number): Promise<AutonomousAgentTask[]>;
  findClaimableTasks?(now: number, limit?: number): Promise<AutonomousAgentTask[]>;
  deleteTask?(taskId: string): Promise<void>;
}

export class InMemoryAutonomousTaskRepository implements IAutonomousTaskRepository {
  private tasks: Map<string, AutonomousAgentTask> = new Map();

  async createTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    if (task.idempotencyKey) {
      const existing = await this.getTaskByIdempotencyKey(task.principal.userId, task.idempotencyKey);
      if (existing) return existing;
    }
    const clone: AutonomousAgentTask = JSON.parse(JSON.stringify(task));
    clone.fencingToken = clone.fencingToken ?? 0;
    clone.workingMemory = clone.workingMemory ?? {};
    this.tasks.set(task.taskId, clone);
    return JSON.parse(JSON.stringify(clone));
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  async getTask(taskId: string): Promise<AutonomousAgentTask | null> {
    const found = this.tasks.get(taskId);
    if (!found) return null;
    return JSON.parse(JSON.stringify(found));
  }

  async getTaskByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<AutonomousAgentTask | null> {
    for (const t of this.tasks.values()) {
      if (t.principal.userId === principalId && t.idempotencyKey === idempotencyKey) {
        return JSON.parse(JSON.stringify(t));
      }
    }
    return null;
  }

  async listTasksByPrincipal(principalId: string, limit = 20): Promise<AutonomousAgentTask[]> {
    const results: AutonomousAgentTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.principal.userId === principalId) {
        results.push(JSON.parse(JSON.stringify(t)));
      }
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, limit);
  }

  async updateTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    const existing = this.tasks.get(task.taskId);
    if (!existing) {
      throw new Error(`Task with id ${task.taskId} not found.`);
    }
    if (task.fencingToken !== existing.fencingToken) {
      throw new Error(`STALE_FENCING_TOKEN: Expected ${task.fencingToken}, but task is at ${existing.fencingToken}.`);
    }
    const mergedObservations = task.observations.length >= existing.observations.length
      ? task.observations
      : existing.observations;

    const updated: AutonomousAgentTask = {
      ...JSON.parse(JSON.stringify(task)),
      state: existing.state,
      fencingToken: existing.fencingToken,
      leaseOwner: existing.leaseOwner,
      leaseExpiresAt: existing.leaseExpiresAt,
      executionHistory: JSON.parse(JSON.stringify(existing.executionHistory)),
      observations: JSON.parse(JSON.stringify(mergedObservations)),
      updatedAt: Date.now()
    };
    this.tasks.set(task.taskId, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async updateState(
    taskId: string,
    newState: AutonomousTaskState,
    reason?: string,
    checkpoint?: string,
    expectedFencingToken?: number
  ): Promise<AutonomousAgentTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }

    if (expectedFencingToken !== undefined && task.fencingToken !== expectedFencingToken) {
      throw new Error(`STALE_FENCING_TOKEN: Expected ${expectedFencingToken}, but task is at ${task.fencingToken}.`);
    }

    if (!canAutonomousStateTransition(task.state, newState)) {
      throw new Error(`Illegal autonomous state transition from "${task.state}" to "${newState}".`);
    }

    const now = Date.now();
    task.state = newState;
    task.fencingToken = (task.fencingToken || 0) + 1;
    task.updatedAt = now;
    if (newState === 'COMPLETED' || newState === 'FAILED' || newState === 'CANCELLED' || newState === 'TIMED_OUT') {
      task.completedAt = now;
      task.leaseOwner = undefined;
      task.leaseExpiresAt = undefined;
    }
    if (newState === 'FAILED' && reason) {
      task.error = reason;
    }

    task.executionHistory.push({
      state: newState,
      timestamp: now,
      reason,
      checkpoint
    });

    this.tasks.set(taskId, task);
    return JSON.parse(JSON.stringify(task));
  }

  async addObservation(taskId: string, observation: AgentObservation): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }
    task.observations.push(JSON.parse(JSON.stringify(observation)));
    task.updatedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  async addArtifact(taskId: string, artifact: AutonomousAgentTask['artifacts'][0]): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }
    task.artifacts.push(JSON.parse(JSON.stringify(artifact)));
    task.updatedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  async claimTask(taskId: string, workerId: string, leaseDurationMs: number): Promise<AutonomousTaskClaimResult> {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };

    const now = Date.now();
    if (task.leaseOwner && task.leaseExpiresAt && task.leaseExpiresAt > now && task.leaseOwner !== workerId) {
      return { success: false, error: `Task is currently leased to ${task.leaseOwner}` };
    }

    task.leaseOwner = workerId;
    task.leaseExpiresAt = now + leaseDurationMs;
    task.heartbeatAt = now;
    task.fencingToken = (task.fencingToken || 0) + 1;
    task.updatedAt = now;

    this.tasks.set(taskId, task);
    return { success: true, task: JSON.parse(JSON.stringify(task)) };
  }

  async renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.leaseOwner !== workerId || task.fencingToken !== fencingToken) return false;

    task.leaseExpiresAt = Date.now() + leaseDurationMs;
    task.heartbeatAt = Date.now();
    task.updatedAt = Date.now();
    this.tasks.set(taskId, task);
    return true;
  }

  async findRecoverableTasks(now: number, limit = 50): Promise<AutonomousAgentTask[]> {
    const recoverable: AutonomousAgentTask[] = [];
    for (const t of this.tasks.values()) {
      if (
        (t.state === 'RUNNING' || t.state === 'RESUMING' || t.state === 'PLANNING') &&
        (!t.leaseOwner || !t.leaseExpiresAt || t.leaseExpiresAt < now)
      ) {
        recoverable.push(JSON.parse(JSON.stringify(t)));
      }
    }
    return recoverable.slice(0, limit);
  }

  async findClaimableTasks(now: number, limit = 10): Promise<AutonomousAgentTask[]> {
    const claimable: AutonomousAgentTask[] = [];
    for (const t of this.tasks.values()) {
      const isClaimableState = ['CREATED', 'READY', 'RUNNING', 'RESUMING', 'PLANNING'].includes(t.state);
      const isLeaseExpiredOrUnowned = !t.leaseOwner || !t.leaseExpiresAt || t.leaseExpiresAt < now;
      if (isClaimableState && isLeaseExpiredOrUnowned) {
        claimable.push(JSON.parse(JSON.stringify(t)));
      }
    }
    return claimable.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }
}

// ==========================================
// POSTGRESQL AUTONOMOUS TASK REPOSITORY
// ==========================================

function safeJsonParse<T>(val: any, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return val;
}

function isDatabaseUnavailable(err: any): boolean {
  if (!err) return false;
  if (err instanceof AutonomousPersistenceUnavailableError) return true;
  if (err.name === 'AutonomousPersistenceUnavailableError' || err.code === 'PERSISTENCE_UNAVAILABLE') return true;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return true;
  if (err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('relation "autonomous_agent_tasks" does not exist') || err.message.includes('AUTONOMOUS_PERSISTENCE_UNAVAILABLE'))) return true;
  if (err.errors && Array.isArray(err.errors)) {
    return err.errors.some((e: any) => e.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED'));
  }
  return false;
}

export class AutonomousPersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE';
  constructor(operation: string, originalError?: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError || 'unknown');
    super(`AUTONOMOUS_PERSISTENCE_UNAVAILABLE: Database storage is unreachable during "${operation}" (${detail}). Cannot execute durable autonomous task without durable persistence.`);
    this.name = 'AutonomousPersistenceUnavailableError';
    if (originalError) this.cause = originalError;
  }
}

export function createOfflinePostgresClient(simulatedErrorMessage = 'connect ECONNREFUSED 127.0.0.1:5432'): any {
  const err = new Error(simulatedErrorMessage);
  (err as any).code = 'ECONNREFUSED';

  const queryBuilder = () => {
    const q: any = {
      insert: async () => { throw err; },
      where: () => q,
      andWhere: () => q,
      whereIn: () => q,
      first: async () => { throw err; },
      select: async () => { throw err; },
      update: async () => { throw err; },
      delete: async () => { throw err; },
      orderBy: () => q,
      limit: async () => { throw err; },
      raw: (expr: string) => expr,
      then: (resolve: any, reject: any) => Promise.reject(err).then(resolve, reject),
      catch: (reject: any) => Promise.reject(err).catch(reject)
    };
    return q;
  };
  queryBuilder.schema = {
    hasTable: async () => { throw err; },
    hasColumn: async () => { throw err; }
  };
  queryBuilder.raw = () => { throw err; };
  return queryBuilder;
}

export class PostgresAutonomousTaskRepository implements IAutonomousTaskRepository {
  private knexClient: any;

  constructor(knexOverride?: any) {
    this.knexClient = knexOverride || db;
  }

  private rowToTask(row: any): AutonomousAgentTask {
    return {
      taskId: row.task_id,
      principal: {
        userId: row.principal_id,
        sessionId: row.session_id || 'default_session',
        workspaceId: row.workspace_id || undefined,
        scopes: ['*']
      },
      objective: row.objective,
      state: row.state,
      activeStepId: row.active_step_id || undefined,
      approvalRequestId: row.approval_request_id || undefined,
      plan: safeJsonParse(row.plan, undefined),
      dag: safeJsonParse(row.dag, undefined),
      observations: safeJsonParse(row.observations, []),
      artifacts: safeJsonParse(row.artifacts, []),
      workingMemory: safeJsonParse(row.working_memory, {}),
      executionHistory: safeJsonParse(row.execution_history, []),
      deliverableSummary: row.deliverable_summary || undefined,
      error: row.error || undefined,
      fencingToken: Number(row.fencing_token || 0),
      leaseOwner: row.lease_owner || undefined,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : undefined,
      heartbeatAt: row.heartbeat_at ? Number(row.heartbeat_at) : undefined,
      idempotencyKey: row.idempotency_key || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined
    };
  }

  async createTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    try {
      if (task.idempotencyKey) {
        const existing = await this.getTaskByIdempotencyKey(task.principal.userId, task.idempotencyKey);
        if (existing) return existing;
      }

      const now = Date.now();
      const row = {
        task_id: task.taskId,
        principal_id: task.principal.userId,
        workspace_id: task.principal.workspaceId || null,
        session_id: task.principal.sessionId || null,
        objective: task.objective,
        state: task.state || 'CREATED',
        active_step_id: task.activeStepId || null,
        approval_request_id: task.approvalRequestId || null,
        plan: task.plan ? JSON.stringify(task.plan) : null,
        dag: task.dag ? JSON.stringify(task.dag) : null,
        observations: JSON.stringify(task.observations || []),
        artifacts: JSON.stringify(task.artifacts || []),
        working_memory: JSON.stringify(task.workingMemory || {}),
        execution_history: JSON.stringify(task.executionHistory || []),
        deliverable_summary: task.deliverableSummary || null,
        error: task.error || null,
        fencing_token: task.fencingToken || 0,
        lease_owner: task.leaseOwner || null,
        lease_expires_at: task.leaseExpiresAt || null,
        heartbeat_at: task.heartbeatAt || null,
        idempotency_key: task.idempotencyKey || null,
        created_at: task.createdAt || now,
        updated_at: task.updatedAt || now,
        completed_at: task.completedAt || null
      };

      await this.knexClient('autonomous_agent_tasks').insert(row);
      return task;
    } catch (err: any) {
      if (
        err.code === '23505' ||
        err.message?.includes('unique constraint') ||
        err.message?.includes('duplicate key') ||
        err.message?.includes('uq_auto_tasks_idempotency')
      ) {
        if (task.idempotencyKey) {
          const existing = await this.getTaskByIdempotencyKey(task.principal.userId, task.idempotencyKey);
          if (existing) return existing;
        }
      }
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('createTask', err);
      }
      throw err;
    }
  }

  async getTask(taskId: string): Promise<AutonomousAgentTask | null> {
    try {
      const row = await this.knexClient('autonomous_agent_tasks').where({ task_id: taskId }).first();
      if (!row) return null;
      return this.rowToTask(row);
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('getTask', err);
      }
      throw err;
    }
  }

  async getTaskByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<AutonomousAgentTask | null> {
    try {
      const row = await this.knexClient('autonomous_agent_tasks')
        .where({ principal_id: principalId, idempotency_key: idempotencyKey })
        .first();
      if (!row) return null;
      return this.rowToTask(row);
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('getTaskByIdempotencyKey', err);
      }
      throw err;
    }
  }

  async listTasksByPrincipal(principalId: string, limit = 20): Promise<AutonomousAgentTask[]> {
    try {
      const rows = await this.knexClient('autonomous_agent_tasks')
        .where({ principal_id: principalId })
        .orderBy('created_at', 'desc')
        .limit(limit);
      return rows.map((r: any) => this.rowToTask(r));
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('listTasksByPrincipal', err);
      }
      throw err;
    }
  }

  async updateTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    try {
      const existing = await this.getTask(task.taskId);
      if (!existing) {
        throw new Error(`Task with id ${task.taskId} not found.`);
      }
      if (task.fencingToken !== existing.fencingToken) {
        throw new Error(`STALE_FENCING_TOKEN: Expected ${task.fencingToken}, but task is at ${existing.fencingToken}.`);
      }

      const mergedObservations = task.observations.length >= existing.observations.length
        ? task.observations
        : existing.observations;

      const now = Date.now();
      const updated = await this.knexClient('autonomous_agent_tasks')
        .where({ task_id: task.taskId })
        .andWhere('fencing_token', task.fencingToken)
        .update({
          active_step_id: task.activeStepId || null,
          approval_request_id: task.approvalRequestId || null,
          plan: task.plan ? JSON.stringify(task.plan) : null,
          dag: task.dag ? JSON.stringify(task.dag) : null,
          observations: JSON.stringify(mergedObservations),
          artifacts: JSON.stringify(task.artifacts || []),
          working_memory: JSON.stringify(task.workingMemory || {}),
          deliverable_summary: task.deliverableSummary || null,
          error: task.error || null,
          updated_at: now
        });
      if (updated === 0) {
        throw new Error(`Concurrent update or stale fencing token on task ${task.taskId}.`);
      }

      task.observations = mergedObservations;
      task.updatedAt = now;
      return task;
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('updateTask', err);
      }
      throw err;
    }
  }

  async updateState(
    taskId: string,
    newState: AutonomousTaskState,
    reason?: string,
    checkpoint?: string,
    expectedFencingToken?: number
  ): Promise<AutonomousAgentTask> {
    try {
      const current = await this.getTask(taskId);
      if (!current) throw new Error(`Task with id ${taskId} not found.`);

      if (expectedFencingToken !== undefined && current.fencingToken !== expectedFencingToken) {
        throw new Error(`STALE_FENCING_TOKEN: Expected ${expectedFencingToken}, but task is at ${current.fencingToken}.`);
      }

      if (!canAutonomousStateTransition(current.state, newState)) {
        throw new Error(`Illegal autonomous state transition from "${current.state}" to "${newState}".`);
      }

      const now = Date.now();
      const newFencingToken = (current.fencingToken || 0) + 1;
      const history = [...current.executionHistory, {
        state: newState,
        timestamp: now,
        reason,
        checkpoint
      }];

      const updateData: any = {
        state: newState,
        fencing_token: newFencingToken,
        execution_history: JSON.stringify(history),
        updated_at: now
      };

      if (newState === 'COMPLETED' || newState === 'FAILED' || newState === 'CANCELLED' || newState === 'TIMED_OUT') {
        updateData.completed_at = now;
        updateData.lease_owner = null;
        updateData.lease_expires_at = null;
      }
      if (newState === 'FAILED' && reason) {
        updateData.error = reason;
      }

      const updated = await this.knexClient('autonomous_agent_tasks')
        .where({ task_id: taskId })
        .andWhere('fencing_token', current.fencingToken)
        .update(updateData);

      if (updated === 0) {
        throw new Error(`Concurrent update or stale fencing token on task ${taskId}.`);
      }

      current.state = newState;
      current.fencingToken = newFencingToken;
      current.executionHistory = history;
      current.updatedAt = now;
      if (updateData.completed_at) {
        current.completedAt = now;
        current.leaseOwner = undefined;
        current.leaseExpiresAt = undefined;
      }
      return current;
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('updateState', err);
      }
      throw err;
    }
  }

  async addObservation(taskId: string, observation: AgentObservation): Promise<void> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Task with id ${taskId} not found.`);
    current.observations.push(observation);
    await this.updateTask(current);
  }

  async addArtifact(taskId: string, artifact: AutonomousAgentTask['artifacts'][0]): Promise<void> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Task with id ${taskId} not found.`);
    current.artifacts.push(artifact);
    await this.updateTask(current);
  }

  async claimTask(taskId: string, workerId: string, leaseDurationMs: number): Promise<AutonomousTaskClaimResult> {
    try {
      const now = Date.now();
      const task = await this.getTask(taskId);
      if (!task) return { success: false, error: 'Task not found' };

      const updated = await this.knexClient('autonomous_agent_tasks')
        .where({ task_id: taskId })
        .andWhere((qb: any) => {
          qb.whereNull('lease_owner')
            .orWhere('lease_expires_at', '<', now)
            .orWhere('lease_owner', workerId);
        })
        .update({
          lease_owner: workerId,
          lease_expires_at: now + leaseDurationMs,
          heartbeat_at: now,
          fencing_token: this.knexClient.raw('fencing_token + 1'),
          updated_at: now
        });

      if (updated === 0) {
        return { success: false, error: 'Task is leased by another active worker' };
      }

      const claimed = await this.getTask(taskId);
      return { success: true, task: claimed || undefined };
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('claimTask', err);
      }
      return { success: false, error: err.message };
    }
  }

  async renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean> {
    try {
      const now = Date.now();
      const updated = await this.knexClient('autonomous_agent_tasks')
        .where({ task_id: taskId, lease_owner: workerId, fencing_token: fencingToken })
        .update({
          lease_expires_at: now + leaseDurationMs,
          heartbeat_at: now,
          updated_at: now
        });
      return updated > 0;
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('renewLease', err);
      }
      return false;
    }
  }

  async findRecoverableTasks(now: number, limit = 50): Promise<AutonomousAgentTask[]> {
    try {
      const rows = await this.knexClient('autonomous_agent_tasks')
        .whereIn('state', ['RUNNING', 'RESUMING', 'PLANNING'])
        .andWhere((qb: any) => {
          qb.whereNull('lease_owner')
            .orWhere('lease_expires_at', '<', now);
        })
        .limit(limit);
      return rows.map((r: any) => this.rowToTask(r));
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('findRecoverableTasks', err);
      }
      throw err;
    }
  }

  async findClaimableTasks(now: number, limit = 10): Promise<AutonomousAgentTask[]> {
    try {
      const rows = await this.knexClient('autonomous_agent_tasks')
        .whereIn('state', ['CREATED', 'READY', 'RUNNING', 'RESUMING', 'PLANNING'])
        .andWhere((qb: any) => {
          qb.whereNull('lease_owner')
            .orWhere('lease_expires_at', '<', now);
        })
        .orderBy('created_at', 'asc')
        .limit(limit);
      return rows.map((r: any) => this.rowToTask(r));
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('findClaimableTasks', err);
      }
      throw err;
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    try {
      await this.knexClient('autonomous_agent_tasks').where({ task_id: taskId }).delete();
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        throw new AutonomousPersistenceUnavailableError('deleteTask', err);
      }
      throw err;
    }
  }
}

// ==========================================
// FAIL-CLOSED AUTONOMOUS TASK REPOSITORY
// ==========================================

export class FailClosedAutonomousTaskRepository implements IAutonomousTaskRepository {
  constructor(public readonly reason = 'Durable database persistence is unconfigured in this deployed environment.') {}

  async createTask(_task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    throw new AutonomousPersistenceUnavailableError('createTask', new Error(this.reason));
  }
  async getTask(_taskId: string): Promise<AutonomousAgentTask | null> {
    throw new AutonomousPersistenceUnavailableError('getTask', new Error(this.reason));
  }
  async getTaskByIdempotencyKey?(_principalId: string, _idempotencyKey: string): Promise<AutonomousAgentTask | null> {
    throw new AutonomousPersistenceUnavailableError('getTaskByIdempotencyKey', new Error(this.reason));
  }
  async listTasksByPrincipal(_principalId: string, _limit?: number): Promise<AutonomousAgentTask[]> {
    throw new AutonomousPersistenceUnavailableError('listTasksByPrincipal', new Error(this.reason));
  }
  async updateTask(_task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    throw new AutonomousPersistenceUnavailableError('updateTask', new Error(this.reason));
  }
  async updateState(
    _taskId: string,
    _newState: AutonomousTaskState,
    _reason?: string,
    _checkpoint?: string,
    _expectedFencingToken?: number
  ): Promise<AutonomousAgentTask> {
    throw new AutonomousPersistenceUnavailableError('updateState', new Error(this.reason));
  }
  async addObservation(_taskId: string, _observation: AgentObservation): Promise<void> {
    throw new AutonomousPersistenceUnavailableError('addObservation', new Error(this.reason));
  }
  async addArtifact(_taskId: string, _artifact: AutonomousAgentTask['artifacts'][0]): Promise<void> {
    throw new AutonomousPersistenceUnavailableError('addArtifact', new Error(this.reason));
  }
  async claimTask?(_taskId: string, _workerId: string, _leaseDurationMs: number): Promise<AutonomousTaskClaimResult> {
    throw new AutonomousPersistenceUnavailableError('claimTask', new Error(this.reason));
  }
  async renewLease?(_taskId: string, _workerId: string, _leaseDurationMs: number, _fencingToken: number): Promise<boolean> {
    throw new AutonomousPersistenceUnavailableError('renewLease', new Error(this.reason));
  }
  async findRecoverableTasks?(_now: number, _limit?: number): Promise<AutonomousAgentTask[]> {
    throw new AutonomousPersistenceUnavailableError('findRecoverableTasks', new Error(this.reason));
  }
  async findClaimableTasks?(_now: number, _limit?: number): Promise<AutonomousAgentTask[]> {
    throw new AutonomousPersistenceUnavailableError('findClaimableTasks', new Error(this.reason));
  }
  async deleteTask?(_taskId: string): Promise<void> {
    throw new AutonomousPersistenceUnavailableError('deleteTask', new Error(this.reason));
  }
}
