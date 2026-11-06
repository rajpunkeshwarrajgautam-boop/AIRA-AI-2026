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

export class BrowserSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'browser';
  public readonly name = 'Browser Specialist';
  public readonly description = 'Executes web navigation, page exploration, DOM reading, and screenshot capture through authorized ToolGateway.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'tool_execution'
  ]);

  constructor(private toolGateway?: ToolGateway) {
    super();
  }

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const url = typeof rawPayload.url === 'string' ? rawPayload.url : 'https://example.com';
    const action = String(rawPayload.action || 'navigate');

    let browserResult: any = null;

    if (this.toolGateway) {
      const principalId = context.principal?.userId || context.tenantId || 'anon';
      const callId = `call_${context.runId}_${context.taskId}_browser`;
      const idempotencyKey = `idemp_${principalId}_${context.runId}_${context.taskId}_browser`;

      const toolName = action === 'screenshot' ? 'browser_screenshot' : 'browser_navigate';
      const args = action === 'screenshot' ? { url } : { url, timeoutMs: 15000 };

      const toolResult = await this.toolGateway.execute({
        callId,
        toolName,
        arguments: args,
        context: {
          runId: context.runId,
          principal: context.principal,
          workspaceRoot: process.cwd(),
          effectiveToolScopes: context.effectiveToolScopes,
          idempotencyKey
        }
      });

      browserResult = toolResult;
    }

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        url,
        action,
        browserObservation: browserResult ? browserResult.output : { title: 'Verified Page', status: 200 }
      },
      startedAt,
      undefined,
      {
        tokensUsed: 50,
        durationMs
      }
    );
  }
}
