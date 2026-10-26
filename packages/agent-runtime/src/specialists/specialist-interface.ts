import {
  SpecialistRole,
  SpecialistTaskResult,
  SpecialistTaskOutcome,
  CapabilityCategory,
  ExecutionPrincipal
} from '../../../contracts/src/index.js';

// ==========================================
// 1. SPECIALIST EXECUTION CONTEXT
// ==========================================

export interface SpecialistModelRoutingRequirements {
  suggestedModelClass?: string;
  maxTokens?: number;
  temperature?: number;
  preferredProvider?: string;
}

export interface SpecialistRemainingBudget {
  maxTokens: number;
  remainingTokens: number;
  maxSpendUsd?: number;
}

export interface SpecialistExecutionContext {
  readonly runId: string;
  readonly taskId: string;
  readonly principal: ExecutionPrincipal;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly authorizedCapabilities: readonly CapabilityCategory[];
  readonly effectiveToolScopes: readonly string[];
  readonly executionPolicyVersion: string;
  readonly promptProfileId: string;
  readonly promptProfileVersion: string;
  readonly modelRoutingRequirements: SpecialistModelRoutingRequirements;
  readonly remainingBudget: SpecialistRemainingBudget;
  readonly cancellationSignal: AbortSignal;
  readonly correlationId: string;
  readonly inputPayload: Readonly<Record<string, unknown>>;
  readonly workingMemory?: Readonly<Record<string, unknown>>;
}

// ==========================================
// 2. SPECIALIST EXECUTION RESULT
// ==========================================

export type SpecialistExecutionResult = SpecialistTaskResult;

// ==========================================
// 3. SPECIALIST AGENT INTERFACE
// ==========================================

export interface ISpecialistAgent {
  readonly role: SpecialistRole;
  readonly name: string;
  readonly description: string;
  readonly requiredCapabilities: readonly CapabilityCategory[];

  /**
   * Validates whether a caller context is authorized to invoke this specialist.
   */
  canExecute(context: SpecialistExecutionContext): { authorized: boolean; reason?: string };

  /**
   * Executes assigned task within bounded capability and budget constraints.
   */
  execute(context: SpecialistExecutionContext): Promise<SpecialistExecutionResult>;
}

// ==========================================
// 4. BASE SPECIALIST AGENT (ABSTRACT FOUNDATION)
// ==========================================

/**
 * Standard base class for future native AIRA specialist agent implementations.
 * Enforces non-bypassable pre-execution capability verification and signal cancellation.
 */
export abstract class BaseSpecialistAgent implements ISpecialistAgent {
  abstract readonly role: SpecialistRole;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly requiredCapabilities: readonly CapabilityCategory[];

  public canExecute(context: SpecialistExecutionContext): { authorized: boolean; reason?: string } {
    if (!context.principal || !context.principal.userId) {
      return { authorized: false, reason: 'Unauthenticated caller: valid execution principal is required.' };
    }

    // Verify all required capabilities are granted in the execution context
    for (const reqCap of this.requiredCapabilities) {
      if (!context.authorizedCapabilities.includes(reqCap)) {
        return {
          authorized: false,
          reason: `Missing required capability: "${reqCap}" is not authorized for principal "${context.principal.userId}".`
        };
      }
    }

    if (context.remainingBudget.remainingTokens <= 0) {
      return { authorized: false, reason: 'Budget exhausted: remaining token budget is zero.' };
    }

    return { authorized: true };
  }

  public async execute(context: SpecialistExecutionContext): Promise<SpecialistExecutionResult> {
    const startedAt = Date.now();

    // Check cancellation signal before starting
    if (context.cancellationSignal.aborted) {
      return this.buildResult(context, 'CANCELLED', undefined, startedAt, {
        code: 'EXECUTION_ABORTED',
        message: 'Task execution was aborted by client cancellation signal.',
        retryable: false
      });
    }

    // Check capability authorization
    const authCheck = this.canExecute(context);
    if (!authCheck.authorized) {
      return this.buildResult(context, 'FAILED', undefined, startedAt, {
        code: 'AUTHORIZATION_DENIED',
        message: authCheck.reason || 'Specialist authorization check failed.',
        retryable: false
      });
    }

    try {
      return await this.performExecution(context, startedAt);
    } catch (err: any) {
      const isAbort = context.cancellationSignal.aborted || err?.name === 'AbortError';
      const outcome: SpecialistTaskOutcome = isAbort ? 'CANCELLED' : 'FAILED';

      return this.buildResult(context, outcome, undefined, startedAt, {
        code: isAbort ? 'EXECUTION_ABORTED' : (err?.code || 'SPECIALIST_EXECUTION_ERROR'),
        message: err?.message || 'An unexpected error occurred during specialist execution.',
        retryable: !isAbort && err?.retryable === true
      });
    }
  }

  /**
   * Internal implementation hook to be implemented by future concrete specialist workers.
   */
  protected abstract performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult>;

  /**
   * Canonical result envelope helper.
   */
  protected buildResult(
    context: SpecialistExecutionContext,
    outcome: SpecialistTaskOutcome,
    output: unknown,
    startedAt: number,
    error?: { code: string; message: string; retryable: boolean },
    usage?: { tokensUsed: number; durationMs: number; model?: string; provider?: string },
    evidenceReferences?: Array<{ source: string; url?: string; description: string; confidence?: number }>
  ): SpecialistExecutionResult {
    const completedAt = Date.now();
    return {
      taskId: context.taskId,
      runId: context.runId,
      role: this.role,
      outcome,
      output,
      evidenceReferences: evidenceReferences || [],
      usage: usage || {
        tokensUsed: 0,
        durationMs: Math.max(0, completedAt - startedAt),
        model: context.modelRoutingRequirements.suggestedModelClass,
        provider: context.modelRoutingRequirements.preferredProvider
      },
      provenance: {
        workerId: 'aira-specialist-runtime',
        promptProfileId: context.promptProfileId
      },
      error,
      timing: {
        startedAt,
        completedAt
      }
    };
  }
}
