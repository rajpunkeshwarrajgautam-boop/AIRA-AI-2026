import './setup-disposable-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import * as migration034 from '../packages/db/src/migrations/034_unique_active_subscription_per_customer.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

test.describe('AIRA ONE — Migration 034 & Real PostgreSQL 18 Concurrency Rehearsal', () => {

  const originalEnv = { ...process.env };

  function makeSub(id: string, customerId: string, planId: string, gateway: string, status: string, gatewaySubId?: string) {
    const now = Date.now();
    return {
      id,
      customer_id: customerId,
      plan_id: planId,
      price_id: planId === 'pro' ? 'price_pro_inr' : 'price_plus_inr',
      status,
      gateway,
      gateway_subscription_id: gatewaySubId || null,
      currency: 'INR',
      amount_minor_units: planId === 'pro' ? 290000 : 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400 * 1000,
      cancel_at_period_end: false,
      created_at: now,
      updated_at: now
    };
  }

  test.before(async () => {
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.CASHFREE_APP_ID = 'cf_test_rehearsal';
    process.env.CASHFREE_SECRET_KEY = 'cf_test_rehearsal_secret';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_rehearsal';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_rehearsal_secret';

    // Ensure clean state for test customers
    await db('subscriptions').where('customer_id', 'like', 'test_pg_%').delete();
    await db('idempotent_operations').where('principal_id', 'like', 'test_pg_%').delete();
    await db('billing_customers').where('id', 'like', 'test_pg_%').delete();
  });

  test.after(async () => {
    await db('subscriptions').where('customer_id', 'like', 'test_pg_%').delete();
    await db('idempotent_operations').where('principal_id', 'like', 'test_pg_%').delete();
    await db('billing_customers').where('id', 'like', 'test_pg_%').delete();
    process.env = { ...originalEnv };
    await closeDb();
  });

  test('STEP 1: Verify PostgreSQL 18.x Engine Identity on aira_test_db', async () => {
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

  test('STEP 2: Migration 034 Preflight Fail-Closed Guard on Duplicate Active Subscriptions', async () => {
    const testCust = 'test_pg_preflight_cust';
    const now = Date.now();

    // Ensure clean down state first
    await migration034.down(db);

    // Create customer first to satisfy foreign key
    await db('billing_customers').insert({
      id: testCust,
      principal_id: testCust,
      name: 'Preflight Customer',
      created_at: now,
      updated_at: now
    });

    // Insert duplicate active subscriptions for the same customer
    await db('subscriptions').insert([
      makeSub(`sub_dup_1_${now}`, testCust, 'pro', 'cashfree', 'active'),
      makeSub(`sub_dup_2_${now}`, testCust, 'plus', 'razorpay', 'active')
    ]);

    // Preflight must reject migration
    await assert.rejects(
      async () => {
        await migration034.up(db);
      },
      (err: any) => {
        assert.ok(err.message.includes('MIGRATION_034_PREFLIGHT_FAILED'));
        return true;
      }
    );

    // Clean up duplicate subscriptions
    await db('subscriptions').where({ customer_id: testCust }).delete();
  });

  test('STEP 3: Migration 034 Up — Creates Partial & Composite Unique Indices', async () => {
    await migration034.up(db);

    // Verify partial unique index exists
    const idx1 = await db.raw(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename = 'subscriptions' AND indexname = 'uniq_subscriptions_customer_active';
    `);
    assert.strictEqual(idx1.rows.length, 1, 'Index uniq_subscriptions_customer_active must exist');
    assert.ok(idx1.rows[0].indexdef.includes('customer_id'), 'Index must index customer_id');
    assert.ok(idx1.rows[0].indexdef.includes('active'), 'Index must have active predicate');

    // Verify composite unique index exists
    const idx2 = await db.raw(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename = 'subscriptions' AND indexname = 'uniq_subscriptions_gateway_sub_id';
    `);
    assert.strictEqual(idx2.rows.length, 1, 'Index uniq_subscriptions_gateway_sub_id must exist');
    assert.ok(idx2.rows[0].indexdef.includes('gateway_subscription_id IS NOT NULL'), 'Index must have NOT NULL predicate');
  });

  test('STEP 4: Real Database Enforcement of Partial & Composite Unique Constraints', async () => {
    const custA = 'test_pg_cust_active_test';
    const now = Date.now();

    await db('billing_customers').insert({
      id: custA,
      principal_id: custA,
      name: 'Active Test Customer A',
      created_at: now,
      updated_at: now
    });

    // 1. Insert first active subscription
    await db('subscriptions').insert(
      makeSub(`sub_act_1_${now}`, custA, 'pro', 'cashfree', 'active', `g_sub_1_${now}`)
    );

    // 2. Second active subscription for same customer must violate partial unique index
    await assert.rejects(
      async () => {
        await db('subscriptions').insert(
          makeSub(`sub_act_2_${now}`, custA, 'plus', 'razorpay', 'active', `g_sub_2_${now}`)
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, '23505', 'PostgreSQL error code must be 23505 (unique_violation)');
        assert.ok(err.detail.includes('Key (customer_id)='), 'Must fail on customer_id unique index');
        return true;
      }
    );

    // 3. Second NON-ACTIVE (e.g. pending or canceled) subscription for same customer MUST succeed
    await db('subscriptions').insert(
      makeSub(`sub_pending_${now}`, custA, 'plus', 'razorpay', 'pending')
    );

    // 4. Duplicate (gateway, gateway_subscription_id) across different customers must violate composite index
    const custB = 'test_pg_cust_b';
    await db('billing_customers').insert({
      id: custB,
      principal_id: custB,
      name: 'Active Test Customer B',
      created_at: now,
      updated_at: now
    });

    await assert.rejects(
      async () => {
        await db('subscriptions').insert(
          makeSub(`sub_dup_gw_${now}`, custB, 'pro', 'cashfree', 'pending', `g_sub_1_${now}`) // Reused gateway_subscription_id
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, '23505', 'Must fail on gateway_subscription_id composite unique index');
        return true;
      }
    );
  });

  test('STEP 5: Clean Migration Down and Re-Up Lifecycle', async () => {
    // Clean down drops indexes cleanly
    await migration034.down(db);

    const checkDown = await db.raw(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'subscriptions' AND indexname IN ('uniq_subscriptions_customer_active', 'uniq_subscriptions_gateway_sub_id');
    `);
    assert.strictEqual(checkDown.rows.length, 0, 'Indices must be dropped');

    // Re-up applies cleanly
    await migration034.up(db);

    const checkUp = await db.raw(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'subscriptions' AND indexname IN ('uniq_subscriptions_customer_active', 'uniq_subscriptions_gateway_sub_id');
    `);
    assert.strictEqual(checkUp.rows.length, 2, 'Indices must be recreated cleanly');
  });

  test('STEP 6: Real Concurrency, Customer Lease Locking & Fencing in PostgreSQL 18', async () => {
    paymentGatewayService.setDbClient(db);

    const principalId = 'test_pg_princ_concurrency';
    const customerId = 'test_pg_cust_concurrency';
    const now = Date.now();

    await db('billing_customers').insert({
      id: customerId,
      principal_id: principalId,
      name: 'Real PG Concurrency User',
      created_at: now,
      updated_at: now
    });

    // Simulate an active concurrency lease
    const leaseKey = `checkout:sub:${customerId}`;
    await db('idempotent_operations').insert({
      key: leaseKey,
      principal_id: principalId,
      operation_id: 'op_existing_worker_1',
      operation_type: 'subscription_checkout',
      payload_hash: 'dummy_hash_existing',
      status: 'IN_PROGRESS',
      locked_until: now + 30000,
      created_at: now,
      updated_at: now
    });

    // Concurrent request from worker 2 must be rejected with 409 CONCURRENT_CHECKOUT_IN_PROGRESS
    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'razorpay',
          { userId: principalId },
          undefined,
          'op_worker_2'
        );
      },
      (err: any) => {
        assert.ok(err.message.includes('CONCURRENT_CHECKOUT_IN_PROGRESS'));
        return true;
      }
    );

    // Release lease
    await db('idempotent_operations').where({ key: leaseKey }).delete();
  });

  test('STEP 7: Stale Worker Fencing Detection in Real PostgreSQL 18', async () => {
    paymentGatewayService.setDbClient(db);
    const principalId = 'test_pg_princ_fencing';
    const customerId = 'test_pg_cust_fencing';
    const now = Date.now();

    await db('billing_customers').insert({
      id: customerId,
      principal_id: principalId,
      name: 'Stale Worker User',
      created_at: now,
      updated_at: now
    });

    const leaseKey = `checkout:sub:${customerId}`;

    // Set gateway transport: while Worker 1 is waiting on gateway, Worker 2 steals/reassigns the lease
    paymentGatewayService.setGatewayTransport(async (params) => {
      // Reassign lease to Worker 2 in real DB
      await db('idempotent_operations')
        .where({ key: leaseKey })
        .update({
          operation_id: 'op_worker_2_stole_lease',
          updated_at: Date.now()
        });

      return {
        gatewayOrderId: `sub_dispatched_${params.orderId}`,
        shortUrl: 'https://rzp.io/i/test_dispatched'
      };
    });

    // Worker 1 dispatches checkout using op_worker_1
    // persistCheckoutRecords must detect that the active lease was reassigned and fence Worker 1
    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'razorpay',
          { userId: principalId },
          undefined,
          'op_worker_1'
        );
      },
      (err: any) => {
        assert.ok(err.message.includes('STALE_WORKER_FENCED'), `Expected STALE_WORKER_FENCED, got: ${err.message}`);
        return true;
      }
    );

    paymentGatewayService.setGatewayTransport(null as any);
    await db('idempotent_operations').where({ key: leaseKey }).delete();
  });

  test('STEP 8: Ambiguous Outcome Persistence and Blocking in Real PostgreSQL 18 (E2E-03)', async () => {
    paymentGatewayService.setDbClient(db);
    const principalId = 'test_pg_princ_ambiguous';
    const customerId = 'test_pg_cust_ambiguous';
    const now = Date.now();

    await db('billing_customers').insert({
      id: customerId,
      principal_id: principalId,
      name: 'Ambiguous User',
      created_at: now,
      updated_at: now
    });

    // Simulate provider timeout during dispatch
    paymentGatewayService.setGatewayTransport(async () => {
      const timeoutErr = new Error('Gateway timed out after 15 seconds');
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    });

    // Dispatch checkout
    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'cashfree',
          { userId: principalId, customerPhone: '9876543210' },
          { phone: '9876543210' },
          'op_ambiguous_first'
        );
      },
      (err: any) => {
        assert.ok(err.message.includes('GATEWAY_AMBIGUOUS_OUTCOME'));
        return true;
      }
    );

    // Verify subscription row in real PostgreSQL
    const sub = await db('subscriptions').where({ customer_id: customerId }).first();
    assert.ok(sub, 'Must persist subscription row');
    assert.strictEqual(sub.status, 'ambiguous_timeout');

    // Verify idempotent_operations in real PostgreSQL
    const lease = await db('idempotent_operations').where({ key: `checkout:sub:${customerId}` }).first();
    assert.ok(lease, 'Lease must exist in DB');
    assert.strictEqual(lease.status, 'AMBIGUOUS');
    assert.strictEqual(lease.response_status, 504);

    // Subsequent checkout attempt must be BLOCKED by real PostgreSQL data check (E2E-03)
    paymentGatewayService.setGatewayTransport(async () => {
      return { gatewayOrderId: 'duplicate_order_that_should_never_happen' };
    });

    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'cashfree',
          { userId: principalId, customerPhone: '9876543210' },
          { phone: '9876543210' }
        );
      },
      (err: any) => {
        assert.ok(err.message.includes('GATEWAY_AMBIGUOUS_OUTCOME'));
        assert.ok(err.message.includes('pending reconciliation'));
        return true;
      }
    );

    // Authoritatively reconcile in real PostgreSQL with verified provider evidence and operator audit trail (V-01)
    const recon = await paymentGatewayService.reconcileAmbiguousSubscription(sub.id, db, 'failed', {
      providerEvidence: {
        trustedServerVerified: true,
        gateway: 'cashfree',
        environment: 'sandbox',
        customerId: sub.customer_id,
        orderId: sub.id,
        exists: false,
        status: 'NOT_FOUND',
        verificationTimestamp: Date.now()
      },
      operatorAuth: {
        operatorId: 'operator_pg_rehearsal',
        justification: 'Automated rehearsal reconciliation of ambiguous timeout',
        evidenceReference: 'REF-REHEARSAL-034'
      }
    });
    assert.strictEqual(recon.reconciled, true);
    assert.strictEqual(recon.status, 'failed');

    const updatedSub = await db('subscriptions').where({ id: sub.id }).first();
    assert.strictEqual(updatedSub.status, 'failed');

    // Clean up
    paymentGatewayService.setGatewayTransport(null as any);
  });
});
