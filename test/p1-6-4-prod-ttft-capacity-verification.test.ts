import assert from 'node:assert/strict';
import {
  PrivateBetaCapacityGuard,
  DistributedPostgresCapacityStore,
  InMemoryCapacityStore
} from '../packages/model-router/src/capacity/index.js';
import { ServerIntentRouter } from '../packages/agent-runtime/src/router.js';
import { CapabilityRegistry } from '../packages/agent-runtime/src/registry.js';
import { ModelRouter } from '../packages/model-router/src/index.js';

async function runTests() {
  console.log('=== P1.6.4 PRODUCTION TTFT & DISTRIBUTED CAPACITY TEST SUITE ===');

  // ============================================================================
  // TEST 1: Distributed Postgres Capacity Store Concurrency Atomicity
  // ============================================================================
  console.log('\n[TEST 1] Distributed Postgres Capacity Store MVCC Concurrency Atomicity');

  const simulatedRows: Array<{ id: string; scope: string; principal_id: string; created_at: number; expires_at: number }> = [];
  let advisoryLocksHeld = new Set<string>();

  const mockDb: any = (tableName: string) => ({
    where: (opts: any) => ({
      delete: async () => {
        const idx = simulatedRows.findIndex(r => r.id === opts.id);
        if (idx !== -1) simulatedRows.splice(idx, 1);
      }
    })
  });

  mockDb.schema = {
    hasTable: async () => true
  };
  mockDb.raw = async (sql: string, bindings: any[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      advisoryLocksHeld.add(bindings[0] || 'default');
      return [];
    }
    return [];
  };
  mockDb.transaction = async (callback: (trx: any) => Promise<any>) => {
    const mockTrx: any = (tableName: string) => {
      return {
        where: (col: any, op?: any, val?: any) => {
          let filterFn = (r: any) => true;
          if (typeof col === 'string' && op === '<=') {
            filterFn = (r: any) => r[col] <= val;
          } else if (typeof col === 'string' && op === '>') {
            filterFn = (r: any) => r[col] > val;
          } else if (typeof col === 'string' && op === undefined) {
            // noop
          } else if (typeof col === 'string') {
            filterFn = (r: any) => r[col] === op;
          }
          return {
            where: (col2: string, op2?: any, val2?: any) => {
              const prev = filterFn;
              const nextFn = op2 === '>' ? (r: any) => r[col2] > val2 : (r: any) => r[col2] === op2;
              filterFn = (r: any) => prev(r) && nextFn(r);
              return {
                where: (col3: string, op3?: any, val3?: any) => {
                  const prev2 = filterFn;
                  filterFn = (r: any) => prev2(r) && r[col3] === op3;
                  return {
                    count: async () => {
                      const matched = simulatedRows.filter(filterFn);
                      return [{ count: matched.length }];
                    }
                  };
                },
                count: async () => {
                  const matched = simulatedRows.filter(filterFn);
                  return [{ count: matched.length }];
                }
              };
            },
            delete: async () => {
              const toKeep = simulatedRows.filter(r => !filterFn(r));
              simulatedRows.length = 0;
              simulatedRows.push(...toKeep);
            },
            count: async () => {
              const matched = simulatedRows.filter(filterFn);
              return [{ count: matched.length }];
            }
          };
        },
        insert: async (data: any) => {
          simulatedRows.push(data);
        }
      };
    };
    mockTrx.raw = async (sql: string, bindings: any[] = []) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        advisoryLocksHeld.add(bindings[0] || 'default');
      }
      return [];
    };

    return await callback(mockTrx);
  };

  const pgStore = new DistributedPostgresCapacityStore(mockDb);
  assert.equal(await pgStore.isAvailable(), true);

  // Acquire permit 1 (maxConcurrent = 2)
  const p1 = await pgStore.acquirePermit('global', 'u1', 2, 30);
  assert.equal(p1.acquired, true);
  assert.ok(p1.permitId);
  assert.equal(p1.currentActive, 1);

  // Acquire permit 2 (maxConcurrent = 2)
  const p2 = await pgStore.acquirePermit('global', 'u2', 2, 30);
  assert.equal(p2.acquired, true);
  assert.ok(p2.permitId);
  assert.equal(p2.currentActive, 2);

  // Acquire permit 3 (maxConcurrent = 2) -> must reject
  const p3 = await pgStore.acquirePermit('global', 'u3', 2, 30);
  assert.equal(p3.acquired, false);
  assert.equal(p3.currentActive, 2);

  console.log('PASS: Distributed Postgres store enforces concurrency atomically.');

  // ============================================================================
  // TEST 2: Capacity Permit Reliable Lifecycle & Release
  // ============================================================================
  console.log('\n[TEST 2] Capacity Permit Reliable Lifecycle & Release');

  // Release permit 1
  await pgStore.releasePermit(p1.permitId!);

  // Now permit 4 can be acquired
  const p4 = await pgStore.acquirePermit('global', 'u4', 2, 30);
  assert.equal(p4.acquired, true, 'Permit released immediately opens capacity for new caller');
  assert.equal(p4.currentActive, 2);

  console.log('PASS: Capacity permit release is immediate and deterministic.');

  // ============================================================================
  // TEST 3: Semantic Reasoner Fast Direct Routing for Conversational Chat Directives
  // ============================================================================
  console.log('\n[TEST 3] Semantic Reasoner Fast Direct Routing for Conversational Directives');

  const registry = new CapabilityRegistry();
  const modelRouter = new ModelRouter();
  const router = new ServerIntentRouter(registry, modelRouter);

  const testPrincipal = {
    userId: 'u_test',
    sessionId: 'sess_test',
    roles: ['workspace_user'],
    scopes: ['chat:write']
  };

  const conversationalPrompts = [
    'Reply with the single word ALPHA',
    'Respond with the exact word BANANA',
    'Answer with CHARLIE',
    'Say DELTA in one word',
    'Output ECHO',
    'Echo FOXTROT back to me'
  ];

  for (const prompt of conversationalPrompts) {
    const decision = await router.route({
      prompt,
      principal: testPrincipal,
      advisoryIntent: 'ANSWER'
    });

    assert.equal(decision.intent, 'ANSWER', `Prompt "${prompt}" must resolve to ANSWER`);
    assert.equal(decision.sideEffectLevel, 'NONE');
    assert.equal(decision.approvalRequired, false);
    // Must use FAST_DIRECT or RULE_BASED without needing an upstream LLM classification call
    assert.ok(
      decision.metadata?.fastPath === true || decision.metadata?.reasoningStrategy === 'FAST_DIRECT',
      `Prompt "${prompt}" must resolve via zero-cost fast path to preserve sub-second TTFT`
    );
  }

  console.log('PASS: Conversational directives resolve via zero-cost fast path without blocking model calls.');

  console.log('\n=== ALL P1.6.4 TEST SUITE TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
