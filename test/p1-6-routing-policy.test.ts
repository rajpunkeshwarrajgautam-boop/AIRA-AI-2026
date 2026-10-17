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
    configuredProviders: ['groq', 'nvidia']
  });

  assert.equal(plan1.primary.provider, 'groq');
  assert.equal(plan1.primary.model, 'openai/gpt-oss-120b');
  assert.equal(plan1.fallback?.provider, 'groq');
  assert.equal(plan1.fallback?.model, 'allam-2-7b');
  assert.ok(plan1.selectionReason.includes('healthy'), 'Reason should cite healthy primary');
  console.log('PASS: Primary openai/gpt-oss-120b selected with allam-2-7b fallback.');

  // TEST 2: Rejection of defective models (empty responses)
  console.log('\n[TEST 2] Rejection of defective models (empty responses)');
  // Even if gpt-oss-20b is registered in catalog, policy must reject it as fast candidate
  assert.equal(policy.isModelAllowed('openai/gpt-oss-20b'), false, 'gpt-oss-20b must be rejected due to empty responses');
  console.log('PASS: Defective model openai/gpt-oss-20b rejected by policy.');

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

  // TEST 5: Automatic failover when primary circuit is OPEN
  console.log('\n[TEST 5] Automatic failover when primary circuit is OPEN');
  // Trip primary circuit breaker
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT'), 504);
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT'), 504);

  const planFailover = policy.selectFastExecutionPlan({
    configuredProviders: ['groq', 'nvidia']
  });

  assert.equal(planFailover.primary.provider, 'groq');
  assert.equal(planFailover.primary.model, 'allam-2-7b', 'Should promote allam-2-7b to primary while 120b is OPEN');
  assert.ok(planFailover.selectionReason.includes('OPEN') || planFailover.selectionReason.includes('degraded'), 'Reason must document circuit state');
  console.log('PASS: Primary circuit trip dynamically routed traffic to allam-2-7b.');

  console.log('\n=== ALL P1.6 ROUTING POLICY TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
