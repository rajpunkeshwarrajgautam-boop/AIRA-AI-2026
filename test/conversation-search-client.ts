import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { composeRequestSignal } from '../src/utils/conversationSearch.js';

async function main() {
  const superseded = new AbortController();
  const cancelled = composeRequestSignal(superseded.signal, 12_000);
  assert.equal(cancelled.aborted, false);
  superseded.abort('obsolete-query');
  assert.equal(cancelled.aborted, true, 'superseding an overlay query must abort the request');

  const caller = new AbortController();
  const deadline = composeRequestSignal(caller.signal, 20);
  await sleep(60);
  assert.equal(deadline.aborted, true, 'timeout must fire even when caller signal is present');
  assert.equal(caller.signal.aborted, false, 'deadline must not abort the owner controller');

  const timeoutOnly = composeRequestSignal(undefined, 20);
  await sleep(60);
  assert.equal(timeoutOnly.aborted, true, 'normal requests must also enforce timeouts');

  console.log('PASS: stale search queries are cancelled');
  console.log('PASS: deadline is enforced alongside an external AbortSignal');
  console.log('PASS: requests without an external AbortSignal still time out');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
