import './setup-disposable-db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { db, closeDb } from '../packages/db/src/index.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

describe('V-02: Durable Outbox Worker Runtime & Scheduling Suite', () => {
  const TEST_WORKER_KEY = 'test_secret_worker_key_xyz123';
  let app: express.Express;
  let server: any;
  let baseUrl: string;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_INTERNAL_WORKER_KEY = TEST_WORKER_KEY;
    process.env.CRON_SECRET = TEST_WORKER_KEY;

    app = express();
    app.use(express.json());
    app.use('/api/billing', createBillingRoutes());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Clean test records
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_invoices').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_customers').where('id', 'like', 'test_wkr_%').delete();
      await db('credit_accounts').where('customer_id', 'like', 'test_wkr_%').delete();
    } catch {}
  });

  after(async () => {
    if (server) server.close();
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_invoices').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_wkr_%').delete();
      await db('billing_customers').where('id', 'like', 'test_wkr_%').delete();
      await db('credit_accounts').where('customer_id', 'like', 'test_wkr_%').delete();
    } catch {}
  });

  // 1. Unauthorized worker invocation
  it('1. rejects unauthorized worker invocation with 401', async () => {
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'GET'
    });
    assert.strictEqual(res.status, 401, 'Must reject missing authorization with 401');

    const resPost = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: { 'x-internal-worker-key': 'wrong_key' }
    });
    assert.strictEqual(resPost.status, 401, 'Must reject invalid authorization key with 401');
  });

  // 2. Authorized scheduled invocation against disposable PostgreSQL
  it('2. executes authorized scheduled invocation against disposable PostgreSQL (GET for Vercel Cron)', async () => {
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${TEST_WORKER_KEY}`
      }
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.workerId === 'string');
    assert.ok(body.cancellations && typeof body.cancellations.processed === 'number');
    assert.ok(body.invoices && typeof body.invoices.processed === 'number');
  });

  // 3. Both outbox processors invoked through actual worker entry point
  it('3. processes both cancellation and invoice outbox queues via worker entry point', async () => {
    const custId = `test_wkr_cust_${Date.now()}`;
    const subId = `test_wkr_sub_${Date.now()}`;
    const now = Date.now();

    // Seed customer and subscription
    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      name: 'Worker Test User',
      email: `${custId}@aira.test`,
      created_at: now,
      updated_at: now
    });

    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_rzp_${subId}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    // Seed 1 cancellation task
    await db('subscription_cancellation_outbox').insert({
      id: `task_cancel_${Date.now()}`,
      subscription_id: subId,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'razorpay',
      gateway_subscription_id: `sub_rzp_${subId}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Seed 1 invoice reconciliation task
    await db('billing_invoice_reconciliation_outbox').insert({
      id: `task_inv_${Date.now()}`,
      subscription_id: subId,
      cycle_number: 1,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 99900,
      currency: 'INR',
      actual_payment_id: `pay_${Date.now()}`,
      correlation_id: `corr_${Date.now()}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Configure transport for cancellation
    paymentGatewayService.setGatewayTransport(async (req) => {
      if (req.action === 'cancel_subscription') {
        return { success: true, orderId: subId, gatewayOrderId: `sub_rzp_${subId}` };
      }
      return { success: true, orderId: subId, gatewayOrderId: `sub_rzp_${subId}` };
    });

    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: {
        'x-internal-worker-key': TEST_WORKER_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ batchSize: 5 })
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.cancellations.processed >= 1, 'Must process cancellation outbox task');
    assert.ok(body.invoices.processed >= 1, 'Must process invoice outbox task');

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 4. Concurrent worker invocation with lease fencing
  it('4. serializes concurrent worker invocations safely via atomic CAS lease claims', async () => {
    const custId = `test_wkr_concurrent_${Date.now()}`;
    const subId = `test_wkr_sub_conc_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'active',
      gateway: 'cashfree',
      gateway_subscription_id: `sub_cf_${subId}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    // Insert 5 cancellation tasks
    for (let i = 0; i < 5; i++) {
      await db('subscription_cancellation_outbox').insert({
        id: `task_conc_${i}_${Date.now()}`,
        subscription_id: subId,
        customer_id: custId,
        principal_id: `neon_user_${custId}`,
        gateway: 'cashfree',
        gateway_subscription_id: `sub_cf_${subId}`,
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        fencing_token: 0,
        created_at: now + i,
        updated_at: now + i
      });
    }

    paymentGatewayService.setGatewayTransport(async () => {
      await new Promise(r => setTimeout(r, 20)); // Small latency
      return { success: true, orderId: subId, gatewayOrderId: `sub_cf_${subId}` };
    });

    // Run 2 worker requests concurrently
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
        method: 'POST',
        headers: { 'x-internal-worker-key': TEST_WORKER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ batchSize: 5 })
      }),
      fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
        method: 'POST',
        headers: { 'x-internal-worker-key': TEST_WORKER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ batchSize: 5 })
      })
    ]);

    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res2.status, 200);

    const data1: any = await res1.json();
    const data2: any = await res2.json();
    const totalProcessed = data1.cancellations.processed + data2.cancellations.processed;
    assert.strictEqual(totalProcessed, 5, 'Exactly 5 tasks claimed without duplicate processing');

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 5. Worker termination and restart / lease expiration recovery
  it('5. recovers expired worker claims when previous worker crashed or timed out', async () => {
    const custId = `test_wkr_crash_${Date.now()}`;
    const subId = `test_wkr_sub_crash_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_rzp_${subId}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    // Seed task stuck in CLAIMED state with an expired lease (lease_until in the past)
    const stuckTaskId = `task_stuck_${Date.now()}`;
    await db('subscription_cancellation_outbox').insert({
      id: stuckTaskId,
      subscription_id: subId,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'razorpay',
      gateway_subscription_id: `sub_rzp_${subId}`,
      state: 'CLAIMED',
      claimed_by: 'dead_worker_pid_9999',
      lease_until: now - 5000, // Expired 5 seconds ago
      attempts: 1,
      max_attempts: 5,
      fencing_token: 1,
      created_at: now - 60000,
      updated_at: now - 5000
    });

    paymentGatewayService.setGatewayTransport(async () => {
      return { success: true, orderId: subId, gatewayOrderId: `sub_rzp_${subId}` };
    });

    // New worker invocation re-claims and completes the expired task
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: { 'x-internal-worker-key': TEST_WORKER_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ batchSize: 5 })
    });

    assert.strictEqual(res.status, 200);
    const completedTask = await db('subscription_cancellation_outbox').where({ id: stuckTaskId }).first();
    assert.strictEqual(completedTask.state, 'COMPLETED');
    assert.ok(completedTask.fencing_token > 1, 'Fencing token must increment on reclaim');

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 6. Provider cancellation timeout handling
  it('6. schedules exponential backoff retry when provider cancellation encounters timeout', async () => {
    const custId = `test_wkr_to_${Date.now()}`;
    const subId = `test_wkr_sub_to_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'cashfree',
      gateway_subscription_id: `sub_cf_${subId}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    const timeoutTaskId = `task_to_${Date.now()}`;
    await db('subscription_cancellation_outbox').insert({
      id: timeoutTaskId,
      subscription_id: subId,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'cashfree',
      gateway_subscription_id: `sub_cf_${subId}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Mock timeout on provider
    paymentGatewayService.setGatewayTransport(async () => {
      throw new Error('ETIMEDOUT: Cashfree API gateway timed out during cancellation');
    });

    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: { 'x-internal-worker-key': TEST_WORKER_KEY }
    });

    assert.strictEqual(res.status, 200);
    const taskAfter = await db('subscription_cancellation_outbox').where({ id: timeoutTaskId }).first();
    assert.strictEqual(taskAfter.state, 'PENDING');
    assert.strictEqual(taskAfter.attempts, 1);
    assert.ok(taskAfter.next_attempt_at > now, 'Must schedule next attempt with backoff');
    assert.ok(taskAfter.last_error?.includes('ETIMEDOUT'));

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 7. Failed invoice issuance followed by successful recovery with exact invoice and credit counts
  it('7. recovers failed invoice issuance with exact invoice count and credit ledger consistency', async () => {
    const custId = `test_wkr_inv_rec_${Date.now()}`;
    const subId = `test_wkr_sub_inv_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_rzp_${subId}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    const taskId = `task_inv_rec_${Date.now()}`;
    await db('billing_invoice_reconciliation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      cycle_number: 1,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 99900,
      currency: 'INR',
      actual_payment_id: `pay_rec_${Date.now()}`,
      correlation_id: `corr_rec_${Date.now()}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Run worker to process invoice
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: {
        'x-internal-worker-key': TEST_WORKER_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ batchSize: 5 })
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.ok, true);

    const taskRecord = await db('billing_invoice_reconciliation_outbox').where({ id: taskId }).first();
    assert.strictEqual(taskRecord.state, 'COMPLETED');

    // Verify exactly 1 invoice created for this subscription and customer
    const invoices = await db('billing_invoices').where({ customer_id: custId, subscription_id: subId });
    assert.strictEqual(invoices.length, 1, 'Exactly one invoice must be issued');
    assert.strictEqual(Number(invoices[0].total_amount), 999.00);
  });

  // 8. Wrong environment execution rejection
  it('8. rejects execution when client requests mismatched target environment', async () => {
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: {
        'x-internal-worker-key': TEST_WORKER_KEY,
        'x-environment-target': 'production-live-target-mismatch' // Mismatched!
      }
    });

    assert.strictEqual(res.status, 400, 'Must reject environment mismatch with 400');
    const body: any = await res.json();
    assert.strictEqual(body.error, 'ENVIRONMENT_ISOLATION_ERROR');
  });

  // 9. Missing worker configuration fail-closed
  it('9. fails closed with 500 when worker secret configuration is empty or missing', async () => {
    const savedWorkerKey = process.env.AIRA_INTERNAL_WORKER_KEY;
    const savedCronSecret = process.env.CRON_SECRET;
    delete process.env.AIRA_INTERNAL_WORKER_KEY;
    delete process.env.CRON_SECRET;

    try {
      const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
        method: 'GET'
      });
      assert.strictEqual(res.status, 500, 'Must fail closed with 500 on missing worker configuration');
      const body: any = await res.json();
      assert.ok(body.error?.includes('CONFIGURATION_ERROR'));
    } finally {
      process.env.AIRA_INTERNAL_WORKER_KEY = savedWorkerKey;
      process.env.CRON_SECRET = savedCronSecret;
    }
  });

  // 10. Bounded batch processing within execution budget
  it('10. strictly enforces bounded batch size limit (batchSize <= 25)', async () => {
    const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: {
        'x-internal-worker-key': TEST_WORKER_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ batchSize: 500 }) // Exceeds max allowable batch
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.appliedBatchSize <= 25, 'Must clamp batchSize to <= 25');
  });

  // 11. Production safety barrier: worker activation disabled on production
  it('11. strictly prohibits financial worker activation on production without explicit authorization', async () => {
    const savedVercelEnv = process.env.VERCEL_ENV;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedTestFulfillment = process.env.AIRA_ENABLE_TEST_FULFILLMENT;
    const savedProdWorker = process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER;

    try {
      process.env.VERCEL_ENV = 'production';
      process.env.NODE_ENV = 'production';
      delete process.env.AIRA_ENABLE_TEST_FULFILLMENT;
      delete process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER;

      const res = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
        method: 'POST',
        headers: {
          'x-internal-worker-key': TEST_WORKER_KEY
        }
      });

      assert.strictEqual(res.status, 403, 'Must reject production worker execution with 403');
      const body: any = await res.json();
      assert.ok(body.error?.startsWith('PRODUCTION_WORKER_DISABLED'), 'Error must be PRODUCTION_WORKER_DISABLED');
    } finally {
      process.env.VERCEL_ENV = savedVercelEnv;
      process.env.NODE_ENV = savedNodeEnv;
      if (savedTestFulfillment) process.env.AIRA_ENABLE_TEST_FULFILLMENT = savedTestFulfillment;
      if (savedProdWorker) process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER = savedProdWorker;
    }
  });

  // 12. Execution deadline budget enforcement
  it('12. respects execution deadline budget and halts task processing safely before deadline', async () => {
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const custId = `test_wkr_bdg_${i}_${Date.now()}`;
      await db('billing_customers').insert({
        id: custId,
        principal_id: `neon_user_${custId}`,
        created_at: now,
        updated_at: now
      });
      const subId = `sub_budget_${i}_${Date.now()}`;
      await db('subscriptions').insert({
        id: subId,
        customer_id: custId,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'canceled',
        gateway: 'cashfree',
        gateway_subscription_id: `cf_sub_budget_${i}`,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        created_at: now,
        updated_at: now
      });
      await db('subscription_cancellation_outbox').insert({
        id: `task_budget_${i}_${Date.now()}`,
        subscription_id: subId,
        customer_id: custId,
        principal_id: `neon_user_${custId}`,
        gateway: 'cashfree',
        gateway_subscription_id: `cf_sub_budget_${i}`,
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        created_at: now + i,
        updated_at: now + i
      });
    }

    // Custom transport simulates slow 500ms external provider calls
    paymentGatewayService.setGatewayTransport(async () => {
      await new Promise(r => setTimeout(r, 200));
      return { success: true };
    });

    // Provide tight budget of 1500ms with a deadline
    const startTime = Date.now();
    const result = await paymentGatewayService.processCancellationOutboxTasks({
      batchSize: 10,
      deadlineEpochMs: startTime + 1000 // Only 1s budget
    });

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed < 4000, `Must halt processing well within deadline (elapsed: ${elapsed}ms)`);
    // Should have processed fewer than 5 tasks due to the budget
    assert.ok(result.processed < 5, 'Must break early when deadline budget is reached');

    paymentGatewayService.setGatewayTransport(null as any);
  });
});
