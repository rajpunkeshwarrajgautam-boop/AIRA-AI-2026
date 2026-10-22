import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelIdentifier, ModelPolicySchema } from '../packages/contracts/src/index.js';
import { ModelRouter, PrivateBetaCapacityGuard, InMemoryCapacityStore, protectInferenceAdapter, withInferencePrincipal, withInferenceReservation, type ModelAdapter } from '../packages/model-router/src/index.js';

const policy = (model: any) => ModelPolicySchema.parse({ model });
const result = { text: 'real provider replaced only for deterministic boundary regression', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
function adapter(action: (signal?: AbortSignal) => Promise<typeof result>): ModelAdapter {
  return { provider: 'groq', complete: (_m, _p, signal) => action(signal), stream: async (_m, _p, chunk, opts) => { const r = await action(opts?.signal); chunk({ text: r.text }); return r; } };
}
const messages = [{ role: 'user' as const, content: 'Reply OK' }];

test('legacy aliases and canonical IDs share one allowlist; malformed IDs fail before admission', async () => {
  for (const [legacy, canonical] of [['claude-3-7-sonnet','aira-auto'],['claude-3-5-haiku','aira-fast'],['claude-3-5-sonnet','aira-pro'],['claude-3-opus','aira-deep']]) assert.equal(normalizeModelIdentifier(legacy), canonical);
  assert.equal(normalizeModelIdentifier(), 'aira-auto');
  const store = new InMemoryCapacityStore();
  const guard = new PrivateBetaCapacityGuard({}, store);
  for (const id of ['aira-auto','aira-fast','claude-3-7-sonnet','claude-3-5-haiku','openai/gpt-oss-120b']) {
    const admission = await guard.admit({ principalId: id, model: id });
    assert.ok(admission.permit, `${id} must reserve capacity`);
    await admission.permit.release();
  }
  for (const bad of ['', 'AIRa-fast', ' aira-fast', 'constructor', '__proto__', 'unknown-model', 'allam-2-7b', 'gemini-2-5-flash', null, {}, [], 42]) {
    assert.throws(() => normalizeModelIdentifier(bad), /Unsupported model/);
    await assert.rejects(guard.admit({ principalId: 'bad', model: bad as any }), /Unsupported model/);
  }
  assert.equal(await store.getActiveConcurrency('global'), 0);
  assert.equal(new PrivateBetaCapacityGuard().isFastTarget('aira-fast', 'RESEARCH'), true, 'Explicit Fast cannot evade admission through intent');
  assert.equal(guard.isFastTarget('aira-auto','RESEARCH'), false, 'Auto research retains Deep policy');
  assert.equal(guard.isFastTarget('aira-pro'), false);
});

test('routed complete and stream calls enforce canonical per-user quota across independent guards', async () => {
  const store = new InMemoryCapacityStore();
  const guards = [new PrivateBetaCapacityGuard({ perUserRpm: 1 }, store), new PrivateBetaCapacityGuard({ perUserRpm: 1 }, store)];
  let calls = 0;
  const raw = adapter(async () => { calls++; return result; });
  await withInferencePrincipal('user-a', () => protectInferenceAdapter(raw, guards[0]).complete(messages, policy('claude-3-5-haiku')));
  await assert.rejects(withInferencePrincipal('user-a', () => protectInferenceAdapter(raw, guards[1]).stream(messages, policy('aira-fast'), () => {})), /per-user request limit/);
  await withInferencePrincipal('user-b', () => protectInferenceAdapter(raw, guards[1]).complete(messages, policy('openai/gpt-oss-120b')));
  assert.equal(calls, 2);
  assert.equal(await store.getCurrentRpm('global', 'system'), 2);
  assert.equal(await store.getActiveConcurrency('global'), 0);
});

test('concurrent inference keeps principal concurrency and releases failed reservations', async () => {
  const store = new InMemoryCapacityStore();
  const guard = new PrivateBetaCapacityGuard({}, store);
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const raw = adapter(async () => { entered(); await new Promise<void>(resolve => { unblock = resolve; }); return result; });
  const wrapped = protectInferenceAdapter(raw, guard);
  const first = withInferencePrincipal('same-user', () => wrapped.complete(messages, policy('aira-fast')));
  await started;
  await assert.rejects(withInferencePrincipal('same-user', () => wrapped.complete(messages, policy('claude-3-5-haiku'))), /active request/);
  unblock(); await first;
  const failing = protectInferenceAdapter(adapter(async () => { throw new Error('UPSTREAM_FAILED'); }), guard);
  await assert.rejects(withInferencePrincipal('same-user', () => failing.complete(messages, policy('aira-fast'))), /UPSTREAM_FAILED/);
  assert.equal(await store.getActiveConcurrency('global'), 0);
  assert.equal(await store.getActiveConcurrency('user','same-user'), 0);
});

test('chat-owned reservation is not double charged and cannot cross principals', async () => {
  const store = new InMemoryCapacityStore();
  const guard = new PrivateBetaCapacityGuard({ perUserRpm: 1 }, store);
  const admission = await guard.admit({ principalId: 'owner', model: 'claude-3-7-sonnet' });
  const wrapped = protectInferenceAdapter(adapter(async () => result), guard);
  await withInferencePrincipal('owner', () => withInferenceReservation(guard, admission, () => wrapped.complete(messages, policy('aira-fast'))));
  assert.equal(await store.getCurrentRpm('user','owner'), 1);
  assert.throws(() => withInferencePrincipal('other', () => withInferenceReservation(guard, admission, () => null)), /PRINCIPAL_MISMATCH/);
  await admission.permit!.release();
});

test('dequeue serialization releases an admission orphaned by abort during database work', async () => {
  class DelayedStore extends InMemoryCapacityStore {
    delay = false;
    entered!: () => void;
    unblock!: () => void;
    override async atomicAdmit(req: Parameters<InMemoryCapacityStore['atomicAdmit']>[0]) {
      if (this.delay) { this.entered(); await new Promise<void>(resolve => { this.unblock = resolve; }); }
      return super.atomicAdmit(req);
    }
  }
  const store = new DelayedStore();
  const guard = new PrivateBetaCapacityGuard({ globalMaxConcurrent: 1 }, store);
  const held = await guard.admit({ principalId: 'held', model: 'aira-fast' });
  const controller = new AbortController();
  const queued = guard.admit({ principalId: 'queued', model: 'aira-fast', abortSignal: controller.signal });
  const rejected = assert.rejects(queued, /CANCELLED_TEST/);
  while (guard.getQueueDepth() === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const entered = new Promise<void>(resolve => { store.entered = resolve; });
  store.delay = true;
  const processing = guard.processNextQueued();
  await entered;
  await guard.processNextQueued(); // Must not start a second DB admission.
  controller.abort(new Error('CANCELLED_TEST'));
  store.unblock(); await processing; await rejected;
  store.delay = false;
  await held.permit!.release();
  assert.equal(guard.getQueueDepth(), 0);
  assert.equal(await store.getActiveConcurrency('global'), 0);
});

test('hosted inference without verified identity fails closed before provider call', async () => {
  const before = process.env.VERCEL;
  process.env.VERCEL = '1';
  let calls = 0;
  try {
    const wrapped = protectInferenceAdapter(adapter(async () => { calls++; return result; }), new PrivateBetaCapacityGuard());
    await assert.rejects(wrapped.complete(messages, policy('aira-fast')), /INFERENCE_PRINCIPAL_REQUIRED/);
    assert.equal(calls, 0);
  } finally { if (before === undefined) delete process.env.VERCEL; else process.env.VERCEL = before; }
});

test('released reservations cannot authorize later background inference', async () => {
  const store = new InMemoryCapacityStore();
  const guard = new PrivateBetaCapacityGuard({ perUserRpm: 1 }, store);
  const admission = await guard.admit({ principalId: 'released-owner', model: 'aira-fast' });
  await withInferencePrincipal('released-owner', () => withInferenceReservation(guard, admission, async () => {
    await admission.permit!.release();
    await assert.rejects(protectInferenceAdapter(adapter(async () => result), guard).complete(messages, policy('aira-fast')), /per-user request limit/);
  }));
  assert.equal(await store.getActiveConcurrency('global'), 0);
});

test('abort during queue notification never registers an orphan queue item', async () => {
  const guard = new PrivateBetaCapacityGuard({ globalMaxConcurrent: 1 }, new InMemoryCapacityStore());
  const held = await guard.admit({ principalId: 'held', model: 'aira-fast' });
  const controller = new AbortController();
  await assert.rejects(guard.admit({ principalId: 'waiter', model: 'aira-fast', abortSignal: controller.signal }, () => controller.abort(new Error('QUEUE_NOTIFY_CANCEL'))), /QUEUE_NOTIFY_CANCEL/);
  assert.equal(guard.getQueueDepth(), 0);
  await held.permit!.release();
});

test('chat cancellation signal reaches inference inside an already acquired reservation', async () => {
  const store = new InMemoryCapacityStore();
  const guard = new PrivateBetaCapacityGuard({}, store);
  const admission = await guard.admit({ principalId: 'closing-user', model: 'aira-fast' });
  const controller = new AbortController();
  controller.abort(new Error('CLIENT_CLOSED_DURING_CREATE'));
  let called = false;
  try {
    await assert.rejects(withInferencePrincipal('closing-user', () => withInferenceReservation(guard, admission, () => protectInferenceAdapter(adapter(async () => { called = true; return result; }), guard).complete(messages, policy('aira-fast')), controller.signal)), /CLIENT_CLOSED_DURING_CREATE/);
    assert.equal(called, false);
  } finally { await admission.permit!.release(); }
  assert.equal(await store.getActiveConcurrency('global'), 0);
});


test('direct Gemini allowlisted IDs select their exact provider model behind admission', () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'deterministic-routing-only-key';
  try {
    const guard = new PrivateBetaCapacityGuard({}, new InMemoryCapacityStore());
    const router = new ModelRouter(undefined, guard);
    for (const [id, providerModel] of [['gemini-3.5-flash-lite','gemini-3.5-flash-lite'],['gemini-2-5-pro','gemini-2.5-pro']] as const) {
      const execution = router.resolveExecution(id);
      assert.equal(execution.executedProvider, 'gemini');
      assert.equal(execution.executedModel, providerModel);
      assert.equal((execution.adapter as any).modelName, providerModel);
      assert.equal(guard.isFastTarget(execution.policy.model), true);
    }
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});
