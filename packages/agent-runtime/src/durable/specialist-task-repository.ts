import {
  SpecialistRole,
  SpecialistTaskOutcome,
  SpecialistTaskState,
  SpecialistExecutionConstraints,
  SpecialistAuthorizationRequirements,
  SpecialistBudgetLimits,
  isTerminalSpecialistState,
  toSpecialistTaskOutcome,
  TERMINAL_SPECIALIST_STATES
} from '../../../contracts/src/index.js';
import { db } from '../../../db/src/index.js';
import {
  assertValidTransition,
  StaleFencingTokenError,
  TerminalStateImmutabilityError
} from './task-state-machine.js';

function canonicalJson(value: unknown, parseJsonText = false): string {
  let current = value;
  if (parseJsonText && typeof current === 'string') {
    try { current = JSON.parse(current); } catch { /* retain ordinary strings */ }
  }
  if (Array.isArray(current)) return `[${current.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (current && typeof current === 'object') {
    const entries = Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(current) ?? 'null';
}

function assertSamePersistedTaskIdentity(row: any, task: DurableSpecialistTask): void {
  const matches =
    row.id === task.id && row.run_id === task.runId &&
    (row.mission_id || undefined) === task.missionId &&
    row.principal_id === task.principalId &&
    (row.workspace_id || undefined) === task.workspaceId &&
    row.role === task.role && row.objective === task.objective &&
    canonicalJson(row.dependencies, true) === canonicalJson(task.dependencies || []) &&
    canonicalJson(row.input_payload, true) === canonicalJson(task.inputPayload || {}) &&
    canonicalJson(row.execution_constraints, true) === canonicalJson(task.executionConstraints || {}) &&
    canonicalJson(row.authorization_requirements, true) === canonicalJson(task.authorizationRequirements || {}) &&
    canonicalJson(row.budget_limits, true) === canonicalJson(task.budgetLimits || {}) &&
    Number(row.timeout_ms) === Number(task.timeoutMs) &&
    Number(row.max_retries) === Number(task.maxRetries) &&
    Number(row.backoff_multiplier) === Number(task.backoffMultiplier) &&
    (row.idempotency_key || undefined) === task.idempotencyKey &&
    Number(row.created_at) === Number(task.createdAt);
  if (!matches) throw new Error(`Durable task ID collision or immutable identity change rejected for task "${task.id}".`);
}

export interface DurableSpecialistTask {
  id: string;
  runId: string;
  missionId?: string;
  principalId: string;
  workspaceId?: string;
  role: SpecialistRole;
  objective: string;
  state: SpecialistTaskState;
  outcome?: SpecialistTaskOutcome;
  dependencies: string[];
  inputPayload: Record<string, unknown>;
  resultOutput?: unknown;
  executionConstraints: SpecialistExecutionConstraints;
  authorizationRequirements: SpecialistAuthorizationRequirements;
  budgetLimits: SpecialistBudgetLimits;
  timeoutMs: number;
  attemptCount: number;
  maxRetries: number;
  backoffMultiplier: number;
  fencingToken: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  idempotencyKey?: string;
  errorDetails?: { code: string; message: string; retryable: boolean };
  usageTelemetry: { tokensUsed: number; durationMs: number; model?: string; provider?: string };
  provenance: { workerId: string; promptProfileId?: string };
  checkpoints: Array<{ checkpoint: string; timestamp: number; data?: unknown }>;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskClaimResult {
  success: boolean;
  task?: DurableSpecialistTask;
  error?: string;
}

export interface AuthoritativeTaskIdentity {
  taskPrincipalId: string;
  runPrincipalId: string;
  taskWorkspaceId?: string;
  runWorkspaceId?: string;
  workspaceAuthorityActive: boolean;
}

export interface SpecialistTaskRepository {
  saveTask(task: DurableSpecialistTask): Promise<void>;
  getTask(id: string): Promise<DurableSpecialistTask | undefined>;
  getAuthoritativeExecutionIdentity?(taskId: string): Promise<AuthoritativeTaskIdentity | undefined>;
  getTaskByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<DurableSpecialistTask | undefined>;
  listTasksByRun(runId: string): Promise<DurableSpecialistTask[]>;
  listTasksByMission(missionId: string): Promise<DurableSpecialistTask[]>;
  listTasksByPrincipal(principalId: string, limit?: number): Promise<DurableSpecialistTask[]>;
  claimTask(taskId: string, workerId: string, leaseDurationMs: number, expectedFencingToken?: number): Promise<TaskClaimResult>;
  renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean>;
  updateTaskState(taskId: string, toState: SpecialistTaskState, fencingToken: number, updates?: Partial<DurableSpecialistTask>): Promise<boolean>;
  appendCheckpoint(taskId: string, fencingToken: number, checkpoint: string, data?: unknown): Promise<boolean>;
  findExpiredLeases(now: number, limit?: number): Promise<DurableSpecialistTask[]>;
  findClaimableTasks(now: number, limit?: number): Promise<DurableSpecialistTask[]>;
  findRunnableTasks(runId: string): Promise<DurableSpecialistTask[]>;
  recordEvent(event: {
    taskId: string;
    runId: string;
    eventType: string;
    fromState?: SpecialistTaskState;
    toState: SpecialistTaskState;
    fencingToken: number;
    workerId?: string;
    payload?: unknown;
  }): Promise<void>;
}

// ==========================================
// IN-MEMORY REPOSITORY (DETERMINISTIC UNIT TESTING)
// ==========================================

export class InMemorySpecialistTaskRepository implements SpecialistTaskRepository {
  private tasks: Map<string, DurableSpecialistTask> = new Map();
  private events: Array<{
    id: string;
    taskId: string;
    runId: string;
    eventType: string;
    fromState?: SpecialistTaskState;
    toState: SpecialistTaskState;
    fencingToken: number;
    workerId?: string;
    payload?: unknown;
    createdAt: number;
  }> = [];

  async saveTask(task: DurableSpecialistTask): Promise<void> {
    const existing = this.tasks.get(task.id);
    if (existing) {
      assertSamePersistedTaskIdentity({
        id: existing.id,
        run_id: existing.runId,
        mission_id: existing.missionId || null,
        principal_id: existing.principalId,
        workspace_id: existing.workspaceId || null,
        role: existing.role,
        objective: existing.objective,
        dependencies: existing.dependencies,
        input_payload: existing.inputPayload,
        execution_constraints: existing.executionConstraints,
        authorization_requirements: existing.authorizationRequirements,
        budget_limits: existing.budgetLimits,
        timeout_ms: existing.timeoutMs,
        max_retries: existing.maxRetries,
        backoff_multiplier: existing.backoffMultiplier,
        idempotency_key: existing.idempotencyKey || null,
        created_at: existing.createdAt
      }, task);
    }
    if (existing && isTerminalSpecialistState(existing.state) && existing.state !== task.state) {
      throw new TerminalStateImmutabilityError(task.id, existing.state, task.state);
    }
    this.tasks.set(task.id, JSON.parse(JSON.stringify(task)));
  }

  async getTask(id: string): Promise<DurableSpecialistTask | undefined> {
    const task = this.tasks.get(id);
    return task ? JSON.parse(JSON.stringify(task)) : undefined;
  }

  async getAuthoritativeExecutionIdentity(taskId: string): Promise<AuthoritativeTaskIdentity | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      taskPrincipalId: task.principalId,
      runPrincipalId: task.principalId,
      taskWorkspaceId: task.workspaceId,
      runWorkspaceId: task.workspaceId,
      workspaceAuthorityActive: Boolean(task.principalId && task.workspaceId)
    };
  }

  async getTaskByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<DurableSpecialistTask | undefined> {
    for (const task of this.tasks.values()) {
      if (task.principalId === principalId && task.idempotencyKey === idempotencyKey) {
        return JSON.parse(JSON.stringify(task));
      }
    }
    return undefined;
  }

  async listTasksByRun(runId: string): Promise<DurableSpecialistTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.runId === runId)
      .map(t => JSON.parse(JSON.stringify(t)));
  }

  async listTasksByMission(missionId: string): Promise<DurableSpecialistTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.missionId === missionId)
      .map(t => JSON.parse(JSON.stringify(t)));
  }

  async listTasksByPrincipal(principalId: string, limit = 50): Promise<DurableSpecialistTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.principalId === principalId)
      .slice(0, limit)
      .map(t => JSON.parse(JSON.stringify(t)));
  }

  async claimTask(taskId: string, workerId: string, leaseDurationMs: number, expectedFencingToken?: number): Promise<TaskClaimResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found.` };
    }

    const now = Date.now();
    const isExpired = task.leaseExpiresAt ? task.leaseExpiresAt < now : true;
    const isClaimableState = task.state === 'QUEUED' || task.state === 'RETRY_WAIT' || isExpired;

    if (!isClaimableState || isTerminalSpecialistState(task.state)) {
      return { success: false, error: `Task "${taskId}" is not in a claimable state (state=${task.state}).` };
    }

    if (expectedFencingToken !== undefined && task.fencingToken !== expectedFencingToken) {
      return {
        success: false,
        error: `Fencing token mismatch: expected ${expectedFencingToken}, current is ${task.fencingToken}.`
      };
    }

    assertValidTransition(task.id, task.state, 'CLAIMED');

    const nextFencingToken = task.fencingToken + 1;
    task.state = 'CLAIMED';
    task.leaseOwner = workerId;
    task.leaseExpiresAt = now + leaseDurationMs;
    task.heartbeatAt = now;
    task.fencingToken = nextFencingToken;
    task.attemptCount += 1;
    task.updatedAt = now;
    if (!task.startedAt) task.startedAt = now;

    await this.recordEvent({
      taskId: task.id,
      runId: task.runId,
      eventType: 'TASK_CLAIMED',
      fromState: 'QUEUED',
      toState: 'CLAIMED',
      fencingToken: nextFencingToken,
      workerId,
      payload: { leaseExpiresAt: task.leaseExpiresAt, attempt: task.attemptCount }
    });

    return { success: true, task: JSON.parse(JSON.stringify(task)) };
  }

  async renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.leaseOwner !== workerId || task.fencingToken !== fencingToken) return false;
    if (isTerminalSpecialistState(task.state)) return false;

    const now = Date.now();
    task.leaseExpiresAt = now + leaseDurationMs;
    task.heartbeatAt = now;
    task.updatedAt = now;
    return true;
  }

  async updateTaskState(
    taskId: string,
    toState: SpecialistTaskState,
    fencingToken: number,
    updates: Partial<DurableSpecialistTask> = {}
  ): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.fencingToken !== fencingToken) {
      throw new StaleFencingTokenError(taskId, fencingToken, task.fencingToken);
    }

    assertValidTransition(taskId, task.state, toState);

    const fromState = task.state;
    task.state = toState;
    task.updatedAt = Date.now();

    if (isTerminalSpecialistState(toState)) {
      task.outcome = toSpecialistTaskOutcome(toState);
      task.completedAt = task.updatedAt;
      task.leaseExpiresAt = undefined;
    }

    if (updates.resultOutput !== undefined) task.resultOutput = updates.resultOutput;
    if (updates.errorDetails !== undefined) task.errorDetails = updates.errorDetails;
    if (updates.usageTelemetry !== undefined) task.usageTelemetry = updates.usageTelemetry;
    if (updates.provenance !== undefined) task.provenance = updates.provenance;

    await this.recordEvent({
      taskId,
      runId: task.runId,
      eventType: `TASK_STATE_${toState}`,
      fromState,
      toState,
      fencingToken,
      workerId: task.leaseOwner,
      payload: updates
    });

    return true;
  }

  async appendCheckpoint(taskId: string, fencingToken: number, checkpoint: string, data?: unknown): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.fencingToken !== fencingToken) return false;

    task.checkpoints.push({
      checkpoint,
      timestamp: Date.now(),
      data
    });
    task.updatedAt = Date.now();
    return true;
  }

  async findExpiredLeases(now: number, limit = 10): Promise<DurableSpecialistTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => !isTerminalSpecialistState(t.state) && t.leaseExpiresAt && t.leaseExpiresAt < now)
      .slice(0, limit)
      .map(t => JSON.parse(JSON.stringify(t)));
  }

  async findClaimableTasks(now: number, limit = 10): Promise<DurableSpecialistTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => {
        if (isTerminalSpecialistState(t.state)) return false;
        if (t.state === 'QUEUED' || t.state === 'RETRY_WAIT') return true;
        if (t.leaseExpiresAt && t.leaseExpiresAt < now) return true;
        return false;
      })
      .slice(0, limit)
      .map(t => JSON.parse(JSON.stringify(t)));
  }

  async findRunnableTasks(runId: string): Promise<DurableSpecialistTask[]> {
    const tasks = Array.from(this.tasks.values()).filter(t => t.runId === runId);
    const completedIds = new Set(tasks.filter(t => t.state === 'COMPLETED').map(t => t.id));

    return tasks.filter(task => {
      if (task.state !== 'QUEUED' && task.state !== 'BLOCKED' && task.state !== 'RETRY_WAIT') return false;
      // All dependencies must be completed
      return task.dependencies.every(depId => completedIds.has(depId));
    }).map(t => JSON.parse(JSON.stringify(t)));
  }

  async recordEvent(event: {
    taskId: string;
    runId: string;
    eventType: string;
    fromState?: SpecialistTaskState;
    toState: SpecialistTaskState;
    fencingToken: number;
    workerId?: string;
    payload?: unknown;
  }): Promise<void> {
    this.events.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ...event,
      createdAt: Date.now()
    });
  }

  public getEvents(taskId?: string) {
    if (taskId) return this.events.filter(e => e.taskId === taskId);
    return [...this.events];
  }
}

