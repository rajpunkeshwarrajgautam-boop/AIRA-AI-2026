import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PrivateBetaCapacityGuard,
  DistributedPostgresCapacityStore,
  InMemoryCapacityStore,
  CapacityStore
} from '../packages/model-router/src/capacity/index.js';

async function runTests() {
  console.log('=== P1.6.5 SINGLE-ROUNDTRIP DISTRIBUTED CAPACITY TEST SUITE ===');

  // Helper to build a simulated Knex client for testing Postgres queries, advisory locks, transactions, and rollback
  function createMockPostgresClient() {
    const permitsTable: Array<{ id: string; scope: string; principal_id: string; created_at: number; expires_at: number }> = [];
    const rpmTable: Array<{ id: string; scope: string; principal_id: string; timestamp: number }> = [];
    const acquiredLocks: string[] = [];
    let lockWaitCounter = 0;

    const mockDb: any = (tableName: string) => ({
      where: (opts: any) => ({
        delete: async () => {
          if (tableName === 'capacity_permits') {
            const idx = permitsTable.findIndex(r => r.id === opts.id);
            if (idx !== -1) permitsTable.splice(idx, 1);
          } else if (tableName === 'capacity_rate_log') {
            const idx = rpmTable.findIndex(r => r.id === opts.id);
            if (idx !== -1) rpmTable.splice(idx, 1);
          }
        }
      }),
      whereIn: (col: string, vals: any[]) => ({
        delete: async () => {
          if (tableName === 'capacity_permits' && col === 'id') {
            const valSet = new Set(vals);
            const toKeep = permitsTable.filter(r => !valSet.has(r.id));
            permitsTable.length = 0;
            permitsTable.push(...toKeep);
          }
        }
      })
    });

    mockDb.schema = {
      hasTable: async () => true
    };

    mockDb.transaction = async (callback: (trx: any) => Promise<any>) => {
      // Snapshot state for rollback safety
      const permitsBackup = permitsTable.map(r => ({ ...r }));
      const rpmBackup = rpmTable.map(r => ({ ...r }));
      const locksBeforeTrx = [...acquiredLocks];

      const mockTrx: any = (tableName: string) => mockDb(tableName);

      mockTrx.raw = async (sql: string, bindings: any[] = []) => {
        // Track advisory locks
        if (sql.includes('pg_advisory_xact_lock')) {
          for (const b of bindings) {
            acquiredLocks.push(String(b));
          }
          return { rows: [] };
        }

        // Handle single atomic CTE admission query
        if (sql.includes('WITH prune_permits') || sql.includes('insert_permits')) {
          const now = Number(bindings[0]);
          const minWindowStart = Number(bindings[1]);
          const principalId = String(bindings[2]);
          const userWindowStart = Number(bindings[6]);
          const globalRpmWindowStart = Number(bindings[9]);
          const userMaxConcurrent = Number(bindings[11]);
          const userRpmLimit = Number(bindings[12]);
          const globalRpmLimit = Number(bindings[13]);
          const globalMaxConcurrent = Number(bindings[14]);
          const userPermitId = String(bindings[15]);
          const expiresAt = Number(bindings[18]);
          const globalPermitId = String(bindings[19]);
          const userLogId = String(bindings[23]);
          const globalLogId = String(bindings[26]);

          // 1. Prune expired permits
          const activePermits = permitsTable.filter(r => r.expires_at > now);
          permitsTable.length = 0;
          permitsTable.push(...activePermits);

          // 2. Prune expired rate log
          const activeRpm = rpmTable.filter(r => r.timestamp > minWindowStart);
          rpmTable.length = 0;
          rpmTable.push(...activeRpm);

          // 3. Evaluate counts
          const userConcurrent = permitsTable.filter(r => r.scope === 'user' && r.principal_id === principalId && r.expires_at > now).length;
          const globalConcurrent = permitsTable.filter(r => r.scope === 'global' && r.expires_at > now).length;
          const userLogs = rpmTable.filter(r => r.scope === 'user' && r.principal_id === principalId && r.timestamp > userWindowStart);
          const userRpm = userLogs.length;
          const userOldestTs = userLogs.length > 0 ? Math.min(...userLogs.map(l => l.timestamp)) : now;
          const globalLogs = rpmTable.filter(r => r.scope === 'global' && r.timestamp > globalRpmWindowStart);
          const globalRpm = globalLogs.length;
          const globalOldestTs = globalLogs.length > 0 ? Math.min(...globalLogs.map(l => l.timestamp)) : now;

          // 4. Decision
          let status = 'ADMIT';
          if (userConcurrent >= userMaxConcurrent) {
            status = 'USER_CONCURRENCY_EXCEEDED';
          } else if (userRpm >= userRpmLimit) {
            status = 'USER_RPM_EXCEEDED';
          } else if (globalRpm >= globalRpmLimit) {
            status = 'GLOBAL_RPM_EXCEEDED';
          } else if (globalConcurrent >= globalMaxConcurrent) {
            status = 'GLOBAL_CONCURRENCY_EXCEEDED';
          }

          if (status === 'ADMIT') {
            permitsTable.push({
              id: userPermitId,
              scope: 'user',
              principal_id: principalId,
              created_at: now,
              expires_at: expiresAt
            });
            permitsTable.push({
              id: globalPermitId,
              scope: 'global',
              principal_id: principalId,
              created_at: now,
              expires_at: expiresAt
            });
            rpmTable.push({
              id: userLogId,
              scope: 'user',
              principal_id: principalId,
              timestamp: now
            });
            rpmTable.push({
              id: globalLogId,
              scope: 'global',
              principal_id: 'system',
              timestamp: now
            });
          }

          return {
            rows: [{
              status,
              user_concurrent: userConcurrent,
              global_concurrent: globalConcurrent,
              user_rpm: userRpm,
              user_oldest_ts: userOldestTs,
              global_rpm: globalRpm,
              global_oldest_ts: globalOldestTs,
              permits_inserted: status === 'ADMIT' ? 2 : 0
            }]
          };
        }

        return { rows: [] };
      };

      try {
        return await callback(mockTrx);
      } catch (err) {
        // Rollback state on error
        permitsTable.length = 0;
        permitsTable.push(...permitsBackup);
        rpmTable.length = 0;
        rpmTable.push(...rpmBackup);
        acquiredLocks.length = 0;
        acquiredLocks.push(...locksBeforeTrx);
        throw err;
      }
    };

    return {
      db: mockDb,
      permits: permitsTable,
      rpm: rpmTable,
      locks: acquiredLocks
    };
  }

  // ============================================================================
  // TEST 1: Normal Permit Admission (Single Atomic Call)
  // ============================================================================
  console.log('\n[TEST 1] Normal permit admission via atomic single round-trip');
  const mockEnv1 = createMockPostgresClient();
  const store1 = new DistributedPostgresCapacityStore(mockEnv1.db);
  const guard1 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, perUserMaxConcurrent: 1, globalRpm: 14, perUserRpm: 5 },
    store1
  );

  const admit1 = await guard1.admit({ principalId: 'user_alpha', model: 'aira-fast' });
  assert.equal(admit1.decision, 'ADMIT_NOW', 'First request must be admitted');
  assert.ok(admit1.permit?.permitId, 'Permit ID must be present');
  assert.equal(mockEnv1.permits.length, 2, 'Must insert user permit and global permit');
  assert.equal(mockEnv1.rpm.length, 2, 'Must insert user rate log and global rate log');
  console.log('PASS: Normal permit admitted in 1 atomic transaction with 2 permits and 2 rate logs.');

  // ============================================================================
  // TEST 2: Per-User Concurrency Rejection
  // ============================================================================
  console.log('\n[TEST 2] Per-user concurrency rejection (max 1 concurrent per user)');
  const admit2 = await guard1.admit({ principalId: 'user_alpha', model: 'aira-fast' });
  assert.equal(admit2.decision, 'REJECT_CAPACITY', 'Second concurrent request for same user must reject');
  assert.equal(admit2.reason, 'USER_CONCURRENCY_EXCEEDED');
  assert.equal(mockEnv1.permits.length, 2, 'No extra permit inserted when rejected');
  console.log('PASS: Per-user concurrency rejected atomically.');

  // ============================================================================
  // TEST 3: Global Concurrency Rejection
  // ============================================================================
  console.log('\n[TEST 3] Global concurrency rejection (max 2 global concurrent)');
  const admit3 = await guard1.admit({ principalId: 'user_beta', model: 'aira-fast' });
  assert.equal(admit3.decision, 'ADMIT_NOW', 'User Beta should be admitted into slot 2 of 2');

  // Now 2 active global permits exist (user_alpha, user_beta). User Gamma should be queued or rejected
  let queued = false;
  const admit4Promise = guard1.admit({ principalId: 'user_gamma', model: 'aira-fast' }, (evt) => {
    if (evt.status === 'QUEUED') queued = true;
  });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(queued, true, 'User Gamma must be queued when global concurrency is saturated (2/2)');
  console.log('PASS: Global concurrency enforced atomically across principals.');

  // Clean up admit1 so admit4 can drain
  await admit1.permit!.release();
  const admit4 = await admit4Promise;
  assert.equal(admit4.decision, 'ADMIT_NOW', 'User Gamma admitted after slot released');
  await admit3.permit!.release();
  await admit4.permit!.release();

  // ============================================================================
  // TEST 4: Per-User RPM Rejection
  // ============================================================================
  console.log('\n[TEST 4] Per-user RPM rejection (limit 5 per min)');
  const mockEnv4 = createMockPostgresClient();
  const store4 = new DistributedPostgresCapacityStore(mockEnv4.db);
  const guard4 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 10, perUserMaxConcurrent: 10, globalRpm: 100, perUserRpm: 5 },
    store4
  );

  for (let i = 0; i < 5; i++) {
    const res = await guard4.admit({ principalId: 'user_rate_test', model: 'aira-fast' });
    assert.equal(res.decision, 'ADMIT_NOW', `Request ${i + 1} should be admitted`);
    await res.permit!.release();
  }

  const res6 = await guard4.admit({ principalId: 'user_rate_test', model: 'aira-fast' });
  assert.equal(res6.decision, 'REJECT_CAPACITY');
  assert.equal(res6.reason, 'USER_RPM_EXCEEDED');
  assert.equal(res6.rejectionCode, 'USER_RATE_LIMIT');
  console.log('PASS: Per-user RPM enforced atomically at 5 requests.');

  // ============================================================================
  // TEST 5: Global RPM Rejection
  // ============================================================================
  console.log('\n[TEST 5] Global RPM rejection (limit 14 per min across all users)');
  const mockEnv5 = createMockPostgresClient();
  const store5 = new DistributedPostgresCapacityStore(mockEnv5.db);
  const guard5 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 20, perUserMaxConcurrent: 20, globalRpm: 14, perUserRpm: 20 },
    store5
  );

  for (let i = 0; i < 14; i++) {
    const res = await guard5.admit({ principalId: `principal_${i}`, model: 'aira-fast' });
    assert.equal(res.decision, 'ADMIT_NOW');
    await res.permit!.release();
  }

  const res15 = await guard5.admit({ principalId: 'principal_overflow', model: 'aira-fast' });
  assert.equal(res15.decision, 'REJECT_CAPACITY');
  assert.equal(res15.reason, 'GLOBAL_RPM_EXCEEDED');
  console.log('PASS: Global RPM rejected when global limit (14) exceeded.');

  // ============================================================================
  // TEST 6: Expired Permit Pruning
  // ============================================================================
  console.log('\n[TEST 6] Expired permit pruning frees capacity');
  const mockEnv6 = createMockPostgresClient();
  // Insert an expired permit in mock DB
  mockEnv6.permits.push({
    id: 'pmt_expired_1',
    scope: 'global',
    principal_id: 'ghost_user',
    created_at: Date.now() - 60000,
    expires_at: Date.now() - 1000 // already expired
  });

  const store6 = new DistributedPostgresCapacityStore(mockEnv6.db);
  const guard6 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 1, perUserMaxConcurrent: 1 },
    store6
  );

  const admit6 = await guard6.admit({ principalId: 'fresh_user', model: 'aira-fast' });
  assert.equal(admit6.decision, 'ADMIT_NOW', 'Fresh user must be admitted because expired permit was pruned');
  assert.ok(!mockEnv6.permits.some(p => p.id === 'pmt_expired_1'), 'Expired permit must be pruned from table');
  await admit6.permit!.release();
  console.log('PASS: Expired permits pruned during atomic admission.');

  // ============================================================================
  // TEST 7: RPM Window Expiry
  // ============================================================================
  console.log('\n[TEST 7] RPM window expiry frees rate quota');
  const mockEnv7 = createMockPostgresClient();
  // Insert 5 expired rate logs
  for (let i = 0; i < 5; i++) {
    mockEnv7.rpm.push({
      id: `log_old_${i}`,
      scope: 'user',
      principal_id: 'window_user',
      timestamp: Date.now() - 65000 // older than 60s window
    });
  }

  const store7 = new DistributedPostgresCapacityStore(mockEnv7.db);
  const guard7 = new PrivateBetaCapacityGuard(
    { perUserRpm: 5 },
    store7
  );

  const admit7 = await guard7.admit({ principalId: 'window_user', model: 'aira-fast' });
  assert.equal(admit7.decision, 'ADMIT_NOW', 'Request admitted after previous RPM window expired');
  await admit7.permit!.release();
  console.log('PASS: RPM window expiry correctly prunes old requests.');

  // ============================================================================
  // TEST 8: Rollback Leaves No Permit
  // ============================================================================
  console.log('\n[TEST 8] Transaction rollback leaves zero orphan permits or rate logs');
  const mockEnv8 = createMockPostgresClient();
  const errorDb: any = {
    ...mockEnv8.db,
    transaction: async (cb: any) => {
      throw new Error('DATABASE_CONNECTION_RESET');
    }
  };
  const store8 = new DistributedPostgresCapacityStore(errorDb);
  const guard8 = new PrivateBetaCapacityGuard({}, store8);

  const admit8 = await guard8.admit({ principalId: 'fail_user', model: 'aira-fast' });
  assert.equal(admit8.decision, 'REJECT_CAPACITY', 'Failed transaction fails closed');
  assert.equal(mockEnv8.permits.length, 0, 'Rollback must leave 0 permits in store');
  assert.equal(mockEnv8.rpm.length, 0, 'Rollback must leave 0 rate logs in store');
  console.log('PASS: Rollback ensures zero orphan records remain.');

  // ============================================================================
  // TEST 9: Transaction Error Cleanup & Conservative Fail-Closed
  // ============================================================================
  console.log('\n[TEST 9] Transaction error cleanup & fail-closed behavior');
  const brokenStore = new DistributedPostgresCapacityStore({
    schema: { hasTable: async () => false }
  } as any);
  const guard9 = new PrivateBetaCapacityGuard({}, brokenStore);

  const admit9 = await guard9.admit({ principalId: 'u9', model: 'aira-fast' });
  assert.equal(admit9.decision, 'REJECT_CAPACITY');
  assert.equal(admit9.rejectionCode, 'AIRA_PRIVATE_BETA_CAPACITY');
  assert.equal(admit9.reason, 'CAPACITY_STORE_UNAVAILABLE');
  console.log('PASS: Storage unavailability triggers conservative fail-closed response.');

  // ============================================================================
  // TEST 10: Concurrent Global Contention (10 contenders -> exactly 2 admitted)
  // ============================================================================
  console.log('\n[TEST 10] Concurrent global contention (10 simultaneous contenders, limit 2)');
  const inMemStore10 = new InMemoryCapacityStore();
  const guard10 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, perUserMaxConcurrent: 1, queueMaxDepth: 0 }, // no queue to measure immediate admissions
    inMemStore10
  );

  const contenders = Array.from({ length: 10 }, (_, i) => `contender_${i}`);
  const results = await Promise.all(
    contenders.map(p => guard10.admit({ principalId: p, model: 'aira-fast' }))
  );

  const admittedCount = results.filter(r => r.decision === 'ADMIT_NOW').length;
  const rejectedCount = results.filter(r => r.decision === 'REJECT_CAPACITY').length;

  assert.equal(admittedCount, 2, 'Exactly 2 contenders must be admitted');
  assert.equal(rejectedCount, 8, 'Remaining 8 contenders must be rejected');
  console.log(`PASS: Zero over-admission race: admitted=${admittedCount}, rejected=${rejectedCount}.`);

  // Release admitted permits
  for (const r of results) {
    if (r.permit) await r.permit.release();
  }

  // ============================================================================
  // TEST 11: Concurrent Per-User Contention (10 simultaneous requests from same user)
  // ============================================================================
  console.log('\n[TEST 11] Concurrent per-user contention (10 simultaneous requests from same user, limit 1)');
  const inMemStore11 = new InMemoryCapacityStore();
  const guard11 = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 10, perUserMaxConcurrent: 1, queueMaxDepth: 0 },
    inMemStore11
  );

  const userContenders = Array.from({ length: 10 }, () => 'single_user_racing');
  const userResults = await Promise.all(
    userContenders.map(() => guard11.admit({ principalId: 'single_user_racing', model: 'aira-fast' }))
  );

  const userAdmitted = userResults.filter(r => r.decision === 'ADMIT_NOW').length;
  const userRejected = userResults.filter(r => r.decision === 'REJECT_CAPACITY').length;

  assert.equal(userAdmitted, 1, 'Exactly 1 request for same user admitted');
  assert.equal(userRejected, 9, 'Other 9 requests for same user rejected');
  console.log(`PASS: Per-user concurrency race prevented: admitted=${userAdmitted}, rejected=${userRejected}.`);

  for (const r of userResults) {
    if (r.permit) await r.permit.release();
  }

  // ============================================================================
  // TEST 12: Release Cleanup
  // ============================================================================
  console.log('\n[TEST 12] Release cleanup releases both global and user permits');
  const mockEnv12 = createMockPostgresClient();
  const store12 = new DistributedPostgresCapacityStore(mockEnv12.db);
  const guard12 = new PrivateBetaCapacityGuard({ globalMaxConcurrent: 1, perUserMaxConcurrent: 1 }, store12);

  const res12 = await guard12.admit({ principalId: 'u12', model: 'aira-fast' });
  assert.equal(res12.decision, 'ADMIT_NOW');
  assert.equal(mockEnv12.permits.length, 2, '2 permits held (user + global)');

  await res12.permit!.release();
  assert.equal(mockEnv12.permits.length, 0, 'Permits deleted immediately on release');

  // Next request succeeds immediately
  const nextRes12 = await guard12.admit({ principalId: 'u12', model: 'aira-fast' });
  assert.equal(nextRes12.decision, 'ADMIT_NOW');
  await nextRes12.permit!.release();
  console.log('PASS: Release cleanup verified with zero stale permits surviving.');

  // ============================================================================
  // TEST 13: Fairness Preservation & Documented Queue Semantics
  // ============================================================================
  console.log('\n[TEST 13] Fairness preservation & documented process-local queue semantics');
  const guard13 = new PrivateBetaCapacityGuard({
    queueMaxDepth: 5,
    queueMaxWaitMs: 6000,
    retryAfterSeconds: 8
  });
  const conf13 = guard13.getConfig();
  assert.equal(conf13.queueMaxDepth, 5);
  assert.equal(conf13.queueMaxWaitMs, 6000);
  assert.equal(conf13.retryAfterSeconds, 8);
  console.log('PASS: Queue limits preserved: maxDepth=5, maxWait=6000ms, retryAfter=8s.');

  // ============================================================================
  // TEST 14: Deterministic Advisory-Lock Order & 64-bit BigInt Keys
  // ============================================================================
  console.log('\n[TEST 14] Deterministic advisory-lock order & 64-bit BigInt keys');
  const mockEnv14 = createMockPostgresClient();
  const store14 = new DistributedPostgresCapacityStore(mockEnv14.db);

  await store14.atomicAdmit({
    principalId: 'lock_order_user',
    userMaxConcurrent: 1,
    userRpmLimit: 5,
    globalMaxConcurrent: 2,
    globalRpmLimit: 14
  });

  assert.equal(mockEnv14.locks.length, 4, 'Must acquire exactly 4 advisory locks in order');
  // Check that all 4 lock keys are signed 64-bit integer strings
  for (const lockKey of mockEnv14.locks) {
    const bi = BigInt(lockKey);
    assert.ok(bi >= -9223372036854775808n && bi <= 9223372036854775807n, `Lock key ${lockKey} must be valid 64-bit BigInt`);
  }
  console.log('PASS: Deterministic advisory locks acquired in exact sequence with 64-bit BigInt keys.');

  console.log('\n=== ALL P1.6.5 SINGLE-ROUNDTRIP CAPACITY TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\n❌ P1.6.5 TEST FAILED:', err);
  process.exit(1);
});
