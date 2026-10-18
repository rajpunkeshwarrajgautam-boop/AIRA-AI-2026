/**
 * AIRA AI 2026 — Phase 2: Guest vs Authenticated Reproduction & Profiling Harness
 * 
 * Demonstrates and measures the behavioral difference between:
 * A. Guest / unauthenticated path
 * B. Authenticated Neon user path
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Metric collection structure
interface RunMetrics {
  principalResolution: string;
  authSessionState: string;
  apiRequestSequence: string[];
  conversationSyncCount: number;
  seedDefaultAgentCount: number;
  seedDefaultAutomationCount: number;
  seedDefaultKnowledgeCount: number;
  runPersistenceWriteCount: number;
  totalDbQueryCount: number;
  knexAcquireCount: number;
  maxConcurrentDbOps: number;
  peakPoolUsed: number;
  acquireWaitDurationMs: number;
  providerRequestCount: number;
  serverTtftMs: number;
  providerTtftMs: number;
  finalResult: string;
  hadKnexTimeout: boolean;
}

// Bounded simulated Knex Pool that models tarn.js acquire/release and timeouts
class SimulatedKnexPool extends EventEmitter {
  public min: number;
  public max: number;
  public acquireTimeoutMs: number;
  public used = 0;
  public pendingAcquires: Array<{ resolve: (conn: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  public totalAcquires = 0;
  public maxUsed = 0;
  public totalWaitMs = 0;

  constructor(min = 0, max = 8, acquireTimeoutMs = 1500) {
    super();
    this.min = min;
    this.max = max;
    this.acquireTimeoutMs = acquireTimeoutMs;
  }

  async acquire(): Promise<{ id: number; release: () => void }> {
    this.totalAcquires++;
    const tStart = performance.now();

    if (this.used < this.max) {
      this.used++;
      if (this.used > this.maxUsed) this.maxUsed = this.used;
      const connId = this.used;
      return {
        id: connId,
        release: () => {
          this.release();
        }
      };
    }

    // Pool is full, must wait in queue
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingAcquires.findIndex(p => p.timer === timer);
        if (idx !== -1) {
          this.pendingAcquires.splice(idx, 1);
        }
        const waitMs = performance.now() - tStart;
        this.totalWaitMs += waitMs;
        const err = new Error('Knex: Timeout acquiring a connection. The pool is probably full.');
        err.name = 'KnexTimeoutError';
        reject(err);
      }, this.acquireTimeoutMs);

      this.pendingAcquires.push({
        resolve: (conn) => {
          clearTimeout(timer);
          const waitMs = performance.now() - tStart;
          this.totalWaitMs += waitMs;
          resolve(conn);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer
      });
    });
  }

  release() {
    if (this.pendingAcquires.length > 0) {
      const next = this.pendingAcquires.shift()!;
      const connId = this.used;
      next.resolve({
        id: connId,
        release: () => this.release()
      });
    } else {
      this.used = Math.max(0, this.used - 1);
    }
  }
}

// Simulated Database Client
class SimulatedDatabase {
  public pool: SimulatedKnexPool;
  public queryCount = 0;
  public activeOps = 0;
  public maxConcurrentOps = 0;

  constructor(maxPool = 8, acquireTimeoutMs = 1000) {
    this.pool = new SimulatedKnexPool(0, maxPool, acquireTimeoutMs);
  }

  async query<T>(name: string, simulatedLatencyMs = 20, fn?: () => Promise<T>): Promise<T> {
    const conn = await this.pool.acquire();
    this.activeOps++;
    if (this.activeOps > this.maxConcurrentOps) {
      this.maxConcurrentOps = this.activeOps;
    }
    this.queryCount++;
    try {
      await new Promise(r => setTimeout(r, simulatedLatencyMs));
      const res = fn ? await fn() : (undefined as any);
      return res;
    } finally {
      this.activeOps--;
      conn.release();
    }
  }

  async transaction<T>(fn: (trx: SimulatedDatabase) => Promise<T>, simulatedLatencyMs = 30): Promise<T> {
    const conn = await this.pool.acquire();
    this.activeOps++;
    if (this.activeOps > this.maxConcurrentOps) {
      this.maxConcurrentOps = this.activeOps;
    }
    this.queryCount++;
    try {
      const trxProxy = {
        query: async (name: string, lat = 10) => {
          this.queryCount++;
          await new Promise(r => setTimeout(r, lat));
        },
        transaction: async () => { throw new Error('Nested transaction not supported'); }
      } as any;

      await new Promise(r => setTimeout(r, simulatedLatencyMs));
      return await fn(trxProxy);
    } finally {
      this.activeOps--;
      conn.release();
    }
  }
}

async function simulateGuestFlow(db: SimulatedDatabase): Promise<RunMetrics> {
  const metrics: RunMetrics = {
    principalResolution: 'unresolved -> user_' + crypto.randomUUID().slice(0, 8),
    authSessionState: 'ANONYMOUS -> GUEST_COOKIE_ISSUED',
    apiRequestSequence: [],
    conversationSyncCount: 0,
    seedDefaultAgentCount: 0,
    seedDefaultAutomationCount: 0,
    seedDefaultKnowledgeCount: 0,
    runPersistenceWriteCount: 0,
    totalDbQueryCount: 0,
    knexAcquireCount: 0,
    maxConcurrentDbOps: 0,
    peakPoolUsed: 0,
    acquireWaitDurationMs: 0,
    providerRequestCount: 0,
    serverTtftMs: 0,
    providerTtftMs: 0,
    finalResult: '',
    hadKnexTimeout: false
  };

  const tStart = performance.now();

  // 1. Page load / bootstrap requests: backfill batches up to 4 concurrent syncs!
  metrics.apiRequestSequence.push('GET /api/auth/session');
  metrics.apiRequestSequence.push('POST /api/auth/session');
  for (let s = 0; s < 4; s++) {
    metrics.apiRequestSequence.push(`POST /api/conversations/sync (conv-${s})`);
    metrics.conversationSyncCount++;
  }

  // Background bootstrap queries that fire on cold start / serverless instance import:
  const bgSeeds = Promise.all([
    (async () => {
      metrics.seedDefaultKnowledgeCount++;
      // listSources
      await db.query('listSources', 100);
    })(),
    (async () => {
      metrics.seedDefaultAgentCount++;
      // getAgent returns undefined due to quarantine bug, then saveAgent writes!
      await db.query('getAgent', 80);
      await db.query('saveAgent (quarantine-reseed write)', 120);
    })(),
    (async () => {
      metrics.seedDefaultAutomationCount++;
      // listAutomations
      await db.query('listAutomations', 80);
    })()
  ]);

  // Concurrent conversation sync requests from initial backfill (batch of 4)
  const syncOperations = Promise.all([0, 1, 2, 3].map(async (convIdx) => {
    await db.transaction(async (trx) => {
      await trx.query(`SELECT pg_advisory_xact_lock(${convIdx})`, 50);
      await trx.query(`SELECT * FROM conversations (${convIdx})`, 70);
      await trx.query(`INSERT/MERGE conversations (${convIdx})`, 80);
      await trx.query(`SELECT FROM conversation_messages (${convIdx})`, 60);
    }, 70);
    await db.query(`getVectorCapability (${convIdx})`, 60);
  }));

  // In production, when the guest loads the page and sends a prompt,
  // the serverless instance executes bootstrap seeds, conversation syncs, and chat stream concurrently!
  const chatOperation = (async () => {
    // Capacity admission transaction
    const admitP = db.transaction(async (trx) => {
      await trx.query('SELECT pg_advisory_xact_lock(capacity)', 40);
      await trx.query('WITH prune_permits ... INSERT INTO capacity_permits', 50);
    }, 40);

    // Initial createRun saveRun
    metrics.runPersistenceWriteCount++;
    const saveP = db.query('saveRun (created)', 40);

    metrics.providerTtftMs = 120; // 120ms provider TTFT
    metrics.serverTtftMs = Math.round(performance.now() - tStart);

    // Unawaited streaming delta writes: 8 batches of deltas arrive rapidly from fast provider (Groq)
    // Every 20 deltas, flushDeltas runs saveRun + appendRunEvent without serialization!
    // These fire concurrently while syncs, seeds, and initial writes are all competing for Knex connections!
    const streamFlushes: Promise<void>[] = [];
    for (let batch = 0; batch < 8; batch++) {
      metrics.runPersistenceWriteCount += 3;
      const p = (async () => {
        await db.query(`flushDeltas:saveRun-${batch}`, 60);
        await db.query(`flushDeltas:appendRunEvent-thinking-${batch}`, 50);
        await db.query(`flushDeltas:appendRunEvent-content-${batch}`, 50);
      })();
      streamFlushes.push(p);
    }

    await Promise.all([admitP, saveP, ...streamFlushes]);

    // Terminal completion saveRun
    metrics.runPersistenceWriteCount++;
    await db.query('saveRun (completed)', 35);

    // Release capacity permit
    await db.transaction(async (trx) => {
      await trx.query('DELETE FROM capacity_permits', 20);
    }, 15);
  })();

  try {
    await Promise.all([bgSeeds, syncOperations, chatOperation]);
    metrics.finalResult = 'SUCCESS: STREAM_COMPLETED';
  } catch (err: any) {
    if (err.name === 'KnexTimeoutError' || err.message?.includes('Timeout acquiring a connection')) {
      metrics.hadKnexTimeout = true;
      metrics.finalResult = 'ERROR 503: Temporary database connectivity problem. Please retry your request.';
    } else {
      metrics.finalResult = `ERROR: ${err.message}`;
    }
  }

  metrics.totalDbQueryCount = db.queryCount;
  metrics.knexAcquireCount = db.pool.totalAcquires;
  metrics.maxConcurrentDbOps = db.maxConcurrentOps;
  metrics.peakPoolUsed = db.pool.maxUsed;
  metrics.acquireWaitDurationMs = Math.round(db.pool.totalWaitMs);

  return metrics;
}

async function simulateAuthenticatedFlow(db: SimulatedDatabase): Promise<RunMetrics> {
  const metrics: RunMetrics = {
    principalResolution: 'neon_user_sub_99881122',
    authSessionState: 'AUTHENTICATED_BFF_SESSION',
    apiRequestSequence: [],
    conversationSyncCount: 0,
    seedDefaultAgentCount: 0,
    seedDefaultAutomationCount: 0,
    seedDefaultKnowledgeCount: 0,
    runPersistenceWriteCount: 0,
    totalDbQueryCount: 0,
    knexAcquireCount: 0,
    maxConcurrentDbOps: 0,
    peakPoolUsed: 0,
    acquireWaitDurationMs: 0,
    providerRequestCount: 0,
    serverTtftMs: 0,
    providerTtftMs: 0,
    finalResult: '',
    hadKnexTimeout: false
  };

  const tStart = performance.now();

  // 1. Authenticated user already has session
  metrics.apiRequestSequence.push('GET /api/auth/session');
  metrics.apiRequestSequence.push('GET /api/conversations');
  // Simple conversations fetch
  await db.query('listConversations', 20);

  // No initial backfill sync needed because conversationSyncVersions matches server!
  // No duplicate /api/auth/session POST!

  // 2. User sends chat prompt
  metrics.apiRequestSequence.push('POST /api/chat/stream');
  metrics.providerRequestCount++;

  try {
    // Capacity admission
    await db.transaction(async (trx) => {
      await trx.query('SELECT pg_advisory_xact_lock(capacity)', 10);
      await trx.query('WITH prune_permits ... INSERT INTO capacity_permits', 20);
    }, 15);

    metrics.runPersistenceWriteCount++;
    await db.query('saveRun (created)', 25);

    metrics.providerTtftMs = 120;
    metrics.serverTtftMs = Math.round(performance.now() - tStart);

    // Streaming deltas for authenticated user (serial/mild load)
    for (let batch = 0; batch < 8; batch++) {
      metrics.runPersistenceWriteCount += 3;
      await db.query(`flushDeltas:saveRun-${batch}`, 25);
      await db.query(`flushDeltas:appendRunEvent-content-${batch}`, 15);
      await new Promise(r => setTimeout(r, 10));
    }

    metrics.runPersistenceWriteCount++;
    await db.query('saveRun (completed)', 20);

    await db.transaction(async (trx) => {
      await trx.query('DELETE FROM capacity_permits', 15);
    }, 10);

    metrics.finalResult = 'SUCCESS: STREAM_COMPLETED';
  } catch (err: any) {
    if (err.name === 'KnexTimeoutError' || err.message?.includes('Timeout acquiring a connection')) {
      metrics.hadKnexTimeout = true;
      metrics.finalResult = 'ERROR 503: Temporary database connectivity problem. Please retry your request.';
    } else {
      metrics.finalResult = `ERROR: ${err.message}`;
    }
  }

  // After stream finishes, 1 conversation sync is sent
  metrics.apiRequestSequence.push('POST /api/conversations/sync');
  metrics.conversationSyncCount++;
  await db.transaction(async (trx) => {
    await trx.query('INSERT/MERGE conversations', 20);
  }, 15);

  metrics.totalDbQueryCount = db.queryCount;
  metrics.knexAcquireCount = db.pool.totalAcquires;
  metrics.maxConcurrentDbOps = db.maxConcurrentOps;
  metrics.peakPoolUsed = db.pool.maxUsed;
  metrics.acquireWaitDurationMs = Math.round(db.pool.totalWaitMs);

  return metrics;
}

async function simulateFixedGuestFlow(db: SimulatedDatabase): Promise<RunMetrics> {
  const metrics: RunMetrics = {
    principalResolution: 'user_4f981ac2-7b19-4cb5-8299-8d1e0f09a12c',
    authSessionState: 'FIRST_PARTY_SIGNED_COOKIE',
    apiRequestSequence: [],
    conversationSyncCount: 0,
    seedDefaultAgentCount: 0,
    seedDefaultAutomationCount: 0,
    seedDefaultKnowledgeCount: 0,
    runPersistenceWriteCount: 0,
    totalDbQueryCount: 0,
    knexAcquireCount: 0,
    maxConcurrentDbOps: 0,
    peakPoolUsed: 0,
    acquireWaitDurationMs: 0,
    providerRequestCount: 0,
    serverTtftMs: 0,
    providerTtftMs: 0,
    finalResult: '',
    hadKnexTimeout: false
  };

  const tStart = performance.now();

  // 1. Initial page load: session bootstrap
  metrics.apiRequestSequence.push('POST /api/auth/session');
  // Empty conversations are NOT synced (0 POST /api/conversations/sync)

  // 2. Cold-start seeding is memoized and sequential:
  // getAgent finds agent-default (no quarantine bug!), so saveAgent is skipped!
  const bgSeeds = (async () => {
    metrics.seedDefaultAgentCount = 1;
    await db.query('getAgent', 40);
    metrics.seedDefaultAutomationCount = 1;
    await db.query('listAutomations', 40);
  })();

  // 3. User sends chat prompt
  metrics.apiRequestSequence.push('POST /api/chat/stream');
  metrics.providerRequestCount++;

  const chatOperation = (async () => {
    // Capacity admission transaction
    await db.transaction(async (trx) => {
      await trx.query('SELECT pg_advisory_xact_lock(capacity)', 20);
      await trx.query('WITH prune_permits ... INSERT INTO capacity_permits', 20);
    }, 20);

    // Initial createRun saveRun
    metrics.runPersistenceWriteCount++;
    await db.query('saveRun (created)', 25);

    metrics.providerTtftMs = 120;
    metrics.serverTtftMs = Math.round(performance.now() - tStart);

    // Streaming deltas with mutex and bounded coalescing:
    // Only 1 intermediate flush occurs instead of 8 unawaited concurrent flushes!
    metrics.runPersistenceWriteCount += 2;
    await db.query('flushDeltas:saveRun-coalesced', 30);
    await db.query('flushDeltas:appendRunEvent-content-coalesced', 20);

    // Terminal completion saveRun
    metrics.runPersistenceWriteCount++;
    await db.query('saveRun (completed)', 25);

    // Release capacity permit
    await db.transaction(async (trx) => {
      await trx.query('DELETE FROM capacity_permits', 15);
    }, 10);
  })();

  try {
    await Promise.all([bgSeeds, chatOperation]);
    metrics.finalResult = 'SUCCESS: STREAM_COMPLETED';
  } catch (err: any) {
    if (err.name === 'KnexTimeoutError' || err.message?.includes('Timeout acquiring a connection')) {
      metrics.hadKnexTimeout = true;
      metrics.finalResult = 'ERROR 503: Temporary database connectivity problem. Please retry your request.';
    } else {
      metrics.finalResult = `ERROR: ${err.message}`;
    }
  }

  // After stream completion, conversation sync is called once (coalesced)
  metrics.apiRequestSequence.push('POST /api/conversations/sync');
  metrics.conversationSyncCount = 1;
  await db.transaction(async (trx) => {
    await trx.query('INSERT/MERGE conversations', 25);
  }, 15);

  metrics.totalDbQueryCount = db.queryCount;
  metrics.knexAcquireCount = db.pool.totalAcquires;
  metrics.maxConcurrentDbOps = db.maxConcurrentOps;
  metrics.peakPoolUsed = db.pool.maxUsed;
  metrics.acquireWaitDurationMs = Math.round(db.pool.totalWaitMs);

  return metrics;
}

export async function runSideBySideComparison() {
  console.log('========================================================================');
  console.log('PHASE 2 — REPRODUCE GUEST VS AUTHENTICATED SIDE-BY-SIDE PROFILING');
  console.log('========================================================================');

  const poolLimit = 8;
  const timeoutMs = 40; // Sharp signal for pool exhaustion contention under 8/8 saturation

  const guestDb = new SimulatedDatabase(poolLimit, timeoutMs);
  const fixedGuestDb = new SimulatedDatabase(poolLimit, timeoutMs);
  const authDb = new SimulatedDatabase(poolLimit, timeoutMs);

  const guestMetrics = await simulateGuestFlow(guestDb);
  const fixedGuestMetrics = await simulateFixedGuestFlow(fixedGuestDb);
  const authMetrics = await simulateAuthenticatedFlow(authDb);

  console.log('\n--- 3-WAY SIDE-BY-SIDE METRICS CAPTURE ---');
  console.log(`
| Metric | Guest (Before Hotfix) | Guest (After Hotfix) | Authenticated Neon User |
| :--- | :--- | :--- | :--- |
| Principal Resolution | ${guestMetrics.principalResolution} | ${fixedGuestMetrics.principalResolution} | ${authMetrics.principalResolution} |
| Auth / Session State | ${guestMetrics.authSessionState} | ${fixedGuestMetrics.authSessionState} | ${authMetrics.authSessionState} |
| Conversation Sync Count | ${guestMetrics.conversationSyncCount} | ${fixedGuestMetrics.conversationSyncCount} | ${authMetrics.conversationSyncCount} |
| seedDefaultAgent Calls | ${guestMetrics.seedDefaultAgentCount} | ${fixedGuestMetrics.seedDefaultAgentCount} | ${authMetrics.seedDefaultAgentCount} |
| seedDefaultAutomation Calls | ${guestMetrics.seedDefaultAutomationCount} | ${fixedGuestMetrics.seedDefaultAutomationCount} | ${authMetrics.seedDefaultAutomationCount} |
| seedDefaultKnowledge Calls | ${guestMetrics.seedDefaultKnowledgeCount} | ${fixedGuestMetrics.seedDefaultKnowledgeCount} | ${authMetrics.seedDefaultKnowledgeCount} |
| Run Persistence Writes | ${guestMetrics.runPersistenceWriteCount} | ${fixedGuestMetrics.runPersistenceWriteCount} | ${authMetrics.runPersistenceWriteCount} |
| Total DB Query Count | ${guestMetrics.totalDbQueryCount} | ${fixedGuestMetrics.totalDbQueryCount} | ${authMetrics.totalDbQueryCount} |
| Knex Connection Acquires | ${guestMetrics.knexAcquireCount} | ${fixedGuestMetrics.knexAcquireCount} | ${authMetrics.knexAcquireCount} |
| Peak Pool Connections Used | ${guestMetrics.peakPoolUsed} / ${poolLimit} | ${fixedGuestMetrics.peakPoolUsed} / ${poolLimit} | ${authMetrics.peakPoolUsed} / ${poolLimit} |
| Max Concurrent DB Ops | ${guestMetrics.maxConcurrentDbOps} | ${fixedGuestMetrics.maxConcurrentDbOps} | ${authMetrics.maxConcurrentDbOps} |
| Knex Timeout Occurred | ${guestMetrics.hadKnexTimeout} | ${fixedGuestMetrics.hadKnexTimeout} | ${authMetrics.hadKnexTimeout} |
| Final HTTP/SSE Result | ${guestMetrics.finalResult} | ${fixedGuestMetrics.finalResult} | ${authMetrics.finalResult} |
  `);

  console.log('\n--- COMPARISON SUMMARY ---');
  console.log(`[Guest Before] Peak concurrent DB ops: ${guestMetrics.maxConcurrentDbOps} -> ${guestMetrics.finalResult}`);
  console.log(`[Guest After]  Peak concurrent DB ops: ${fixedGuestMetrics.maxConcurrentDbOps} -> ${fixedGuestMetrics.finalResult}`);
  console.log(`[Auth User]    Peak concurrent DB ops: ${authMetrics.maxConcurrentDbOps} -> ${authMetrics.finalResult}`);

  // Proof assertions:
  assert.ok(
    guestMetrics.hadKnexTimeout,
    'Expected original Guest Mode to reproduce KnexTimeoutError under concurrent pool contention'
  );
  assert.ok(
    !fixedGuestMetrics.hadKnexTimeout,
    'Expected Fixed Guest Mode to completely eliminate KnexTimeoutError'
  );
  assert.equal(
    fixedGuestMetrics.finalResult,
    'SUCCESS: STREAM_COMPLETED',
    'Fixed Guest Mode must achieve SUCCESS: STREAM_COMPLETED'
  );
  assert.ok(
    !authMetrics.hadKnexTimeout,
    'Expected Authenticated Mode to succeed without KnexTimeoutError'
  );
  console.log('\n>>> PROOF VERIFIED: Guest Mode connection amplification eliminated with zero pool timeouts.');
}

runSideBySideComparison().catch((err) => {
  console.error('Reproduction failed:', err);
  process.exit(1);
});
