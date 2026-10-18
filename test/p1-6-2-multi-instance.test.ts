import assert from 'node:assert/strict';
import {
  PrivateBetaCapacityGuard,
  InMemoryCapacityStore
} from '../packages/model-router/src/capacity/index.js';

async function runTests() {
  console.log('=== P1.6.2 MULTI-INSTANCE CAPACITY GUARD TEST SUITE ===');

  // Shared store simulating distributed cross-instance store (e.g. Postgres / shared backing)
  const sharedStore = new InMemoryCapacityStore();

  // Create Instance 1 and Instance 2 sharing the same store
  const instance1 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, perUserMaxConcurrent: 1, globalRpm: 5, queueMaxDepth: 2, queueMaxWaitMs: 300 },
    sharedStore
  );

  const instance2 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, perUserMaxConcurrent: 1, globalRpm: 5, queueMaxDepth: 2, queueMaxWaitMs: 300 },
    sharedStore
  );

  // TEST 1: Global concurrency is globally authoritative across instances
  console.log('\n[TEST 1] Global concurrency across multiple serverless instances');
  // Instance 1 admits 1 request
  const inst1Req = await instance1.admit({ principalId: 'user1', model: 'aira-fast' });
  assert.equal(inst1Req.decision, 'ADMIT_NOW', 'Instance 1 admitted slot 1 of 2');

  // Instance 2 admits 1 request
  const inst2Req = await instance2.admit({ principalId: 'user2', model: 'aira-fast' });
  assert.equal(inst2Req.decision, 'ADMIT_NOW', 'Instance 2 admitted slot 2 of 2');

  // Both slots are now filled across instances (1 on instance 1, 1 on instance 2).
  // A third request arriving on Instance 1 must enter queue
  let isQueued = false;
  const overflowPromise = instance1.admit(
    { principalId: 'user3', model: 'aira-fast' },
    (progress) => {
      isQueued = true;
      assert.equal(progress.status, 'QUEUED');
    }
  );

  await new Promise(r => setTimeout(r, 20));
  assert.equal(isQueued, true, 'Instance 1 must queue request when global capacity is reached on instance 2');

  // When Instance 2 finishes and releases its permit in sharedStore:
  await inst2Req.permit!.release();

  // Queued request on Instance 1 is picked up by cross-instance queue poll and admitted!
  const admittedOnInst1 = await overflowPromise;
  assert.equal(admittedOnInst1.decision, 'ADMIT_NOW', 'Queued request on Instance 1 successfully admitted after Instance 2 permit release');
  assert.ok(admittedOnInst1.permit?.permitId);

  await inst1Req.permit!.release();
  await admittedOnInst1.permit!.release();
  console.log('PASS: Global concurrency limits enforced across independent runtime instances.');

  // TEST 2: Per-user concurrency limit across instances
  console.log('\n[TEST 2] Per-user concurrency limit across instances');
  await sharedStore.reset();

  // User A starts request on Instance 1
  const userAReq1 = await instance1.admit({ principalId: 'userA', model: 'aira-fast' });
  assert.equal(userAReq1.decision, 'ADMIT_NOW');

  // User A immediately sends a parallel request routed to Instance 2
  const userAReq2 = await instance2.admit({ principalId: 'userA', model: 'aira-fast' });
  assert.equal(userAReq2.decision, 'REJECT_CAPACITY', 'Instance 2 must reject User A because User A is active on Instance 1');
  assert.equal(userAReq2.reason, 'USER_CONCURRENCY_EXCEEDED');

  await userAReq1.permit!.release();
  console.log('PASS: Per-user concurrency enforced across instances.');

  // TEST 3: Distributed rate limit persists across process restart / cold start
  console.log('\n[TEST 3] Distributed rate limit persists across cold start');
  await sharedStore.reset();

  // Submit 4 requests on Instance 1
  for (let i = 0; i < 4; i++) {
    const res = await instance1.admit({ principalId: `temp_user_${i}`, model: 'aira-fast' });
    assert.equal(res.decision, 'ADMIT_NOW');
    await res.permit!.release();
  }

  // Simulate cold start: Instance 3 spins up fresh with an empty local state, connecting to sharedStore
  const instance3 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, globalRpm: 5 },
    sharedStore
  );

  // 5th request succeeds
  const fifthReq = await instance3.admit({ principalId: 'temp_user_5', model: 'aira-fast' });
  assert.equal(fifthReq.decision, 'ADMIT_NOW');
  await fifthReq.permit!.release();

  // 6th request on Instance 3 hits the 5 RPM global limit that was mostly consumed by Instance 1!
  const sixthReq = await instance3.admit({ principalId: 'temp_user_6', model: 'aira-fast' });
  assert.equal(sixthReq.decision, 'REJECT_CAPACITY', 'Cold-started Instance 3 respects distributed RPM limit');
  assert.equal(sixthReq.reason, 'GLOBAL_RPM_EXCEEDED');
  console.log('PASS: Cold starts and multi-instance deployments share authoritative capacity state.');

  // TEST 4: Race condition concurrency test (Simultaneous burst to multiple instances)
  console.log('\n[TEST 4] Concurrent admission race condition test');
  await sharedStore.reset();

  // Spin up 10 simultaneous requests distributed across Instance 1 and Instance 2
  const promises: Promise<any>[] = [];
  for (let i = 0; i < 10; i++) {
    const targetInst = i % 2 === 0 ? instance1 : instance2;
    promises.push(targetInst.admit({ principalId: `race_user_${i}`, model: 'aira-fast' }));
  }

  const results = await Promise.all(promises);
  const admitted = results.filter(r => r.decision === 'ADMIT_NOW');
  const queued = results.filter(r => r.decision === 'QUEUE');
  const rejected = results.filter(r => r.decision === 'REJECT_CAPACITY');

  console.log(`Race results: admitted=${admitted.length}, queued=${queued.length}, rejected=${rejected.length}`);
  // Concurrency is 2. At most 2 can be ADMIT_NOW simultaneously!
  assert.ok(admitted.length <= 2, `Never admit more than maxConcurrent (2) during concurrent bursts. Got: ${admitted.length}`);

  // Clean up all admitted permits
  await Promise.all(admitted.map(a => a.permit?.release()));

  console.log('PASS: Zero over-admission race observed under concurrent multi-instance load.');
  console.log('\n=== ALL P1.6.2 MULTI-INSTANCE TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('Multi-instance test failed:', err);
  process.exit(1);
});
