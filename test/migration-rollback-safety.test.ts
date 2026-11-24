import './setup-disposable-db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import * as migration035 from '../packages/db/src/migrations/035_subscription_cancellation_and_invoice_outbox.js';
import * as migration034 from '../packages/db/src/migrations/034_unique_active_subscription_per_customer.js';

describe('V-06: Non-Destructive Rollback & Migration Safety Suite', () => {
  before(async () => {
    // Ensure migration 034 and 035 are applied
    await migration034.up(db as any);
    await migration035.up(db as any);

    // Clean test records
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_rb_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_rb_%').delete();
    } catch {}
  });

  after(async () => {
    try {
      await db('subscription_cancellation_outbox').where('customer_id', 'like', 'test_rb_%').delete();
      await db('billing_invoice_reconciliation_outbox').where('customer_id', 'like', 'test_rb_%').delete();
    } catch {}
  });

  // 1. Rollback blocked when pending cancellation tasks exist
  it('1. blocks destructive down() migration when unresolved cancellation tasks exist', async () => {
    const taskId = `task_rb_cancel_${Date.now()}`;
    const now = Date.now();

    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: 'sub_rb_test_1',
      customer_id: 'test_rb_cust_1',
      principal_id: 'neon_user_rb_1',
      gateway: 'cashfree',
      gateway_subscription_id: 'cf_sub_rb_1',
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    // Attempt down migration without force override
    await assert.rejects(
      async () => {
        await migration035.down(db as any);
      },
      /MIGRATION_035_ROLLBACK_BLOCKED.*unresolved mandate cancellation/
    );

    // Verify table and task still exist
    const task = await db('subscription_cancellation_outbox').where({ id: taskId }).first();
    assert.ok(task, 'Pending cancellation task must NOT be deleted');
    assert.strictEqual(task.state, 'PENDING');

    // Clean up task for next test
    await db('subscription_cancellation_outbox').where({ id: taskId }).delete();
  });

  // 2. Rollback blocked when pending invoice tasks exist
  it('2. blocks destructive down() migration when unresolved invoice reconciliation tasks exist', async () => {
    const taskId = `task_rb_inv_${Date.now()}`;
    const now = Date.now();

    await db('billing_invoice_reconciliation_outbox').insert({
      id: taskId,
      subscription_id: 'sub_rb_test_2',
      cycle_number: 1,
      customer_id: 'test_rb_cust_2',
      principal_id: 'neon_user_rb_2',
      gateway: 'razorpay',
      plan_tier: 'pro',
      amount_minor_units: 99900,
      currency: 'INR',
      actual_payment_id: 'pay_rb_2',
      correlation_id: `corr_rb_${Date.now()}`,
      state: 'CLAIMED',
      attempts: 1,
      max_attempts: 5,
      fencing_token: 1,
      lease_until: now + 30000,
      created_at: now,
      updated_at: now
    });

    await assert.rejects(
      async () => {
        await migration035.down(db as any);
      },
      /MIGRATION_035_ROLLBACK_BLOCKED.*unresolved invoice reconciliation/
    );

    const task = await db('billing_invoice_reconciliation_outbox').where({ id: taskId }).first();
    assert.ok(task, 'Unresolved invoice task must NOT be deleted');

    // Clean up task for next test
    await db('billing_invoice_reconciliation_outbox').where({ id: taskId }).delete();
  });

  // 3. Rollback succeeds when all tasks are resolved (COMPLETED or FAILED)
  it('3. allows clean down() migration when all outbox tasks are in terminal states or table is empty', async () => {
    // Both tables are now clean of pending tasks
    // Execute down()
    await migration035.down(db as any);

    // Verify tables were safely dropped
    const hasCancelTable = await db.schema.hasTable('subscription_cancellation_outbox');
    const hasInvTable = await db.schema.hasTable('billing_invoice_reconciliation_outbox');
    assert.strictEqual(hasCancelTable, false);
    assert.strictEqual(hasInvTable, false);

    // Re-apply up() for subsequent tests and system health
    await migration035.up(db as any);
    const hasCancelAfter = await db.schema.hasTable('subscription_cancellation_outbox');
    assert.strictEqual(hasCancelAfter, true);
  });

  // 4. Force override prohibited: env var cannot delete unresolved financial obligations
  it('4. strictly prohibits FORCE_DESTRUCTIVE_OUTBOX_DROP from bypassing rollback barrier', async () => {
    const taskId = `task_rb_force_${Date.now()}`;
    const now = Date.now();

    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: 'sub_rb_force',
      customer_id: 'test_rb_cust_force',
      principal_id: 'neon_user_rb_force',
      gateway: 'cashfree',
      gateway_subscription_id: 'cf_sub_force',
      state: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      fencing_token: 0,
      created_at: now,
      updated_at: now
    });

    process.env.FORCE_DESTRUCTIVE_OUTBOX_DROP = 'true';
    try {
      await assert.rejects(
        async () => {
          await migration035.down(db as any);
        },
        /MIGRATION_035_ROLLBACK_BLOCKED/
      );
      const hasCancel = await db.schema.hasTable('subscription_cancellation_outbox');
      assert.strictEqual(hasCancel, true, 'Table must NOT be dropped even if FORCE_DESTRUCTIVE_OUTBOX_DROP=true');
    } finally {
      delete process.env.FORCE_DESTRUCTIVE_OUTBOX_DROP;
      await db('subscription_cancellation_outbox').where({ id: taskId }).delete();
    }
  });

  // 4b. Failed tasks requiring manual reconciliation also block rollback
  it('4b. blocks rollback when failed tasks requiring manual reconciliation exist', async () => {
    const taskId = `task_rb_failed_${Date.now()}`;
    const now = Date.now();

    await db('subscription_cancellation_outbox').insert({
      id: taskId,
      subscription_id: 'sub_rb_failed',
      customer_id: 'test_rb_cust_failed',
      principal_id: 'neon_user_rb_failed',
      gateway: 'cashfree',
      gateway_subscription_id: 'cf_sub_failed',
      state: 'FAILED',
      attempts: 5,
      max_attempts: 5,
      fencing_token: 5,
      created_at: now,
      updated_at: now
    });

    try {
      await assert.rejects(
        async () => {
          await migration035.down(db as any);
        },
        /MIGRATION_035_ROLLBACK_BLOCKED/
      );
      const hasCancel = await db.schema.hasTable('subscription_cancellation_outbox');
      assert.strictEqual(hasCancel, true, 'Table must NOT be dropped when failed tasks exist');
    } finally {
      await db('subscription_cancellation_outbox').where({ id: taskId }).delete();
    }
  });

  // 5. Additive schema backward compatibility
  it('5. confirms previous application queries operate cleanly with additive migrations 034 and 035 installed', async () => {
    // Normal query performed by previous application version
    const testCust = `test_rb_compat_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: testCust,
      principal_id: `neon_user_${testCust}`,
      created_at: now,
      updated_at: now
    });

    // Standard insert of single active subscription works seamlessly with migration 034 constraint
    const subId = `sub_compat_${Date.now()}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: testCust,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'active',
      gateway: 'cashfree',
      gateway_subscription_id: `cf_sub_${subId}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now,
      updated_at: now
    });

    const queriedSub = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(queriedSub.id, subId);
    assert.strictEqual(queriedSub.status, 'active');

    // Clean up
    await db('subscriptions').where({ id: subId }).delete();
    await db('billing_customers').where({ id: testCust }).delete();
  });
});
