import './setup-disposable-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import {
  DurableIdempotencyManager,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyUncertainOutcomeError
} from '../apps/api/src/utils/idempotency.js';
import * as migration023 from '../packages/db/src/migrations/023_idempotent_operations.js';

test.describe('AIRA ONE — Real PostgreSQL Durable Idempotency & Concurrency Suite', () => {

  test.before(async () => {
    // Ensure clean table state before tests
    const hasTable = await db.schema.hasTable('idempotent_operations');
    if (!hasTable) {
      await migration023.up(db);
    }
  });

  test.after(async () => {
    // Keep test database clean
    await db('idempotent_operations').where('principal_id', 'like', 'test-%').delete();
    await closeDb();
  });

  test('GATE 1: Real PostgreSQL Connectivity & Server Identity (Strict Disposable DB Check)', async () => {
    console.log('\n--- Verifying Real PostgreSQL Engine Identity ---');
    const res = await db.raw(
      "SELECT version() AS version, current_database() AS db_name, current_user AS db_user, current_setting('server_version') AS server_version"
    );
    const row = res.rows[0];
    console.log(`  Engine:   ${row.version.split(' on ')[0]}`);
    console.log(`  Database: ${row.db_name}`);
    console.log(`  User:     ${row.db_user}`);
    console.log(`  Version:  ${row.server_version}`);

    assert.ok(row.version.toLowerCase().includes('postgresql'), 'Database engine must be real PostgreSQL');
    assert.ok(row.db_name, 'Database name must be present');

    // Strict Gate 5 Invariant: Operational database 'aira_db' is NEVER an approved disposable test database.
    // Tests must connect exclusively to 'aira_test_db' (or an explicitly declared disposable test DB in CI).
    const isApprovedDisposableDb = row.db_name === 'aira_test_db' || (process.env.CI === 'true' && row.db_name.endsWith('_test_db'));
    assert.strictEqual(
      isApprovedDisposableDb,
      true,
      `GATE 5 VIOLATION: Tests must run only against an approved disposable testing database ('aira_test_db'). Database '${row.db_name}' is not approved (aira_db is an operational database).`
    );
  });

  test('GATE 2: Migration 023 Clean Lifecycle with Destructive Safety Barrier', async () => {
    console.log('\n--- Verifying Migration 023 Lifecycle in Real Database ---');
    const res = await db.raw("SELECT current_database() AS db_name");
    const currentDb = res.rows[0]?.db_name;

    // Destructive guard: down() must NEVER execute on operational or non-test databases
    const isApprovedDisposableDb = currentDb === 'aira_test_db' || (process.env.CI === 'true' && currentDb.endsWith('_test_db'));
    const allowDestructive = process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION === '1';

    if (!isApprovedDisposableDb) {
      throw new Error(`CRITICAL: Destructive migration down() blocked on database '${currentDb}'! Only 'aira_test_db' is permitted.`);
    }

    if (allowDestructive) {
      // Test clean rollback
      await migration023.down(db);
      const existsAfterDown = await db.schema.hasTable('idempotent_operations');
      assert.strictEqual(existsAfterDown, false, 'Migration 023 down() must drop idempotent_operations table cleanly');

      // Test clean apply
      await migration023.up(db);
      const existsAfterUp = await db.schema.hasTable('idempotent_operations');
      assert.strictEqual(existsAfterUp, true, 'Migration 023 up() must recreate idempotent_operations table cleanly');
    } else {
      console.log('  NOTICE: Destructive migration down() skipped (ALLOW_DESTRUCTIVE_TEST_MIGRATION != 1). Verifying existing schema integrity.');
      const exists = await db.schema.hasTable('idempotent_operations');
      if (!exists) {
        await migration023.up(db);
      }
    }

    // Check columns
    const columns = await db('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'idempotent_operations' })
      .select('column_name', 'data_type');
    const colMap = new Set(columns.map(c => c.column_name));

    assert.ok(colMap.has('key'), 'Missing key column');
    assert.ok(colMap.has('principal_id'), 'Missing principal_id column');
    assert.ok(colMap.has('operation_id'), 'Missing operation_id column');
    assert.ok(colMap.has('operation_type'), 'Missing operation_type column');
    assert.ok(colMap.has('payload_hash'), 'Missing payload_hash column');
    assert.ok(colMap.has('status'), 'Missing status column');
    assert.ok(colMap.has('locked_until'), 'Missing locked_until column');
    console.log('  PASS: Migration 023 schema verified with all required columns and constraints.');
  });

  test('GATE 3: Principal-Scoped Isolation (Two users with same operation ID do not collide)', async () => {
    console.log('\n--- Verifying Principal-Scoped Idempotency Isolation ---');
    const manager = new DurableIdempotencyManager();
    const sharedOpId = `op-shared-${Date.now()}`;
    const userA = 'test-principal-alpha';
    const userB = 'test-principal-beta';
    const payload = { prompt: 'A futuristic skyline', aspect: '1:1' };

    // Both users should be able to begin their operation with the exact same operationId
    const resA = await manager.beginOrGet(userA, sharedOpId, 'VISION_GENERATE', payload);
    const resB = await manager.beginOrGet(userB, sharedOpId, 'VISION_GENERATE', payload);

    assert.strictEqual(resA.isReplay, false, 'User A should acquire new lock');
    assert.strictEqual(resB.isReplay, false, 'User B should acquire new lock without colliding with User A');

    // Complete both with distinct outputs
    await manager.complete(userA, sharedOpId, 200, { image: 'image-alpha.png' });
    await manager.complete(userB, sharedOpId, 200, { image: 'image-beta.png' });

    // Verify replay returns user-isolated data
    const replayA = await manager.beginOrGet(userA, sharedOpId, 'VISION_GENERATE', payload);
    const replayB = await manager.beginOrGet(userB, sharedOpId, 'VISION_GENERATE', payload);

    assert.strictEqual(replayA.isReplay, true);
    assert.strictEqual(replayB.isReplay, true);
    if (replayA.isReplay && replayB.isReplay) {
      assert.strictEqual(replayA.responseBody.image, 'image-alpha.png');
      assert.strictEqual(replayB.responseBody.image, 'image-beta.png');
    }
    console.log('  PASS: Principal-scoped isolation verified across distinct users in real PostgreSQL.');
  });

  test('GATE 4: Concurrent Requests Across Independent Execution Contexts (Workers)', async () => {
    console.log('\n--- Verifying Concurrency Across Independent Contexts ---');
    // Instantiate two separate managers with isolated memory caches to simulate separate serverless workers
    const worker1 = new DurableIdempotencyManager();
    const worker2 = new DurableIdempotencyManager();
    const principal = 'test-principal-concurrent';
    const opId = `op-concurrent-${Date.now()}`;
    const payload = { prompt: 'Concurrent execution test' };

    // Fire simultaneous requests
    const [res1, res2] = await Promise.allSettled([
      worker1.beginOrGet(principal, opId, 'VISION_GENERATE', payload),
      worker2.beginOrGet(principal, opId, 'VISION_GENERATE', payload)
    ]);

    const successes = [res1, res2].filter(r => r.status === 'fulfilled');
    const failures = [res1, res2].filter(r => r.status === 'rejected');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent worker must acquire the lock');
    assert.strictEqual(failures.length, 1, 'The other worker must be rejected with in-progress error');

    const err = (failures[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof IdempotencyInProgressError, 'Failure reason must be IdempotencyInProgressError');
    assert.strictEqual(err.statusCode, 409);
    console.log('  PASS: Exactly one worker acquired lock; concurrent request rejected with 409 in-progress.');
  });

  test('GATE 5: Long-Running Task Lease Heartbeat Renewal Prevents Race Steal', async () => {
    console.log('\n--- Verifying Heartbeat Lease Extension in Real PostgreSQL ---');
    const worker1 = new DurableIdempotencyManager();
    const worker2 = new DurableIdempotencyManager();
    const principal = 'test-principal-heartbeat';
    const opId = `op-heartbeat-${Date.now()}`;
    const payload = { prompt: 'Long running vision diffusion' };

    // Worker 1 acquires lock with a 800ms initial lease
    const initial = await worker1.beginOrGet(principal, opId, 'VISION_GENERATE', payload, 800);
    assert.strictEqual(initial.isReplay, false);

    // Start heartbeat: extends lease by 3000ms every 250ms
    const heartbeat = worker1.startHeartbeat(principal, opId, 250, 3000);

    // Wait 1000ms (longer than the initial 800ms lease)
    await new Promise(r => setTimeout(r, 1000));

    // Inspect real PostgreSQL row: locked_until should have been pushed into the future
    const row = await db('idempotent_operations').where({ key: `${principal}:${opId}` }).first();
    const now = Date.now();
    assert.ok(parseInt(row.locked_until, 10) > now + 1000, 'PostgreSQL locked_until must be extended by heartbeat');

    // Worker 2 attempts to claim: should still be rejected as IN_PROGRESS
    await assert.rejects(
      worker2.beginOrGet(principal, opId, 'VISION_GENERATE', payload),
      IdempotencyInProgressError,
      'Concurrent worker must NOT steal lease while heartbeat is actively renewing'
    );

    heartbeat.stop();
    await worker1.complete(principal, opId, 200, { result: 'done' });
    console.log('  PASS: Heartbeat renewal continuously refreshed PostgreSQL lease; prevented lease-expiration races.');
  });

  test('GATE 6: Audit complete() and fail() safety — Committed Side Effect NEVER Deleted', async () => {
    console.log('\n--- Auditing Side Effect Committed Safety (No Double-Billing) ---');
    const manager = new DurableIdempotencyManager();
    const principal = 'test-principal-side-effect';
    const opId = `op-side-effect-${Date.now()}`;
    const payload = { prompt: 'Billed premium vision image', count: 2 };

    await manager.beginOrGet(principal, opId, 'VISION_GENERATE', payload);

    // Simulate external side effect committed (credits charged, image generated),
    // but PostgreSQL completion persistence fails or throws in try block
    const mockGeneratedResult = { imageId: 'img-committed-777', creditsCharged: 12 };
    await manager.fail(principal, opId, {
      sideEffectCommitted: true,
      result: mockGeneratedResult,
      error: 'Simulated connection blip during post-execution persistence'
    });

    // Invariant: Row in real PostgreSQL must NOT be deleted!
    const row = await db('idempotent_operations').where({ key: `${principal}:${opId}` }).first();
    assert.ok(row, 'PostgreSQL record must NOT be deleted after side effect committed');
    assert.strictEqual(row.status, 'COMPLETED', 'Row should be saved as COMPLETED with fallback result');

    // Subsequent client retry MUST return the replayed result rather than re-executing
    const freshManager = new DurableIdempotencyManager();
    const retry = await freshManager.beginOrGet(principal, opId, 'VISION_GENERATE', payload);
    assert.strictEqual(retry.isReplay, true, 'Retry must be recognized as replay');
    if (retry.isReplay) {
      assert.strictEqual(retry.responseBody.imageId, 'img-committed-777');
      assert.strictEqual(retry.responseBody.creditsCharged, 12);
    }
    console.log('  PASS: Committed side effect was preserved in PostgreSQL; retry safely replayed without duplicate charge.');
  });

  test('GATE 7: Uncertain Outcome Reconciliation Blocks Duplicate Execution', async () => {
    console.log('\n--- Auditing Uncertain Outcome Safety & Reconciliation ---');
    const manager = new DurableIdempotencyManager();
    const principal = 'test-principal-uncertain';
    const opId = `op-uncertain-${Date.now()}`;
    const payload = { prompt: 'Financial credit transfer' };

    await manager.beginOrGet(principal, opId, 'BILLING_HOLD', payload);

    // Side effect committed, but no result object could be extracted (e.g. timeout on upstream provider ack)
    await manager.fail(principal, opId, {
      sideEffectCommitted: true,
      error: 'Upstream gateway timed out while executing financial side effect'
    });

    // Verify row in PostgreSQL is marked FAILED with UNCERTAIN_OUTCOME
    const row = await db('idempotent_operations').where({ key: `${principal}:${opId}` }).first();
    assert.strictEqual(row.status, 'FAILED');
    assert.ok(row.response_body.includes('UNCERTAIN_OUTCOME'));

    // A fresh worker instance attempts retry: must FAIL with IdempotencyUncertainOutcomeError (409)
    const worker2 = new DurableIdempotencyManager();
    await assert.rejects(
      worker2.beginOrGet(principal, opId, 'BILLING_HOLD', payload),
      IdempotencyUncertainOutcomeError,
      'Retry on uncertain outcome must be blocked to prevent double-charging'
    );

    // Administrative reconciliation
    await worker2.reconcile(principal, opId, {
      status: 'COMPLETED',
      statusCode: 200,
      responseBody: { status: 'reconciled_after_audit', txId: 'tx-audited-888' }
    });

    // After reconciliation, subsequent call cleanly replays the reconciled outcome
    const replay = await worker2.beginOrGet(principal, opId, 'BILLING_HOLD', payload);
    assert.strictEqual(replay.isReplay, true);
    if (replay.isReplay) {
      assert.strictEqual(replay.responseBody.txId, 'tx-audited-888');
    }
    console.log('  PASS: Uncertain outcome blocked duplicate execution; administrative reconciliation verified.');
  });

  test('GATE 8: Payload Conflict Detection in Real PostgreSQL', async () => {
    console.log('\n--- Verifying Payload Conflict Detection ---');
    const manager1 = new DurableIdempotencyManager();
    const manager2 = new DurableIdempotencyManager();
    const principal = 'test-principal-conflict';
    const opId = `op-conflict-${Date.now()}`;

    await manager1.beginOrGet(principal, opId, 'AUTOMATION_CREATE', { name: 'Backup Job A' });
    await manager1.complete(principal, opId, 201, { id: 'auto-1' });

    // Second worker receives request with same ID but different payload
    await assert.rejects(
      manager2.beginOrGet(principal, opId, 'AUTOMATION_CREATE', { name: 'Backup Job B (Conflicting)' }),
      IdempotencyConflictError,
      'Mismatched payload hash must throw IdempotencyConflictError'
    );
    console.log('  PASS: Payload conflict threw 409 IdempotencyConflictError across separate contexts.');
  });

  test('GATE 9: Clean Rollback of In-Progress Lock on Pre-Side-Effect Failure', async () => {
    console.log('\n--- Verifying Clean Lease Release on Pre-Commit Error ---');
    const manager = new DurableIdempotencyManager();
    const principal = 'test-principal-pre-commit';
    const opId = `op-pre-commit-${Date.now()}`;
    const payload = { prompt: 'Validation failure test' };

    await manager.beginOrGet(principal, opId, 'VISION_GENERATE', payload);

    // Error before external execution (e.g. credit check failed, no side effect committed)
    await manager.fail(principal, opId, { sideEffectCommitted: false });

    // Verify row was deleted from real PostgreSQL
    const row = await db('idempotent_operations').where({ key: `${principal}:${opId}` }).first();
    assert.strictEqual(row, undefined, 'In-progress row must be deleted if no side effect committed');

    // Legitimate retry can now acquire the lock
    const retry = await manager.beginOrGet(principal, opId, 'VISION_GENERATE', payload);
    assert.strictEqual(retry.isReplay, false, 'Clean retry must be allowed to acquire lock');
    await manager.complete(principal, opId, 200, { ok: true });
    console.log('  PASS: Pre-commit error deleted in-progress lock; legitimate retry acquired cleanly.');
  });
});
