import { AgentDefinition, Run, StreamingEvent } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const EXECUTION_LEASE_LOST = 'EXECUTION_LEASE_LOST';
const executionLeaseContext = new AsyncLocalStorage<{ runId: string; lease: RunExecutionLease }>();

// Capture the acquired token for this async execution, never the latest token read
// from the row. Control-plane requests and delegated child runs keep their own scope.
export function withExecutionLease<T>(runId: string, lease: RunExecutionLease, execute: () => Promise<T>): Promise<T> {
  return executionLeaseContext.run({ runId, lease }, execute);
}

function executionLeaseFor(runId: string): RunExecutionLease | undefined {
  const context = executionLeaseContext.getStore();
  return context?.runId === runId ? context.lease : undefined;
}

export interface AgentRepository {
  saveAgent(agent: AgentDefinition): Promise<void>;
  getAgent(id: string): Promise<AgentDefinition | undefined>;
  listAgents(): Promise<AgentDefinition[]>;
  deleteAgent(id: string): Promise<boolean>;
}

export interface RunExecutionLease {
  owner: string;
  fence: number;
  leaseUntil: number;
}

export interface RunRepository {
  saveRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  getInterruptedRuns(): Promise<Run[]>;
  appendRunEvent(event: StreamingEvent): Promise<StreamingEvent>;
  getRunEvents(runId: string): Promise<StreamingEvent[]>;
  getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]>;
  getLatestEventSequence(runId: string): Promise<number>;
  claimInterruptedRun(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  claimExecution(runId: string, owner: string, ttlMs: number): Promise<RunExecutionLease | undefined>;
  renewExecution(runId: string, owner: string, fence: number, ttlMs: number): Promise<RunExecutionLease | undefined>;
  assertExecution(runId: string, owner: string, fence: number): Promise<boolean>;
  releaseExecution(runId: string, owner: string, fence: number): Promise<boolean>;
  getExecutionLease(runId: string): Promise<RunExecutionLease | undefined>;
}

export class PostgresAgentRepository implements AgentRepository {
  async saveAgent(agent: AgentDefinition): Promise<void> {
    await db('agents').insert({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      instructions: agent.instructions,
      modelPolicy: JSON.stringify(agent.modelPolicy),
      tools: JSON.stringify(agent.tools),
      memoryScopes: JSON.stringify(agent.memoryScopes),
      approvalPolicy: agent.approvalPolicy,
      maxSteps: agent.maxSteps,
      timeoutPolicy: JSON.stringify({ maxMs: agent.timeoutMs }),
      createdAt: agent.createdAt || Date.now(),
      updatedAt: Date.now()
    }).onConflict('id').merge();
  }

  async getAgent(id: string): Promise<AgentDefinition | undefined> {
    const row = await db('agents').where({ id }).first();
    if (!row) return undefined;
    return this.mapToAgent(row);
  }

  async listAgents(): Promise<AgentDefinition[]> {
    const rows = await db('agents').select('*');
    return rows.map(this.mapToAgent);
  }

  async deleteAgent(id: string): Promise<boolean> {
    const deleted = await db('agents').where({ id }).delete();
    return deleted > 0;
  }

  private mapToAgent(row: any): AgentDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      instructions: row.instructions,
      modelPolicy: typeof row.modelPolicy === 'string' ? JSON.parse(row.modelPolicy) : row.modelPolicy,
      tools: typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools,
      memoryScopes: typeof row.memoryScopes === 'string' ? JSON.parse(row.memoryScopes) : row.memoryScopes,
      approvalPolicy: row.approvalPolicy,
      maxSteps: row.maxSteps,
      timeoutMs: typeof row.timeoutPolicy === 'string' ? JSON.parse(row.timeoutPolicy)?.maxMs : row.timeoutPolicy?.maxMs
    };
  }
}

