import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchRunApproval } from '../src/utils/approvalDispatch';

test('a successful backend acknowledgement resolves the approval', async () => {
  let called = 0;
  await dispatchRunApproval('run_a', 'approval_a', 'APPROVE', async (url, init) => {
    called++;
    assert.equal(url, '/api/runs/run_a/approve');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId: 'approval_a', decision: 'APPROVE' });
    return new Response(JSON.stringify({ status: 'DECISION_RECORDED' }), { status: 200 });
  });
  assert.equal(called, 1);
});

test('HTTP rejection never masquerades as an approved execution', async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    await assert.rejects(
      dispatchRunApproval('run_a', 'approval_a', 'APPROVE', async () => new Response('', { status })),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test('network failures and absent identifiers reject without optimistic confirmation', async () => {
  await assert.rejects(dispatchRunApproval('run_a', 'approval_a', 'REJECT', async () => {
    throw new Error('network unavailable');
  }), /network unavailable/);

  let dispatched = false;
  await assert.rejects(dispatchRunApproval(undefined, 'approval_a', 'APPROVE', async () => {
    dispatched = true;
    return new Response('', { status: 200 });
  }), /active run/);
  await assert.rejects(dispatchRunApproval('run_a', '', 'APPROVE', async () => {
    dispatched = true;
    return new Response('', { status: 200 });
  }), /pending approval/);
  assert.equal(dispatched, false);
});
