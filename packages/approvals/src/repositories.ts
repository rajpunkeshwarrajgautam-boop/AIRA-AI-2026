import { ApprovalRequest, ApprovalDecision, ToolCall } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  getPendingForRun(runId: string): Promise<ApprovalRequest[]>;
  resolveRequest(id: string, decision: ApprovalDecision, resolvedBy: string): Promise<void>;
}

export class PostgresApprovalRepository implements ApprovalRepository {
  async saveRequest(request: ApprovalRequest): Promise<void> {
    // Save tool_call first to satisfy the foreign key constraint from approvals
    await db('tool_calls').insert({
      id: request.toolCall.id,
      run_id: request.runId,
      tool: request.toolCall.name,
      arguments: JSON.stringify(request.toolCall.arguments),
      status: 'PENDING',
      started_at: Date.now()
    }).onConflict('id').ignore();

    await db('approvals').insert({
      id: request.id,
      run_id: request.runId,
      tool_call_id: request.toolCall.id,
      status: 'PENDING',
      reason: request.reason,
      created_at: request.requestedAt
    }).onConflict('id').merge();
  }

  async getRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = await db('approvals')
      .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
      .select('approvals.*', 'tool_calls.tool', 'tool_calls.arguments', 'tool_calls.started_at')
      .where('approvals.id', id).first();
      
    if (!row) return undefined;
    
    return {
      id: row.id,
      runId: row.run_id,
      toolCall: {
        id: row.tool_call_id,
        toolId: `tool_${row.tool}`,
        status: 'PENDING',
        name: row.tool,
        arguments: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
        timestamp: parseInt(row.started_at, 10)
      },
      risk: 'medium', // dynamically computed elsewhere ideally
      title: `Authorize Action: ${row.tool}`,
      reason: row.reason || '',
      sanitizedPreview: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
      requestedAt: parseInt(row.created_at, 10),
      decision: row.status === 'PENDING' ? undefined : row.status as ApprovalDecision,
      resolvedAt: row.resolved_at ? parseInt(row.resolved_at, 10) : undefined,
      resolvedBy: row.resolved_by || undefined
    };
  }

  async getPendingForRun(runId: string): Promise<ApprovalRequest[]> {
    const rows = await db('approvals')
      .join('tool_calls', 'approvals.tool_call_id', 'tool_calls.id')
      .select('approvals.*', 'tool_calls.tool', 'tool_calls.arguments', 'tool_calls.started_at')
      .where('approvals.run_id', runId)
      .andWhere('approvals.status', 'PENDING');
      
    return rows.map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      toolCall: {
        id: row.tool_call_id,
        toolId: `tool_${row.tool}`,
        status: 'PENDING',
        name: row.tool,
        arguments: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
        timestamp: parseInt(row.started_at, 10)
      },
      risk: 'medium',
      title: `Authorize Action: ${row.tool}`,
      reason: row.reason || '',
      sanitizedPreview: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
      requestedAt: parseInt(row.created_at, 10),
      decision: undefined
    }));
  }

  async resolveRequest(id: string, decision: ApprovalDecision, resolvedBy: string): Promise<void> {
    const updated = await db('approvals').where({ id, status: 'PENDING' }).update({
      status: decision,
      resolved_at: Date.now(),
      resolved_by: resolvedBy
    });
    if (!updated) throw new Error('Approval is already resolved.');
  }
}

export interface SessionGrantRepository {
  grantSession(runId: string, tool: string, principalId: string): Promise<void>;
  grantAlways(tool: string, principalId: string): Promise<void>;
  hasSessionGrant(runId: string, tool: string, principalId: string): Promise<boolean>;
  hasAlwaysGrant(tool: string, principalId: string): Promise<boolean>;
  clearSession(runId: string): Promise<void>;
}

export class PostgresSessionGrantRepository implements SessionGrantRepository {
  async grantSession(runId: string, tool: string, principalId: string): Promise<void> {
    const id = `gr_${Math.random().toString(36).slice(2,10)}`;
    await db('session_grants').insert({
      id,
      principal_id: principalId,
      session_id: runId, // using runId as sessionId for now
      tool,
      permission: 'SESSION',
      granted_at: Date.now()
    });
  }

  async grantAlways(tool: string, principalId: string): Promise<void> {
    const id = `gr_${Math.random().toString(36).slice(2,10)}`;
    await db('session_grants').insert({
      id,
      principal_id: principalId,
      tool,
      permission: 'ALWAYS',
      granted_at: Date.now()
    });
  }

  async hasSessionGrant(runId: string, tool: string, principalId: string): Promise<boolean> {
    const row = await db('session_grants').where({
      principal_id: principalId,
      session_id: runId,
      tool,
      permission: 'SESSION'
    }).first();
    return !!row;
  }

  async hasAlwaysGrant(tool: string, principalId: string): Promise<boolean> {
    const row = await db('session_grants').where({
      principal_id: principalId,
      tool,
      permission: 'ALWAYS'
    }).first();
    return !!row;
  }

  async clearSession(runId: string): Promise<void> {
    await db('session_grants').where({ session_id: runId }).delete();
  }
}