export class PostgresRunRepository implements RunRepository {
  async saveRun(run: Run): Promise<void> {
    const values = {
      id: run.id,
      principal_id: run.principalId,
      agent_id: run.agentId || null,
      session_id: run.sessionId,
      workspace_id: run.workspaceId || null,
      project_id: run.projectId || null,
      conversation_id: run.conversationId || null,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      intent: run.intent,
      status: run.state,
      state: run.state,
      modelPolicy: JSON.stringify(run.modelPolicy),
      context_data: JSON.stringify(run.context),
      content: run.content,
      thinking: run.thinking,
      error: run.error,
      toolsUsed: JSON.stringify(run.toolsUsed),
      toolCalls: JSON.stringify(run.toolCalls),
      toolResults: JSON.stringify(run.toolResults),
      citations: JSON.stringify(run.citations),
      artifacts: JSON.stringify(run.artifacts),
      pending_approval: run.pendingApproval ? JSON.stringify(run.pendingApproval) : null,
      stepCount: run.stepCount,
      max_steps: run.maxSteps,
      execution_checkpoint: run.executionCheckpoint,
      recovery_owner: run.recoveryOwner,
      recovery_claimed_at: run.recoveryClaimedAt,
      recovery_lease_until: run.recoveryLeaseUntil,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completed_at: run.completedAt
    };
    const lease = executionLeaseFor(run.id);
    if (lease) {
      // The predicate is checked with the write under PostgreSQL's row lock.
      // Database time also checks expiry after any lock wait, not before dispatch.
      const updated = await db.transaction<number>(async trx => {
        await trx('runs').where({ id: run.id }).forUpdate().first('id');
        const rows = await trx('runs')
          .where({ id: run.id, execution_owner: lease.owner, execution_fence: lease.fence })
          .whereRaw('execution_lease_until >= floor(extract(epoch from clock_timestamp()) * 1000)')
          .whereNotIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
          .update(values).returning('id');
        return rows.length;
      });
      if (!updated) throw new Error(EXECUTION_LEASE_LOST);
      return;
    }
    await db('runs').insert(values).onConflict('id').merge().whereNotIn('runs.state', ['COMPLETED', 'FAILED', 'CANCELLED']);
  }

  async getRun(id: string): Promise<Run | undefined> {
    const row = await db('runs').where({ id }).first();
    if (!row) return undefined;
    return this.mapToRun(row);
  }

  async listRuns(): Promise<Run[]> {
    const rows = await db('runs').select('*').orderBy('createdAt', 'desc');
    return rows.map(row => this.mapToRun(row));
  }

  async getInterruptedRuns(): Promise<Run[]> {
    const rows = await db('runs').whereIn('state', ['QUEUED', 'RUNNING', 'WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL']).orderBy('createdAt', 'asc');
    return rows.map(row => this.mapToRun(row));
  }

  async claimInterruptedRun(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const until = now + ttlMs;
    const result = await db('runs')
      .where({ id: runId })
      .andWhere(function() {
        this.whereNull('recovery_owner').orWhere('recovery_lease_until', '<', now);
      })
      .update({ recovery_owner: owner, recovery_claimed_at: now, recovery_lease_until: until, updatedAt: now });
    return result > 0;
  }

  async claimExecution(runId: string, owner: string, ttlMs: number): Promise<RunExecutionLease | undefined> {
    const now = Date.now();
    const until = now + Math.max(5_000, ttlMs);
    const rows = await db('runs')
      .where({ id: runId })
      .whereNotIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .andWhere(function() {
        this.whereNull('execution_owner').orWhereNull('execution_lease_until').orWhere('execution_lease_until', '<', now);
      })
      .update({
        execution_owner: owner,
        execution_lease_until: until,
        execution_fence: db.raw('COALESCE(execution_fence, 0) + 1')
      })
      .returning(['execution_fence', 'execution_lease_until']);
    if (!rows[0]) return undefined;
    return { owner, fence: Number(rows[0].execution_fence), leaseUntil: Number(rows[0].execution_lease_until) };
  }

  async renewExecution(runId: string, owner: string, fence: number, ttlMs: number): Promise<RunExecutionLease | undefined> {
    const now = Date.now();
    const until = now + Math.max(5_000, ttlMs);
    const rows = await db('runs')
      .where({ id: runId, execution_owner: owner, execution_fence: fence })
      .andWhere('execution_lease_until', '>=', now)
      .whereNotIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .update({ execution_lease_until: until })
      .returning(['execution_fence', 'execution_lease_until']);
    if (!rows[0]) return undefined;
    return { owner, fence: Number(rows[0].execution_fence), leaseUntil: Number(rows[0].execution_lease_until) };
  }

  async assertExecution(runId: string, owner: string, fence: number): Promise<boolean> {
    const row = await db('runs').where({ id: runId, execution_owner: owner, execution_fence: fence }).first('execution_lease_until');
    return Boolean(row && Number(row.execution_lease_until) >= Date.now());
  }

