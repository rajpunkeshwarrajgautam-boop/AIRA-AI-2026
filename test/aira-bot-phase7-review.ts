import assert from 'node:assert/strict';
import { createTestDatabase } from './postgres-fixture.js';

process.env.NODE_ENV = 'test';
const cleanup = await createTestDatabase();
const { db, runMigrations, closeDb } = await import('../packages/db/src/index.js');
const { DistributedRuntimeCoordinator } = await import('../packages/computer-runtime/src/distributed.js');
const { RuntimeReliabilityService } = await import('../packages/computer-runtime/src/reliability.js');
const { ManagedComputerRuntime } = await import('../packages/computer-runtime/src/managed.js');
await runMigrations();
try {
  const coordinator = new DistributedRuntimeCoordinator();
  // Explicit fault fixture: provider returns ERROR instead of throwing, as the
  // real Docker provider does when its post-action status request fails.
  const fault = { kind: 'docker', enabled: true, terminalEnabled: true, allowedPrograms: [],
    start: async () => ({ state: 'ERROR', lastError: 'status probe failed' }),
    stop: async () => ({ state: 'ERROR', lastError: 'status probe failed' }) } as any;
  const managed = new ManagedComputerRuntime(fault);
  const failures: string[] = [];
  async function check(name: string, test: () => Promise<void>) {
    try { await test(); console.log('PASS ' + name); }
    catch (error) { failures.push(name + ': ' + (error as Error).message); }
  }
  await check('reconciliation preserves ERROR results instead of declaring success', async () => {
    const generation = await coordinator.setComputerDesiredState('fault-reconcile', 'docker', 'RUNNING');
    const applied = await coordinator.reconcileComputer('fault-reconcile', generation, state => managed.reconcileState('fault-reconcile', state));
    assert.equal(applied, false);
    assert.equal((await db('aira_computer_instances').where({ owner_id: 'fault-reconcile' }).first()).observed_state, 'ERROR');
    assert.equal((await db('aira_runtime_outbox').where({ dedupe_key: 'computer:fault-reconcile:generation:' + generation })).length, 0);
  });
  await check('managed stop never records a failed provider status as STOPPED', async () => {
    await managed.stop('fault-stop', 'bot-review').catch(() => {});
    assert.equal((await db('aira_computer_instances').where({ owner_id: 'fault-stop' }).first()).observed_state, 'ERROR');
    assert.equal((await db('aira_runtime_outbox').where({ aggregate_id: 'fault-stop', topic: 'computer.reconciled' })).length, 0);
  });
  await check('standalone reliability also rejects returned lifecycle ERROR', async () => {
    const service = new RuntimeReliabilityService(fault, coordinator);
    for (const desired of ['RUNNING', 'STOPPED'] as const) {
      const owner = 'fault-fallback-' + desired;
      await coordinator.setComputerDesiredState(owner, 'docker', desired);
      await service.reconcile();
      assert.equal((await db('aira_computer_instances').where({ owner_id: owner }).first()).observed_state, 'ERROR');
      assert.equal((await db('aira_runtime_outbox').where({ aggregate_id: owner, topic: 'computer.reconciled' })).length, 0);
    }
    service.stop();
  });
  // Remove fault lifecycle rows to isolate instance freshness from the backlog.
  await db('aira_computer_instances').delete();
  await check('another healthy API cannot mask this instance stale heartbeat', async () => {
    const a = new RuntimeReliabilityService(fault, coordinator, { instanceId: 'review-A' });
    const b = new RuntimeReliabilityService(fault, coordinator, { instanceId: 'review-B' });
    await a.heartbeat(); await b.heartbeat();
    await db('aira_runtime_instances').where({ instance_id: 'review-A' }).update({ heartbeat_at: 0 });
    assert.equal((await a.health()).ready, false);
    assert.equal((await b.health()).ready, true);
    await a.heartbeat();
    assert.equal((await a.health()).ready, true);
    a.stop(); b.stop();
  });
  assert.deepEqual(failures, []);
  console.log('Aira Bot Phase 7 review regressions: PASS');
} finally { await closeDb(); await cleanup(); }
