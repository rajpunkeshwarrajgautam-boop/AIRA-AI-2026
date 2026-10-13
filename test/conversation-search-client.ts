import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { composeRequestSignal, syncConversationToServer } from '../src/utils/conversationSearch.js';
import { isTemporaryDatabaseError } from '../apps/api/src/utils/storage-errors.js';

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

  assert.equal(isTemporaryDatabaseError(new Error('Knex: Timeout acquiring a connection. The pool is probably full.')), true);
  assert.equal(isTemporaryDatabaseError(Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTemporaryDatabaseError(new Error('Invalid conversation title')), false);

  const originalFetch = globalThis.fetch;
  let syncRequests = 0;
  let mode: 'transient' | 'forbidden' = 'transient';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const route = String(input);
    if (route === '/api/auth/session') return Response.json({}, { status: 200 });
    if (route !== '/api/conversations/sync') throw new Error('Unexpected test request');
    syncRequests++;
    if (mode === 'forbidden') return Response.json({ error: 'Forbidden' }, { status: 403 });
    if (syncRequests === 1) {
      return Response.json({ code: 'CONVERSATION_STORAGE_TEMPORARILY_UNAVAILABLE' }, {
        status: 503,
        headers: { 'Retry-After': '1' }
      });
    }
    return Response.json({ status: 'SYNCED' }, { status: 200 });
  }) as typeof fetch;
  try {
    const sampleConversation = {
      id: 'client-retry-qa',
      title: 'Transient storage test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    } as any;

    assert.equal(await syncConversationToServer(sampleConversation), true,
      'idempotent sync must recover from one temporary HTTP 503');
    assert.equal(syncRequests, 2, 'exactly one retry should occur');

    mode = 'forbidden';
    syncRequests = 0;
    assert.equal(await syncConversationToServer(sampleConversation), false,
      'nonretryable authorization error must fail');
    assert.equal(syncRequests, 1, 'authorization errors must not be retried');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('PASS: stale search queries are cancelled');
  console.log('PASS: deadline is enforced alongside an external AbortSignal');
  console.log('PASS: requests without an external AbortSignal still time out');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
