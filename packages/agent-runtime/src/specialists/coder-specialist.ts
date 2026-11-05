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

export class CoderSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'coder';
  public readonly name = 'Coder Specialist';
  public readonly description = 'Executes software engineering, file operations, and code artifact generation through authorized ToolGateway.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'software_engineering',
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
    const action = String(rawPayload.action || 'generate_code');
    const targetFile = typeof rawPayload.filePath === 'string' ? rawPayload.filePath : undefined;
    const codeContent = typeof rawPayload.content === 'string' ? rawPayload.content : undefined;

    let toolOutput: any = null;

    if (this.toolGateway && targetFile && action === 'write') {
      const principalId = context.principal?.userId || context.tenantId || 'anon';
      const callId = `call_${context.runId}_${context.taskId}_write`;
      const idempotencyKey = `idemp_${principalId}_${context.runId}_${context.taskId}_write`;

      const toolResult = await this.toolGateway.execute({
        callId,
        toolName: 'file_system_write',
        arguments: { filePath: targetFile, content: codeContent || '' },
        context: {
          runId: context.runId,
          principal: context.principal,
          workspaceRoot: process.cwd(),
          effectiveToolScopes: context.effectiveToolScopes,
          idempotencyKey
        }
      });

      toolOutput = toolResult;
    } else if (this.toolGateway && targetFile && action === 'read') {
      const principalId = context.principal?.userId || context.tenantId || 'anon';
      const callId = `call_${context.runId}_${context.taskId}_read`;
      const idempotencyKey = `idemp_${principalId}_${context.runId}_${context.taskId}_read`;

      const toolResult = await this.toolGateway.execute({
        callId,
        toolName: 'file_system_read',
        arguments: { filePath: targetFile },
        context: {
          runId: context.runId,
          principal: context.principal,
          workspaceRoot: process.cwd(),
          effectiveToolScopes: context.effectiveToolScopes,
          idempotencyKey
        }
      });

      toolOutput = toolResult;
    }

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        action,
        filePath: targetFile,
        code: codeContent || rawPayload.code || 'export default function App() { return <div>AIRA Component</div>; }',
        toolOutput,
        status: 'SUCCESS'
      },
      startedAt,
      undefined,
      {
        tokensUsed: 60,
        durationMs
      }
    );
  }
}
