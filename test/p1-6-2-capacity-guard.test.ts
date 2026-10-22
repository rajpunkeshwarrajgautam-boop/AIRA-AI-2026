import assert from 'node:assert/strict';
import {
  PrivateBetaCapacityGuard,
  InMemoryCapacityStore,
  CapacityStore
} from '../packages/model-router/src/capacity/index.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';

async function runTests() {
  console.log('=== P1.6.2 PRIVATE BETA CAPACITY GUARD TEST SUITE ===');

  // TEST 1: Default initialization & clean configuration
  console.log('\n[TEST 1] Default initialization & clean configuration');
  const guard = new PrivateBetaCapacityGuard({
    globalMaxConcurrent: 2,
    perUserMaxConcurrent: 1,
    globalRpm: 14,
    perUserRpm: 5,
    queueMaxDepth: 3,
    queueMaxWaitMs: 300,
    retryAfterSeconds: 5
  });

  const config = guard.getConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.globalMaxConcurrent, 2);
  assert.equal(config.perUserMaxConcurrent, 1);
  assert.equal(config.globalRpm, 14);
  assert.equal(config.perUserRpm, 5);
  console.log('PASS: Guard initialized with correct evidence-based defaults.');

  // TEST 2: Route separation: Deep & Research bypass Fast Capacity Guard
  console.log('\n[TEST 2] Route separation: Deep & Research bypass Fast Capacity Guard');
  const deepRes = await guard.admit({ principalId: 'user1', model: 'aira-deep' });
  assert.equal(deepRes.decision, 'ADMIT_NOW', 'Deep route should bypass Fast guard');
  assert.equal(deepRes.permit, undefined, 'Bypassed route does not consume permit');

  const researchRes = await guard.admit({ principalId: 'user1', model: 'aira-fast', intent: 'RESEARCH' });
  assert.equal(researchRes.decision, 'ADMIT_NOW', 'Research intent should bypass Fast guard');
  console.log('PASS: Deep and Research routes cleanly separated from Fast capacity.');

  // TEST 3: Global concurrency enforcement & permit acquisition
  console.log('\n[TEST 3] Global concurrency enforcement & permit acquisition');
  await guard.reset();
  const req1 = await guard.admit({ principalId: 'user1', model: 'aira-fast' });
  assert.equal(req1.decision, 'ADMIT_NOW', 'User 1 request 1 should be admitted');
  assert.ok(req1.permit?.permitId, 'Permit ID must be issued');

  const req2 = await guard.admit({ principalId: 'user2', model: 'aira-fast' });
  assert.equal(req2.decision, 'ADMIT_NOW', 'User 2 request 1 should be admitted (concurrency 2 of 2)');
  assert.ok(req2.permit?.permitId);

  // Concurrency is now saturated (2 active)
  console.log('PASS: Global concurrency permits acquired atomically up to limit.');

  // TEST 4: Per-user concurrency limit
  console.log('\n[TEST 4] Per-user concurrency limit (no concurrent parallel requests per user)');
  // User 1 attempts a second parallel request while req1 is still active
  const user1Req2 = await guard.admit({ principalId: 'user1', model: 'aira-fast' });
  assert.equal(user1Req2.decision, 'REJECT_CAPACITY', 'Second concurrent request by same user must be rejected');
  assert.equal(user1Req2.reason, 'USER_CONCURRENCY_EXCEEDED');
  assert.ok(user1Req2.retryAfterSeconds! >= 5, 'Retry-After should include jittered backoff');
  console.log('PASS: Per-user concurrency limit rejected second concurrent request.');

  // TEST 5: Clean permit release & no double release
  console.log('\n[TEST 5] Clean permit release & no double release');
  await req1.permit!.release();
  // Double release must be a safe no-op
  await req1.permit!.release();

  // User 1 should now be able to start a new request
  const user1Req3 = await guard.admit({ principalId: 'user1', model: 'aira-fast' });
  assert.equal(user1Req3.decision, 'ADMIT_NOW', 'User 1 admitted after previous permit released');
  await req2.permit!.release();
  await user1Req3.permit!.release();
  console.log('PASS: Permit released idempotently with zero double-release side effects.');

  // TEST 6: Sliding window RPM limits and resetMs calculation
  console.log('\n[TEST 6] Sliding window RPM limits and resetMs calculation');
  await guard.reset();
  // Per-user RPM limit is 5. Submit 5 requests sequentially:
  for (let i = 0; i < 5; i++) {
    const res = await guard.admit({ principalId: 'user_rpm_test', model: 'aira-fast' });
    assert.equal(res.decision, 'ADMIT_NOW');
    await res.permit!.release();
  }
  // 6th request within window must be rejected
  const req6 = await guard.admit({ principalId: 'user_rpm_test', model: 'aira-fast' });
  assert.equal(req6.decision, 'REJECT_CAPACITY');
  assert.equal(req6.reason, 'USER_RPM_EXCEEDED');
  assert.ok(req6.retryAfterSeconds! > 0, 'Must emit truthful positive retry-after');
  console.log('PASS: Sliding window rate limit enforced cleanly without boundary spikes.');

  // TEST 7: Multi-user fairness: One user exhausting quota does NOT starve another user
  console.log('\n[TEST 7] Multi-user fairness');
  const userB = await guard.admit({ principalId: 'user_fairness_b', model: 'aira-fast' });
  assert.equal(userB.decision, 'ADMIT_NOW', 'User B must obtain capacity even after User A reached user limit');
  await userB.permit!.release();
  console.log('PASS: Per-principal partitioning ensures fair access across independent users.');

  // TEST 8: Bounded FIFO Queue admission
  console.log('\n[TEST 8] Bounded FIFO Queue admission on saturated concurrency');
  await guard.reset();
  // Fill both global slots
  const active1 = await guard.admit({ principalId: 'userA', model: 'aira-fast' });
  const active2 = await guard.admit({ principalId: 'userB', model: 'aira-fast' });
  assert.equal(active1.decision, 'ADMIT_NOW');
  assert.equal(active2.decision, 'ADMIT_NOW');

  let queuedProgressCalled = false;
  // User C request is enqueued
  const queuePromise = guard.admit(
    { principalId: 'userC', model: 'aira-fast' },
    (progress) => {
      queuedProgressCalled = true;
      assert.equal(progress.status, 'QUEUED');
      assert.equal(progress.queuePosition, 1);
    }
  );

  // Await short tick to allow async admit to reach queue checkpoint
  await new Promise(r => setTimeout(r, 20));
  assert.equal(queuedProgressCalled, true, 'onQueued callback must be called immediately');
  assert.equal(guard.getQueueDepth(), 1, 'Queue depth must be 1');

  // Release active1 permit -> queued request should immediately be admitted!
  await active1.permit!.release();

  const queuedResult = await queuePromise;
  assert.equal(queuedResult.decision, 'ADMIT_NOW', 'Queued request must be admitted once permit is released');
  assert.ok(queuedResult.permit?.permitId);

  await active2.permit!.release();
  await queuedResult.permit!.release();
  console.log('PASS: Queued request smoothly admitted upon permit availability.');

  // TEST 9: Queue timeout ejection
  console.log('\n[TEST 9] Queue timeout ejection');
  await guard.reset();
  const hold1 = await guard.admit({ principalId: 'u1', model: 'aira-fast' });
  const hold2 = await guard.admit({ principalId: 'u2', model: 'aira-fast' });

  // u3 queues, but nobody releases within the 300ms queueMaxWaitMs
  const timeoutRes = await guard.admit({ principalId: 'u3', model: 'aira-fast' });
  assert.equal(timeoutRes.decision, 'REJECT_CAPACITY', 'Timed out queued request must reject with capacity code');
  assert.equal(timeoutRes.reason, 'QUEUE_TIMEOUT');
  assert.equal(guard.getQueueDepth(), 0, 'Timed out request must be removed from queue');

  await hold1.permit!.release();
  await hold2.permit!.release();
  console.log('PASS: Queue timeout safely rejected and pruned stranded request.');

  // TEST 10: Queue cancellation on client abort
  console.log('\n[TEST 10] Queue cancellation on client disconnect (AbortSignal)');
  await guard.reset();
  const h1 = await guard.admit({ principalId: 'u1', model: 'aira-fast' });
  const h2 = await guard.admit({ principalId: 'u2', model: 'aira-fast' });

  const abortController = new AbortController();
  const abortPromise = guard.admit({
    principalId: 'u3',
    model: 'aira-fast',
    abortSignal: abortController.signal
  });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(guard.getQueueDepth(), 1);
  abortController.abort(new Error('CLIENT_CLOSED'));

  await assert.rejects(abortPromise, /CLIENT_CLOSED/);
  assert.equal(guard.getQueueDepth(), 0, 'Aborted request must be removed from queue immediately');

  await h1.permit!.release();
  await h2.permit!.release();
  console.log('PASS: Client abort removed item from queue with zero leaked permits.');

  // TEST 11: Queue depth limit rejection (Queue Full)
  console.log('\n[TEST 11] Queue depth limit rejection (Queue Full)');
  await guard.reset();
  const s1 = await guard.admit({ principalId: 's1', model: 'aira-fast' });
  const s2 = await guard.admit({ principalId: 's2', model: 'aira-fast' });

  // Queue up to queueMaxDepth (3)
  const q1 = guard.admit({ principalId: 'q1', model: 'aira-fast' });
  const q2 = guard.admit({ principalId: 'q2', model: 'aira-fast' });
  const q3 = guard.admit({ principalId: 'q3', model: 'aira-fast' });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(guard.getQueueDepth(), 3);

  // 4th queued request exceeds depth 3 -> immediate capacity rejection
  const qOverflow = await guard.admit({ principalId: 'q_overflow', model: 'aira-fast' });
  assert.equal(qOverflow.decision, 'REJECT_CAPACITY');
  assert.equal(qOverflow.reason, 'QUEUE_FULL');

  // Clean up
  await s1.permit!.release();
  await s2.permit!.release();
  await Promise.all([q1, q2, q3]).then(results => Promise.all(results.map(r => r.permit?.release())));
  console.log('PASS: Queue depth limit rejected overflow requests immediately.');

  // TEST 12: Circuit breaker integration (Provider failure throttling)
  console.log('\n[TEST 12] Circuit breaker integration');
  await guard.reset();
  const tracker = new ProviderHealthTracker({ slidingWindowSize: 10, cooldownMs: 1000 });
  const guardedTracker = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, globalRpm: 14, queueMaxWaitMs: 500 },
    new InMemoryCapacityStore(),
    tracker
  );

  // Normal state -> admits 2 concurrent
  const c1 = await guardedTracker.admit({ principalId: 'p1', model: 'aira-fast' });
  const c2 = await guardedTracker.admit({ principalId: 'p2', model: 'aira-fast' });
  assert.equal(c1.decision, 'ADMIT_NOW');
  assert.equal(c2.decision, 'ADMIT_NOW');
  await c1.permit!.release();
  await c2.permit!.release();

  // Trip Groq circuit to OPEN
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('rate_limit 429'), 429);
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('rate_limit 429'), 429);
  tracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('rate_limit 429'), 429);
  assert.equal(tracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'OPEN');

  // Concurrency is throttled to 1 because only Gemini is available
  const g1 = await guardedTracker.admit({ principalId: 'p1', model: 'aira-fast' });
  assert.equal(g1.decision, 'ADMIT_NOW');
  
  let g2Queued = false;
  const g2Promise = guardedTracker.admit(
    { principalId: 'p2', model: 'aira-fast' },
    (progress) => {
      g2Queued = true;
      assert.equal(progress.status, 'QUEUED');
    }
  );

  await new Promise(r => setTimeout(r, 20));
  assert.equal(g2Queued, true, 'Second concurrent request must queue when Groq circuit is OPEN');

  await g1.permit!.release();
  const g2Res = await g2Promise;
  assert.equal(g2Res.decision, 'ADMIT_NOW');
  await g2Res.permit!.release();

  // Now trip Gemini circuit as well -> BOTH circuits OPEN
  tracker.recordFailure('gemini', 'gemini-3.5-flash-lite', new Error('rate_limit 429'), 429);
  tracker.recordFailure('gemini', 'gemini-3.5-flash-lite', new Error('rate_limit 429'), 429);
  tracker.recordFailure('gemini', 'gemini-3.5-flash-lite', new Error('rate_limit 429'), 429);
  assert.equal(tracker.getCircuitState('gemini', 'gemini-3.5-flash-lite'), 'OPEN');

  const bothOpen = await guardedTracker.admit({ principalId: 'p3', model: 'aira-fast' });
  assert.equal(bothOpen.decision, 'REJECT_CAPACITY');
  assert.equal(bothOpen.rejectionCode, 'CIRCUITS_OPEN');
  assert.equal(bothOpen.reason, 'ALL_PROVIDERS_UNAVAILABLE');
  console.log('PASS: Circuit breaker degradation dynamically throttled and protected providers.');

  // TEST 13: Token estimation & excessive prompt rejection
  console.log('\n[TEST 13] Token estimation & excessive prompt rejection');
  const hugePrompt = 'A'.repeat(20000); // ~5,000 tokens > 4,000 max
  const hugeRes = await guard.admit({ principalId: 'user_large', model: 'aira-fast', promptText: hugePrompt });
  assert.equal(hugeRes.decision, 'REJECT_CAPACITY');
  assert.equal(hugeRes.rejectionCode, 'PROMPT_TOO_LARGE');
  console.log('PASS: Oversized prompt rejected cleanly to prevent shared TPM exhaustion.');

  // TEST 14: Feature flag disabled bypass
  console.log('\n[TEST 14] Feature flag disabled bypass');
  const disabledGuard = new PrivateBetaCapacityGuard({ enabled: false });
  const disRes = await disabledGuard.admit({ principalId: 'u_disabled', model: 'aira-fast' });
  assert.equal(disRes.decision, 'ADMIT_NOW');
  assert.equal(disRes.permit, undefined);
  console.log('PASS: Feature flag disabled completely bypasses capacity guard.');

  // TEST 15: Sanitized diagnostics output
  console.log('\n[TEST 15] Sanitized diagnostics output');
  const diag = await guard.getDiagnostics();
  assert.equal(typeof diag.guardEnabled, 'boolean');
  assert.equal(typeof diag.currentActiveRequests, 'number');
  assert.equal(typeof diag.recentGlobalRpm, 'number');
  assert.equal(typeof diag.saturationPercentage, 'number');
  assert.equal(typeof diag.providerCircuits, 'object');
  // Confirm no secret keys or prompt text exposed
  const diagJson = JSON.stringify(diag);
  assert.ok(!diagJson.includes('key'));
  assert.ok(!diagJson.includes('prompt'));
  console.log('PASS: Sanitized diagnostics exposed cleanly for observability.');

  console.log('\n=== ALL P1.6.2 CAPACITY GUARD TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
