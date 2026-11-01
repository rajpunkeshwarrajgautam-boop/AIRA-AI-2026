import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class SynthesizerSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'synthesizer';
  public readonly name = 'Synthesizer Specialist';
  public readonly description = 'Aggregates multi-agent specialist task outputs into a cohesive, attributed, and verified final deliverable.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'general_reasoning',
    'document_intelligence'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const priorResults = (rawPayload.priorResults && typeof rawPayload.priorResults === 'object')
      ? rawPayload.priorResults as Record<string, any>
      : {};
    const objective = typeof rawPayload.objective === 'string'
      ? rawPayload.objective
      : 'Synthesize multi-agent findings';

    const resultKeys = Object.keys(priorResults);
    let synthesis = `# Executive Synthesis: ${objective}\n\n`;
    synthesis += `Aggregated findings from ${resultKeys.length} specialized task contributors.\n\n`;

    for (const key of resultKeys) {
      const res = priorResults[key];
      synthesis += `### Contributor: ${key}\n`;
      if (res && typeof res === 'object') {
        if (res.findingsSummary) synthesis += `${res.findingsSummary}\n`;
        else if (res.output) synthesis += `${JSON.stringify(res.output, null, 2)}\n`;
        else synthesis += `${JSON.stringify(res, null, 2)}\n`;
      } else {
        synthesis += `${String(res)}\n`;
      }
      synthesis += '\n';
    }

    synthesis += `\n**Verification Status**: Ready for final verifier review.\n`;

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        objective,
        contributorCount: resultKeys.length,
        synthesis,
        status: 'SYNTHESIZED'
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
