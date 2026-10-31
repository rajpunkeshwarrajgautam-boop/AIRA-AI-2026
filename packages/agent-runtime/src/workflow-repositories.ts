import {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepExecution
} from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface WorkflowRepository {
  saveWorkflowDefinition(def: WorkflowDefinition): Promise<void>;
  getWorkflowDefinition(id: string): Promise<WorkflowDefinition | undefined>;
  listWorkflowDefinitions(principalId?: string): Promise<WorkflowDefinition[]>;

  saveWorkflowRun(run: WorkflowRun): Promise<void>;
  getWorkflowRun(id: string): Promise<WorkflowRun | undefined>;
  getWorkflowRunByRunId(runId: string): Promise<WorkflowRun | undefined>;
  listWorkflowRuns(principalId?: string): Promise<WorkflowRun[]>;
  claimWorkflowRun(workflowRunId: string, owner: string, leaseDurationMs: number): Promise<boolean>;

  saveWorkflowStep(step: WorkflowStepExecution): Promise<void>;
  getWorkflowSteps(workflowRunId: string): Promise<WorkflowStepExecution[]>;
  getStepByIdempotencyKey(key: string): Promise<WorkflowStepExecution | undefined>;
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  async saveWorkflowDefinition(def: WorkflowDefinition): Promise<void> {
    const now = Date.now();
    await db('workflow_definitions').insert({
      id: def.workflowId,
      version: def.version || 1,
      name: def.name,
      description: def.description || null,
      principal_id: def.principalId || null,
      input_schema: JSON.stringify(def.inputSchema || {}),
      steps: JSON.stringify(def.steps),
      execution_policy: JSON.stringify(def.executionPolicy || {}),
      output_schema: JSON.stringify(def.outputSchema || {}),
      created_at: def.createdAt ?? now,
      updated_at: def.updatedAt ?? now
    }).onConflict('id').merge();
  }

  async getWorkflowDefinition(id: string): Promise<WorkflowDefinition | undefined> {
    const row = await db('workflow_definitions').where({ id }).first();
    if (!row) return undefined;
    return this.mapToWorkflowDefinition(row);
  }

  async listWorkflowDefinitions(principalId?: string): Promise<WorkflowDefinition[]> {
    let query = db('workflow_definitions').select('*');
    if (principalId) {
      query = query.where({ principal_id: principalId });
    }
    const rows = await query.orderBy('created_at', 'desc');
    return rows.map(r => this.mapToWorkflowDefinition(r));
  }

  async saveWorkflowRun(run: WorkflowRun): Promise<void> {
    await db('workflow_runs').insert({
      id: run.id,
      workflow_id: run.workflowId,
      run_id: run.runId,
      principal_id: run.principalId,
      session_id: run.sessionId,
      state: run.state,
      step_states: JSON.stringify(run.stepStates),
      step_outputs: JSON.stringify(run.stepOutputs),
      step_attempts: JSON.stringify(run.stepAttempts),
      pending_approval_step_id: run.pendingApprovalStepId || null,
      artifacts: JSON.stringify(run.artifacts || []),
      error: run.error || null,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      completed_at: run.completedAt || null
    }).onConflict('id').merge();
  }

  async getWorkflowRun(id: string): Promise<WorkflowRun | undefined> {
    const row = await db('workflow_runs').where({ id }).first();
    if (!row) return undefined;
    return this.mapToWorkflowRun(row);
  }

  async getWorkflowRunByRunId(runId: string): Promise<WorkflowRun | undefined> {
    const row = await db('workflow_runs').where({ run_id: runId }).first();
    if (!row) return undefined;
    return this.mapToWorkflowRun(row);
  }

  async listWorkflowRuns(principalId?: string): Promise<WorkflowRun[]> {
    let query = db('workflow_runs').select('*');
    if (principalId) {
      query = query.where({ principal_id: principalId });
    }
    const rows = await query.orderBy('created_at', 'desc');
    return rows.map(r => this.mapToWorkflowRun(r));
  }

  async claimWorkflowRun(workflowRunId: string, owner: string, leaseDurationMs: number): Promise<boolean> {
    const now = Date.now();
    const leaseUntil = now + leaseDurationMs;
    const updated = await db('workflow_runs')
      .where({ id: workflowRunId })
      .where(function() {
        this.whereNull('recovery_owner')
          .orWhere('recovery_lease_until', '<', now)
          .orWhere('recovery_owner', owner);
      })
      .update({
        recovery_owner: owner,
        recovery_claimed_at: now,
        recovery_lease_until: leaseUntil,
        updated_at: now
      });
    return updated > 0;
  }

  async saveWorkflowStep(step: WorkflowStepExecution): Promise<void> {
    await db('workflow_steps').insert({
      id: step.id,
      workflow_run_id: step.workflowRunId,
      step_id: step.stepId,
      name: step.name,
      state: step.state,
      depends_on: JSON.stringify(step.dependsOn || []),
      attempt: step.attempt,
      input: step.input ? JSON.stringify(step.input) : null,
      output: step.output ? JSON.stringify(step.output) : null,
      error: step.error || null,
      side_effect_level: step.sideEffectLevel,
      approval_required: step.approvalRequired,
      idempotency_key: step.idempotencyKey || null,
      started_at: step.startedAt || null,
      completed_at: step.completedAt || null
    }).onConflict('id').merge();
  }

  async getWorkflowSteps(workflowRunId: string): Promise<WorkflowStepExecution[]> {
    const rows = await db('workflow_steps')
      .where({ workflow_run_id: workflowRunId })
      .orderBy('started_at', 'asc');
    return rows.map(r => this.mapToWorkflowStep(r));
  }

  async getStepByIdempotencyKey(key: string): Promise<WorkflowStepExecution | undefined> {
    const row = await db('workflow_steps').where({ idempotency_key: key }).first();
    if (!row) return undefined;
    return this.mapToWorkflowStep(row);
  }

  private mapToWorkflowDefinition(row: any): WorkflowDefinition {
    return {
      workflowId: row.id,
      version: Number(row.version),
      name: row.name,
      description: row.description || undefined,
      principalId: row.principal_id || undefined,
      inputSchema: typeof row.input_schema === 'string' ? JSON.parse(row.input_schema) : (row.input_schema || {}),
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps || []),
      executionPolicy: typeof row.execution_policy === 'string' ? JSON.parse(row.execution_policy) : (row.execution_policy || {}),
      outputSchema: typeof row.output_schema === 'string' ? JSON.parse(row.output_schema) : (row.output_schema || {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  private mapToWorkflowRun(row: any): WorkflowRun {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      runId: row.run_id,
      principalId: row.principal_id,
      sessionId: row.session_id,
      state: row.state,
      stepStates: typeof row.step_states === 'string' ? JSON.parse(row.step_states) : (row.step_states || {}),
      stepOutputs: typeof row.step_outputs === 'string' ? JSON.parse(row.step_outputs) : (row.step_outputs || {}),
      stepAttempts: typeof row.step_attempts === 'string' ? JSON.parse(row.step_attempts) : (row.step_attempts || {}),
      pendingApprovalStepId: row.pending_approval_step_id || undefined,
      artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : (row.artifacts || []),
      error: row.error || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined
    };
  }

  private mapToWorkflowStep(row: any): WorkflowStepExecution {
    return {
      id: row.id,
      workflowRunId: row.workflow_run_id,
      stepId: row.step_id,
      name: row.name,
      state: row.state,
      dependsOn: typeof row.depends_on === 'string' ? JSON.parse(row.depends_on) : (row.depends_on || []),
      attempt: Number(row.attempt),
      input: row.input ? (typeof row.input === 'string' ? JSON.parse(row.input) : row.input) : undefined,
      output: row.output ? (typeof row.output === 'string' ? JSON.parse(row.output) : row.output) : undefined,
      error: row.error || undefined,
      sideEffectLevel: row.side_effect_level,
      approvalRequired: Boolean(row.approval_required),
      idempotencyKey: row.idempotency_key || undefined,
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined
    };
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private defs: Map<string, WorkflowDefinition> = new Map();
  private runs: Map<string, WorkflowRun> = new Map();
  private runClaims: Map<string, { owner: string; expiresAt: number }> = new Map();
  private runIdIndex: Map<string, string> = new Map();
  private steps: Map<string, WorkflowStepExecution[]> = new Map();

  async saveWorkflowDefinition(def: WorkflowDefinition): Promise<void> {
    this.defs.set(def.workflowId, { ...def });
  }

  async getWorkflowDefinition(id: string): Promise<WorkflowDefinition | undefined> {
    const def = this.defs.get(id);
    return def ? { ...def } : undefined;
  }

  async listWorkflowDefinitions(principalId?: string): Promise<WorkflowDefinition[]> {
    const all = Array.from(this.defs.values());
    if (principalId) {
      return all.filter(d => d.principalId === principalId);
    }
    return all;
  }

  async saveWorkflowRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, { ...run });
    if (run.runId) {
      this.runIdIndex.set(run.runId, run.id);
    }
  }

  async getWorkflowRun(id: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(id);
    return run ? { ...run } : undefined;
  }

  async getWorkflowRunByRunId(runId: string): Promise<WorkflowRun | undefined> {
    const id = this.runIdIndex.get(runId);
    if (!id) return undefined;
    return this.getWorkflowRun(id);
  }

  async listWorkflowRuns(principalId?: string): Promise<WorkflowRun[]> {
    const all = Array.from(this.runs.values());
    if (principalId) {
      return all.filter(r => r.principalId === principalId);
    }
    return all;
  }

  async claimWorkflowRun(workflowRunId: string, owner: string, leaseDurationMs: number): Promise<boolean> {
    const run = this.runs.get(workflowRunId);
    if (!run) return false;
    const now = Date.now();
    const existing = this.runClaims.get(workflowRunId);
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
      return false;
    }
    this.runClaims.set(workflowRunId, { owner, expiresAt: now + leaseDurationMs });
    return true;
  }

  async saveWorkflowStep(step: WorkflowStepExecution): Promise<void> {
    const list = this.steps.get(step.workflowRunId) || [];
    const idx = list.findIndex(s => s.id === step.id);
    if (idx >= 0) {
      list[idx] = { ...step };
    } else {
      list.push({ ...step });
    }
    this.steps.set(step.workflowRunId, list);
  }

  async getWorkflowSteps(workflowRunId: string): Promise<WorkflowStepExecution[]> {
    const list = this.steps.get(workflowRunId) || [];
    return list.map(s => ({ ...s }));
  }

  async getStepByIdempotencyKey(key: string): Promise<WorkflowStepExecution | undefined> {
    for (const list of this.steps.values()) {
      const found = list.find(s => s.idempotencyKey === key && s.state === 'COMPLETED');
      if (found) return { ...found };
    }
    return undefined;
  }
}

