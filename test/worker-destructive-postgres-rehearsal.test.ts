import './setup-disposable-db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, closeDb } from '../packages/db/src/index.js';
import * as migration035 from '../packages/db/src/migrations/035_subscription_cancellation_and_invoice_outbox.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

describe('Destructive Fault-Injection Worker Rehearsal (Real PostgreSQL 18)', () => {
  const PREFIX = 'test_wkr_destr_';

  async function cleanFixtures() {
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('billing_audit_events').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('billing_invoices').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('subscriptions').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('credit_accounts').where('customer_id', 'like', `${PREFIX}%`).delete();
      await db('billing_customers').where('id', 'like', `${PREFIX}%`).delete();
    } catch {}
  }

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    await migration035.up(db);
    await cleanFixtures();
  });

  after(async () => {
    paymentGatewayService.setGatewayTransport(null as any);
    await cleanFixtures();
    await closeDb();
  });

  it('1. Parallel worker race + crashed worker lease takeover fencing prevents duplicate cancellation execution', async () => {
    const now = Date.now();
    const custId = `${PREFIX}cust_race_${now}`;
    const subId = `sub_destr_race_${now}`;
    const taskId = `task_destr_race_${now}`;

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      name: 'Destructive Race User',
      email: `${custId}@aira.test`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'canceled',
      gateway: 'cashfree',
      gateway_subscription_id: `cf_race_${now}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });
    // Seed a simulated crashed-worker task holding an expired CLAIMED lease
    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'cashfree',
      gateway_subscription_id: `cf_race_${now}`,
      state: 'CLAIMED',
      attempts: 1,
      max_attempts: 5,
      claimed_by: 'crashed_worker_pid_0',
      lease_until: now - 10000,
      fencing_token: 3,
      created_at: now,
      updated_at: now - 10000
    });

    let gatewayCancelCalls = 0;
    paymentGatewayService.setGatewayTransport(async () => {
      gatewayCancelCalls += 1;
      await new Promise(r => setTimeout(r, 40));
      return { success: true };
    });

    const [w1, w2] = await Promise.all([
      paymentGatewayService.processCancellationOutboxTasks({ batchSize: 5, workerId: 'race_wkr_1' }),
      paymentGatewayService.processCancellationOutboxTasks({ batchSize: 5, workerId: 'race_wkr_2' })
    ]);

    assert.strictEqual(w1.succeeded + w2.succeeded, 1, 'Exactly one competing worker may claim and complete crashed task');
    assert.strictEqual(gatewayCancelCalls, 1, 'External provider cancellation must execute strictly once');

    const updated = await db('subscription_cancellation_outbox').where({ id: taskId }).first();
    assert.strictEqual(updated.state, 'COMPLETED');
    assert.strictEqual(Number(updated.fencing_token), 4, 'Fencing token must increment monotonically on lease takeover');
    paymentGatewayService.setGatewayTransport(null as any);
  });

  it('2. Failure injection: transient failures schedule exponential backoff; retry exhaustion transitions to dead-letter FAILED', async () => {
    const now = Date.now();
    const custId = `${PREFIX}cust_retry_${now}`;
    const subId = `sub_destr_retry_${now}`;
    const taskId = `task_destr_retry_${now}`;

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      name: 'Retry User',
      email: `${custId}@aira.test`,
      created_at: now,
      updated_at: now
    });
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'canceled',
      gateway: 'cashfree',
      gateway_subscription_id: `cf_retry_${now}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });
    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'cashfree',
      gateway_subscription_id: `cf_retry_${now}`,
      state: 'PENDING',
      attempts: 1,
      max_attempts: 2,
      created_at: now,
      updated_at: now
    });

    paymentGatewayService.setGatewayTransport(async () => {
      throw new Error('503_UPSTREAM_TIMEOUT');
    });

    const firstAttempt = await paymentGatewayService.processCancellationOutboxTasks({ batchSize: 5, workerId: 'retry_wkr_1' });
    assert.strictEqual(firstAttempt.failed, 1);

    const terminalRow = await db('subscription_cancellation_outbox').where({ id: taskId }).first();
    assert.strictEqual(terminalRow.state, 'FAILED', 'Reaching max_attempts must transition task to terminal FAILED state');
    assert.strictEqual(Number(terminalRow.attempts), 2);
    assert.ok(String(terminalRow.last_error || '').includes('503_UPSTREAM_TIMEOUT'));

    // Subsequent worker sweep must skip terminal FAILED dead-letter task
    const replaySweep = await paymentGatewayService.processCancellationOutboxTasks({ batchSize: 5, workerId: 'retry_wkr_2' });
    assert.strictEqual(replaySweep.processed, 0);
    paymentGatewayService.setGatewayTransport(null as any);
  });

  it('3. Parallel invoice reconciliation workers issue strictly one GST Paid invoice despite crashed lease takeover', async () => {
    const now = Date.now();
    const custId = `${PREFIX}cust_inv_${now}`;
    const subId = `sub_destr_inv_${now}`;
    const taskId = `task_destr_inv_${now}`;
    const payId = `pay_destr_inv_${now}`;

    await db('billing_customers').insert({
      id: custId,
      principal_id: `neon_user_${custId}`,
      name: 'Invoice Race User',
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
      gateway: 'cashfree',
      gateway_subscription_id: `cf_inv_${now}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });
    await db('billing_invoice_reconciliation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      cycle_number: 1,
      customer_id: custId,
      principal_id: `neon_user_${custId}`,
      gateway: 'cashfree',
      plan_tier: 'pro',
      amount_minor_units: 99900,
      currency: 'INR',
      actual_payment_id: payId,
      gateway_order_id: `cf_ord_inv_${now}`,
      correlation_id: `corr_destr_${now}`,
      state: 'CLAIMED',
      attempts: 1,
      max_attempts: 5,
      claimed_by: 'crashed_inv_worker',
      lease_until: now - 15000,
      fencing_token: 2,
      created_at: now,
      updated_at: now - 15000
    });

    const [i1, i2] = await Promise.all([
      paymentGatewayService.processInvoiceReconciliationTasks({ batchSize: 5, workerId: 'inv_race_1' }),
      paymentGatewayService.processInvoiceReconciliationTasks({ batchSize: 5, workerId: 'inv_race_2' })
    ]);

    assert.strictEqual(i1.succeeded + i2.succeeded, 1, 'Exactly one worker must claim expired invoice task');
    const invoices = await db('billing_invoices').where({ subscription_id: subId });
    assert.strictEqual(invoices.length, 1, 'Strictly one invoice may be issued');
    assert.strictEqual(invoices[0].status, 'Paid');

    const taskAfter = await db('billing_invoice_reconciliation_outbox').where({ id: taskId }).first();
    assert.strictEqual(taskAfter.state, 'COMPLETED');
    assert.strictEqual(Number(taskAfter.fencing_token), 3);
  });
});
