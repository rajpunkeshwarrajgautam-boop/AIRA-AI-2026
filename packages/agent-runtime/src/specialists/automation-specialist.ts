import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class AutomationSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'automation';
  public readonly name = 'Automation Specialist';
  public readonly description = 'Designs, schedules, and validates durable background workflows and trigger configurations.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'general_reasoning',
    'tool_execution'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const name = typeof rawPayload.name === 'string' ? rawPayload.name : 'Durable Workflow Trigger';
    const schedule = typeof rawPayload.cronExpression === 'string' ? rawPayload.cronExpression : '0 9 * * 1';
    const objective = typeof rawPayload.objective === 'string' ? rawPayload.objective : 'Execute recurring workflow';

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        automationId: `auto_${context.taskId}`,
        name,
        schedule,
        objective,
        status: 'CONFIGURED',
        isDurable: true
      },
      startedAt,
      undefined,
      {
        tokensUsed: 30,
        durationMs
      }
    );
  }
}
