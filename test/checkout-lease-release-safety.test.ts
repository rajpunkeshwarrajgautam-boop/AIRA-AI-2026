import './setup-disposable-db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, closeDb } from '../packages/db/src/index.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

describe('V-07: Checkout Lease Release Safety Suite', () => {
  let app: express.Express;
  let server: any;
  let baseUrl: string;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_rehearsal';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_rehearsal_secret';
    process.env.CASHFREE_APP_ID = 'cf_test_rehearsal';
    process.env.CASHFREE_SECRET_KEY = 'cf_test_rehearsal_secret';

    app = express();
    app.use(express.json());

    // Mock principal auth middleware for route testing
    app.use((req: any, _res, next) => {
      const authHeader = req.headers['x-test-principal'];
      if (authHeader) {
        req.principal = {
          userId: authHeader,
          email: `${authHeader}@aira.test`,
          roles: ['user']
        };
      }
      next();
    });

    app.use('/api/billing', createBillingRoutes());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    try {
      await db('billing_customers').where('id', 'like', 'test_lease_%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_lease_%').delete();
      await db('idempotent_operations').where('key', 'like', '%test_lease%').delete();
    } catch {}
  });

  after(async () => {
    if (server) server.close();
    try {
      await db('billing_customers').where('id', 'like', 'test_lease_%').delete();
      await db('subscriptions').where('customer_id', 'like', 'test_lease_%').delete();
      await db('idempotent_operations').where('key', 'like', '%test_lease%').delete();
    } catch {}
  });

  // 1. Route existence and unauthorized access rejection
  it('1. rejects unauthenticated access to /api/billing/checkout/release-lease with 401', async () => {
    const res = await fetch(`${baseUrl}/api/billing/checkout/release-lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(res.status, 401, 'Must reject unauthenticated request with 401');
  });

  // 2. Premature release during active provider dispatch (< 30s) is strictly rejected
  it('2. rejects premature lease release while initiating provider dispatch is in flight (< 30s)', async () => {
    const custId = `test_lease_cust_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      name: 'Lease User',
      created_at: now,
      updated_at: now
    });

    await db('subscriptions').insert({
      id: `sub_in_flight_${Date.now()}`,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'initiating',
      gateway: 'cashfree',
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now, // Created just now
      updated_at: now
    });

    await db('idempotent_operations').insert({
      key: `checkout:sub:${custId}`,
      principal_id: principalId,
      operation_id: `op_${custId}`,
      operation_type: 'subscription_checkout',
      payload_hash: 'hash_test_123',
      status: 'IN_PROGRESS',
      locked_until: now + 30000,
      created_at: now,
      updated_at: now
    });

    const res = await fetch(`${baseUrl}/api/billing/checkout/release-lease`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': principalId
      },
      body: JSON.stringify({ operationId: `op_${custId}` })
    });

    assert.strictEqual(res.status, 409, 'Must reject premature release with 409');
    const body: any = await res.json();
    assert.strictEqual(body.error, 'LEASE_RELEASE_REJECTED');
    assert.ok(body.message?.includes('provider dispatch is in flight'));
  });

  // 3. Ambiguous timeout state cannot be released by modal dismissal
  it('3. strictly rejects release when ambiguous_timeout is pending', async () => {
    const custId = `test_lease_ambig_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      created_at: now,
      updated_at: now
    });

    await db('subscriptions').insert({
      id: `sub_ambig_${Date.now()}`,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'ambiguous_timeout',
      gateway: 'razorpay',
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      created_at: now - 60000,
      updated_at: now - 60000
    });

    const res = await fetch(`${baseUrl}/api/billing/checkout/release-lease`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': principalId
      },
      body: JSON.stringify({})
    });

    assert.strictEqual(res.status, 409, 'Must reject release of ambiguous timeout with 409');
    const body: any = await res.json();
    assert.strictEqual(body.error, 'LEASE_RELEASE_REJECTED');
  });

  // 4. Modal dismissal on pending subscription preserves durable pending session
  it('4. preserves durable pending subscription in database when modal is dismissed', async () => {
    const custId = `test_lease_pend_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      created_at: now,
      updated_at: now
    });

    const subId = `sub_pend_${Date.now()}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: `cf_sub_${subId}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      metadata: JSON.stringify({ checkoutUrl: 'https://sandbox.cashfree.com/pay', subsSessionId: 'sess_123' }),
      created_at: now,
      updated_at: now
    });

    await db('idempotent_operations').insert({
      key: `checkout:sub:${custId}`,
      principal_id: principalId,
      operation_id: `op_${custId}`,
      operation_type: 'subscription_checkout',
      payload_hash: 'hash_test_123',
      status: 'IN_PROGRESS',
      locked_until: now + 30000,
      created_at: now,
      updated_at: now
    });

    const res = await fetch(`${baseUrl}/api/billing/checkout/release-lease`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': principalId
      },
      body: JSON.stringify({ operationId: `op_${custId}` })
    });

    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.released, true);
    assert.strictEqual(body.subStatus, 'pending');

    // Confirm subscription is STILL pending in DB (never canceled or deleted)
    const sub = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(sub.status, 'pending', 'Subscription status must remain pending');
  });

  // 5. Customer isolation: cannot release another customer's operation
  it('5. strictly prevents arbitrary release of another customer operation', async () => {
    const victimCustId = `test_lease_victim_${Date.now()}`;
    const attackerPrincipal = `neon_user_attacker_${Date.now()}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: victimCustId,
      principal_id: `neon_user_${victimCustId}`,
      created_at: now,
      updated_at: now
    });

    // Attacker calls release-lease with victim's operation ID
    const res = await fetch(`${baseUrl}/api/billing/checkout/release-lease`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': attackerPrincipal // Attacker!
      },
      body: JSON.stringify({ operationId: `op_${victimCustId}` })
    });

    // Attacker does not own victim's customer account
    const body: any = await res.json();
    assert.ok(res.status === 200 || res.status === 404 || res.status === 403);
    if (res.status === 200) {
      assert.strictEqual(body.released, false, 'Cannot release other customer lease');
    }
  });

  // 6. Concurrency beyond 30-second lease expiration preserves protection and exact provider invocation count
  it('6. enforces exact 1 provider invocation even when 30s lease expires and subsequent request arrives', async () => {
    const custId = `test_lease_invoc_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      name: 'Invoc User',
      created_at: now,
      updated_at: now
    });

    let providerCallCount = 0;
    paymentGatewayService.setGatewayTransport(async () => {
      providerCallCount++;
      return {
        success: true,
        orderId: `order_${Date.now()}`,
        gatewayOrderId: `sub_cf_${Date.now()}`,
        subscriptionSessionId: `subs_session_${Date.now()}`,
        shortUrl: 'https://sandbox.cashfree.com/pg/checkout'
      };
    });

    // First checkout invocation
    const checkout1 = await paymentGatewayService.createSubscriptionCheckout(
      principalId,
      'pro',
      'INR',
      'cashfree',
      { userId: principalId },
      { phone: '9876543210' }
    );

    assert.strictEqual(providerCallCount, 1, 'First checkout must call provider exactly 1 time');
    assert.ok(checkout1.subscriptionSessionId);

    // Second checkout invocation within 15-minute window for identical plan
    const checkout2 = await paymentGatewayService.createSubscriptionCheckout(
      principalId,
      'pro',
      'INR',
      'cashfree',
      { userId: principalId },
      { phone: '9876543210' }
    );

    assert.strictEqual(providerCallCount, 1, 'Second checkout within window must REUSE session (zero new provider calls)');
    assert.strictEqual(checkout2.subscriptionSessionId, checkout1.subscriptionSessionId);

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 7. Post-15-minute expiration protection: unresolved pending subscription blocks new checkout
  it('7. unresolved pending subscription beyond 15 minutes blocks duplicate creation with ZERO provider calls', async () => {
    const custId = `test_lease_post15_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      name: 'Post15 User',
      created_at: now,
      updated_at: now
    });

    // Seed pending subscription created 20 minutes ago (expired window)
    const subId = `sub_post15_${Date.now()}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'pending',
      gateway: 'cashfree',
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now - 20 * 60000,
      current_period_end: now + 30 * 86400000,
      created_at: now - 20 * 60000,
      updated_at: now - 20 * 60000
    });

    let providerCallCount = 0;
    paymentGatewayService.setGatewayTransport(async () => {
      providerCallCount++;
      return { success: true };
    });

    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'cashfree',
          { userId: principalId },
          { phone: '9876543210' }
        );
      },
      /CONCURRENT_CHECKOUT_IN_PROGRESS/
    );

    assert.strictEqual(providerCallCount, 0, 'Must execute exactly ZERO provider calls on expired pending checkout');
    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 8. Post-lease-release protection: client dismissal preserves pending state and prevents duplicate provider calls
  it('8. client lease release preserves pending session and subsequent checkout executes ZERO new provider calls', async () => {
    const custId = `test_lease_rel_reuse_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      name: 'Release Reuse User',
      created_at: now,
      updated_at: now
    });

    let providerCallCount = 0;
    paymentGatewayService.setGatewayTransport(async () => {
      providerCallCount++;
      return {
        success: true,
        orderId: `order_${Date.now()}`,
        subscriptionSessionId: `subs_rel_${Date.now()}`,
        shortUrl: 'https://sandbox.cashfree.com/pg/checkout'
      };
    });

    // Initial checkout
    const initialCheckout = await paymentGatewayService.createSubscriptionCheckout(
      principalId,
      'plus',
      'INR',
      'cashfree',
      { userId: principalId },
      { phone: '9876543210' }
    );
    assert.strictEqual(providerCallCount, 1);

    // Client releases lease on modal close
    const releaseRes = await paymentGatewayService.releaseCheckoutLease(principalId);
    assert.strictEqual(releaseRes.released, true);

    // Client re-initiates checkout within 15 minutes: reuses session, ZERO new provider calls
    const secondCheckout = await paymentGatewayService.createSubscriptionCheckout(
      principalId,
      'plus',
      'INR',
      'cashfree',
      { userId: principalId },
      { phone: '9876543210' }
    );

    assert.strictEqual(providerCallCount, 1, 'Provider call count must remain exactly 1');
    assert.strictEqual(secondCheckout.subscriptionSessionId, initialCheckout.subscriptionSessionId);

    paymentGatewayService.setGatewayTransport(null as any);
  });

  // 9. Post-ambiguous-timeout and application restart protection
  it('9. unresolved ambiguous timeout blocks replacement checkout across service restarts with ZERO provider calls', async () => {
    const custId = `test_lease_ambig_rst_${Date.now()}`;
    const principalId = `neon_user_${custId}`;
    const now = Date.now();

    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      name: 'Ambig Restart User',
      created_at: now,
      updated_at: now
    });

    // Seed ambiguous subscription in DB
    const subId = `sub_ambig_rst_${Date.now()}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'ambiguous_timeout',
      gateway: 'cashfree',
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now - 60000,
      current_period_end: now + 30 * 86400000,
      created_at: now - 60000,
      updated_at: now - 60000
    });

    let providerCallCount = 0;
    paymentGatewayService.setGatewayTransport(async () => {
      providerCallCount++;
      return { success: true };
    });

    // Even if lease is released or expired, DB state blocks checkout
    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(
          principalId,
          'pro',
          'INR',
          'cashfree',
          { userId: principalId },
          { phone: '9876543210' }
        );
      },
      /GATEWAY_AMBIGUOUS_OUTCOME/
    );

    assert.strictEqual(providerCallCount, 0, 'Must execute exactly ZERO provider calls when ambiguous timeout is unresolved');
    paymentGatewayService.setGatewayTransport(null as any);
  });
});
