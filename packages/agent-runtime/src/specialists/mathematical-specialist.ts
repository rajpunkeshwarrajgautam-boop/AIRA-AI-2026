import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import { ToolGateway } from '../../../tool-runtime/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class MathematicalSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'analyst';
  public readonly name = 'Mathematical Specialist';
  public readonly description = 'Executes deterministic mathematical and arithmetic expressions through authorized ToolGateway.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'tool_execution',
    'data_analysis'
  ]);

  constructor(private toolGateway: ToolGateway) {
    super();
  }

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const expression = typeof rawPayload.expression === 'string'
      ? rawPayload.expression
      : (typeof rawPayload.formula === 'string'
        ? rawPayload.formula
        : String(rawPayload.input || ''));

    if (!expression || expression.trim().length === 0) {
      return this.buildResult(context, 'FAILED', undefined, startedAt, {
        code: 'MISSING_EXPRESSION',
        message: 'No mathematical expression was provided in inputPayload.',
        retryable: false
      });
    }

    const delayMs = Number(rawPayload.executionDelayMs || rawPayload.sleepMs || 0);
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    // Security invariant: Tool invocation must route authoritatively through ToolGateway
    const principalId = context.principal?.userId || context.tenantId || 'anon';
    const idempotencyKey = context.taskId
      ? `idemp_${principalId}_${context.runId}_${context.taskId}_calculator`
      : undefined;
    const callId = context.taskId
      ? `call_${context.runId}_${context.taskId}_calc`
      : undefined;

    const toolResult = await this.toolGateway.execute({
      callId,
      toolName: 'calculator',
      arguments: { expression },
      context: {
        runId: context.runId,
        principal: context.principal,
        workspaceRoot: process.cwd(),
        effectiveToolScopes: context.effectiveToolScopes,
        idempotencyKey
      }
    });

    const durationMs = Math.max(1, Date.now() - startedAt);

    if (toolResult.isError) {
      return this.buildResult(
        context,
        'FAILED',
        undefined,
        startedAt,
        {
          code: 'CALCULATOR_TOOL_ERROR',
          message: toolResult.error || 'Calculator tool execution failed.',
          retryable: false
        },
        {
          tokensUsed: 15,
          durationMs
        }
      );
    }

    return this.buildResult(
      context,
      'COMPLETED',
      toolResult.output,
      startedAt,
      undefined,
      {
        tokensUsed: 15,
        durationMs
      }
    );
  }
}
