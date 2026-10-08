import { DurableToolCall, ToolLifecycleState } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface ToolCallRepository {
  saveToolCall(call: DurableToolCall): Promise<void>;
  getToolCall(id: string): Promise<DurableToolCall | undefined>;
  getToolCallByIdempotencyKey(key: string): Promise<DurableToolCall | undefined>;
  listToolCallsForRun(runId: string): Promise<DurableToolCall[]>;
  listToolCallsForPrincipal(principalId: string, limit?: number): Promise<DurableToolCall[]>;
  updateToolCallStatus(
    id: string,
    status: ToolLifecycleState,
    output?: any,
    error?: string,
    errorCode?: string,
    durationMs?: number
  ): Promise<void>;
}

export class PostgresToolCallRepository implements ToolCallRepository {
  async saveToolCall(call: DurableToolCall): Promise<void> {
    const existingRun = await db('runs').where({ id: call.runId }).first();
    if (!existingRun) {
      await db('runs').insert({
        id: call.runId,
        prompt: `Tool Execution: ${call.toolName}`,
        status: 'RUNNING',
        state: 'RUNNING',
        createdAt: call.startedAt,
        updatedAt: call.startedAt,
        principal_id: call.principalId,
        session_id: 'tool_execution_session'
      }).onConflict('id').ignore();
    }

    await db('tool_calls').insert({
      id: call.id,
      run_id: call.runId,
      workflow_run_id: call.workflowRunId || null,
      agent_mission_id: call.agentMissionId || null,
      principal_id: call.principalId,
      tool_id: call.toolId,
      tool: call.toolName,
      adapter: call.adapter,
      side_effect_level: call.sideEffectLevel,
      permission_scopes: JSON.stringify(call.permissionScopes || []),
      status: call.lifecycleState,
      arguments: JSON.stringify(call.arguments || {}),
      result: call.output !== undefined ? JSON.stringify(call.output) : null,
      error: call.error || null,
      error_code: call.errorCode || null,
      attempt_count: call.attemptCount || 1,
      approval_id: call.approvalId || null,
      idempotency_key: call.idempotencyKey || null,
      started_at: call.startedAt,
      completed_at: call.completedAt || null,
      duration_ms: call.durationMs || null
    }).onConflict('id').merge();
  }

  async getToolCall(id: string): Promise<DurableToolCall | undefined> {
    const row = await db('tool_calls').where({ id }).first();
    if (!row) return undefined;
    return this.mapToDurableToolCall(row);
  }

  async getToolCallByIdempotencyKey(key: string): Promise<DurableToolCall | undefined> {
    const row = await db('tool_calls')
      .where({ idempotency_key: key, status: 'COMPLETED' })
      .orderBy('completed_at', 'desc')
      .first();
    if (!row) return undefined;
    return this.mapToDurableToolCall(row);
  }

  async listToolCallsForRun(runId: string): Promise<DurableToolCall[]> {
    const rows = await db('tool_calls')
      .where({ run_id: runId })
      .orderBy('started_at', 'asc');
    return rows.map(r => this.mapToDurableToolCall(r));
  }

  async listToolCallsForPrincipal(principalId: string, limit = 50): Promise<DurableToolCall[]> {
    const rows = await db('tool_calls')
      .where({ principal_id: principalId })
      .orderBy('started_at', 'desc')
      .limit(limit);
    return rows.map(r => this.mapToDurableToolCall(r));
  }

  async updateToolCallStatus(
    id: string,
    status: ToolLifecycleState,
    output?: any,
    error?: string,
    errorCode?: string,
    durationMs?: number
  ): Promise<void> {
    const updates: Record<string, any> = {
      status,
      completed_at: Date.now()
    };
    if (output !== undefined) updates.result = JSON.stringify(output);
    if (error !== undefined) updates.error = error;
    if (errorCode !== undefined) updates.error_code = errorCode;
    if (durationMs !== undefined) updates.duration_ms = durationMs;

    await db('tool_calls').where({ id }).update(updates);
  }

  private mapToDurableToolCall(row: any): DurableToolCall {
    const parseJson = (val: any, fallback: any = null) => {
      if (!val) return fallback;
      if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return fallback; }
      }
      return val;
    };

    return {
      id: row.id,
      runId: row.run_id,
      workflowRunId: row.workflow_run_id || undefined,
      agentMissionId: row.agent_mission_id || undefined,
      principalId: row.principal_id || '',
      toolId: row.tool_id || row.tool || '',
      toolName: row.tool,
      adapter: (row.adapter || 'native') as any,
      sideEffectLevel: (row.side_effect_level || row.permission || 'NONE') as any,
      permissionScopes: parseJson(row.permission_scopes, []),
      lifecycleState: (row.status || 'RESOLVED') as any,
      arguments: parseJson(row.arguments, {}),
      output: parseJson(row.result, undefined),
      error: row.error || undefined,
      errorCode: row.error_code || undefined,
      attemptCount: row.attempt_count || 1,
      approvalId: row.approval_id || undefined,
      idempotencyKey: row.idempotency_key || undefined,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      durationMs: row.duration_ms ? Number(row.duration_ms) : undefined
    };
  }
}
