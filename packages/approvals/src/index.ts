import {
  ApprovalRequest,
  ApprovalDecision,
  PermissionLevel,
  ToolCall
} from '../../contracts/src/index.js';

export interface ApprovalManagerOptions {
  autoApproveRead?: boolean;
}

export class ApprovalKernel {
  private pendingRequests: Map<string, ApprovalRequest> = new Map();
  private sessionGrants: Set<string> = new Set();
  private alwaysAllowedTools: Set<string> = new Set();

  constructor(private options: ApprovalManagerOptions = { autoApproveRead: true }) {}

  public isToolCallApproved(runId: string, toolName: string, permission: PermissionLevel): boolean {
    if (this.alwaysAllowedTools.has(toolName)) {
      return true;
    }
    if (this.sessionGrants.has(`${runId}:${toolName}`)) {
      return true;
    }
    if (permission === 'READ' && this.options.autoApproveRead) {
      return true;
    }
    return false;
  }

  public createRequest(
    runId: string,
    toolCall: ToolCall,
    permission: PermissionLevel,
    impactDescription?: string
  ): ApprovalRequest {
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
    this.pendingRequests.set(requestId, request);
    return request;
  }

  public getPendingRequest(requestId: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  public getPendingForRun(runId: string): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values()).filter(
      r => r.runId === runId && !r.decision
    );
  }

  public decide(requestId: string, decision: ApprovalDecision, resolvedBy = 'user'): { approved: boolean; request: ApprovalRequest } {
    const request = this.pendingRequests.get(requestId);

    if (!request) {
      throw new Error(`Approval request with ID "${requestId}" not found.`);
    }

    request.decision = decision;
    request.resolvedAt = Date.now();
    request.resolvedBy = resolvedBy;

    if (decision === 'REJECT') {
      return { approved: false, request };
    }

    if (decision === 'ALLOW_SESSION') {
      this.sessionGrants.add(`${request.runId}:${request.toolCall.name}`);
    } else if (decision === 'ALLOW_ALWAYS_FOR_TOOL') {
      this.alwaysAllowedTools.add(request.toolCall.name);
    }

    return { approved: true, request };
  }

  public clearSessionGrants(runId: string): void {
    for (const key of this.sessionGrants) {
      if (key.startsWith(`${runId}:`)) {
        this.sessionGrants.delete(key);
      }
    }
  }
}
