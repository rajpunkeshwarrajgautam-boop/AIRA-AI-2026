import { isDeepStrictEqual } from 'node:util';
import {
  ApprovalRequest,
  ApprovalDecision,
  PermissionLevel,
  ToolCall
} from '../../contracts/src/index.js';
import { ApprovalRepository, SessionGrantRepository } from './repositories.js';

export interface ApprovalManagerOptions {
  autoApproveRead?: boolean;
}

export class ApprovalKernel {
  constructor(
    private repository: ApprovalRepository,
    private grantRepo: SessionGrantRepository,
    private options: ApprovalManagerOptions = { autoApproveRead: true }
  ) {}

  public async isToolCallApproved(runId: string, toolName: string, permission: PermissionLevel, principalId: string): Promise<boolean> {
    if (await this.grantRepo.hasAlwaysGrant(toolName, principalId)) {
      return true;
    }
    if (await this.grantRepo.hasSessionGrant(runId, toolName, principalId)) {
      return true;
    }
    if (permission === 'READ' && this.options.autoApproveRead) {
      return true;
    }
    return false;
  }

  /**
   * High-risk tools require a decision tied to the exact immutable call ID,
   * tool, arguments and authenticated principal. A generic per-tool grant
   * must not authorize a different payload.
   */
  public async isExactToolCallApproved(
    runId: string, call: ToolCall, principalId: string
  ): Promise<boolean> {
    if (!this.repository.getApprovedForToolCall) return false;
    const approved = await this.repository.getApprovedForToolCall(runId, call.id);
    return Boolean(approved && approved.runId === runId &&
      approved.toolCall.id === call.id && approved.toolCall.name === call.name &&
      isDeepStrictEqual(approved.toolCall.arguments, call.arguments) &&
      approved.resolvedBy === principalId &&
      approved.decision !== 'REJECT');
  }

  public async createRequest(
    runId: string,
    toolCall: ToolCall,
    permission: PermissionLevel,
    impactDescription?: string
  ): Promise<ApprovalRequest> {
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const risk = permission === 'DESTRUCTIVE' ? 'critical' : permission === 'FINANCIAL' ? 'high' : 'medium';
    const request: ApprovalRequest = {
      id: requestId,
      runId,
      toolCall,
      risk,
      title: `Authorize Action: ${toolCall.name}`,
      reason: impactDescription || `Action "${toolCall.name}" requires user confirmation under ${permission} policy.`,
      sanitizedPreview: toolCall.arguments || {},
      requestedAt: Date.now()
    };
    
    await this.repository.saveRequest(request);
    return request;
  }

  public async getPendingRequest(requestId: string): Promise<ApprovalRequest | undefined> {
    const request = await this.repository.getRequest(requestId);
    if (request && !request.decision) {
        return request;
    }
    return undefined;
  }

  public async getPendingForRun(runId: string): Promise<ApprovalRequest[]> {
    return this.repository.getPendingForRun(runId);
  }

  public async decide(requestId: string, decision: ApprovalDecision, resolvedBy: string): Promise<{ approved: boolean; request: ApprovalRequest }> {
    const request = await this.repository.getRequest(requestId);

    if (!request || request.decision) {
      throw new Error('APPROVAL_REQUEST_NOT_PENDING');
    }
    if (!resolvedBy || typeof resolvedBy !== 'string') {
      throw new Error('APPROVAL_RESOLVED_BY_REQUIRED');
    }
    // Isolated builds must never produce blanket grants: generated source
    // changes on every task, so only approval of this exact call is valid.
    if (request.toolCall.name === 'isolated_application_build' &&
        decision !== 'ALLOW_ONCE' && decision !== 'REJECT') {
      throw new Error('ISOLATED_BUILD_REQUIRES_APPROVE_ONCE');
    }

    request.decision = decision;
    request.resolvedAt = Date.now();
    request.resolvedBy = resolvedBy;

    await this.repository.resolveRequest(requestId, decision, resolvedBy);

    if (decision === 'REJECT') {
      return { approved: false, request };
    }

    if (decision === 'ALLOW_SESSION') {
      await this.grantRepo.grantSession(request.runId, request.toolCall.name, resolvedBy);
    } else if (decision === 'ALLOW_ALWAYS_FOR_TOOL') {
      await this.grantRepo.grantAlways(request.toolCall.name, resolvedBy);
    }
    // ALLOW_ONCE does nothing more; the pending_approval resolves and executeRunLoop proceeds.

    return { approved: true, request };
  }

  public async clearSessionGrants(runId: string): Promise<void> {
    await this.grantRepo.clearSession(runId);
  }
}
