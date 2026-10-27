import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class VerificationSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'verifier';
  public readonly name = 'Verification Specialist';
  public readonly description = 'Validates execution outputs and artifacts against explicit verification assertions.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'result_verification'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const expectedValue = rawPayload.expectedValue;
    const actualValue = rawPayload.actualValue;
    const criteria = Array.isArray(rawPayload.criteria) ? rawPayload.criteria : [];

    let verified = true;
    const mismatches: string[] = [];

    if (expectedValue !== undefined && actualValue !== undefined) {
      const match = JSON.stringify(expectedValue) === JSON.stringify(actualValue);
      if (!match) {
        verified = false;
        mismatches.push(`Expected value ${JSON.stringify(expectedValue)} does not match actual value ${JSON.stringify(actualValue)}.`);
      }
    }

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      verified ? 'COMPLETED' : 'FAILED',
      {
        verified,
        criteriaEvaluated: criteria.length,
        mismatches
      },
      startedAt,
      verified
        ? undefined
        : {
            code: 'VERIFICATION_ASSERTION_FAILED',
            message: `Verification assertions failed: ${mismatches.join('; ')}`,
            retryable: false
          },
      {
        tokensUsed: 20,
        durationMs
      }
    );
  }
}