// ==========================================
// POSTGRESQL DURABLE REPOSITORY
// ==========================================

export class PostgresSpecialistTaskRepository implements SpecialistTaskRepository {
  async saveTask(task: DurableSpecialistTask): Promise<void> {
    const values = {
      id: task.id,
      run_id: task.runId,
      mission_id: task.missionId || null,
      principal_id: task.principalId,
      workspace_id: task.workspaceId || null,
      role: task.role,
      objective: task.objective,
      state: task.state,
      outcome: task.outcome || null,
      dependencies: JSON.stringify(task.dependencies || []),
      input_payload: JSON.stringify(task.inputPayload || {}),
      result_output: task.resultOutput !== undefined ? JSON.stringify(task.resultOutput) : null,
      execution_constraints: JSON.stringify(task.executionConstraints || {}),
      authorization_requirements: JSON.stringify(task.authorizationRequirements || {}),
      budget_limits: JSON.stringify(task.budgetLimits || {}),
      timeout_ms: task.timeoutMs,
      attempt_count: task.attemptCount,
      max_retries: task.maxRetries,
      backoff_multiplier: task.backoffMultiplier,
      fencing_token: task.fencingToken,
      lease_owner: task.leaseOwner || null,
      lease_expires_at: task.leaseExpiresAt || null,
      heartbeat_at: task.heartbeatAt || null,
      idempotency_key: task.idempotencyKey || null,
      error_details: task.errorDetails ? JSON.stringify(task.errorDetails) : null,
      usage_telemetry: JSON.stringify(task.usageTelemetry || {}),
      provenance: JSON.stringify(task.provenance || {}),
      checkpoints: JSON.stringify(task.checkpoints || []),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      started_at: task.startedAt || null,
      completed_at: task.completedAt || null
    };

    // Task submission is insert-only. Replays with the same immutable identity
    // are harmless; an ID collision can never rewrite ownership, constraints,
    // payload, or state for an already persisted task.
    await db.transaction(async (trx) => {
      const existing = await trx('specialist_tasks').where({ id: task.id }).forUpdate().first();
      if (existing) {
        assertSamePersistedTaskIdentity(existing, task);
        if (isTerminalSpecialistState(existing.state as SpecialistTaskState) && existing.state !== task.state) {
          throw new TerminalStateImmutabilityError(task.id, existing.state as SpecialistTaskState, task.state);
        }
        return;
      }

      await trx('specialist_tasks').insert(values).onConflict('id').ignore();
      const persisted = await trx('specialist_tasks').where({ id: task.id }).forUpdate().first();
      if (!persisted) throw new Error(`Durable task "${task.id}" failed to persist.`);
      assertSamePersistedTaskIdentity(persisted, task);
    });
  }

