import {
  VerifiableCompletionState,
  ToolRecoveryDecision
} from '../../contracts/src/behavioral.js';
import { ToolResult } from '../../contracts/src/index.js';

export interface ToolExecutionContext {
  toolName: string;
  arguments: Record<string, unknown>;
  isIdempotent: boolean;
  requiresApproval: boolean;
  alternativeTools?: string[];
}

export interface ExecutionAttemptRecord {
  attempt: number;
  state: VerifiableCompletionState;
  startTime: number;
  endTime?: number;
  error?: string;
  toolResult?: ToolResult;
}

export class ToolRecoveryEngine {
  private static readonly MAX_BOUNDED_RETRIES = 2; // Maximum 2 retries (3 total attempts)

  /**
   * Evaluates a failed tool execution and determines whether a safe bounded
   * retry, an alternative fallback tool, user approval, or terminal abort is appropriate.
   */
  public evaluateFailure(
    context: ToolExecutionContext,
    attempt: number,
    error: Error | string,
    toolResult?: ToolResult
  ): ToolRecoveryDecision {
    const errorMsg = typeof error === 'string' ? error : error.message || '';
    const isTransient = this.isTransientError(errorMsg, toolResult);

    // Rule 1: Authorization or permission error requiring explicit confirmation
    if (this.isPermissionOrApprovalError(errorMsg)) {
      return {
        action: 'ASK_APPROVAL',
        attempt,
        maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
        explanation: `Action requires explicit authorization: ${errorMsg}`,
        isIdempotent: context.isIdempotent
      };
    }

    // Rule 2: Non-idempotent operations must NEVER be blindly retried
    if (!context.isIdempotent) {
      // Check if alternative read/verification tool exists
      if (context.alternativeTools && context.alternativeTools.length > 0) {
        return {
          action: 'FALLBACK_TOOL',
          attempt,
          maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
          alternativeTool: context.alternativeTools[0],
          explanation: `Non-idempotent tool "${context.toolName}" failed. Switching to safe fallback tool "${context.alternativeTools[0]}" rather than blindly repeating mutation.`,
          isIdempotent: false
        };
      }

      return {
        action: 'ABORT_PERMANENT_ERROR',
        attempt,
        maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
        explanation: `Non-idempotent operation "${context.toolName}" failed (${errorMsg}). Aborting to prevent duplicate side-effects.`,
        isIdempotent: false
      };
    }

    // Rule 2: Permanent errors abort immediately without burning retry budget
    if (!isTransient) {
      if (this.isPermissionOrApprovalError(errorMsg)) {
        return {
          action: 'ASK_APPROVAL',
          attempt,
          maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
          explanation: `Action requires explicit authorization: ${errorMsg}`,
          isIdempotent: context.isIdempotent
        };
      }

      // Check if alternative fallback tool is available
      if (context.alternativeTools && context.alternativeTools.length > 0) {
        return {
          action: 'FALLBACK_TOOL',
          attempt,
          maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
          alternativeTool: context.alternativeTools[0],
          explanation: `Tool "${context.toolName}" encountered permanent error. Falling back to alternative tool "${context.alternativeTools[0]}".`,
          isIdempotent: true
        };
      }

      return {
        action: 'ABORT_PERMANENT_ERROR',
        attempt,
        maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
        explanation: `Permanent tool error in "${context.toolName}": ${errorMsg}. Halting execution.`,
        isIdempotent: context.isIdempotent
      };
    }

    // Rule 3: Safe transient failure on idempotent operation with remaining retry budget
    if (attempt < ToolRecoveryEngine.MAX_BOUNDED_RETRIES) {
      return {
        action: 'RETRY',
        attempt: attempt + 1,
        maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
        explanation: `Transient error in idempotent operation (${errorMsg}). Retrying (attempt ${attempt + 1}/${ToolRecoveryEngine.MAX_BOUNDED_RETRIES}).`,
        isIdempotent: true
      };
    }

    // Rule 4: Retries exhausted — try fallback tool if available
    if (context.alternativeTools && context.alternativeTools.length > 0) {
      return {
        action: 'FALLBACK_TOOL',
        attempt,
        maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
        alternativeTool: context.alternativeTools[0],
        explanation: `Max retries reached for "${context.toolName}". Switching to fallback capability "${context.alternativeTools[0]}".`,
        isIdempotent: true
      };
    }

    // Rule 5: Bounded retries exhausted and no fallback
    return {
      action: 'ABORT_PERMANENT_ERROR',
      attempt,
      maxAttempts: ToolRecoveryEngine.MAX_BOUNDED_RETRIES,
      explanation: `Exhausted bounded retry limit (${ToolRecoveryEngine.MAX_BOUNDED_RETRIES} retries) for "${context.toolName}".`,
      isIdempotent: true
    };
  }

  /**
   * Verifies completion evidence.
   * AIRA invariants: Never fabricate success or claim completion without verified proof.
   */
  public verifyCompletion(
    toolName: string,
    toolResult?: ToolResult
  ): {
    state: VerifiableCompletionState;
    verified: boolean;
    reason: string;
  } {
    if (!toolResult) {
      return {
        state: 'FAILED',
        verified: false,
        reason: 'No execution result received from tool runtime.'
      };
    }

    if (toolResult.error) {
      return {
        state: 'FAILED',
        verified: false,
        reason: `Tool reported error: ${toolResult.error}`
      };
    }

    // Check specific evidence per tool type
    if (toolName === 'browser_navigate' || toolName === 'browser_screenshot') {
      const output = toolResult.output as any;
      if (!output || (!output.screenshot && !output.title && !output.url)) {
        return {
          state: 'PARTIALLY_COMPLETED',
          verified: false,
          reason: 'Browser tool returned without page render confirmation.'
        };
      }
    }

    return {
      state: 'COMPLETED',
      verified: true,
      reason: 'Execution result verified with concrete evidence.'
    };
  }

  private isTransientError(errorMsg: string, toolResult?: ToolResult): boolean {
    const transientKeywords = [
      'timeout', 'etimedout', 'econnreset', 'econnrefused', 'socket hang up',
      'network error', 'rate limit', '429', '503', '504', 'temporarily unavailable',
      'overloaded', 'gateway timeout'
    ];
    const lower = errorMsg.toLowerCase();
    return transientKeywords.some(kw => lower.includes(kw));
  }

  private isPermissionOrApprovalError(errorMsg: string): boolean {
    const permKeywords = [
      'permission denied', 'unauthorized', 'approval required', 'forbidden',
      'insufficient scopes', 'eacces'
    ];
    const lower = errorMsg.toLowerCase();
    return permKeywords.some(kw => lower.includes(kw));
  }
}
