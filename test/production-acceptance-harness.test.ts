/**
 * AIRA AI 2026 — Production Acceptance Harness Regression & Unit Test Suite
 *
 * Verifies the correctness, mathematical integrity, and safety guards of
 * the remediated production acceptance harness (scripts/production-acceptance-suite.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDistinctPrincipals,
  parseAndReconstructSseStream,
  preDispatchBudgetGuard,
  calculateTokenUsageAndCost,
  validateCrossAccountProbe,
  createHarmlessApprovalWorkflowDefinition,
  MAX_AUTHORIZED_SPEND_USD
} from '../scripts/production-acceptance-suite.js';

describe('AIRA Production Acceptance Harness Remediation', () => {

  // ---------------------------------------------------------------------------
  // P0 Defect 1: Enforce Distinct Principal Isolation
  // ---------------------------------------------------------------------------
  describe('validateDistinctPrincipals (P0)', () => {
    it('must block isolation certification when both OAuth providers map to the identical principal ID', () => {
      const sharedUserId = 'neon_user_c0fc8caa-a796-482c-9db8-c54e09e8a2b8';
      const result = validateDistinctPrincipals(sharedUserId, sharedUserId);

      assert.equal(result.isDistinct, false, 'Identical user IDs must not be marked distinct');
      assert.equal(result.isolationCertificationStatus, 'BLOCKED', 'Identical user IDs must yield BLOCKED isolation status');
      assert.ok(result.reason.includes('identical AIRA principal'), 'Reason must document shared principal identity');
      assert.ok(result.reason.includes(sharedUserId), 'Reason must include principal identifier');
    });

    it('must pass distinct-principal validation when user IDs are genuinely independent', () => {
      const userA = 'usr_11111111-1111-4111-8111-111111111111';
      const userB = 'usr_22222222-2222-4222-8222-222222222222';
      const result = validateDistinctPrincipals(userA, userB);

      assert.equal(result.isDistinct, true);
      assert.equal(result.isolationCertificationStatus, 'PASS');
      assert.ok(result.reason.includes('Distinct principals verified'));
    });

    it('must block isolation certification when either user ID is missing or undefined', () => {
      const res1 = validateDistinctPrincipals(undefined, 'usr_some_user');
      assert.equal(res1.isDistinct, false);
      assert.equal(res1.isolationCertificationStatus, 'BLOCKED');

      const res2 = validateDistinctPrincipals('usr_some_user', undefined);
      assert.equal(res2.isDistinct, false);
      assert.equal(res2.isolationCertificationStatus, 'BLOCKED');

      const res3 = validateDistinctPrincipals('', '');
      assert.equal(res3.isDistinct, false);
      assert.equal(res3.isolationCertificationStatus, 'BLOCKED');
    });
  });

  // ---------------------------------------------------------------------------
  // P0 Defect 2: Cross-Account Resource Probe Validation
  // ---------------------------------------------------------------------------
  describe('validateCrossAccountProbe (P0)', () => {
    const ownerId = 'neon_user_c0fc8caa-a796-482c-9db8-c54e09e8a2b8';
    const legitimateResource = 'wfrun_run_e9eaa9f5-4';

    it('must reject probes when accounts share identical principal', () => {
      const result = validateCrossAccountProbe(false, ownerId, ownerId, legitimateResource);
      assert.equal(result.valid, false);
      assert.equal(result.status, 'BLOCKED');
      assert.ok(result.reason.includes('identical principal'));
    });

    it('must reject fabricated or unowned probe targets like wf_foreign_isolated_probe', () => {
      const foreignCaller = 'usr_independent_account_b';
      const result = validateCrossAccountProbe(true, foreignCaller, ownerId, 'wf_foreign_isolated_probe');
      assert.equal(result.valid, false);
      assert.equal(result.status, 'BLOCKED');
      assert.ok(result.reason.includes('fabricated or unowned identifier'));
    });

    it('must accept valid cross-principal probe when callers are distinct and resource is legitimate', () => {
      const foreignCaller = 'usr_independent_account_b';
      const result = validateCrossAccountProbe(true, foreignCaller, ownerId, legitimateResource);
      assert.equal(result.valid, true);
      assert.equal(result.status, 'PASS');
      assert.ok(result.reason.includes('Valid cross-principal isolation probe'));
    });
  });

  // ---------------------------------------------------------------------------
  // P1 Defect 3: SSE Stream Reconstruction and Content Assertions
  // ---------------------------------------------------------------------------
  describe('parseAndReconstructSseStream (P1)', () => {
    it('must correctly reconstruct full token stream and confirm terminal done event', () => {
      const rawSse = [
        'event: run_started',
        'data: {"runId":"run_test_12345"}',
        '',
        'event: routing_decision',
        'data: {"model":"aira-fast","provider":"groq"}',
        '',
        'event: model_provenance',
        'data: {"executedModel":"llama-3.3-70b-versatile","provider":"groq"}',
        '',
        'event: content_delta',
        'data: {"text":"AIRA_"}',
        '',
        'event: content_delta',
        'data: {"text":"2026_"}',
        '',
        'event: content_delta',
        'data: {"text":"TEST_OK"}',
        '',
        'event: done',
        'data: [DONE]'
      ].join('\n');

      const parsed = parseAndReconstructSseStream(rawSse);

      assert.equal(parsed.hasRunStarted, true);
      assert.equal(parsed.runId, 'run_test_12345');
      assert.equal(parsed.modelProvenance?.provider, 'groq');
      assert.equal(parsed.modelProvenance?.executedModel, 'llama-3.3-70b-versatile');
      assert.equal(parsed.reconstructedText, 'AIRA_2026_TEST_OK');
      assert.equal(parsed.hasTerminalDone, true);
      assert.equal(parsed.hasError, false);
      assert.ok(parsed.reconstructedText.includes('AIRA_2026_TEST_OK'));
    });

    it('must detect truncated streams missing terminal [DONE]', () => {
      const truncatedSse = [
        'event: run_started',
        'data: {"runId":"run_truncated_99"}',
        '',
        'event: content_delta',
        'data: {"text":"Partial output only"}'
      ].join('\n');

      const parsed = parseAndReconstructSseStream(truncatedSse);

      assert.equal(parsed.hasRunStarted, true);
      assert.equal(parsed.reconstructedText, 'Partial output only');
      assert.equal(parsed.hasTerminalDone, false, 'Truncated stream must not have terminal done');
      assert.equal(parsed.hasError, false);
    });

    it('must capture and flag stream errors (event: error)', () => {
      const errorSse = [
        'event: run_started',
        'data: {"runId":"run_failed_01"}',
        '',
        'event: error',
        'data: {"error":"Model rate limit exceeded","code":"RATE_LIMIT_EXCEEDED"}'
      ].join('\n');

      const parsed = parseAndReconstructSseStream(errorSse);

      assert.equal(parsed.hasRunStarted, true);
      assert.equal(parsed.hasError, true);
      assert.ok(parsed.errorMessage?.includes('Model rate limit exceeded'));
    });

    it('must separate thinking_delta from content_delta', () => {
      const thinkingSse = [
        'event: run_started',
        'data: {"runId":"run_thinking_01"}',
        '',
        'event: thinking_delta',
        'data: {"thinking":"Let me think carefully about the test prompt."}',
        '',
        'event: content_delta',
        'data: {"text":"AIRA_2026_TEST_OK"}',
        '',
        'event: done',
        'data: [DONE]'
      ].join('\n');

      const parsed = parseAndReconstructSseStream(thinkingSse);

      assert.equal(parsed.thinkingText, 'Let me think carefully about the test prompt.');
      assert.equal(parsed.reconstructedText, 'AIRA_2026_TEST_OK');
      assert.equal(parsed.hasTerminalDone, true);
    });
  });

  // ---------------------------------------------------------------------------
  // P1 Defect 4: Pre-Dispatch Budget Guard & Token Accounting
  // ---------------------------------------------------------------------------
  describe('preDispatchBudgetGuard & calculateTokenUsageAndCost (P1)', () => {
    it('must permit inference when projected cost is within budget ceiling', () => {
      const prompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
      const currentSpend = 0.000100;
      const ceiling = MAX_AUTHORIZED_SPEND_USD; // 0.05

      const guard = preDispatchBudgetGuard(currentSpend, ceiling, prompt, 'aira-fast', 64);
      assert.equal(guard.allowed, true);
      assert.ok(guard.newProjectedTotalUsd < ceiling);
      assert.ok(guard.estimatedPromptTokens > 0);
    });

    it('must reject inference when current spend is already at or near ceiling', () => {
      const prompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
      const currentSpend = 0.049990;
      const ceiling = 0.05;

      const guard = preDispatchBudgetGuard(currentSpend, ceiling, prompt, 'aira-fast', 64);
      assert.equal(guard.allowed, false);
      assert.ok(guard.newProjectedTotalUsd > ceiling);
    });

    it('must dynamically compute token usage and mark accountingType as ESTIMATED', () => {
      const prompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
      const response = 'AIRA_2026_TEST_OK';

      const usage = calculateTokenUsageAndCost(prompt, response, 0.60);

      assert.ok(usage.promptTokens > 0);
      assert.ok(usage.completionTokens > 0);
      assert.equal(usage.totalTokens, usage.promptTokens + usage.completionTokens);
      assert.ok(usage.costUsd > 0);
      assert.equal(usage.accountingType, 'ESTIMATED');
    });
  });

  // ---------------------------------------------------------------------------
  // P1 Defect 5: Safe Human-Approval Workflow Definition
  // ---------------------------------------------------------------------------
  describe('createHarmlessApprovalWorkflowDefinition (P1)', () => {
    it('must configure non-destructive sideEffectLevel and require human approval', () => {
      const def = createHarmlessApprovalWorkflowDefinition();

      assert.ok(def.workflowId.startsWith('wf-cancellable-'));
      assert.equal(def.steps.length, 1);

      const step = def.steps[0];
      assert.equal(step.stepId, 'step_require_approval');
      assert.equal(step.name, 'Read-Only Compliance Pause and Verification');
      assert.equal(step.approvalRequired, true, 'approvalRequired must be true to trigger WAITING_FOR_APPROVAL');
      assert.equal(step.sideEffectLevel, 'READ', 'sideEffectLevel must be READ (never DESTRUCTIVE)');
    });
  });

});
