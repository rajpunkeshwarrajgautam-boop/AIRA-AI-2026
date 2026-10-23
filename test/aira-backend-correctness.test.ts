import test from 'node:test';
import assert from 'node:assert/strict';
import cronParser from 'cron-parser';

function parseCron(expr: string, opts?: any) {
  const p: any = cronParser;
  if (typeof p.parseExpression === 'function') return p.parseExpression(expr, opts);
  if (p.CronExpressionParser?.parse) return p.CronExpressionParser.parse(expr, opts);
  if (p.default?.parseExpression) return p.default.parseExpression(expr, opts);
  if (p.default?.CronExpressionParser?.parse) return p.default.CronExpressionParser.parse(expr, opts);
  throw new Error('cron-parser: parse method not found');
}
import {
  resolveSchedule,
  getWallClockInTimezone,
  wallClockToUtcEpoch
} from '../src/utils/scheduleResolver.js';
import {
  DurableIdempotencyManager,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyDatabaseError
} from '../apps/api/src/utils/idempotency.js';
import { db } from '../packages/db/src/index.js';
import { AutomationEngine } from '../packages/automation/src/index.js';
import type {
  AutomationDefinition,
  AutomationRun
} from '../packages/contracts/src/index.js';
import type {
  AutomationRepository,
  AutomationRunRepository
} from '../packages/automation/src/repositories.js';

// ============================================================================
// GATE 1: SINGLE AUTHORITATIVE TRANSACTIONAL CLAIM & AUTOMATION LIFECYCLE
// ============================================================================

class TestTransactionalAutomationRepo implements AutomationRepository {
  private automations = new Map<string, AutomationDefinition>();

  async saveAutomation(automation: AutomationDefinition): Promise<void> {
    this.automations.set(automation.id, { ...automation });
  }

  async getAutomation(id: string): Promise<AutomationDefinition | undefined> {
    const item = this.automations.get(id);
    return item ? { ...item } : undefined;
  }

  async listAutomations(): Promise<AutomationDefinition[]> {
    return Array.from(this.automations.values()).map(a => ({ ...a }));
  }

  async getDueAutomations(): Promise<AutomationDefinition[]> {
    return Array.from(this.automations.values())
      .filter(a => a.enabled)
      .map(a => ({ ...a }));
  }

  async updateLastRun(id: string, lastRun: number): Promise<void> {
    const item = this.automations.get(id);
    if (item) {
      item.lastRun = lastRun;
    }
  }

  async tryClaimAutomationRun(id: string, dueThreshold: number, newLastRun: number): Promise<boolean> {
    const item = this.automations.get(id);
    if (!item || (item.lastRun || 0) >= dueThreshold) return false;
    item.lastRun = newLastRun;
    return true;
  }

  async deleteAutomation(id: string): Promise<boolean> {
    return this.automations.delete(id);
  }
}

class TestTransactionalRunRepo implements AutomationRunRepository {
  private runs = new Map<string, AutomationRun>();
  private claimsBySchedule = new Map<string, string>(); // key: `${automationId}:${scheduledFor}` -> runId

