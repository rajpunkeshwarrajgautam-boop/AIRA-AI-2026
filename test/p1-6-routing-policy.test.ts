import assert from 'node:assert/strict';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';
import { LatencyAwareRoutingPolicy } from '../packages/model-router/src/routing-policy.js';

async function runTests() {
  console.log('=== P1.6 LATENCY-AWARE ROUTING POLICY TEST SUITE ===');

  const tracker = new ProviderHealthTracker({ cooldownMs: 200 });
  const policy = new LatencyAwareRoutingPolicy(tracker);

  // TEST 1: Default healthy selection
  console.log('\n[TEST 1] Default healthy selection');
  const plan1 = policy.selectFastExecutionPlan({
    configuredProviders: ['groq', 'gemini', 'nvidia']
  });

  assert.equal(plan1.primary.provider, 'groq');
  assert.equal(plan1.primary.model, 'openai/gpt-oss-120b');
  assert.equal(plan1.fallback?.provider, 'gemini');
  assert.equal(plan1.fallback?.model, 'gemini-3.5-flash-lite');
  assert.ok(plan1.selectionReason.includes('healthy'), 'Reason should cite healthy primary');
  console.log('PASS: Primary openai/gpt-oss-120b selected with gemini-3.5-flash-lite fallback.');

  // TEST 2: Rejection of defective models (empty responses) and tertiary-only allam
  console.log('\n[TEST 2] Rejection of defective models (empty responses) and tertiary-only allam');
  assert.equal(policy.isModelAllowed('openai/gpt-oss-20b'), false, 'gpt-oss-20b must be rejected due to empty responses');
  assert.equal(policy.isModelAllowed('allam-2-7b'), false, 'allam-2-7b must be rejected as primary/secondary candidate (TERTIARY_ONLY)');
  console.log('PASS: Defective models and tertiary-only candidates properly rejected by policy.');

  // TEST 3: Strict exclusion of NVIDIA Nemotron 120B from Fast fallback
  console.log('\n[TEST 3] Strict exclusion of NVIDIA Nemotron 120B from Fast fallback');
  const planNvidiaOnly = policy.selectFastExecutionPlan({
    configuredProviders: ['nvidia'], // No Groq, only default NVIDIA
    hasDedicatedNvidiaFastModel: false
  });

  // Nemotron 120B must NOT be chosen as fast fallback
  assert.notEqual(planNvidiaOnly.primary.model, 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 120B must not be used for Fast');
  assert.equal(planNvidiaOnly.isDegraded, true, 'Without valid fast candidate, plan must be marked degraded');
  console.log('PASS: Nemotron 120B strictly prohibited as Fast fallback.');

  // TEST 4: NVIDIA permitted only with dedicated instruction model
  console.log('\n[TEST 4] NVIDIA permitted only with dedicated instruction model');
  const planNvidiaFast = policy.selectFastExecutionPlan({
    configuredProviders: ['nvidia'],
    hasDedicatedNvidiaFastModel: true,
    nvidiaFastModel: 'meta/llama-3.1-70b-instruct'
  });

  assert.equal(planNvidiaFast.primary.provider, 'nvidia');
  assert.equal(planNvidiaFast.primary.model, 'meta/llama-3.1-70b-instruct');
  console.log('PASS: NVIDIA permitted for Fast route when dedicated instruction model is configured.');

  // TEST 5: Automatic failover to Gemini when primary Groq circuit is OPEN
  console.log('\n[TEST 5] Automatic failover to Gemini when primary Groq circuit is OPEN');
  // Trip primary circuit breaker
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT'), 504);
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT'), 504);

  const planFailover = policy.selectFastExecutionPlan({
    configuredProviders: ['groq', 'gemini', 'nvidia']
  });

  assert.equal(planFailover.primary.provider, 'gemini', 'Should promote gemini to primary while 120b is OPEN');
  assert.equal(planFailover.primary.model, 'gemini-3.5-flash-lite');
  assert.ok(planFailover.selectionReason.includes('OPEN') || planFailover.selectionReason.includes('FAILOVER'), 'Reason must document circuit state');
  console.log('PASS: Primary circuit trip dynamically promoted Gemini to primary (allam-2-7b never promoted).');

  // TEST 6: Independent Gemini Fallback Selection (Prompt Section 8)
  console.log('\n[TEST 6] Independent Gemini Fallback Selection');
  const trackerGemini = new ProviderHealthTracker({ cooldownMs: 200 });
  const policyGemini = new LatencyAwareRoutingPolicy(trackerGemini);
  const planGroqGemini = policyGemini.selectFastExecutionPlan({
    configuredProviders: ['groq', 'gemini', 'nvidia']
  });

  assert.equal(planGroqGemini.primary.provider, 'groq');
  assert.equal(planGroqGemini.primary.model, 'openai/gpt-oss-120b');
  assert.equal(planGroqGemini.fallback?.provider, 'gemini', 'Fallback must be independent provider gemini');
  assert.equal(planGroqGemini.fallback?.model, 'gemini-3.5-flash-lite');
  console.log('PASS: Independent provider gemini/gemini-3.5-flash-lite selected as fallback.');

  // TEST 7: Groq circuit trips -> Failover to Gemini Primary
  console.log('\n[TEST 7] Failover to Gemini when Groq circuits trip');
  trackerGemini.recordFailure('groq', 'openai/gpt-oss-120b', new Error('RATE_LIMIT_429'), 429);
  trackerGemini.recordFailure('groq', 'openai/gpt-oss-120b', new Error('RATE_LIMIT_429'), 429);
  trackerGemini.recordFailure('groq', 'openai/gpt-oss-120b', new Error('RATE_LIMIT_429'), 429);

  const planGeminiFailover = policyGemini.selectFastExecutionPlan({
    configuredProviders: ['groq', 'gemini', 'nvidia']
  });

  assert.equal(planGeminiFailover.primary.provider, 'gemini', 'Gemini must become primary when Groq trips');
  assert.equal(planGeminiFailover.primary.model, 'gemini-3.5-flash-lite');
  assert.notEqual(planGeminiFailover.primary.model, 'allam-2-7b', 'allam-2-7b must NEVER be promoted to primary');
  console.log('PASS: Full failover to Gemini primary when Groq circuit is tripped.');

  console.log('\n=== ALL P1.6 ROUTING POLICY TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
