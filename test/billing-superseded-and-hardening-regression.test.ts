import './setup-disposable-db.js';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { db, closeDb } from '../packages/db/src/index.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { taxDeterminationService } from '../apps/api/src/billing/tax-determination.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';

const RZP_SECRET = 'rzp_wh_hardening_test_secret_2026';
const CF_SECRET = 'cf_wh_hardening_test_secret_2026';

function signRazorpay(rawBody: string): string {
  return crypto.createHmac('sha256', RZP_SECRET).update(rawBody).digest('hex');
}

function signCashfree(rawBody: string, tsSec: string): string {
  return crypto.createHmac('sha256', CF_SECRET).update(`${tsSec}${rawBody}`).digest('base64');
}

describe('Billing Superseded Safety, Cashfree Guard & Security Hardening Regression Suite (PG18)', () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;
  const createdPrincipals: string[] = [];
  const createdEventIds: string[] = [];

  before(async () => {
    const res = await db.raw('SELECT current_database() AS db_name');
    const dbName = String(res.rows[0]?.db_name || '');
    assert.ok(
      dbName === 'aira_test_db' || dbName === 'aira_db',
      `Must run against isolated test database (aira_test_db or aira_db), got: ${dbName}`
    );
  });

  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'test';
    process.env.AIRA_ENVIRONMENT = 'staging';
    process.env.VERCEL_ENV = 'preview';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_hardening_2026';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_hardening_2026';
    process.env.RAZORPAY_WEBHOOK_SECRET = RZP_SECRET;
    process.env.RAZORPAY_PLAN_ID_PLUS_INR = 'plan_rzp_plus_399';
    process.env.RAZORPAY_PLAN_ID_PRO_INR = 'plan_rzp_pro_999';
    process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
    process.env.CASHFREE_SECRET_KEY = CF_SECRET;
    process.env.CASHFREE_ENV = 'TEST';
    process.env.CASHFREE_PLAN_ID_PLUS_INR = 'aira_plus_monthly_inr';
    process.env.CASHFREE_PLAN_ID_PRO_INR = 'aira_pro_monthly_inr';
    paymentGatewayService.setDbClient(null as any);
    paymentGatewayService.setGatewayTransport(null as any);
    paymentGatewayService.setRazorpaySecret(RZP_SECRET);
    paymentGatewayService.setCashfreeSecret(CF_SECRET);
  });

  afterEach(() => {
    global.fetch = origFetch;
    paymentGatewayService.setDbClient(null as any);
    paymentGatewayService.setGatewayTransport(null as any);
  });

  after(async () => {
    global.fetch = origFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);

    for (const pId of createdPrincipals) {
      try {
        const cust = await db('billing_customers').where({ principal_id: pId }).first();
        if (cust) {
          await db('billing_credit_notes').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_invoices').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_invoice_reconciliation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('subscription_cancellation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('subscriptions').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_audit_events').where({ customer_id: cust.id }).delete().catch(() => {});
          const acct = await db('credit_accounts').where({ customer_id: cust.id }).first();
          if (acct) {
            await db('credit_transactions').where({ account_id: acct.id }).delete().catch(() => {});
            await db('credit_grants').where({ account_id: acct.id }).delete().catch(() => {});
            await db('credit_accounts').where({ id: acct.id }).delete().catch(() => {});
          }
          await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
        }
        await db('idempotent_operations').where({ principal_id: pId }).delete().catch(() => {});
      } catch {}
    }

    if (createdEventIds.length > 0) {
      await db('payment_gateway_events').whereIn('event_id', createdEventIds).delete().catch(() => {});
    }

    await closeDb().catch(() => {});
  });

  function freshPrincipal(tag: string): string {
    const id = `usr_hard_${tag}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    createdPrincipals.push(id);
    return id;
  }

  it('1. Late payment on older pending subscription NEVER overwrites newer active subscription and routes payment evidence to durable recovery', async () => {
    const principalId = freshPrincipal('late_pay');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Late Pay User');
    const tOld = Date.now() - 600000;
    const tNew = Date.now() - 100000;

    const oldPendingId = `pur_old_pending_${crypto.randomUUID().slice(0, 8)}`;
    const newActiveId = `pur_new_active_${crypto.randomUUID().slice(0, 8)}`;
    const oldGwSubId = `sub_rzp_old_${crypto.randomUUID().slice(0, 8)}`;
    const newGwSubId = `sub_rzp_new_${crypto.randomUUID().slice(0, 8)}`;

    await db('subscriptions').insert([
      {
        id: oldPendingId,
        customer_id: cust.id,
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: oldGwSubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: tOld,
        current_period_end: tOld,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: cust.id, planTier: 'plus', createdAt: tOld }),
        created_at: tOld,
        updated_at: tOld
      },
      {
        id: newActiveId,
        customer_id: cust.id,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: newGwSubId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: tNew,
        current_period_end: tNew + 30 * 86400 * 1000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId,
          customerId: cust.id,
          planTier: 'pro',
          fulfilledCycle: 1,
          initialPaymentId: 'pay_new_active_999',
          lastPaymentId: 'pay_new_active_999',
          createdAt: tNew
        }),
        created_at: tNew,
        updated_at: tNew
      }
    ]);

    const lateEventId = `evt_late_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(lateEventId);
    const latePayId = `pay_late_old_${crypto.randomUUID().slice(0, 8)}`;
    const rawBody = JSON.stringify({
      event_id: lateEventId,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: oldGwSubId, paid_count: 1, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
        payment: { entity: { id: latePayId, status: 'captured', amount: 39900, currency: 'INR' } }
      }
    });

    const result = await paymentGatewayService.processRazorpayWebhook(rawBody, signRazorpay(rawBody));
    assert.strictEqual(result.status, 'PROCESSED');

    const newRow = await db('subscriptions').where({ id: newActiveId }).first();
    const oldRow = await db('subscriptions').where({ id: oldPendingId }).first();
    assert.strictEqual(newRow.status, 'active', 'Newer active Pro subscription must remain active');
    assert.strictEqual(newRow.plan_id, 'pro');
    assert.notStrictEqual(oldRow.status, 'active', 'Older late-paid subscription must NOT activate over newer active sub');

    const oldMeta = typeof oldRow.metadata === 'string' ? JSON.parse(oldRow.metadata) : (oldRow.metadata || {});
    assert.ok(oldMeta.latePaymentRecovery, 'Late payment evidence must be durably recorded in old sub metadata');
    assert.strictEqual(oldMeta.latePaymentRecovery.paymentId, latePayId);
    assert.strictEqual(oldMeta.latePaymentRecovery.supersededByActiveId, newActiveId);
    assert.strictEqual(oldMeta.latePaymentRecovery.status, 'PENDING_RECOVERY_REFUND');

    const recoveryAudit = await db('billing_audit_events')
      .where({ customer_id: cust.id, event_type: 'LATE_PAYMENT_ON_SUPERSEDED_SUBSCRIPTION' })
      .first();
    assert.ok(recoveryAudit, 'Audit trail must preserve LATE_PAYMENT_ON_SUPERSEDED_SUBSCRIPTION');

    const outboxRow = await db('subscription_cancellation_outbox')
      .where({ subscription_id: oldPendingId })
      .first();
    assert.ok(outboxRow, 'Cancellation/recovery outbox must enqueue older mandate cleanup, NEVER newer active mandate');
    assert.notStrictEqual(outboxRow.subscription_id, newActiveId);

    const newOutbox = await db('subscription_cancellation_outbox').where({ subscription_id: newActiveId }).first();
    assert.strictEqual(newOutbox, undefined, 'Newer active mandate must NOT be cancelled');

    const acct = await db('credit_accounts').where({ customer_id: cust.id }).first();
    assert.strictEqual(Number(acct.balance_credits), 100, 'No Plus credits should be granted from late payment on superseded sub');
  });

  it('2. Checkout refuses to ignore older pending subscription when provider cancellation fails, and cleans up safely when provider cancels', async () => {
    const principalId = freshPrincipal('sup_checkout');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Sup Checkout');
    const tOld = Date.now() - 300000;
    const tNew = Date.now() - 100000;

    const oldPendingId = `pur_stale_pending_${crypto.randomUUID().slice(0, 8)}`;
    const newActiveId = `pur_newer_active_${crypto.randomUUID().slice(0, 8)}`;

    await db('subscriptions').insert([
      {
        id: oldPendingId,
        customer_id: cust.id,
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: `sub_old_pend_${oldPendingId.slice(-6)}`,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: tOld,
        current_period_end: tOld,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: cust.id }),
        created_at: tOld,
        updated_at: tOld
      },
      {
        id: newActiveId,
        customer_id: cust.id,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: `sub_new_act_${newActiveId.slice(-6)}`,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: tNew,
        current_period_end: tNew + 30 * 86400 * 1000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: cust.id }),
        created_at: tNew,
        updated_at: tNew
      }
    ]);

    // 2a: Provider cancellation fails -> checkout MUST fail closed without marking oldPendingId canceled
    paymentGatewayService.setGatewayTransport(async (req: any) => {
      if (req.action === 'query_subscription') {
        return { exists: true, status: 'created', paid_count: 0, payments: [] };
      }
      if (req.action === 'cancel_subscription') {
        throw new Error('PROVIDER_UNAVAILABLE');
      }
      throw new Error(`Unexpected action ${req.action}`);
    });

    await assert.rejects(
      async () => paymentGatewayService.createSubscriptionCheckout(principalId, 'plus', 'INR', 'razorpay'),
      /CONCURRENT_CHECKOUT_IN_PROGRESS/
    );
    const oldStillPending = await db('subscriptions').where({ id: oldPendingId }).first();
    assert.strictEqual(oldStillPending.status, 'pending', 'Must NOT mark pending subscription canceled when provider cancel failed');

    // 2b: Provider verifies unpaid & cancels old mandate -> checkout safely transitions oldPendingId -> canceled and proceeds
    paymentGatewayService.setGatewayTransport(async (req: any) => {
      if (req.action === 'query_subscription') {
        return { exists: true, status: 'created', paid_count: 0, payments: [] };
      }
      if (req.action === 'cancel_subscription') {
        return { gatewayOrderId: req.gatewaySubscriptionId || req.orderId, cancelled: true };
      }
      if (req.action === 'create_subscription') {
        return { gatewayOrderId: `sub_rzp_fresh_${Date.now()}`, shortUrl: 'https://rzp.io/i/fresh' };
      }
      return {};
    });

    const freshCheckout = await paymentGatewayService.createSubscriptionCheckout(principalId, 'plus', 'INR', 'razorpay');
    assert.ok(freshCheckout.purchaseId);
    const oldAfterProviderCancel = await db('subscriptions').where({ id: oldPendingId }).first();
    assert.strictEqual(oldAfterProviderCancel.status, 'canceled', 'Older pending checkout must transition to canceled after provider cancel');
  });

  it('3. Concurrent activation race between older pending S1 and newer S2 preserves at most one active subscription (S2)', async () => {
    const principalId = freshPrincipal('conc_race');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Concurrent Race');
    const tOld = Date.now() - 200000;
    const tNew = Date.now() - 50000;

    const s1Id = `pur_race_s1_${crypto.randomUUID().slice(0, 8)}`;
    const s2Id = `pur_race_s2_${crypto.randomUUID().slice(0, 8)}`;
    const gw1 = `sub_race_1_${crypto.randomUUID().slice(0, 8)}`;
    const gw2 = `sub_race_2_${crypto.randomUUID().slice(0, 8)}`;

    await db('subscriptions').insert([
      {
        id: s1Id,
        customer_id: cust.id,
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: gw1,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: tOld,
        current_period_end: tOld,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: cust.id, planTier: 'plus', createdAt: tOld }),
        created_at: tOld,
        updated_at: tOld
      },
      {
        id: s2Id,
        customer_id: cust.id,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: gw2,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: tNew,
        current_period_end: tNew,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: cust.id, planTier: 'pro', createdAt: tNew }),
        created_at: tNew,
        updated_at: tNew
      }
    ]);

    const e1 = `evt_race_1_${crypto.randomUUID().slice(0, 8)}`;
    const e2 = `evt_race_2_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(e1, e2);

    const b1 = JSON.stringify({
      event_id: e1,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: gw1, paid_count: 1 } },
        payment: { entity: { id: `pay_r1_${Date.now()}`, status: 'captured', amount: 39900, currency: 'INR' } }
      }
    });
    const b2 = JSON.stringify({
      event_id: e2,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: gw2, paid_count: 1 } },
        payment: { entity: { id: `pay_r2_${Date.now()}`, status: 'captured', amount: 99900, currency: 'INR' } }
      }
    });

    await Promise.all([
      paymentGatewayService.processRazorpayWebhook(b1, signRazorpay(b1)),
      paymentGatewayService.processRazorpayWebhook(b2, signRazorpay(b2))
    ]);

    const activeRows = await db('subscriptions').where({ customer_id: cust.id, status: 'active' });
    assert.strictEqual(activeRows.length, 1, 'Exactly one subscription must be active');
    assert.strictEqual(activeRows[0].id, s2Id, 'Newer subscription S2 must prevail even under concurrent race');

    const s1Row = await db('subscriptions').where({ id: s1Id }).first();
    assert.strictEqual(s1Row.status, 'superseded', 'Older pending S1 must be superseded rather than left pending');

    const acct = await db('credit_accounts').where({ customer_id: cust.id }).first();
    const lateRecovery = await db('billing_audit_events')
      .where({ customer_id: cust.id, event_type: 'LATE_PAYMENT_ON_SUPERSEDED_SUBSCRIPTION' })
      .first();
    const expectedBalance = lateRecovery ? 7600 : 10600;
    assert.strictEqual(
      Number(acct.balance_credits),
      expectedBalance,
      `Concurrent race must deterministically grant ${expectedBalance} credits (observed lateRecovery=${Boolean(lateRecovery)}) without double-granting any subscription`
    );

    const outboxS1 = await db('subscription_cancellation_outbox').where({ subscription_id: s1Id }).first();
    assert.ok(outboxS1, 'Superseded S1 mandate cancellation must be scheduled in outbox');
  });

  it('4. Cashfree premature Cycle 1 CHARGE webhook after immediate non-refundable AUTH must NOT double-grant Cycle 1 credits', async () => {
    const principalId = freshPrincipal('cf_dup_c1');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Dup Guard');
    const now = Date.now();
    const subId = `pur_cf_dup_${crypto.randomUUID().slice(0, 8)}`;

    await db('subscriptions').insert({
      id: subId,
      customer_id: cust.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: subId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId,
        customerId: cust.id,
        planTier: 'plus',
        immediateAuthChargeExpected: true,
        authorization_amount: 399,
        authorizationAmountRefund: false,
        createdAt: now
      }),
      created_at: now,
      updated_at: now
    });

    const eAuth = `evt_cf_auth_${crypto.randomUUID().slice(0, 8)}`;
    const eDupCharge = `evt_cf_dup_chg_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(eAuth, eDupCharge);

    const ts1 = String(Math.floor(Date.now() / 1000));
    const rawAuth = JSON.stringify({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: subId,
        cf_payment_id: `cf_auth_399_${Date.now()}`,
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: false, authorization_status: 'ACTIVE' }
      }
    });
    await paymentGatewayService.processCashfreeWebhook(rawAuth, signCashfree(rawAuth, ts1), ts1, { idempotencyHeader: eAuth });

    // Simulate Cashfree firing unexpected CHARGE webhooks (both current_cycle: 1 AND current_cycle: 2) during Cycle 1
    const ts2 = String(Math.floor(Date.now() / 1000));
    const dupChargePayId1 = `cf_dup_charge_c1_${Date.now()}`;
    const rawCharge1 = JSON.stringify({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: subId,
        current_cycle: 1,
        cf_payment_id: dupChargePayId1,
        payment_type: 'CHARGE',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR'
      }
    });
    await paymentGatewayService.processCashfreeWebhook(rawCharge1, signCashfree(rawCharge1, ts2), ts2, { idempotencyHeader: eDupCharge });

    // Flag provider schedule mismatch on subscription (e.g. Cashfree T+1 next_schedule_date inside Cycle 1),
    // then verify even a current_cycle: 2 premature CHARGE arriving >5 days before period end is caught
    const subBeforeC2 = await db('subscriptions').where({ id: subId }).first();
    const metaBeforeC2 = typeof subBeforeC2.metadata === 'string' ? JSON.parse(subBeforeC2.metadata) : subBeforeC2.metadata;
    await db('subscriptions').where({ id: subId }).update({
      metadata: JSON.stringify({
        ...metaBeforeC2,
        cashfreeScheduleMismatch: {
          expectedRenewal: new Date(now + 30 * 86400 * 1000).toISOString(),
          providerNextScheduleDate: new Date(now + 86400 * 1000).toISOString()
        }
      })
    });

    const eDupCharge2 = `evt_cf_dup_chg2_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(eDupCharge2);
    const rawCharge2 = JSON.stringify({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: subId,
        current_cycle: 2,
        cf_payment_id: `cf_dup_charge_c2_${Date.now()}`,
        payment_type: 'CHARGE',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR'
      }
    });
    await paymentGatewayService.processCashfreeWebhook(rawCharge2, signCashfree(rawCharge2, ts2), ts2, { idempotencyHeader: eDupCharge2 });

    // Simulate concurrent SUBSCRIPTION_STATUS_CHANGED after AUTH: must NOT clobber immediateAuthPaid metadata
    const eStatusSync = `evt_cf_stat_sync_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(eStatusSync);
    const rawStatusSync = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: {
        subscription_details: { subscription_id: subId, subscription_status: 'ACTIVE' }
      }
    });
    await paymentGatewayService.processCashfreeWebhook(rawStatusSync, signCashfree(rawStatusSync, ts2), ts2, { idempotencyHeader: eStatusSync });

    const acct = await db('credit_accounts').where({ customer_id: cust.id }).first();
    assert.strictEqual(Number(acct.balance_credits), 3100, 'Cycle 1 immediate AUTH + premature Cycle 1/2 CHARGE must NEVER grant 6,100 credits');

    const dupAudits = await db('billing_audit_events')
      .where({ customer_id: cust.id, event_type: 'DUPLICATE_CYCLE_PAYMENT_DETECTED' });
    assert.strictEqual(dupAudits.length, 2, 'Both premature Cycle 1/2 CHARGE events must be preserved in audit ledger for recovery/refund');

    const subAfter = await db('subscriptions').where({ id: subId }).first();
    const metaAfter = typeof subAfter.metadata === 'string' ? JSON.parse(subAfter.metadata) : subAfter.metadata;
    assert.strictEqual(metaAfter.immediateAuthPaid, true, 'Status sync must not clobber immediateAuthPaid flag');
  });

  it('5. Webhook endpoints fail closed when req.rawBody is missing (no JSON.stringify(req.body) fallback)', async () => {
    const app = express();
    app.use(express.json()); // Deliberately omits rawBody verify capture
    app.use('/api/billing', createBillingRoutes());
    const srv = await new Promise<http.Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;

    try {
      const bodyStr = JSON.stringify({ event: 'subscription.charged', id: 'evt_no_raw' });
      const ts = String(Math.floor(Date.now() / 1000));
      const rzpRes = await origFetch(`${url}/api/billing/webhook/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signRazorpay(bodyStr) },
        body: bodyStr
      });
      assert.strictEqual(rzpRes.status, 400);
      const rzpJson: any = await rzpRes.json();
      assert.match(String(rzpJson.error || ''), /WEBHOOK_RAW_BODY_REQUIRED/);

      const cfRes = await origFetch(`${url}/api/billing/webhook/cashfree`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signCashfree(bodyStr, ts),
          'x-webhook-timestamp': ts
        },
        body: bodyStr
      });
      assert.strictEqual(cfRes.status, 400);
      const cfJson: any = await cfRes.json();
      assert.match(String(cfJson.error || ''), /WEBHOOK_RAW_BODY_REQUIRED/);
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  it('6. Refund webhook correlates superseded subscription via payment_id and issues linked credit note', async () => {
    const principalId = freshPrincipal('sup_refund');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Sup Refund');
    const now = Date.now();
    const oldSubId = `pur_sup_ref_${crypto.randomUUID().slice(0, 8)}`;
    const oldPayId = `pay_sup_ref_${crypto.randomUUID().slice(0, 8)}`;

    await db('subscriptions').insert({
      id: oldSubId,
      customer_id: cust.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_sup_ref_${oldSubId.slice(-6)}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now - 10000,
      current_period_end: now - 10000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId, customerId: cust.id }),
      created_at: now - 10000,
      updated_at: now - 10000
    });

    // Activate S1 first so invoice + credits exist, then supersede S1 by S2
    const ev1 = `evt_sr_act_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(ev1);
    const b1 = JSON.stringify({
      event_id: ev1,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: `sub_sup_ref_${oldSubId.slice(-6)}`, paid_count: 1 } },
        payment: { entity: { id: oldPayId, status: 'captured', amount: 39900, currency: 'INR' } }
      }
    });
    await paymentGatewayService.processRazorpayWebhook(b1, signRazorpay(b1));

    await db('subscriptions').where({ id: oldSubId }).update({ status: 'superseded', updated_at: Date.now() });

    const evRef = `evt_sr_ref_${crypto.randomUUID().slice(0, 8)}`;
    createdEventIds.push(evRef);
    const bRef = JSON.stringify({
      event_id: evRef,
      event: 'refund.processed',
      payload: {
        payment: { entity: { id: oldPayId, amount: 39900, currency: 'INR' } },
        refund: { entity: { id: `rfnd_sup_${Date.now()}`, payment_id: oldPayId, amount: 39900, currency: 'INR', status: 'processed' } }
      }
    });
    const refRes = await paymentGatewayService.processRazorpayWebhook(bRef, signRazorpay(bRef));
    assert.strictEqual(refRes.status, 'PROCESSED');

    const cn = await db('billing_credit_notes').where({ subscription_id: oldSubId }).first();
    assert.ok(cn, 'Credit note must be issued even when refund correlates a superseded subscription');
  });

  it('7. TaxDeterminationService supports configurable taxRate & taxRateVersion metadata (ADR 0002)', () => {
    const customTax = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      placeOfSupply: '09',
      taxRate: 0.12,
      taxRateVersion: 'GST_TEST_12_v1'
    } as any);

    assert.strictEqual((customTax as any).taxRate, 0.12);
    assert.strictEqual((customTax as any).cgstRate, 0.06);
    assert.strictEqual((customTax as any).sgstRate, 0.06);
    assert.strictEqual((customTax as any).taxRateVersion, 'GST_TEST_12_v1');
    assert.strictEqual(customTax.taxableBase, 356.25);
    assert.strictEqual(customTax.gstAmount, 42.75);

    const prevGst = process.env.AIRA_GST_RATE;
    process.env.AIRA_GST_RATE = '';
    try {
      const emptyEnvTax = taxDeterminationService.determineTax({
        amountMinorUnits: 39900,
        currency: 'INR',
        placeOfSupply: '09'
      });
      assert.strictEqual(emptyEnvTax.taxRate, 0.18, 'Empty AIRA_GST_RATE env var must safely default to 18% GST');
    } finally {
      if (prevGst !== undefined) process.env.AIRA_GST_RATE = prevGst;
      else delete process.env.AIRA_GST_RATE;
    }
  });
});