  async saveRun(run: AutomationRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<AutomationRun | undefined> {
    const r = this.runs.get(id);
    return r ? { ...r } : undefined;
  }

  async getRunsForAutomation(automationId: string): Promise<AutomationRun[]> {
    return Array.from(this.runs.values())
      .filter(r => r.automationId === automationId)
      .map(r => ({ ...r }));
  }

  async claimRun(automationId: string, scheduledFor: number): Promise<AutomationRun | undefined> {
    const scheduleKey = `${automationId}:${scheduledFor}`;
    // Strict transactional uniqueness assertion: exactly one claim allowed per scheduled occurrence
    if (this.claimsBySchedule.has(scheduleKey)) {
      return undefined; // Already claimed: conflict
    }

    const runId = `autorun_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const now = Date.now();
    const run: AutomationRun = {
      id: runId,
      automationId,
      scheduledFor,
      startedAt: now,
      status: 'CLAIMED',
      attempt: 1,
      claimedAt: now
    };

    this.claimsBySchedule.set(scheduleKey, runId);
    this.runs.set(runId, run);
    return { ...run };
  }

  async recoverStaleRuns(staleThresholdMs = 15 * 60 * 1000): Promise<number> {
    const threshold = Date.now() - staleThresholdMs;
    const now = Date.now();
    let count = 0;
    for (const [id, run] of this.runs.entries()) {
      if ((run.status === 'CLAIMED' || run.status === 'RUNNING') && run.startedAt <= threshold) {
        run.status = 'FAILED';
        run.error = 'CRASH_RECOVERY_TIMED_OUT: Process timed out before completing terminal state.';
        run.completedAt = now;
        this.runs.set(id, run);
        count++;
      }
    }
    return count;
  }
}

class TestMockRuntime {
  public executionCount = 0;
  public failNextRun = false;
  private runs = new Map<string, { id: string; state: string; error?: string }>();

  async createRun(_spec: any, _ctx: any) {
    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const state = 'QUEUED';
    this.runs.set(id, { id, state });
    return { id, state };
  }

  async startRun(id: string) {
    this.executionCount++;
    const r = this.runs.get(id);
    if (!r) throw new Error('Run not found');
    if (this.failNextRun) {
      r.state = 'FAILED';
      r.error = 'Execution failed due to child process error';
    } else {
      r.state = 'COMPLETED';
    }
    this.runs.set(id, r);
  }

  async getRun(id: string) {
    return this.runs.get(id);
  }
}

test('Gate 1.1: One-time automation executes exactly once without double-claiming rejection', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engine = new AutomationEngine(runtime as any, autoRepo, runRepo);

  const targetRunAt = Date.now() - 5000; // Due 5 seconds ago
  await autoRepo.saveAutomation({
    id: 'auto_onetime_1',
    name: 'One-time Task',
    enabled: true,
    agentId: 'default',
    trigger: 'ONE_TIME',
    targetRunAt,
    conditions: {},
    objective: 'Execute once'
  });

  // Evaluate schedule cycle
  const result = await engine.runScheduledCronCycle();
  assert.equal(result.evaluated, 1);
  assert.equal(result.triggered.length, 1, 'One-time automation was successfully triggered');
  assert.equal(runtime.executionCount, 1);

  // Verify terminal state
  const runs = await runRepo.getRunsForAutomation('auto_onetime_1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'COMPLETED');
  assert.equal(runs[0].scheduledFor, targetRunAt);

  // Verify automation is disabled and marked COMPLETED
  const updatedAuto = await autoRepo.getAutomation('auto_onetime_1');
  assert.equal(updatedAuto?.enabled, false);
  assert.equal(updatedAuto?.failureState, 'COMPLETED');
});

test('Gate 1.2: Recurring automation executes when due and passes claim through without double claiming', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engine = new AutomationEngine(runtime as any, autoRepo, runRepo);

  // Every minute cron
  await autoRepo.saveAutomation({
    id: 'auto_cron_1',
    name: 'Recurring Task',
    enabled: true,
    agentId: 'default',
    trigger: 'CRON',
    cronExpression: '* * * * *',
    timezone: 'UTC',
    lastRun: 0,
    conditions: {},
    objective: 'Recurring work'
  });

  const result = await engine.runScheduledCronCycle();
  assert.equal(result.evaluated, 1);
  assert.equal(result.triggered.length, 1, 'Recurring cron successfully executed');
  assert.equal(runtime.executionCount, 1);

  const runs = await runRepo.getRunsForAutomation('auto_cron_1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'COMPLETED');
});

test('Gate 1.3: Concurrent scheduler workers cannot execute the same occurrence twice', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engineWorkerA = new AutomationEngine(runtime as any, autoRepo, runRepo);
  const engineWorkerB = new AutomationEngine(runtime as any, autoRepo, runRepo);

  const targetRunAt = Date.now() - 1000;
  await autoRepo.saveAutomation({
    id: 'auto_concurrent_1',
    name: 'Concurrent Safety Task',
    enabled: true,
    agentId: 'default',
    trigger: 'ONE_TIME',
    targetRunAt,
    conditions: {},
    objective: 'Verify concurrency deduplication'
  });

  // Run Worker A and Worker B concurrently on the same schedule
  const [resA, resB] = await Promise.all([
    engineWorkerA.runScheduledCronCycle(),
    engineWorkerB.runScheduledCronCycle()
  ]);

  const totalTriggered = resA.triggered.length + resB.triggered.length;
  assert.equal(totalTriggered, 1, 'Exactly one worker claimed and triggered the run');
  assert.equal(runtime.executionCount, 1, 'Runtime executed exactly once');
});

test('Gate 1.4: Failed execution transitions to correct terminal state FAILED', async () => {
  const runtime = new TestMockRuntime();
  runtime.failNextRun = true; // Force child execution failure
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engine = new AutomationEngine(runtime as any, autoRepo, runRepo);

  const targetRunAt = Date.now() - 2000;
  await autoRepo.saveAutomation({
    id: 'auto_failure_1',
    name: 'Failing Task',
    enabled: true,
    agentId: 'default',
    trigger: 'ONE_TIME',
    targetRunAt,
    conditions: {},
    objective: 'Expect graceful terminal failure'
  });

  const result = await engine.runScheduledCronCycle();
  assert.equal(result.triggered.length, 1);

  const runs = await runRepo.getRunsForAutomation('auto_failure_1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'FAILED');
  assert.ok(runs[0].error?.includes('failed'));

  const auto = await autoRepo.getAutomation('auto_failure_1');
  assert.equal(auto?.enabled, false);
  assert.equal(auto?.failureState, 'FAILED');
});

test('Gate 1.5: One-time automations never recur in subsequent schedule cycles', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engine = new AutomationEngine(runtime as any, autoRepo, runRepo);

  const targetRunAt = Date.now() - 1000;
  await autoRepo.saveAutomation({
    id: 'auto_no_recur',
    name: 'At-most-once Task',
    enabled: true,
    agentId: 'default',
    trigger: 'ONE_TIME',
    targetRunAt,
    conditions: {},
    objective: 'Never repeat'
  });

  // First cycle executes
  await engine.runScheduledCronCycle();
  assert.equal(runtime.executionCount, 1);

  // Subsequent cycles do NOT execute
  const secondCycle = await engine.runScheduledCronCycle();
  assert.equal(secondCycle.triggered.length, 0);
  assert.equal(runtime.executionCount, 1);
});

test('Gate 1.6: Scheduler restarts cannot repeat completed operations', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();

  // First engine instance runs
  const engine1 = new AutomationEngine(runtime as any, autoRepo, runRepo);
  const targetRunAt = Date.now() - 5000;
  await autoRepo.saveAutomation({
    id: 'auto_restart_safety',
    name: 'Restart Safety',
    enabled: true,
    agentId: 'default',
    trigger: 'ONE_TIME',
    targetRunAt,
    conditions: {},
    objective: 'Test restart resilience'
  });

  await engine1.runScheduledCronCycle();
  assert.equal(runtime.executionCount, 1);

  // Simulate scheduler restart: create fresh AutomationEngine instance pointing to shared persistent repos
  const restartedEngine = new AutomationEngine(runtime as any, autoRepo, runRepo);
  const restartResult = await restartedEngine.runScheduledCronCycle();

  assert.equal(restartResult.triggered.length, 0);
  assert.equal(runtime.executionCount, 1, 'Restarted scheduler did not repeat completed operation');
});

test('Gate 1.7: Crash recovery recovers abandoned and stale runs into terminal FAILED state', async () => {
  const runtime = new TestMockRuntime();
  const autoRepo = new TestTransactionalAutomationRepo();
  const runRepo = new TestTransactionalRunRepo();
  const engine = new AutomationEngine(runtime as any, autoRepo, runRepo);

  // Simulate an abandoned run that was claimed 30 minutes ago by a crashed instance
  const abandonedTime = Date.now() - 30 * 60 * 1000;
  const oldRun: AutomationRun = {
    id: 'crashed_run_1',
    automationId: 'auto_crashed',
    scheduledFor: abandonedTime,
    startedAt: abandonedTime,
    status: 'CLAIMED',
    attempt: 1
  };
  await runRepo.saveRun(oldRun);

  // Running recoverStaleRuns should transition it to FAILED
  const recovered = await engine.recoverStaleRuns(15 * 60 * 1000); // 15 min threshold
  assert.equal(recovered, 1);

  const updatedRun = await runRepo.getRun('crashed_run_1');
  assert.equal(updatedRun?.status, 'FAILED');
  assert.ok(updatedRun?.error?.includes('CRASH_RECOVERY_TIMED_OUT'));
});

// ============================================================================
// GATE 2: DATABASE-BACKED IDEMPOTENCY & MULTI-INSTANCE CONCURRENCY
// ============================================================================

test('Gate 2.1: Same principal + key + payload returns original completed result', async () => {
  const manager = new DurableIdempotencyManager(30_000);
  const principalId = 'user_p21_' + Date.now();
  const opId = 'op_p21_' + Date.now();
  const payload = { prompt: 'Render architecture model', quality: 'standard' };

  const first = await manager.beginOrGet(principalId, opId, 'VISION_GEN', payload);
  assert.equal(first.isReplay, false);

  const responseBody = { id: 'img_res_1', credits: 12 };
  await manager.complete(principalId, opId, 200, responseBody);

  const replay = await manager.beginOrGet(principalId, opId, 'VISION_GEN', payload);
  assert.equal(replay.isReplay, true);
  if (replay.isReplay) {
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.responseBody, responseBody);
  }
});

test('Gate 2.2: Same key with different payload returns 409 conflict', async () => {
  const manager = new DurableIdempotencyManager(30_000);
  const principalId = 'user_p22_' + Date.now();
  const opId = 'op_p22_' + Date.now();
  const payload1 = { prompt: 'Original prompt' };
  const payloadConflict = { prompt: 'Conflicting prompt with altered parameters' };

  await manager.beginOrGet(principalId, opId, 'OP_TEST', payload1);
  await manager.complete(principalId, opId, 200, { success: true });

  await assert.rejects(
    async () => {
      await manager.beginOrGet(principalId, opId, 'OP_TEST', payloadConflict);
    },
    (err: any) => err instanceof IdempotencyConflictError && err.statusCode === 409
  );
});

test('Gate 2.3: In-progress concurrent requests cannot duplicate execution', async () => {
  const manager = new DurableIdempotencyManager(30_000);
  const principalId = 'user_p23_' + Date.now();
  const opId = 'op_p23_' + Date.now();
  const payload = { test: true };

  const first = await manager.beginOrGet(principalId, opId, 'OP_CONCURRENT', payload);
  assert.equal(first.isReplay, false);

  // Concurrent request while in progress
  await assert.rejects(
    async () => {
      await manager.beginOrGet(principalId, opId, 'OP_CONCURRENT', payload);
    },
    (err: any) => err instanceof IdempotencyInProgressError && err.statusCode === 409
  );
});

test('Gate 2.4: Production database failures fail closed (never silent memory downgrade)', async () => {
  const manager = new DurableIdempotencyManager(30_000);
  
  // Force production environment
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  const origQuery = (db.client as any).query;
  (db.client as any).query = async () => {
    throw new Error('Connection terminated unexpectedly');
  };

  try {
    // If PostgreSQL is not reachable, beginOrGet in production MUST throw IdempotencyDatabaseError (503)
    // rather than silently returning { isReplay: false } with in-memory storage!
    await assert.rejects(
      async () => {
        await manager.beginOrGet('prod_user', 'prod_op_' + Date.now(), 'PROD_OP', { a: 1 });
      },
      (err: any) => err instanceof IdempotencyDatabaseError && err.statusCode === 503
    );
  } finally {
    (db.client as any).query = origQuery;
    process.env.NODE_ENV = originalEnv;
  }
});

test('Gate 2.5: A conflict cannot delete another valid operation lock', async () => {
  const manager = new DurableIdempotencyManager(30_000);
  const principalId = 'user_p25_' + Date.now();
  const opId = 'op_p25_' + Date.now();
  const payloadValid = { action: 'book_flight' };
  const payloadAttacker = { action: 'malicious_overwrite' };

  // 1. Initial valid attempt begins and completes
  await manager.beginOrGet(principalId, opId, 'TX', payloadValid);
  await manager.complete(principalId, opId, 200, { booked: true });

  // 2. Attacker / conflicting request attempts to use same opId with different payload -> throws 409
  try {
    await manager.beginOrGet(principalId, opId, 'TX', payloadAttacker);
    assert.fail('Should have thrown conflict');
  } catch (err: any) {
    assert.ok(err instanceof IdempotencyConflictError);
  }

  // 3. Attacker's catch block calls fail() -> Invariant: fail() MUST NOT delete completed record!
  await manager.fail(principalId, opId);

  // 4. Original valid request replay still succeeds and returns completed state!
  const replay = await manager.beginOrGet(principalId, opId, 'TX', payloadValid);
  assert.equal(replay.isReplay, true);
  if (replay.isReplay) {
    assert.deepEqual(replay.responseBody, { booked: true });
  }
});

// ============================================================================
// GATE 3: TIMEZONE-AWARE SCHEDULE CONVERSION & DST RESOLUTION
// ============================================================================

test('Gate 3.1: Asia/Kolkata schedule executes at exact intended India local time (UTC+5:30)', () => {
  // 3:00 PM (15:00) Indian Standard Time must map exactly to 09:30:00 UTC
  const kolkataTarget = wallClockToUtcEpoch(
    { year: 2026, month: 10, day: 24, hour: 15, minute: 0 },
    'Asia/Kolkata'
  );
  assert.equal(kolkataTarget.isAmbiguous, false);
  assert.equal(kolkataTarget.isNonexistent, false);

  const iso = new Date(kolkataTarget.epochMs).toISOString();
  assert.equal(iso, '2026-10-24T09:30:00.000Z', '3:00 PM IST is exactly 09:30:00 UTC');
});

test('Gate 3.2: America/New_York correctly handles daylight saving transitions (EDT vs EST)', () => {
  // Summer: July 15, 2026 at 3:00 PM EDT (UTC-4) -> 19:00:00 UTC
  const nySummer = wallClockToUtcEpoch(
    { year: 2026, month: 7, day: 15, hour: 15, minute: 0 },
    'America/New_York'
  );
  assert.equal(new Date(nySummer.epochMs).toISOString(), '2026-07-15T19:00:00.000Z');

  // Winter: December 15, 2026 at 3:00 PM EST (UTC-5) -> 20:00:00 UTC
  const nyWinter = wallClockToUtcEpoch(
    { year: 2026, month: 12, day: 15, hour: 15, minute: 0 },
    'America/New_York'
  );
  assert.equal(new Date(nyWinter.epochMs).toISOString(), '2026-12-15T20:00:00.000Z');
});

test('Gate 3.3: Ambiguous and nonexistent local times are detected and handled explicitly', () => {
  // Spring forward: March 8, 2026 at 2:30 AM does NOT exist in America/New_York (clocks jump 2:00 -> 3:00)
  const springGap = wallClockToUtcEpoch(
    { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
    'America/New_York'
  );
  assert.equal(springGap.isNonexistent, true, 'Nonexistent spring gap is explicitly flagged');

  // Fall back: November 1, 2026 at 1:30 AM is repeated in America/New_York (clocks fall back 2:00 -> 1:00)
  const fallOverlap = wallClockToUtcEpoch(
    { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
    'America/New_York'
  );
  assert.equal(fallOverlap.isAmbiguous, true, 'Ambiguous repeated hour is explicitly flagged');
});

test('Gate 3.4: One-time execution stores the correct UTC epoch with IANA timezone', () => {
  const resolution = resolveSchedule('Schedule backup tomorrow at 4pm in Asia/Kolkata');
  assert.equal(resolution.valid, true);
  assert.equal(resolution.scheduleType, 'ONE_TIME');
  assert.equal(resolution.timezone, 'Asia/Kolkata');
  assert.ok(resolution.targetTimestamp);

  // Verify the target timestamp matches 16:00 IST (10:30 UTC)
  const wallClock = getWallClockInTimezone(new Date(resolution.targetTimestamp), 'Asia/Kolkata');
  assert.equal(wallClock.hour, 16);
  assert.equal(wallClock.minute, 0);
  assert.ok(resolution.humanSchedule?.includes('Asia/Kolkata'));
});

test('Gate 3.5: Recurring jobs evaluate according to saved IANA timezone', () => {
  // Parse daily 8:30 PM (20:30) in Asia/Kolkata
  const interval = parseCron('30 20 * * *', {
    tz: 'Asia/Kolkata',
    currentDate: new Date('2026-10-24T23:00:00Z')
  });

  const prev = interval.prev().toDate();
  const wallClock = getWallClockInTimezone(prev, 'Asia/Kolkata');
  assert.equal(wallClock.hour, 20);
  assert.equal(wallClock.minute, 30);
});
