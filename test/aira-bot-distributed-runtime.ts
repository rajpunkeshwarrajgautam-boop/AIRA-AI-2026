import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './postgres-fixture.js';

process.env.NODE_ENV = 'test';
const cleanup = await createTestDatabase();
const { db, runMigrations, closeDb } = await import('../packages/db/src/index.js');
const { DistributedRuntimeCoordinator } = await import('../packages/computer-runtime/src/distributed.js');
const { RuntimeReliabilityService } = await import('../packages/computer-runtime/src/reliability.js');
const workers: ChildProcess[] = [];
const coordinator = new DistributedRuntimeCoordinator(db);
let requestId = 0;
const input = (ownerId: string, holderId: string, ttlMs = 60000) => ({ ownerId, botId: 'bot', holderId, mode: 'BOT' as const, ttlMs });
async function until(check: () => Promise<boolean>, message: string, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail(message);
}
async function spawnWorker(index: number) {
  const child = fork(fileURLToPath(new URL('./aira-bot-distributed-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, AIRA_TEST_CLOCK: String(index % 2 ? 1 : 9_000_000_000_000) }
  });
  workers.push(child);
  let output = '';
  child.stderr?.on('data', data => { output += data; });
  child.stdout?.on('data', data => { output += data; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker startup timed out: ' + output)), 15000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Worker startup exit ' + code + ': ' + output)); });
    child.once('message', () => { clearTimeout(timer); resolve(); });
  });
  return child;
}
function request(child: ChildProcess, action: string, key: string, holder: string): Promise<{ value?: any; error?: string }> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    const onMessage = (message: any) => { if (message.id === id) { finish(); resolve(message); } };
    const onExit = (code: number | null) => { finish(); reject(new Error('Worker exited before reply: ' + code)); };
    const timer = setTimeout(() => { finish(); reject(new Error('Worker request timed out: ' + action)); }, 15000);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ id, action, key, holder });
  });
}
async function blockedUpdate(table: string, predicate: Record<string, unknown>, deadlineColumn: string, action: () => Promise<unknown>, queryPattern: string) {
  const lock = await db.transaction();
  let pending: Promise<unknown> | undefined;
  try {
    await lock(table).where(predicate).forUpdate().first();
    pending = action();
    // Attach rejection immediately; assert the original settled result below.
    void pending.catch(() => {});
    await until(async () => {
      const rows = await db.raw("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE ?", [queryPattern]);
      return rows.rows.length > 0;
    }, 'operation must actually wait for a database row lock');
    await lock(table).where(predicate).update({ [deadlineColumn]: 0 });
    await lock.commit();
    return await pending;
  } catch (error) {
    if (!lock.isCompleted()) await lock.rollback();
    if (pending) await pending.catch(() => {});
    throw error;
  }
}
try {
  await runMigrations();

  const first = await coordinator.acquireComputerLease(input('release', 'A'));
  assert.equal(await coordinator.releaseComputerLease(first.ownerId, first.token, first.fence), true);
  const second = await coordinator.acquireComputerLease(input('release', 'B'));
  assert.ok(second.fence > first.fence, 'release preserves the fencing high-water mark');
  assert.equal(await coordinator.releaseComputerLease(first.ownerId, first.token, first.fence), false);
  await assert.rejects(coordinator.renewComputerLease(first.ownerId, first.token, 60000), /COMPUTER_LEASE_LOST/);
  await assert.rejects(coordinator.assertComputerLease(second.ownerId, second.token, second.fence - 1), /COMPUTER_LEASE_LOST/);
  await assert.rejects(coordinator.acquireComputerLease(input('invalid', 'A', 0)), /INVALID_LEASE_DURATION/);
  await assert.rejects(coordinator.acquireComputerLease(input('release', 'C')), /COMPUTER_BUSY/);
  const human = await coordinator.acquireComputerLease({ ...input('release', 'human'), mode: 'HUMAN', preemptBot: true });
  assert.ok(human.fence > second.fence);
  await assert.rejects(coordinator.acquireComputerLease(input('release', 'B')), /COMPUTER_TAKEN_OVER/);
  await assert.rejects(coordinator.assertComputerLease(second.ownerId, second.token, second.fence), /COMPUTER_LEASE_LOST/);
  assert.equal(await coordinator.releaseComputerLease(human.ownerId, human.token, human.fence), true);

  const waiting = await coordinator.acquireComputerLease(input('lock-wait', 'A'));
  await assert.rejects(blockedUpdate('aira_computer_leases', { owner_id: waiting.ownerId }, 'lease_until',
    () => coordinator.renewComputerLease(waiting.ownerId, waiting.token, 60000), '%aira_computer_leases%'), /COMPUTER_LEASE_LOST/);

  await Promise.all(Array.from({ length: 8 }, (_, i) => spawnWorker(i)));
  for (let round = 0; round < 5; round++) {
    const claims = await Promise.all(workers.map((worker, i) => request(worker, 'lease', 'race:' + round, 'worker:' + i)));
    const winners = claims.filter(result => result.value);
    assert.equal(winners.length, 1, 'exactly one first-time computer owner across eight processes');
    assert.equal(claims.filter(result => result.error === 'COMPUTER_BUSY').length, 7);
    const winner = winners[0].value;
    assert.equal(winner.fence, 1);
    assert.equal(await coordinator.releaseComputerLease(winner.ownerId, winner.token, winner.fence), true);
    const replacement = await coordinator.acquireComputerLease(input(winner.ownerId, 'replacement'));
    assert.equal(replacement.fence, 2);

    const leaders = await Promise.all(workers.map((worker, i) => request(worker, 'scheduler', 'scheduler:' + round, 'worker:' + i)));
    assert.equal(leaders.filter(result => result.value).length, 1, 'first-time scheduler claim is exclusive');
    assert.equal(leaders.filter(result => result.error).length, 0);

    const generations = await Promise.all(workers.map((worker, i) => request(worker, 'desired', 'lifecycle:' + round, 'worker:' + i)));
    assert.deepEqual(generations.map(result => result.value).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    const events = await Promise.all(workers.map((worker, i) => request(worker, 'event', 'events:' + round, 'worker:' + i)));
    assert.deepEqual(events.map(result => result.value.sequence).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    const replay = await new DistributedRuntimeCoordinator(db).computerEvents('events:' + round, 'bot', 4);
    assert.deepEqual(replay.map(event => event.sequence), [5, 6, 7, 8]);
  }

  const dead = workers.pop()!;
  const crash = (await request(dead, 'crash-lease', 'crashed-worker', 'dead')).value;
  assert.ok(crash);
  const exited = new Promise<void>(resolve => dead.once('exit', () => resolve()));
  dead.kill('SIGKILL');
  await exited;
  await until(async () => !await coordinator.currentComputerLease(crash.ownerId), 'dead worker lease expires using database time');
  const survivor = await coordinator.acquireComputerLease(input(crash.ownerId, 'survivor'));
  assert.ok(survivor.fence > crash.fence);
  await assert.rejects(coordinator.assertComputerLease(crash.ownerId, crash.token, crash.fence), /COMPUTER_LEASE_LOST/);

  const crashedGeneration = await coordinator.setComputerDesiredState('crashed-reconciler', 'docker', 'RUNNING');
  const deadReconciler = workers.pop()!;
  assert.equal((await request(deadReconciler, 'crash-reconcile', 'crashed-reconciler', 'dead')).value.started, true);
  const reconcilerExit = new Promise<void>(resolve => deadReconciler.once('exit', () => resolve()));
  deadReconciler.kill('SIGKILL');
  await reconcilerExit;
  assert.equal(await coordinator.reconcileComputer('crashed-reconciler', crashedGeneration, async () => {}), true, 'worker death rolls back its observation; a survivor reconciles the durable intent');
  assert.equal(Number((await db('aira_runtime_outbox').where({ dedupe_key: 'computer:crashed-reconciler:generation:' + crashedGeneration }).count('* as count'))[0].count), 1);
  const recoveredNotification = (await coordinator.claimOutbox('recovery-publisher', 1))[0];
  assert.equal(recoveredNotification.dedupeKey, 'computer:crashed-reconciler:generation:' + crashedGeneration);
  assert.equal(await coordinator.completeOutbox(recoveredNotification.id, 'recovery-publisher', recoveredNotification.attempts), true);

  const leaderA = await coordinator.acquireSchedulerLease('failover', 'A', 60000);
  assert.ok(leaderA);
  assert.equal(await coordinator.acquireSchedulerLease('failover', 'B', 60000), undefined);
  await db('aira_scheduler_leases').where({ name: 'failover' }).update({ lease_until: 0 });
  const leaderB = await coordinator.acquireSchedulerLease('failover', 'B', 60000);
  assert.ok(leaderB && leaderB.fence > leaderA.fence);
  assert.equal(await coordinator.assertSchedulerLease(leaderA), false);
  assert.equal(await coordinator.assertSchedulerLease(leaderB), true);

  const outbox = await coordinator.enqueueOutbox('test', 'aggregate', 'dedupe', { value: 1 });
  assert.ok(outbox);
  assert.equal(await coordinator.enqueueOutbox('test', 'aggregate', 'dedupe', { value: 2 }), undefined);
  const claims = await Promise.all(workers.map((worker, i) => request(worker, 'outbox', '', 'outbox:' + i)));
  assert.equal(claims.flatMap(result => result.value || []).length, 1, 'SKIP LOCKED outbox claim is exclusive across processes');
  const row = await db('aira_runtime_outbox').where({ id: outbox }).first();
  const originalAttempt = Number(row.attempts);
  await db('aira_runtime_outbox').where({ id: outbox }).update({ claim_until: 0 });
  assert.equal(await coordinator.completeOutbox(outbox, row.claimed_by, originalAttempt), false, 'expired acknowledgements fail even before reclaim');
  const reclaimed = (await coordinator.claimOutbox(row.claimed_by, 1))[0];
  assert.equal(reclaimed.attempts, originalAttempt + 1);
  assert.equal(await coordinator.completeOutbox(outbox, row.claimed_by, originalAttempt), false, 'same worker ID cannot acknowledge an older attempt');
  assert.equal(await coordinator.failOutbox(outbox, row.claimed_by, originalAttempt, 'stale', 0), false);
  assert.equal(await coordinator.completeOutbox(outbox, row.claimed_by, reclaimed.attempts), true);
  const waitingOutbox = await coordinator.enqueueOutbox('test', 'aggregate', 'wait-expiry', {});
  const waitingClaim = (await coordinator.claimOutbox('wait-worker', 1))[0];
  assert.equal(await blockedUpdate('aira_runtime_outbox', { id: waitingOutbox }, 'claim_until',
    () => coordinator.completeOutbox(waitingOutbox!, 'wait-worker', waitingClaim.attempts), '%aira_runtime_outbox%'), false);

  const generation1 = await coordinator.setComputerDesiredState('observe', 'docker', 'RUNNING');
  const generation2 = await coordinator.setComputerDesiredState('observe', 'docker', 'STOPPED');
  assert.equal(await coordinator.recordComputerObservation('observe', generation1, 'RUNNING'), false, 'stale generation cannot overwrite a newer intent');
  await db.raw("ALTER TABLE aira_runtime_outbox ADD CONSTRAINT test_outbox_failure CHECK (aggregate_id <> 'observe')");
  await assert.rejects(coordinator.recordComputerObservation('observe', generation2, 'STOPPED'), /test_outbox_failure/);
  assert.equal(Number((await db('aira_computer_instances').where({ owner_id: 'observe' }).first()).observed_generation), 0, 'outbox failure rolls back the observation');
  await db.raw('ALTER TABLE aira_runtime_outbox DROP CONSTRAINT test_outbox_failure');
  assert.equal(await coordinator.recordComputerObservation('observe', generation2, 'STOPPED'), true);
  assert.equal(Number((await db('aira_runtime_outbox').where({ dedupe_key: 'computer:observe:generation:' + generation2 }).count('* as count'))[0].count), 1);

  const reconcileGeneration = await coordinator.setComputerDesiredState('reconcile', 'docker', 'RUNNING');
  let applied = 0;
  const apply = async () => { applied++; await delay(25); };
  const reconciled = await Promise.all(Array.from({ length: 8 }, () => coordinator.reconcileComputer('reconcile', reconcileGeneration, apply)));
  assert.equal(reconciled.filter(Boolean).length, 1);
  assert.equal(applied, 1, 'competing reconcilers apply one lifecycle generation only once');
  const failureGeneration = await coordinator.setComputerDesiredState('reconcile-error', 'docker', 'RUNNING');
  assert.equal(await coordinator.reconcileComputer('reconcile-error', failureGeneration, async () => { throw new Error('provider unavailable'); }), false);
  assert.equal((await db('aira_computer_instances').where({ owner_id: 'reconcile-error' }).first()).observed_state, 'ERROR');
  assert.equal(await coordinator.reconcileComputer('reconcile-error', failureGeneration, async () => {}), true, 'provider failure remains retryable');

  // Readiness must not be vacuously true; dead historical instances remain diagnostic.
  assert.equal((await coordinator.readiness()).ready, false);
  await coordinator.heartbeatInstance('old', 'aira-bot-api', 'test');
  await db('aira_runtime_instances').where({ instance_id: 'old' }).update({ heartbeat_at: 0 });
  await coordinator.heartbeatInstance('live', 'aira-bot-api', 'test');
  await coordinator.acquireSchedulerLease('aira-bot-routines', 'live', 60000);
  assert.equal((await coordinator.readiness()).ready, false, 'unreconciled intent blocks readiness');
  for (const item of await coordinator.reconciliationBacklog()) await coordinator.recordComputerObservation(item.ownerId, item.generation, item.desiredState);
  const health = await coordinator.readiness();
  assert.equal(health.ready, true);
  assert.equal(health.staleInstances, 1);
  await db('aira_scheduler_leases').where({ name: 'aira-bot-routines' }).update({ lease_until: 0 });
  assert.equal((await coordinator.readiness()).ready, false, 'missing routine leadership blocks readiness');

  const provider = { kind: 'docker' as const } as any;
  const service = new RuntimeReliabilityService(provider, coordinator, { instanceId: 'service-test' });
  await service.heartbeat();
  assert.equal(await service.isSchedulerLeader(), true);
  await db('aira_scheduler_leases').where({ name: 'aira-bot-routines' }).update({ lease_until: 0 });
  assert.equal(await service.isSchedulerLeader(), false, 'cached leadership is not authority');
  const heartbeat = coordinator.heartbeatInstance.bind(coordinator);
  coordinator.heartbeatInstance = async () => { throw new Error('database unavailable'); };
  await assert.rejects(service.heartbeat(), /database unavailable/);
  assert.equal(await service.isSchedulerLeader(), false);
  coordinator.heartbeatInstance = heartbeat;
  const readiness = coordinator.readiness.bind(coordinator);
  coordinator.readiness = async () => { throw new Error('database unavailable'); };
  assert.deepEqual(await service.health(), { live: true, ready: false, database: false, schedulerLeader: false });
  coordinator.readiness = readiness;
  service.stop();
  const localService = new RuntimeReliabilityService({} as any, coordinator, { instanceId: 'local-test' });
  const localGeneration = await localService.requestState('local-kind-default', 'STOPPED');
  assert.equal(localGeneration, 1);
  assert.equal((await db('aira_computer_instances').where({ owner_id: 'local-kind-default' }).first()).provider, 'local');
  localService.stop();

  console.log('Aira Bot distributed foundations: PASS — actual coordinator methods on PostgreSQL; 8 OS workers; 5 rounds each of computer/scheduler/lifecycle/event contention; clock skew; worker crash/expiry; release fencing; lock-wait expiry; outbox attempt fencing; atomic observation/outbox rollback; serialized reconciliation; fail-closed readiness');
} finally {
  await Promise.all(workers.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => clearTimeout(timer));
  })));
  await closeDb();
  await cleanup();
}
