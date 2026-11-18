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
  validateServerAuthoritativeEntitlements,
  validateServerSideCancellation,
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
      assert.equal(guard.enforcementNature, 'CLIENT_SAFETY_TRIPWIRE');
    });

    it('must reject inference when current spend is already at or near ceiling', () => {
      const prompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
      const currentSpend = 0.049990;
      const ceiling = 0.05;

      const guard = preDispatchBudgetGuard(currentSpend, ceiling, prompt, 'aira-fast', 64);
      assert.equal(guard.allowed, false);
      assert.ok(guard.newProjectedTotalUsd > ceiling);
      assert.ok(guard.rejectionReason?.includes('exceeds budget ceiling'));
    });

    it('must reject inference when current spend has already reached ceiling', () => {
      const guard = preDispatchBudgetGuard(0.050000, 0.05, 'test', 'aira-fast');
      assert.equal(guard.allowed, false);
      assert.ok(guard.rejectionReason?.includes('already reached or exceeded budget ceiling'));
    });

    it('must dynamically compute token usage and mark accountingType as ESTIMATED when usage events absent', () => {
      const prompt = "Reply with 'AIRA_2026_TEST_OK' and nothing else";
      const response = 'AIRA_2026_TEST_OK';

      const usage = calculateTokenUsageAndCost(prompt, response, 'aira-fast');

      assert.ok(usage.promptTokens > 0);
      assert.ok(usage.completionTokens > 0);
      assert.equal(usage.totalTokens, usage.promptTokens + usage.completionTokens);
      assert.ok(usage.costUsd > 0);
      assert.equal(usage.accountingType, 'ESTIMATED');
    });

    it('must extract AUTHORITATIVE token accounting when usage events exist', () => {
      const events = [
        { event: 'model_provenance', data: '', parsedData: { provider: 'groq', executedModel: 'llama-3.3-70b-versatile' } },
        { event: 'usage', data: '', parsedData: { promptTokens: 14, completionTokens: 4 } }
      ];

      const usage = calculateTokenUsageAndCost('prompt', 'response', 'aira-fast', events);

      assert.equal(usage.accountingType, 'AUTHORITATIVE');
      assert.equal(usage.promptTokens, 14);
      assert.equal(usage.completionTokens, 4);
      assert.equal(usage.totalTokens, 18);
      assert.equal(usage.provider, 'groq');
      assert.equal(usage.model, 'llama-3.3-70b-versatile');
    });

    it('must record UNKNOWN accounting on empty response without events', () => {
      const usage = calculateTokenUsageAndCost('', '', 'aira-fast');
      assert.equal(usage.accountingType, 'UNKNOWN');
      assert.equal(usage.totalTokens, 0);
      assert.equal(usage.costUsd, 0);
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

  // ---------------------------------------------------------------------------
  // P1 Defect 6: Server-Authoritative Entitlements (No Silent Defaults)
  // ---------------------------------------------------------------------------
  describe('validateServerAuthoritativeEntitlements (P1)', () => {
    const validEntitlements = {
      customerId: 'usr_valid_customer_123',
      plan: 'free',
      subscriptionStatus: 'active',
      dailyStandardChatLimit: 15,
      availableCredits: 100
    };

    const validSummary = {
      principalId: 'usr_valid_customer_123',
      planId: 'free',
      subscriptionStatus: 'active',
      dailyChatLimit: 15,
      availableCredits: 100
    };

    it('must pass when server returns complete, consistent entitlement records', () => {
      const result = validateServerAuthoritativeEntitlements(validEntitlements, validSummary, 'usr_valid_customer_123');
      assert.equal(result.valid, true);
      assert.equal(result.status, 'PASS');
      assert.equal(result.planId, 'free');
      assert.equal(result.dailyChatLimit, 15);
      assert.equal(result.availableCredits, 100);
    });

    it('must fail when both entitlements and summary are null (prohibits silent fallback)', () => {
      const result = validateServerAuthoritativeEntitlements(null, null);
      assert.equal(result.valid, false);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reason?.includes('Silent fallback to default plan is strictly prohibited'));
    });

    it('must fail when planId is missing or invalid', () => {
      const invalidPlanSummary = { ...validSummary, planId: 'unknown_plan_tier' };
      const result = validateServerAuthoritativeEntitlements(null, invalidPlanSummary);
      assert.equal(result.valid, false);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reason?.includes('invalid or missing planId'));
    });

    it('must fail when dailyChatLimit is non-numeric or missing', () => {
      const missingLimitSummary = { ...validSummary, dailyChatLimit: undefined };
      const result = validateServerAuthoritativeEntitlements(null, missingLimitSummary);
      assert.equal(result.valid, false);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reason?.includes('invalid or non-numeric dailyChatLimit'));
    });

    it('must fail when principalId mismatches expected principal', () => {
      const result = validateServerAuthoritativeEntitlements(validEntitlements, validSummary, 'usr_different_user');
      assert.equal(result.valid, false);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reason?.includes('Principal mismatch'));
    });

    it('must fail when entitlements and summary report contradictory plans', () => {
      const conflictingEntitlements = { ...validEntitlements, plan: 'pro' };
      const result = validateServerAuthoritativeEntitlements(conflictingEntitlements, validSummary);
      assert.equal(result.valid, false);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reason?.includes('Contradiction detected'));
    });
  });

  // ---------------------------------------------------------------------------
  // P1 Defect 7: Server-Side Cancellation Telemetry Verification
  // ---------------------------------------------------------------------------
  describe('validateServerSideCancellation (P1)', () => {
    it('must return PASS for client and UNVERIFIED/BLOCKED for server when only client abort occurred', () => {
      const result = validateServerSideCancellation(true);
      assert.equal(result.clientAbortStatus, 'PASS');
      assert.equal(result.serverLeaseStatus, 'UNVERIFIED/BLOCKED');
      assert.ok(result.reason.includes('Browser AbortError does not prove upstream provider cancellation'));
    });

    it('must return PASS for both when authoritative post-abort run state is CANCELLED', () => {
      const result = validateServerSideCancellation(true, 'CANCELLED');
      assert.equal(result.clientAbortStatus, 'PASS');
      assert.equal(result.serverLeaseStatus, 'PASS');
      assert.ok(result.reason.includes('confirmed via authoritative execution telemetry'));
    });

    it('must return PASS for both when server telemetry was observed', () => {
      const result = validateServerSideCancellation(true, undefined, true);
      assert.equal(result.clientAbortStatus, 'PASS');
      assert.equal(result.serverLeaseStatus, 'PASS');
    });

    it('must return FAIL for client when client abort failed', () => {
      const result = validateServerSideCancellation(false);
      assert.equal(result.clientAbortStatus, 'FAIL');
      assert.equal(result.serverLeaseStatus, 'UNVERIFIED/BLOCKED');
    });
  });

});
