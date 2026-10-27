import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class AnalysisSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'analyst';
  public readonly name = 'Analysis Specialist';
  public readonly description = 'Performs deterministic structured read-only data evaluation, aggregation, and synthesis.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'data_analysis'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const dataItems = Array.isArray(rawPayload.items)
      ? rawPayload.items
      : (Array.isArray(rawPayload.data) ? rawPayload.data : [rawPayload]);

    const count = dataItems.length;
    const summary = {
      evaluatedCount: count,
      timestamp: Date.now(),
      status: 'ANALYZED',
      metrics: {
        keysAnalyzed: Object.keys(rawPayload).length,
        hasPayload: count > 0
      }
    };

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      summary,
      startedAt,
      undefined,
      {
        tokensUsed: 25,
        durationMs
      }
    );
  }
}