  async getTask(id: string): Promise<DurableSpecialistTask | undefined> {
    const row = await db('specialist_tasks').where({ id }).first();
    if (!row) return undefined;
    return this.mapToTask(row);
  }

  async getAuthoritativeExecutionIdentity(taskId: string): Promise<AuthoritativeTaskIdentity | undefined> {
    const row = await db('specialist_tasks')
      .join('runs', 'specialist_tasks.run_id', 'runs.id')
      .leftJoin('principal_workspace_authorities as workspace_authority', function () {
        this.on('workspace_authority.principal_id', '=', 'runs.principal_id')
          .andOn('workspace_authority.workspace_id', '=', 'runs.workspace_id');
      })
      .where('specialist_tasks.id', taskId)
      .select(
        'specialist_tasks.principal_id as task_principal_id',
        'runs.principal_id as run_principal_id',
        'specialist_tasks.workspace_id as task_workspace_id',
        'runs.workspace_id as run_workspace_id',
        'workspace_authority.state as workspace_authority_state',
        'workspace_authority.revoked_at as workspace_authority_revoked_at'
      )
      .first();
    if (!row) return undefined;
    return {
      taskPrincipalId: row.task_principal_id,
      runPrincipalId: row.run_principal_id,
      taskWorkspaceId: row.task_workspace_id || undefined,
      runWorkspaceId: row.run_workspace_id || undefined,
      workspaceAuthorityActive: row.workspace_authority_state === 'ACTIVE' && row.workspace_authority_revoked_at == null
    };
  }

