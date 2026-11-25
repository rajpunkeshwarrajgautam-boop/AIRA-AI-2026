import './setup-disposable-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, closeDb } from '../packages/db/src/index.js';
import * as migration035 from '../packages/db/src/migrations/035_subscription_cancellation_and_invoice_outbox.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

test.describe('AIRA ONE — Migration 035 & Real PostgreSQL 18 Outbox Rehearsal', () => {

  const originalEnv = { ...process.env };

  test.before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.CASHFREE_APP_ID = 'cf_test_rehearsal';
    process.env.CASHFREE_SECRET_KEY = 'cf_test_rehearsal_secret';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_rehearsal';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_rehearsal_secret';

    // Ensure clean state for test customers and outbox tables
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_invoices').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_audit_events').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('idempotent_operations').where('principal_id', 'like', 'test_outbox_%').delete();
      await db('idempotent_operations').where('key', 'like', '%test_outbox%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_customers').where('id', 'like', 'test_outbox_%').delete();
    } catch {}
  });

  test.after(async () => {
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_invoices').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_audit_events').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('idempotent_operations').where('principal_id', 'like', 'test_outbox_%').delete();
      await db('idempotent_operations').where('key', 'like', '%test_outbox%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_outbox_%').delete();
      await db('billing_customers').where('id', 'like', 'test_outbox_%').delete();
    } catch {}
    process.env = { ...originalEnv };
    await closeDb();
  });

  test('GATE 1: Verify PostgreSQL 18.x Engine Identity on aira_test_db', async () => {
    const res = await db.raw(
      "SELECT version() AS version, current_database() AS db_name, current_user AS db_user, current_setting('server_version') AS server_version"
    );
    const row = res.rows[0];
    console.log(`\n  Engine:   ${row.version.split(' on ')[0]}`);
    console.log(`  Database: ${row.db_name}`);
    console.log(`  User:     ${row.db_user}`);
    console.log(`  Version:  ${row.server_version}`);

    assert.ok(row.version.toLowerCase().includes('postgresql 18'), 'Engine must be PostgreSQL 18.x');
    assert.strictEqual(row.db_name, 'aira_test_db', 'Must connect exclusively to disposable aira_test_db');
  });

  test('GATE 2: Migration 035 Up — Creates Outbox Tables and Indices in Real PostgreSQL 18', async () => {
    await migration035.up(db);

    const hasSubCancel = await db.schema.hasTable('subscription_cancellation_outbox');
    assert.strictEqual(hasSubCancel, true, 'subscription_cancellation_outbox must exist');

    const hasInvRecon = await db.schema.hasTable('billing_invoice_reconciliation_outbox');
    assert.strictEqual(hasInvRecon, true, 'billing_invoice_reconciliation_outbox must exist');

    // Verify index existence via pg_indexes catalog
    const indices = await db.raw(`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE tablename IN ('subscription_cancellation_outbox', 'billing_invoice_reconciliation_outbox')
    `);
    const indexNames = indices.rows.map((r: any) => r.indexname);
    assert.ok(indexNames.includes('idx_sub_cancel_outbox_claim'), 'Claim index on cancellation outbox must exist');
    assert.ok(indexNames.includes('idx_inv_recon_outbox_claim'), 'Claim index on invoice outbox must exist');
    assert.ok(indexNames.includes('uniq_inv_recon_outbox_sub_cycle'), 'Unique (sub, cycle) index must exist');
  });

  test('GATE 3: Real Database Unique Constraint Enforcement on Invoice Reconciliation Outbox', async () => {
    const customerId = 'test_outbox_cust_uniq';
    const subId = 'sub_outbox_uniq_test';
    const now = Date.now();

    // Clean previous
    await db('billing_invoice_reconciliation_outbox').where({ subscription_id: subId }).delete();

    // First insert succeeds
    await db('billing_invoice_reconciliation_outbox').insert({
      id: `task_inv_${crypto.randomUUID().replace(/-/g, '')}`,
      subscription_id: subId,
      cycle_number: 1,
      customer_id: customerId,
      principal_id: customerId,
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 290000,
      currency: 'INR',
      actual_payment_id: 'pay_test_001',
      gateway_order_id: 'order_test_001',
      correlation_id: `corr_${crypto.randomUUID().replace(/-/g, '')}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Duplicate insert for same (subscription_id, cycle_number) MUST fail with 23505
    await assert.rejects(
      async () => {
        await db('billing_invoice_reconciliation_outbox').insert({
          id: `task_inv_dup_${crypto.randomUUID().replace(/-/g, '')}`,
          subscription_id: subId,
          cycle_number: 1, // Same cycle number!
          customer_id: customerId,
          principal_id: customerId,
          gateway: 'razorpay',
          plan_tier: 'pro',
          amount_minor_units: 290000,
          currency: 'INR',
          actual_payment_id: 'pay_test_002',
          gateway_order_id: 'order_test_002',
          correlation_id: `corr_dup_${crypto.randomUUID().replace(/-/g, '')}`,
          state: 'PENDING',
          attempts: 0,
          max_attempts: 5,
          fencing_token: 0,
          created_at: now,
          updated_at: now
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, '23505', 'PostgreSQL error code must be 23505 (unique_violation)');
        assert.ok(err.message.includes('uniq_inv_recon_outbox_sub_cycle'), 'Error must reference unique constraint');
        return true;
      }
    );

    // Different cycle number succeeds
    await db('billing_invoice_reconciliation_outbox').insert({
      id: `task_inv_cycle2_${crypto.randomUUID().replace(/-/g, '')}`,
      subscription_id: subId,
      cycle_number: 2,
      customer_id: customerId,
      principal_id: customerId,
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 290000,
      currency: 'INR',
      actual_payment_id: 'pay_test_003',
      gateway_order_id: 'order_test_003',
      correlation_id: `corr_cycle2_${crypto.randomUUID().replace(/-/g, '')}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    const rows = await db('billing_invoice_reconciliation_outbox').where({ subscription_id: subId });
    assert.strictEqual(rows.length, 2, 'Must have exactly 2 distinct cycle tasks');

    // Clean up GATE 3 test rows
    await db('billing_invoice_reconciliation_outbox').where({ subscription_id: subId }).delete();
  });

  test('GATE 4: Check Constraint Validation on Invalid Outbox States', async () => {
    const now = Date.now();

    await assert.rejects(
      async () => {
        await db('subscription_cancellation_outbox').insert({
          id: `task_bad_state_${now}`,
          subscription_id: 'sub_bad_state',
          customer_id: 'cust_bad_state',
          principal_id: 'cust_bad_state',
          gateway: 'cashfree',
          gateway_subscription_id: 'cf_sub_bad',
          state: 'INVALID_STATE_XYZ',
          created_at: now,
          updated_at: now
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, '23514', 'PostgreSQL error code must be 23514 (check_violation)');
        return true;
      }
    );
  });

  test('GATE 5: Worker Atomic Claim and Fencing Token Increment in Real PostgreSQL', async () => {
    const customerId = 'test_outbox_cust_claim';
    const subId = 'sub_outbox_claim_1';
    const now = Date.now();
    const taskId = `task_claim_${crypto.randomUUID().replace(/-/g, '')}`;

    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      customer_id: customerId,
      principal_id: customerId,
      gateway: 'cashfree',
      gateway_subscription_id: 'cf_sub_claim_1',
      replacement_subscription_id: 'cf_sub_claim_2',
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 10,
      created_at: now,
      updated_at: now
    });

    // Worker 1 claims task atomically
    const leaseDurationMs = 30000;
    const claimedUntil = now + leaseDurationMs;
    const worker1 = 'worker_test_alpha';

    const claimResult = await db.raw(`
      UPDATE subscription_cancellation_outbox
      SET state = 'CLAIMED',
          claimed_by = ?,
          lease_until = ?,
          fencing_token = fencing_token + 1,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id IN (
        SELECT id FROM subscription_cancellation_outbox
        WHERE id = ? AND (state = 'PENDING' OR (state = 'CLAIMED' AND lease_until < ?))
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [worker1, claimedUntil, now, taskId, now]);

    assert.strictEqual(claimResult.rows.length, 1, 'Worker 1 must claim exactly 1 task');
    const claimedTask = claimResult.rows[0];
    assert.strictEqual(claimedTask.state, 'CLAIMED');
    assert.strictEqual(claimedTask.claimed_by, worker1);
    assert.strictEqual(claimedTask.fencing_token, '11', 'Fencing token must advance to 11');
    assert.strictEqual(claimedTask.attempts, 1);

    // Worker 2 attempts concurrent claim on active lease: must return 0 rows
    const worker2 = 'worker_test_beta';
    const claimResult2 = await db.raw(`
      UPDATE subscription_cancellation_outbox
      SET state = 'CLAIMED',
          claimed_by = ?,
          lease_until = ?,
          fencing_token = fencing_token + 1,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id IN (
        SELECT id FROM subscription_cancellation_outbox
        WHERE id = ? AND (state = 'PENDING' OR (state = 'CLAIMED' AND lease_until < ?))
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [worker2, claimedUntil, now, taskId, now]);

    assert.strictEqual(claimResult2.rows.length, 0, 'Worker 2 must NOT claim already claimed task with active lease');

    // Complete task so outbox is clean
    await db('subscription_cancellation_outbox')
      .where({ id: taskId })
      .update({
        state: 'COMPLETED',
        completed_at: now,
        updated_at: now
      });
  });

  test('GATE 6: Worker Lease Expiration and Stale Worker Fencing in Real PostgreSQL', async () => {
    const customerId = 'test_outbox_cust_lease';
    const subId = 'sub_outbox_lease_1';
    const now = Date.now();
    const taskId = `task_expired_lease_${crypto.randomUUID().replace(/-/g, '')}`;

    // Insert task whose lease expired 10 seconds ago
    const expiredLease = now - 10000;
    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      customer_id: customerId,
      principal_id: customerId,
      gateway: 'razorpay',
      gateway_subscription_id: 'sub_rzp_expired_1',
      state: 'CLAIMED',
      claimed_by: 'worker_crashed',
      lease_until: expiredLease,
      fencing_token: 5,
      attempts: 1,
      max_attempts: 5,
      created_at: now - 60000,
      updated_at: expiredLease
    });

    // Secondary worker takes over the expired lease
    const newWorker = 'worker_healthy_takeover';
    const newLease = now + 30000;
    const takeoverResult = await db.raw(`
      UPDATE subscription_cancellation_outbox
      SET state = 'CLAIMED',
          claimed_by = ?,
          lease_until = ?,
          fencing_token = fencing_token + 1,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id IN (
        SELECT id FROM subscription_cancellation_outbox
        WHERE id = ? AND (state = 'PENDING' OR (state = 'CLAIMED' AND lease_until < ?))
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [newWorker, newLease, now, taskId, now]);

    assert.strictEqual(takeoverResult.rows.length, 1, 'Healthy worker must take over expired task');
    assert.strictEqual(takeoverResult.rows[0].claimed_by, newWorker);
    assert.strictEqual(takeoverResult.rows[0].fencing_token, '6', 'Fencing token must advance to 6');

    // The crashed/stale worker wakes up and attempts CAS completion using its old fencing_token (5)
    const staleCompletion = await db('subscription_cancellation_outbox')
      .where({ id: taskId, fencing_token: 5 })
      .update({
        state: 'COMPLETED',
        completed_at: now,
        updated_at: now
      });

    assert.strictEqual(staleCompletion, 0, 'Stale worker CAS completion must affect 0 rows (fencing protection)');

    // The healthy worker completes using current fencing_token (6)
    const validCompletion = await db('subscription_cancellation_outbox')
      .where({ id: taskId, fencing_token: 6 })
      .update({
        state: 'COMPLETED',
        completed_at: now,
        updated_at: now
      });

    assert.strictEqual(validCompletion, 1, 'Healthy worker completion must succeed');

    const finalTask = await db('subscription_cancellation_outbox').where({ id: taskId }).first();
    assert.strictEqual(finalTask.state, 'COMPLETED');
    assert.ok(finalTask.completed_at);
  });

  test('GATE 7: End-to-End Service Execution: processCancellationOutboxTasks in Real PostgreSQL', async () => {
    const customerId = 'test_outbox_cust_e2e';
    const subId = 'sub_outbox_e2e_cancel';
    const now = Date.now();
    const taskId = `task_e2e_cancel_${crypto.randomUUID().replace(/-/g, '')}`;

    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      customer_id: customerId,
      principal_id: customerId,
      gateway: 'cashfree',
      gateway_subscription_id: 'cf_sub_e2e_cancel_1',
      replacement_subscription_id: 'cf_sub_e2e_cancel_2',
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    let cancellationTransportCalled = false;
    paymentGatewayService.setGatewayTransport(async (action: any, params: any) => {
      cancellationTransportCalled = true;
      return { status: 'CANCELLED', action, params };
    });

    const result = await paymentGatewayService.processCancellationOutboxTasks(db, {
      workerId: 'worker_real_pg_rehearsal',
      leaseDurationMs: 30000,
      batchSize: 5
    });

    assert.ok(result.processed >= 1, 'Must have processed at least 1 task');
    assert.ok(result.succeeded >= 1, 'Must have succeeded at least 1 task');
    assert.strictEqual(cancellationTransportCalled, true, 'Gateway transport must be invoked for mandate cancellation');

    const updatedTask = await db('subscription_cancellation_outbox').where({ id: taskId }).first();
    assert.strictEqual(updatedTask.state, 'COMPLETED');
    assert.ok(updatedTask.completed_at);

    // Clean transport
    paymentGatewayService.setGatewayTransport(null as any);
  });

  test('GATE 8: End-to-End Service Execution: processInvoiceReconciliationTasks in Real PostgreSQL', async () => {
    const customerId = 'test_outbox_cust_inv_e2e';
    const principalId = customerId;
    const subId = 'sub_outbox_inv_e2e_1';
    const now = Date.now();
    const taskId = `task_e2e_inv_${crypto.randomUUID().replace(/-/g, '')}`;

    // Clean up any remaining outbox/idempotency items for clean execution
    await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_outbox_%').delete();
    await db('billing_invoices').where('customer_id', 'like', 'test_outbox_%').delete();
    await db('billing_audit_events').where('customer_id', 'like', 'test_outbox_%').delete();
    await db('idempotent_operations').where('principal_id', 'like', 'test_outbox_%').delete();
    await db('idempotent_operations').where('key', 'like', '%test_outbox%').delete();
    await db('subscriptions').where('customer_id', 'like', 'test_outbox_%').delete();
    await db('billing_customers').where('id', 'like', 'test_outbox_%').delete();

    // Pre-insert customer and subscription to satisfy foreign keys
    await db('billing_customers').insert({
      id: customerId,
      principal_id: principalId,
      name: 'Invoice Outbox Test Customer',
      created_at: now,
      updated_at: now
    });

    await db('subscriptions').insert({
      id: subId,
      customer_id: customerId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'razorpay',
      currency: 'INR',
      amount_minor_units: 290000,
      current_period_start: now,
      current_period_end: now + 30 * 86400 * 1000,
      cancel_at_period_end: false,
      created_at: now,
      updated_at: now
    });

    await db('billing_invoice_reconciliation_outbox').insert({
      id: taskId,
      subscription_id: subId,
      cycle_number: 1,
      customer_id: customerId,
      principal_id: principalId,
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 290000,
      currency: 'INR',
      actual_payment_id: 'pay_e2e_inv_001',
      gateway_order_id: 'order_e2e_inv_001',
      correlation_id: `corr_inv_${crypto.randomUUID().replace(/-/g, '')}`,
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    const result = await paymentGatewayService.processInvoiceReconciliationTasks(db, {
      workerId: 'worker_real_pg_invoice_rehearsal',
      leaseDurationMs: 30000,
      limit: 5
    });

    assert.ok(result.processed >= 1, 'Must have processed at least 1 invoice task');
    assert.ok(result.succeeded >= 1, 'Must have succeeded at least 1 invoice task');

    const updatedTask = await db('billing_invoice_reconciliation_outbox').where({ id: taskId }).first();
    assert.strictEqual(updatedTask.state, 'COMPLETED');
    assert.ok(updatedTask.completed_at);

    // Verify invoice was issued in billing_invoices table
    const invoice = await db('billing_invoices').where({ customer_id: customerId }).first();
    assert.ok(invoice, 'Invoice record must exist in billing_invoices');
    assert.strictEqual(invoice.status, 'Paid');
    assert.strictEqual(Number(invoice.total_amount), 2900);
  });

  test('GATE 9: Migration 035 Down and Re-Up Clean Lifecycle in Real PostgreSQL 18', async () => {
    // Clean down drops tables
    await migration035.down(db);

    const hasSubCancelAfterDown = await db.schema.hasTable('subscription_cancellation_outbox');
    assert.strictEqual(hasSubCancelAfterDown, false, 'subscription_cancellation_outbox must be dropped on down');

    const hasInvReconAfterDown = await db.schema.hasTable('billing_invoice_reconciliation_outbox');
    assert.strictEqual(hasInvReconAfterDown, false, 'billing_invoice_reconciliation_outbox must be dropped on down');

    // Re-up successfully recreates tables and constraints
    await migration035.up(db);

    const hasSubCancelAfterReUp = await db.schema.hasTable('subscription_cancellation_outbox');
    assert.strictEqual(hasSubCancelAfterReUp, true, 'subscription_cancellation_outbox must exist after re-up');

    const hasInvReconAfterReUp = await db.schema.hasTable('billing_invoice_reconciliation_outbox');
    assert.strictEqual(hasInvReconAfterReUp, true, 'billing_invoice_reconciliation_outbox must exist after re-up');
  });

});
