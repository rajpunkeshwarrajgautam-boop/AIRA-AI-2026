import { ApprovalRequest, ApprovalDecision } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  getPendingForRun(runId: string): Promise<ApprovalRequest[]>;
  resolveRequest(id: string, decision: ApprovalDecision, resolvedBy: string): Promise<void>;
}

export class PostgresApprovalRepository implements ApprovalRepository {
  async saveRequest(request: ApprovalRequest): Promise<void> {
    const existingRun = await db('runs').where({ id: request.runId }).first();
    if (!existingRun) {
      await db('runs').insert({
        id: request.runId,
        prompt: `Action Approval: ${request.toolCall.name}`,
        status: 'RUNNING',
        state: 'RUNNING',
        createdAt: request.requestedAt,
        updatedAt: request.requestedAt,
        principal_id: 'usr_system',
        session_id: 'approval_session'
      }).onConflict('id').ignore();
    }

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
      .where('approvals.id', id).first();
      
    if (!row) return undefined;
    
    return {
      id: row.id,
      runId: row.run_id,
      toolCall: {
        id: row.tool_call_id,
        toolId: row.tool_id || `tool_${row.tool}`,
        status: 'WAITING_FOR_APPROVAL',
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
      .where('approvals.run_id', runId)
      .andWhere('approvals.status', 'PENDING');
      
    return rows.map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      toolCall: {
        id: row.tool_call_id,
        toolId: row.tool_id || `tool_${row.tool}`,
        status: 'WAITING_FOR_APPROVAL',
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
    await db('approvals').where({ id }).update({
      status: decision,
      resolved_at: Date.now(),
      resolved_by: resolvedBy
    });
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