  async releaseExecution(runId: string, owner: string, fence: number): Promise<boolean> {
    const updated = await db('runs')
      .where({ id: runId, execution_owner: owner, execution_fence: fence })
      .update({ execution_owner: null, execution_lease_until: null });
    return updated > 0;
  }

  async getExecutionLease(runId: string): Promise<RunExecutionLease | undefined> {
    const row = await db('runs').where({ id: runId }).first('execution_owner', 'execution_fence', 'execution_lease_until');
    if (!row?.execution_owner || !row?.execution_lease_until) return undefined;
    return { owner: row.execution_owner, fence: Number(row.execution_fence || 0), leaseUntil: Number(row.execution_lease_until) };
  }

  async appendRunEvent(event: StreamingEvent): Promise<StreamingEvent> {
    const lease = executionLeaseFor(event.runId);
    const insert = async (query: typeof db) => query('run_events').insert({
      id: event.eventId,
      run_id: event.runId,
      type: event.type,
      payload: JSON.stringify(event.data),
      createdAt: event.timestamp
    }).returning('*');
    const rows = lease ? await db.transaction(async trx => {
      // Keep takeover blocked until the event commits. A separate preflight
      // SELECT cannot protect an INSERT into the event table.
      const run = await trx('runs').where({ id: event.runId }).forUpdate().first();
      const time = await trx.raw('select floor(extract(epoch from clock_timestamp()) * 1000) as now');
      if (!run || run.execution_owner !== lease.owner || Number(run.execution_fence) !== lease.fence
          || Number(run.execution_lease_until) < Number(time.rows[0].now) || run.execution_lease_until === null) {
        throw new Error(EXECUTION_LEASE_LOST);
      }
      return insert(trx);
    }) : await insert(db);
    const row = rows[0];
    return {
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    };
  }

  async getRunEvents(runId: string): Promise<StreamingEvent[]> {
    const rows = await db('run_events').where({ run_id: runId }).orderBy('sequence', 'asc');
    return rows.map((row: any) => ({
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }

  async getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]> {
    const rows = await db('run_events')
      .where({ run_id: runId })
      .andWhere('sequence', '>', sequence)
      .orderBy('sequence', 'asc');
    return rows.map((row: any) => ({
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }

  async getLatestEventSequence(runId: string): Promise<number> {
    const row = await db('run_events').where({ run_id: runId }).max('sequence as max_seq').first();
    return row && row.max_seq ? parseInt(row.max_seq, 10) : 0;
  }

  private mapToRun(row: any): Run {
    const parseJson = (val: any, def: any) => {
      if (!val) return def;
      return typeof val === 'string' ? JSON.parse(val) : val;
    };
    return {
      id: row.id,
      principalId: row.principal_id,
      agentId: row.agent_id || null,
      sessionId: row.session_id,
      workspaceId: row.workspace_id || null,
      projectId: row.project_id || null,
      conversationId: row.conversation_id || null,
      intent: row.intent as any,
      state: row.state as any,
      modelPolicy: parseJson(row.modelPolicy, {}),
      prompt: row.prompt,
      systemPrompt: row.systemPrompt || '',
      context: parseJson(row.context_data, {}),
      content: row.content || '',
      thinking: row.thinking || '',
      error: row.error,
      toolsUsed: parseJson(row.toolsUsed, []),
      toolCalls: parseJson(row.toolCalls, []),
      toolResults: parseJson(row.toolResults, []),
      pendingApproval: row.pending_approval ? parseJson(row.pending_approval, undefined) : undefined,
      artifacts: parseJson(row.artifacts, []),
      citations: parseJson(row.citations, []),
      stepCount: row.stepCount || 0,
      maxSteps: row.max_steps || 10,
      executionCheckpoint: row.execution_checkpoint,
      recoveryOwner: row.recovery_owner,
      recoveryClaimedAt: row.recovery_claimed_at ? parseInt(row.recovery_claimed_at, 10) : undefined,
      recoveryLeaseUntil: row.recovery_lease_until ? parseInt(row.recovery_lease_until, 10) : undefined,
      createdAt: parseInt(row.createdAt, 10),
      updatedAt: parseInt(row.updatedAt, 10),
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : undefined
    };
  }
}