  async getTaskByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<DurableSpecialistTask | undefined> {
    const row = await db('specialist_tasks')
      .where({ principal_id: principalId, idempotency_key: idempotencyKey })
      .first();
    if (!row) return undefined;
    return this.mapToTask(row);
  }

  async listTasksByRun(runId: string): Promise<DurableSpecialistTask[]> {
    const rows = await db('specialist_tasks').where({ run_id: runId }).orderBy('created_at', 'asc');
    return rows.map(r => this.mapToTask(r));
  }

  async listTasksByMission(missionId: string): Promise<DurableSpecialistTask[]> {
    const rows = await db('specialist_tasks').where({ mission_id: missionId }).orderBy('created_at', 'asc');
    return rows.map(r => this.mapToTask(r));
  }

  async listTasksByPrincipal(principalId: string, limit = 50): Promise<DurableSpecialistTask[]> {
    const rows = await db('specialist_tasks')
      .where({ principal_id: principalId })
      .orderBy('created_at', 'desc')
      .limit(limit);
    return rows.map(r => this.mapToTask(r));
  }

  /**
   * Atomic PostgreSQL claim using transactional locking and monotonically incremented fencing token.
   */
  async claimTask(
    taskId: string,
    workerId: string,
    leaseDurationMs: number,
    expectedFencingToken?: number
  ): Promise<TaskClaimResult> {
    return await db.transaction(async (trx) => {
      const row = await trx('specialist_tasks')
        .where({ id: taskId })
        .forUpdate()
        .first();

      if (!row) {
        return { success: false, error: `Task "${taskId}" not found.` };
      }

      const currentState = row.state as SpecialistTaskState;
      if (isTerminalSpecialistState(currentState)) {
        return { success: false, error: `Task "${taskId}" is already terminal (${currentState}).` };
      }

      const now = Date.now();
      const isExpired = row.lease_expires_at ? Number(row.lease_expires_at) < now : true;
      const isClaimable = currentState === 'QUEUED' || currentState === 'RETRY_WAIT' || isExpired;

      if (!isClaimable) {
        return { success: false, error: `Task "${taskId}" is currently active under lease (owner=${row.lease_owner}).` };
      }

      const currentToken = Number(row.fencing_token);
      if (expectedFencingToken !== undefined && currentToken !== expectedFencingToken) {
        return {
          success: false,
          error: `Fencing token mismatch: expected ${expectedFencingToken}, actual ${currentToken}.`
        };
      }

      assertValidTransition(taskId, currentState, 'CLAIMED');

      const nextFencingToken = currentToken + 1;
      const leaseExpiresAt = now + leaseDurationMs;
      const attemptCount = Number(row.attempt_count) + 1;
      const startedAt = row.started_at ? Number(row.started_at) : now;

      await trx('specialist_tasks')
        .where({ id: taskId, fencing_token: currentToken })
        .update({
          state: 'CLAIMED',
          lease_owner: workerId,
          lease_expires_at: leaseExpiresAt,
          heartbeat_at: now,
          fencing_token: nextFencingToken,
          attempt_count: attemptCount,
          started_at: startedAt,
          updated_at: now
        });

      await trx('specialist_task_events').insert({
        id: `evt_${now}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: taskId,
        run_id: row.run_id,
        event_type: 'TASK_CLAIMED',
        from_state: currentState,
        to_state: 'CLAIMED',
        fencing_token: nextFencingToken,
        worker_id: workerId,
        payload: JSON.stringify({ leaseExpiresAt, attempt: attemptCount }),
        created_at: now
      });

      const updatedRow = await trx('specialist_tasks').where({ id: taskId }).first();
      return { success: true, task: this.mapToTask(updatedRow) };
    });
  }

  async renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean> {
    const now = Date.now();
    const rowsUpdated = await db('specialist_tasks')
      .where({
        id: taskId,
        lease_owner: workerId,
        fencing_token: fencingToken
      })
      .whereNotIn('state', TERMINAL_SPECIALIST_STATES)
      .update({
        lease_expires_at: now + leaseDurationMs,
        heartbeat_at: now,
        updated_at: now
      });

    return rowsUpdated > 0;
  }

  async updateTaskState(
    taskId: string,
    toState: SpecialistTaskState,
    fencingToken: number,
    updates: Partial<DurableSpecialistTask> = {}
  ): Promise<boolean> {
    return await db.transaction(async (trx) => {
      const row = await trx('specialist_tasks').where({ id: taskId }).forUpdate().first();
      if (!row) return false;

      const currentToken = Number(row.fencing_token);
      if (currentToken !== fencingToken) {
        throw new StaleFencingTokenError(taskId, fencingToken, currentToken);
      }

      const currentState = row.state as SpecialistTaskState;
      assertValidTransition(taskId, currentState, toState);

      const now = Date.now();
      const updateData: Record<string, any> = {
        state: toState,
        updated_at: now
      };

      if (isTerminalSpecialistState(toState)) {
        updateData.outcome = toSpecialistTaskOutcome(toState);
        updateData.completed_at = now;
        updateData.lease_expires_at = null;
      }

      if (updates.resultOutput !== undefined) {
        updateData.result_output = JSON.stringify(updates.resultOutput);
      }
      if (updates.errorDetails !== undefined) {
        updateData.error_details = JSON.stringify(updates.errorDetails);
      }
      if (updates.usageTelemetry !== undefined) {
        updateData.usage_telemetry = JSON.stringify(updates.usageTelemetry);
      }
      if (updates.provenance !== undefined) {
        updateData.provenance = JSON.stringify(updates.provenance);
      }

      const count = await trx('specialist_tasks')
        .where({ id: taskId, fencing_token: fencingToken })
        .update(updateData);

      if (count === 0) {
        throw new StaleFencingTokenError(taskId, fencingToken, currentToken);
      }

      await trx('specialist_task_events').insert({
        id: `evt_${now}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: taskId,
        run_id: row.run_id,
        event_type: `TASK_STATE_${toState}`,
        from_state: currentState,
        to_state: toState,
        fencing_token: fencingToken,
        worker_id: row.lease_owner,
        payload: JSON.stringify(updates),
        created_at: now
      });

      return true;
    });
  }

