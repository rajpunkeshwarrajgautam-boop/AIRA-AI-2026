import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { db, closeDb } from '../packages/db/src/index.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';

describe('Payment Gateway Webhook & Subscription Lifecycle Tests', () => {
  const secret = 'test_webhook_secret_razorpay_2026';
  const testPrincipalId = `usr_webhook_${Date.now()}`;

  after(async () => {
    try {
      const customer = await db('billing_customers').where({ principal_id: testPrincipalId }).first();
      if (customer) {
        await db('billing_invoices').where({ customer_id: customer.id }).delete().catch(() => {});
        await db('subscriptions').where({ customer_id: customer.id }).delete();
        await db('billing_audit_events').where({ customer_id: customer.id }).delete();
        const account = await db('credit_accounts').where({ customer_id: customer.id }).first();
        if (account) {
          await db('credit_transactions').where({ account_id: account.id }).delete();
          await db('credit_grants').where({ account_id: account.id }).delete();
          await db('credit_accounts').where({ id: account.id }).delete();
        }
        await db('billing_customers').where({ id: customer.id }).delete();
      }
      await db('idempotent_operations').where({ principal_id: testPrincipalId }).delete().catch(() => {});
      await db('payment_gateway_events').whereILike('event_id', '%test_evt_%').delete();
    } catch {
      // Ignored if local PostgreSQL daemon is not active in unit test mode
    }
    await closeDb().catch(() => {});
  });

  it('1. Verifies valid Razorpay HMAC-SHA256 signature', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'pay_123' });
    const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const result = paymentGatewayService.verifyRazorpayWebhook(rawBody, validSignature, secret);
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it('2. Rejects tampered body payload with invalid signature', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'pay_123' });
    const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const tamperedBody = JSON.stringify({ event: 'payment.captured', id: 'pay_123', hacked: true });

    const result = paymentGatewayService.verifyRazorpayWebhook(tamperedBody, validSignature, secret);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'Signature verification failed.');
  });

  it('3. Rejects webhook signed with wrong secret', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'pay_123' });
    const wrongSignature = crypto.createHmac('sha256', 'wrong_secret_123').update(rawBody).digest('hex');

    const result = paymentGatewayService.verifyRazorpayWebhook(rawBody, wrongSignature, secret);
    assert.equal(result.valid, false);
  });

  it('4. Verifies Cashfree HMAC-SHA256 signature with timestamp', () => {
    const cashfreeSecret = 'test_webhook_secret_cashfree_2026';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'SUBSCRIPTION_PAYMENT_SUCCESS' });
    const expected = crypto.createHmac('sha256', cashfreeSecret).update(`${timestamp}${rawBody}`).digest('base64');

    const result = paymentGatewayService.verifyCashfreeWebhook(rawBody, expected, timestamp, cashfreeSecret);
    assert.equal(result.valid, true);
  });

  it('5. Deduplicates duplicate webhook events idempotently', async (t) => {
    paymentGatewayService.setRazorpaySecret(secret);
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';

    let hasDb = false;
    try {
      await db.raw('SELECT 1');
      hasDb = true;
    } catch {
      hasDb = false;
    }

    if (!hasDb) {
      t.skip('Local PostgreSQL connection not available; covered by offline lifecycle suite');
      return;
    }
    // Ensure customer + initial 100 welcome credits and authoritative pending purchase exist in PostgreSQL
    await commercialBillingService.getEntitlements(testPrincipalId);
    const customer = await db('billing_customers').where({ principal_id: testPrincipalId }).first();
    assert.ok(customer, 'Customer must exist in PostgreSQL');

    const now = Date.now();
    const rzpSubId = `sub_rzp_${now}`;
    const subId = `pur_rzp_wh_${now}`;
    const eventId = `test_evt_${now}`;
    const paymentId = `pay_rzp_wh_${now}`;

    await db('subscriptions').insert({
      id: subId,
      customer_id: customer.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'razorpay',
      gateway_subscription_id: rzpSubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId: testPrincipalId,
        customerId: customer.id,
        planTier: 'plus',
        customerState: '07'
      }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      id: eventId,
      event_id: eventId,
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: rzpSubId,
            current_start: Math.floor(now / 1000),
            current_end: Math.floor((now + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: paymentId,
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    // First arrival: should process
    const res1 = await paymentGatewayService.processRazorpayWebhook(rawBody, signature);
    assert.equal(res1.status, 'PROCESSED');
    assert.equal(res1.duplicate, false);

    // Second arrival (duplicate retry from gateway): should detect duplicate and skip processing
    const res2 = await paymentGatewayService.processRazorpayWebhook(rawBody, signature);
    assert.equal(res2.status, 'ALREADY_PROCESSED');
    assert.equal(res2.duplicate, true);

    // Verify entitlements: User must have PLUS entitlements and exactly 3,100 credits (100 welcome + 3,000 Plus)
    const entitlements = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(entitlements.plan, 'plus');
    assert.equal(entitlements.subscriptionStatus, 'active');
    assert.equal(entitlements.creditBalance, 3100);
    assert.equal(entitlements.dailyStandardChatLimit, 50);
    assert.equal(entitlements.monthlyStandardChatUnitsLimit, 700);
    assert.equal(entitlements.reasoningBoostsLimit, 50);
  });
});
