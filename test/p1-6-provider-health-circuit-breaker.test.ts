import assert from 'node:assert/strict';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';

async function runTests() {
  console.log('=== P1.6 PROVIDER HEALTH TRACKER & CIRCUIT BREAKER TEST SUITE ===');

  // TEST 1: Initial state & clean defaults
  console.log('\n[TEST 1] Initial state & clean defaults');
  const tracker = new ProviderHealthTracker({
    slidingWindowSize: 20,
    cooldownMs: 100, // fast for testing
    consecutiveTimeoutThreshold: 2,
    consecutiveRateLimitThreshold: 3
  });

  const state0 = tracker.getCircuitState('groq', 'openai/gpt-oss-120b');
  assert.equal(state0, 'CLOSED', 'Initial circuit state must be CLOSED');
  assert.equal(tracker.isAvailable('groq', 'openai/gpt-oss-120b'), true);
  console.log('PASS: Initial circuit state is CLOSED and available.');

  // TEST 2: Success tracking & rolling TTFT metrics
  console.log('\n[TEST 2] Success tracking & rolling TTFT metrics');
  tracker.recordSuccess('groq', 'openai/gpt-oss-120b', 300);
  tracker.recordSuccess('groq', 'openai/gpt-oss-120b', 400);
  tracker.recordSuccess('groq', 'openai/gpt-oss-120b', 500);

  const tele1 = tracker.getTelemetry('groq', 'openai/gpt-oss-120b');
  assert.equal(tele1.successCount, 3);
  assert.equal(tele1.failureCount, 0);
  assert.equal(tele1.recentTTFTP50, 400);
  assert.equal(tele1.recentTTFTP95, 490);
  assert.equal(tele1.consecutiveTimeouts, 0);
  assert.equal(tele1.consecutiveRateLimits, 0);
  console.log('PASS: Rolling metrics and percentiles recorded correctly.');

  // TEST 3: Circuit Trip on Consecutive Timeouts
  console.log('\n[TEST 3] Circuit Trip on Consecutive Timeouts');
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT: exceeded deadline'), 504);
  assert.equal(tracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'CLOSED', '1 timeout should not open circuit');
  assert.equal(tracker.isAvailable('groq', 'openai/gpt-oss-120b'), true);

  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('FIRST_TOKEN_TIMEOUT: exceeded deadline'), 504);
  assert.equal(tracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'OPEN', '2 consecutive timeouts must OPEN circuit');
  assert.equal(tracker.isAvailable('groq', 'openai/gpt-oss-120b'), false, 'OPEN circuit must mark provider unavailable');
  console.log('PASS: 2 consecutive timeouts tripped circuit breaker to OPEN.');

  // TEST 4: Cooldown & HALF_OPEN transition
  console.log('\n[TEST 4] Cooldown & HALF_OPEN transition');
  assert.equal(tracker.isAvailable('groq', 'openai/gpt-oss-120b'), false, 'Unavailable before cooldown');
  
  // Wait for 110ms cooldown
  await new Promise(r => setTimeout(r, 110));
  assert.equal(tracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'HALF_OPEN', 'Should transition to HALF_OPEN after cooldown');
  assert.equal(tracker.isAvailable('groq', 'openai/gpt-oss-120b'), true, 'HALF_OPEN allows probe');
  console.log('PASS: Cooldown elapsed, transitioned to HALF_OPEN.');

  // TEST 5: HALF_OPEN probe recovery to CLOSED
  console.log('\n[TEST 5] HALF_OPEN probe recovery to CLOSED');
  tracker.recordSuccess('groq', 'openai/gpt-oss-120b', 350);
  assert.equal(tracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'CLOSED', 'Successful probe must reset to CLOSED');
  const teleAfter = tracker.getTelemetry('groq', 'openai/gpt-oss-120b');
  assert.equal(teleAfter.consecutiveTimeouts, 0, 'Consecutive timeouts must be reset');
  console.log('PASS: Successful probe reset circuit to CLOSED.');

  // TEST 6: 429 Rate Limit classification and trip
  console.log('\n[TEST 6] 429 Rate Limit classification and trip');
  tracker.recordFailure('groq', 'qwen/qwen3.8-27b', new Error('Rate limit reached on output tokens per minute (OTPM)'), 429);
  tracker.recordFailure('groq', 'qwen/qwen3.8-27b', new Error('rate_limit_exceeded: 429'), 429);
  assert.equal(tracker.getCircuitState('groq', 'qwen/qwen3.8-27b'), 'CLOSED');
  
  tracker.recordFailure('groq', 'qwen/qwen3.8-27b', new Error('429 Too Many Requests'), 429);
  assert.equal(tracker.getCircuitState('groq', 'qwen/qwen3.8-27b'), 'OPEN', '3 consecutive 429s must OPEN circuit');
  assert.equal(tracker.isAvailable('groq', 'qwen/qwen3.8-27b'), false);
  console.log('PASS: 3 consecutive 429 rate limits tripped circuit breaker.');

  // TEST 7: HALF_OPEN probe failure triggers backoff
  console.log('\n[TEST 7] HALF_OPEN probe failure triggers backoff');
  await new Promise(r => setTimeout(r, 110));
  assert.equal(tracker.getCircuitState('groq', 'qwen/qwen3.8-27b'), 'HALF_OPEN');
  // Probe fails
  tracker.recordFailure('groq', 'qwen/qwen3.8-27b', new Error('429 Too Many Requests'), 429);
  assert.equal(tracker.getCircuitState('groq', 'qwen/qwen3.8-27b'), 'OPEN', 'Failed probe must immediately re-OPEN circuit');
  console.log('PASS: Failed probe returned circuit to OPEN with backoff.');

  console.log('\n=== ALL P1.6 PROVIDER HEALTH TRACKER TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
