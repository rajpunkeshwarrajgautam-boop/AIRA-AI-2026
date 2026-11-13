import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseReadinessProbe } from '../apps/api/src/runtime-readiness.js';

test('database readiness caches a successful SELECT and deduplicates concurrent probes', async () => {
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = createDatabaseReadinessProbe(async () => { requests++; await gate; }, {
    cacheMs: 10_000, timeoutMs: 200
  });
  const first = probe();
  const second = probe();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(requests, 1);
  assert.equal(await probe(), true);
  assert.equal(requests, 1);
});

test('database failure is fail-closed and retryable without revealing driver errors', async () => {
  let requests = 0;
  const probe = createDatabaseReadinessProbe(async () => {
    requests++;
    if (requests === 1) throw new Error('postgresql://secret-password@private-host');
  }, { cacheMs: 0, timeoutMs: 200 });
  assert.equal(await probe(), false);
  assert.equal(await probe(), true);
  assert.equal(requests, 2);
});

test('a hanging database probe times out rather than reporting readiness', async () => {
  const probe = createDatabaseReadinessProbe(
    async () => new Promise<void>(() => {}),
    { cacheMs: 0, timeoutMs: 15 }
  );
  assert.equal(await probe(), false);
});
