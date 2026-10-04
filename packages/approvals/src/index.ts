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

    if (!request) {
      throw new Error(`Approval request with ID "${requestId}" not found.`);
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