  async appendCheckpoint(taskId: string, fencingToken: number, checkpoint: string, data?: unknown): Promise<boolean> {
    return await db.transaction(async (trx) => {
      const row = await trx('specialist_tasks').where({ id: taskId }).forUpdate().first();
      if (!row || Number(row.fencing_token) !== fencingToken) return false;

      const existingCheckpoints: any[] = typeof row.checkpoints === 'string'
        ? JSON.parse(row.checkpoints)
        : (row.checkpoints || []);

      existingCheckpoints.push({
        checkpoint,
        timestamp: Date.now(),
        data
      });

      const updated = await trx('specialist_tasks')
        .where({ id: taskId, fencing_token: fencingToken })
        .update({
          checkpoints: JSON.stringify(existingCheckpoints),
          updated_at: Date.now()
        });

      return updated > 0;
    });
  }

  async findExpiredLeases(now: number, limit = 10): Promise<DurableSpecialistTask[]> {
    const rows = await db('specialist_tasks')
      .whereNotIn('state', TERMINAL_SPECIALIST_STATES)
      .whereNotNull('lease_expires_at')
      .where('lease_expires_at', '<', now)
      .limit(limit);

    return rows.map(r => this.mapToTask(r));
  }

  async findClaimableTasks(now: number, limit = 10): Promise<DurableSpecialistTask[]> {
    const rows = await db('specialist_tasks')
      .whereIn('state', ['QUEUED', 'RETRY_WAIT'])
      .orWhere(builder => {
        builder.whereNotIn('state', TERMINAL_SPECIALIST_STATES)
          .whereNotNull('lease_expires_at')
          .where('lease_expires_at', '<', now);
      })
      .orderBy('created_at', 'asc')
      .limit(limit);

    return rows.map(r => this.mapToTask(r));
  }

