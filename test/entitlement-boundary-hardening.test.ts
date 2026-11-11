import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousWorkerHost } from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { InMemoryAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

const forgedProTask = {
  taskId: 'task_forged_paid_1',
  principal: { userId: 'usr_not_subscribed', sessionId: 's', workspaceId: 'w', roles: ['admin'], scopes: ['*'], tier: 'pro' },
  objective: 'Never execute without a paid subscription',
  state: 'CREATED',
  observations: [], artifacts: [], workingMemory: {}, fencingToken: 1,
  createdAt: Date.now(), updatedAt: Date.now()
};

test('forged Pro in a serialized autonomous principal cannot bypass a verified Free subscription', async () => {
  let executed = 0;
  let state: string | undefined;
  const repo: any = { updateState: async (_id: string, nextState: string) => { state = nextState; } };
  const engine: any = { executeAutonomousTask: async () => { executed++; } };
  const worker = new AutonomousWorkerHost(repo, engine, {
    resolveCurrentTier: async () => 'free'
  });
  await (worker as any).processTask(forgedProTask);
  assert.equal(executed, 0);
  assert.equal(state, 'FAILED');
});

test('autonomous worker cannot run when subscription lookup is unavailable', async () => {
  let executed = 0;
  let stateUpdates = 0;
  let unavailable = false;
  const repo: any = { updateState: async () => { stateUpdates++; } };
  const worker = new AutonomousWorkerHost(repo, {
    executeAutonomousTask: async () => { executed++; }
  } as any, {
    resolveCurrentTier: async () => { throw new Error('database offline'); }
  });
  worker.on('worker.error', (e: any) => { unavailable ||= e.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE'; });
  await (worker as any).processTask(forgedProTask);
  assert.equal(executed, 0);
  assert.equal(stateUpdates, 0, 'Do not permanently fail a valid paid task on a temporary outage');
  assert.equal(unavailable, true);
});

test('direct autonomous engine entry points also reject revoked subscriptions', async () => {
  const repository = new InMemoryAutonomousTaskRepository();
  const engine = new AutonomousAgentEngine({ repository, resolveCurrentTier: async () => 'free' });
  const task = await engine.createTask('Attempt to resume a revoked paid task', forgedProTask.principal as any);
  await assert.rejects(() => engine.startTask(task.taskId), /PLAN_CAPABILITY_RESTRICTED/);
  await assert.rejects(() => engine.resumeTask(task.taskId), /PLAN_CAPABILITY_RESTRICTED/);
  await assert.rejects(() => engine.recoverTask(task.taskId), /PLAN_CAPABILITY_RESTRICTED/);
  assert.equal((await repository.getTask(task.taskId))?.state, 'CREATED');
});

test('direct tool gateway ignores forged Pro and resolves the current plan', async () => {
  const principal: any = forgedProTask.principal;
  const invocation = (toolName: string) => ({
    toolName, arguments: toolName === 'python_sandbox' ? { code: 'print(1)' } : { url: 'https://example.com' },
    context: { runId: 'run_boundary_test', principal }
  });

  const gateway = new ToolGateway(new InMemoryToolCallRepository(), undefined, process.cwd(), undefined, undefined, async () => 'free');
  for (const name of ['browser_navigate', 'python_sandbox']) {
    const result = await gateway.execute(invocation(name));
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'PLAN_TOOL_RESTRICTED');
  }

  const offlineGateway = new ToolGateway(new InMemoryToolCallRepository(), undefined, process.cwd(), undefined, undefined, async () => { throw new Error('DB offline'); });
  const result = await offlineGateway.execute(invocation('browser_navigate'));
  assert.equal(result.errorCode, 'ENTITLEMENT_SERVICE_UNAVAILABLE');
});

test('sandbox checkout cannot fabricate a payment order, even with live-looking credentials', async () => {
  const priorKey = process.env.RAZORPAY_KEY_ID;
  try {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_dummy_for_test';
    await assert.rejects(() => paymentGatewayService.createSubscriptionCheckout('usr', 'pro'), /BILLING_UNAVAILABLE/);
  } finally {
    if (priorKey === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = priorKey;
  }
});

test('sandbox billing does not fabricate paid invoice numbers from subscription rows', async () => {
  assert.deepEqual(await paymentGatewayService.getInvoices('usr_preview'), []);
});

test('signed-webhook fulfillment cannot elevate a tier from unverified merchant notes', async () => {
  await assert.rejects(() => (paymentGatewayService as any).handleGatewayEvent('razorpay', 'subscription.activated', {
    payload: { subscription: { entity: { notes: { principal_id: 'usr', plan_tier: 'pro' } } } }
  }), /BILLING_UNAVAILABLE/);
});

test('webhooks cannot use a built-in default HMAC secret to change account state', () => {
  assert.equal(paymentGatewayService.verifyRazorpayWebhook('{"event":"subscription.cancelled"}', 'forged-signature').valid, false);
  assert.equal(paymentGatewayService.verifyCashfreeWebhook('{"type":"subscription.cancelled"}', 'forged-signature', '123').valid, false);
});

test('invalid chat idempotency keys are rejected before any database access', async () => {
  await assert.rejects(() => commercialBillingService.reserveStandardChat('usr', 'free', 'aira-fast', 'short'), /Invalid chat idempotency key/);
});
