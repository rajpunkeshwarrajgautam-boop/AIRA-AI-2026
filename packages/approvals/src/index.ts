import {
  ApprovalRequest,
  ApprovalDecision,
  PermissionLevel,
  ToolCall
} from '../../contracts/src/index.js';
import {
  ApprovalGrantRequest,
  ApprovalRepository,
  OneTimeAuthorizationBinding,
  ApprovalResumptionEvent,
  SessionGrantRepository
} from './repositories.js';

export interface ApprovalManagerOptions {
  autoApproveRead?: boolean;
}

export interface ApprovalResolution {
  approved: boolean;
  request: ApprovalRequest;
  /** False means an identical decision was already committed; callers must not resume again. */
  applied: boolean;
}

function grantForDecision(decision: ApprovalDecision, riskCeiling: PermissionLevel): ApprovalGrantRequest | undefined {
  if (decision === 'ALLOW_SESSION') return { scope: 'SESSION', riskCeiling };
  if (decision === 'ALLOW_ALWAYS_FOR_TOOL') return { scope: 'ALWAYS', riskCeiling };
  return undefined;
}

export class ApprovalKernel {
  constructor(
    private repository: ApprovalRepository,
    private grantRepo: SessionGrantRepository,
    private options: ApprovalManagerOptions = { autoApproveRead: true }
  ) {}

  public async isToolCallApproved(runId: string, toolName: string, permission: PermissionLevel, principalId: string): Promise<boolean> {
    if (await this.grantRepo.hasAlwaysGrant(toolName, principalId, permission, runId)) {
      return true;
    }
    if (await this.grantRepo.hasSessionGrant(runId, toolName, principalId, permission)) {
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
    impactDescription?: string,
    toolDefinitionVersion?: number,
    toolPolicyFingerprint?: string
  ): Promise<ApprovalRequest> {
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const risk = permission === 'DESTRUCTIVE' ? 'critical' : permission === 'FINANCIAL' ? 'high' : permission === 'READ' ? 'low' : 'medium';
    const request: ApprovalRequest = {
      id: requestId,
      runId,
      toolCall,
      risk,
      title: `Authorize Action: ${toolCall.name}`,
      reason: impactDescription || `Action "${toolCall.name}" requires user confirmation under ${permission} policy.`,
      sanitizedPreview: toolCall.arguments || {},
      requestedAt: Date.now(),
      permissionLevel: permission,
      toolDefinitionVersion,
      toolPolicyFingerprint
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

  public async decide(requestId: string, decision: ApprovalDecision, resolvedBy: string): Promise<ApprovalResolution> {
    return this.resolveDecision(requestId, decision, resolvedBy, true);
  }

  /**
   * Resolve and persist a workflow-step decision without issuing reusable
   * ToolGateway session or always grants. WorkflowEngine owns the step-scoped
   * authorization through its pending-step state transition.
   */
  public async resolveWorkflowDecision(
    requestId: string,
    decision: ApprovalDecision,
    resolvedBy: string
  ): Promise<ApprovalResolution> {
    return this.resolveDecision(requestId, decision, resolvedBy, false);
  }

  private async resolveDecision(
    requestId: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    issueReusableGrant: boolean
  ): Promise<ApprovalResolution> {
    const existing = await this.repository.getRequest(requestId);
    if (!existing) throw new Error(`Approval request with ID "${requestId}" not found.`);
    const permission = existing.permissionLevel || 'READ';
    const grant = issueReusableGrant ? grantForDecision(decision, permission) : undefined;

    if (this.repository.resolvePendingRequest) {
      const result = await this.repository.resolvePendingRequest(
        requestId,
        decision,
        resolvedBy,
        grant,
        issueReusableGrant && decision === 'ALLOW_ONCE'
      );
      return { approved: decision !== 'REJECT', request: result.request, applied: result.applied };
    }

    // Compatibility path for in-memory repositories used by legacy unit tests.
    // Production PostgreSQL repositories implement the transactional CAS above.
    if (existing.decision) {
      if (existing.decision === decision && existing.resolvedBy === resolvedBy) {
        return { approved: decision !== 'REJECT', request: existing, applied: false };
      }
      throw new Error('Approval request was already resolved with a different decision or resolver.');
    }
    existing.decision = decision;
    existing.resolvedAt = Date.now();
    existing.resolvedBy = resolvedBy;
    await this.repository.resolveRequest(requestId, decision, resolvedBy);

    if (grant && decision === 'ALLOW_SESSION') {
      await this.grantRepo.grantSession(existing.runId, existing.toolCall.name, resolvedBy, permission);
    } else if (grant && decision === 'ALLOW_ALWAYS_FOR_TOOL') {
      await this.grantRepo.grantAlways(existing.toolCall.name, resolvedBy, permission);
    }
    return { approved: decision !== 'REJECT', request: existing, applied: true };
  }

  public async claimOnceAuthorization(binding: OneTimeAuthorizationBinding): Promise<boolean> {
    if (!this.repository.claimOnceAuthorization) return false;
    return this.repository.claimOnceAuthorization(binding);
  }

  public async markOnceAuthorizationDispatched(requestId: string, claimId: string): Promise<boolean> {
    if (!this.repository.markOnceAuthorizationDispatched) return false;
    return this.repository.markOnceAuthorizationDispatched(requestId, claimId);
  }

  public async finishOnceAuthorization(
    requestId: string,
    claimId: string,
    outcome: 'COMPLETED' | 'FAILED'
  ): Promise<boolean> {
    if (!this.repository.finishOnceAuthorization) return false;
    return this.repository.finishOnceAuthorization(requestId, claimId, outcome);
  }

  public supportsApprovalResumptionOutbox(): boolean {
    return Boolean(this.repository.claimApprovalResumption && this.repository.applyApprovalResumption);
  }

  public async claimApprovalResumption(owner: string, leaseMs: number): Promise<ApprovalResumptionEvent | undefined> {
    return this.repository.claimApprovalResumption?.(owner, leaseMs);
  }

  public async applyApprovalResumption(event: ApprovalResumptionEvent, owner: string): Promise<boolean> {
    return this.repository.applyApprovalResumption?.(event, owner) ?? false;
  }

  public async completeApprovalResumption(eventId: string, result: unknown): Promise<boolean> {
    return this.repository.completeApprovalResumption?.(eventId, result) ?? false;
  }

  public async failApprovalResumption(event: ApprovalResumptionEvent, owner: string, error: string): Promise<boolean> {
    return this.repository.failApprovalResumption?.(event, owner, error) ?? false;
  }

  public async clearSessionGrants(runId: string): Promise<void> {
    await this.grantRepo.clearSession(runId);
  }
}