  async findRunnableTasks(runId: string): Promise<DurableSpecialistTask[]> {
    const allTasks = await this.listTasksByRun(runId);
    const completedIds = new Set(allTasks.filter(t => t.state === 'COMPLETED').map(t => t.id));

    return allTasks.filter(task => {
      if (task.state !== 'QUEUED' && task.state !== 'BLOCKED' && task.state !== 'RETRY_WAIT') return false;
      return task.dependencies.every(depId => completedIds.has(depId));
    });
  }

  async recordEvent(event: {
    taskId: string;
    runId: string;
    eventType: string;
    fromState?: SpecialistTaskState;
    toState: SpecialistTaskState;
    fencingToken: number;
    workerId?: string;
    payload?: unknown;
  }): Promise<void> {
    const now = Date.now();
    await db('specialist_task_events').insert({
      id: `evt_${now}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: event.taskId,
      run_id: event.runId,
      event_type: event.eventType,
      from_state: event.fromState || null,
      to_state: event.toState,
      fencing_token: event.fencingToken,
      worker_id: event.workerId || null,
      payload: JSON.stringify(event.payload || {}),
      created_at: now
    });
  }

  private mapToTask(row: any): DurableSpecialistTask {
    return {
      id: row.id,
      runId: row.run_id,
      missionId: row.mission_id || undefined,
      principalId: row.principal_id,
      workspaceId: row.workspace_id || undefined,
      role: row.role as SpecialistRole,
      objective: row.objective,
      state: row.state as SpecialistTaskState,
      outcome: row.outcome as SpecialistTaskOutcome || undefined,
      dependencies: typeof row.dependencies === 'string' ? JSON.parse(row.dependencies) : (row.dependencies || []),
      inputPayload: typeof row.input_payload === 'string' ? JSON.parse(row.input_payload) : (row.input_payload || {}),
      resultOutput: row.result_output ? (typeof row.result_output === 'string' ? JSON.parse(row.result_output) : row.result_output) : undefined,
      executionConstraints: typeof row.execution_constraints === 'string' ? JSON.parse(row.execution_constraints) : (row.execution_constraints || {}),
      authorizationRequirements: typeof row.authorization_requirements === 'string' ? JSON.parse(row.authorization_requirements) : (row.authorization_requirements || {}),
      budgetLimits: typeof row.budget_limits === 'string' ? JSON.parse(row.budget_limits) : (row.budget_limits || {}),
      timeoutMs: Number(row.timeout_ms),
      attemptCount: Number(row.attempt_count),
      maxRetries: Number(row.max_retries),
      backoffMultiplier: Number(row.backoff_multiplier),
      fencingToken: Number(row.fencing_token),
      leaseOwner: row.lease_owner || undefined,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : undefined,
      heartbeatAt: row.heartbeat_at ? Number(row.heartbeat_at) : undefined,
      idempotencyKey: row.idempotency_key || undefined,
      errorDetails: row.error_details ? (typeof row.error_details === 'string' ? JSON.parse(row.error_details) : row.error_details) : undefined,
      usageTelemetry: typeof row.usage_telemetry === 'string' ? JSON.parse(row.usage_telemetry) : (row.usage_telemetry || {}),
      provenance: typeof row.provenance === 'string' ? JSON.parse(row.provenance) : (row.provenance || {}),
      checkpoints: typeof row.checkpoints === 'string' ? JSON.parse(row.checkpoints) : (row.checkpoints || []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined
    };
  }
}
