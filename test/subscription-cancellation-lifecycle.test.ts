import './setup-disposable-db.js';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { db, closeDb } from '../packages/db/src/index.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { resolveCallerTier } from '../apps/api/src/middleware/entitlement-guard.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';

const RZP_SECRET = 'rzp_wh_cancel_lifecycle_secret_2026';
const CF_SECRET = 'cf_wh_cancel_lifecycle_secret_2026';

function signRazorpay(rawBody: string): string {
  return crypto.createHmac('sha256', RZP_SECRET).update(rawBody).digest('hex');
}

function signCashfree(rawBody: string, tsSec: string): string {
  return crypto.createHmac('sha256', CF_SECRET).update(`${tsSec}${rawBody}`).digest('base64');
}

function futureMonth(now = Date.now()): number {
  return now + 30 * 24 * 60 * 60 * 1000;
}

describe('Paid Subscription Cancellation & Credit Lifecycle Regression Suite (17 Scenarios, PG18)', () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;
  const createdPrincipals: string[] = [];
  const createdEventIds: string[] = [];
  let appServer: http.Server | null = null;
  let baseUrl = '';

  const uid = (tag: string): string => {
    const id = `usr_cancel_reg_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    createdPrincipals.push(id);
    return id;
  };

  async function seedPaidSubscription(opts: {
    principalId: string;
    planId: 'plus' | 'pro';
    gateway: 'cashfree' | 'razorpay';
    gatewaySubId: string;
    paymentId: string;
    now?: number;
    periodEnd?: number;
    grantExtraTopupCredits?: number;
  }) {
    const now = opts.now ?? Date.now();
    const periodEnd = opts.periodEnd ?? futureMonth(now);
    const amountMinor = opts.planId === 'pro' ? 99900 : 39900;
    const customer = await commercialBillingService.getOrCreateCustomer(
      opts.principalId,
      `${opts.principalId}@virexa.test`,
      'Staging Test User'
    );

    const subId = `pur_${crypto.randomUUID().replace(/-/g, '')}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: customer.id,
      plan_id: opts.planId,
      price_id: `price_${opts.planId}_inr`,
      status: 'pending',
      gateway: opts.gateway,
      gateway_subscription_id: opts.gatewaySubId,
      currency: 'INR',
      amount_minor_units: amountMinor,
      current_period_start: now - 5000,
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId: opts.principalId,
        expectedNextRenewalAt: periodEnd,
        immediateAuthChargeExpected: opts.gateway === 'cashfree'
      }),
      created_at: now - 5000,
      updated_at: now - 5000
    });

    const eventId = `evt_seed_${opts.gateway}_${crypto.randomUUID().replace(/-/g, '')}`;
    createdEventIds.push(eventId);

    if (opts.gateway === 'cashfree') {
      const payload = {
        type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
        event_time: new Date(now).toISOString(),
        data: {
          subscription_id: subId,
          cf_subscription_id: opts.gatewaySubId,
          payment_id: opts.paymentId,
          cf_payment_id: opts.paymentId,
          payment_type: 'AUTH',
          payment_status: 'SUCCESS',
          payment_amount: amountMinor / 100,
          payment_currency: 'INR',
          authorization_details: {
            authorization_amount: amountMinor / 100,
            authorization_amount_refund: false,
            authorization_status: 'ACTIVE'
          }
        }
      };
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(now / 1000));
      const res = await paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, eventId);
      assert.equal(res.status, 'PROCESSED');
    } else {
      const payload = {
        event_id: eventId,
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: opts.gatewaySubId,
              plan_id: opts.planId === 'pro' ? 'plan_rzp_pro_999' : 'plan_rzp_plus_399',
              status: 'active',
              current_start: Math.floor(now / 1000),
              current_end: Math.floor(periodEnd / 1000),
              paid_count: 1,
              notes: { principal_id: opts.principalId, customer_id: customer.id, purchase_id: subId, plan_tier: opts.planId }
            }
          },
          payment: {
            entity: {
              id: opts.paymentId,
              amount: amountMinor,
              currency: 'INR',
              status: 'captured',
              order_id: `ord_${opts.paymentId}`
            }
          },
          invoice: {
            entity: {
              id: `inv_${opts.paymentId}`,
              subscription_id: opts.gatewaySubId,
              payment_id: opts.paymentId,
              amount: amountMinor,
              amount_paid: amountMinor,
              currency: 'INR',
              status: 'paid'
            }
          }
        }
      };
      const raw = JSON.stringify(payload);
      const res = await paymentGatewayService.processRazorpayWebhook(raw, signRazorpay(raw));
      assert.equal(res.status, 'PROCESSED');
    }

    if (opts.grantExtraTopupCredits && opts.grantExtraTopupCredits > 0) {
      await commercialBillingService.grantCredits(
        opts.principalId,
        opts.grantExtraTopupCredits,
        'purchased_topup',
        undefined,
        0,
        { idempotencyKey: `topup_seed_${opts.principalId}_${now}` }
      );
    }

    return { customer, subId, periodEnd };
  }

  async function cleanupPrincipal(pId: string) {
    const cust = await db('billing_customers').where({ principal_id: pId }).first();
    if (!cust) return;
    await db('billing_credit_notes').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_invoices').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_invoice_reconciliation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('subscription_cancellation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('subscriptions').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_audit_events').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('entitlement_snapshots').where({ customer_id: cust.id }).delete().catch(() => {});
    const acct = await db('credit_accounts').where({ customer_id: cust.id }).first();
    if (acct) {
      await db('credit_transactions').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_reservations').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_grants').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_accounts').where({ id: acct.id }).delete().catch(() => {});
    }
    await db('idempotent_operations').where({ principal_id: pId }).delete().catch(() => {});
    await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
  }

  before(async () => {
    const res = await db.raw('SELECT current_database() AS db_name');
    const dbName = String(res.rows[0]?.db_name || '');
    assert.ok(
      dbName === 'aira_test_db' || dbName === 'aira_db',
      `Must run against isolated test database, got: ${dbName}`
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const p = req.headers['x-test-principal'];
      if (typeof p === 'string' && p.trim()) {
        req.principal = { userId: p.trim(), email: `${p.trim()}@virexa.test`, name: 'Test User' } as any;
      }
      next();
    });
    app.use('/api/billing', createBillingRoutes());
    appServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = appServer.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'test';
    process.env.AIRA_ENVIRONMENT = 'staging';
    process.env.VERCEL_ENV = 'preview';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = 'cashfree';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_cancel_2026';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_cancel_2026';
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
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);

    for (const pId of createdPrincipals) {
      await cleanupPrincipal(pId);
    }
    if (createdEventIds.length > 0) {
      await db('payment_gateway_events').whereIn('event_id', createdEventIds).delete().catch(() => {});
    }
    if (appServer) {
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    }
    await closeDb();
  });

  it('1. Cashfree Pro immediate cancellation preserves Pro entitlements, 7,600 credits, chats, boosts, and renewal-cancelled summary', async () => {
    const p = uid('cf_pro_cancel');
    const gwSubId = `1479507678_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `1479507718_${Date.now()}`
    });

    // Cashfree /manage { action: CANCEL } returns OK, then fires SUBSCRIPTION_STATUS_CHANGED CANCELLED
    global.fetch = (async () => new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 })) as any;

    const cancelRes = await paymentGatewayService.cancelSubscription(p);
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.gatewayCancelled, true);

    const whBody = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: {
        subscription_details: {
          subscription_id: subId,
          cf_subscription_id: gwSubId,
          subscription_status: 'CANCELLED'
        }
      }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const evId = `evt_cf_pro_cancel_${Date.now()}`;
    createdEventIds.push(evId);
    const whRes = await paymentGatewayService.processCashfreeWebhook(whBody, signCashfree(whBody, ts), ts, evId);
    assert.equal(whRes.status, 'PROCESSED');

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'pro', 'Cancelled Cashfree Pro must remain on pro until current_period_end');
    assert.equal(ent.availableCredits, 7600);
    assert.equal(ent.dailyStandardChatLimit, 150);
    assert.equal(ent.monthlyStandardChatUnitsLimit, 2000);
    assert.equal(ent.reasoningBoostsLimit, 200);
    assert.equal(ent.savedAgentsLimit, 20);
    assert.equal(ent.builderAccess, 'metered');

    const tier = await resolveCallerTier({ principal: { userId: p } } as any);
    assert.equal(tier, 'pro', 'Entitlement middleware must keep pro access active until period end');

    // User can still spend credits & use Pro quotas after cancellation
    const hold = await commercialBillingService.reserveCredits(p, 50, 'vision_generate', 'post_cancel_spend');
    const settled = await commercialBillingService.settleReservation(hold.reservationId, 50);
    assert.equal(settled.balanceAfter, 7550);
    assert.equal(await commercialBillingService.tryConsumeReasoningBoost(p), true);

    const lifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(p);
    assert.ok(lifecycle.activeSubscription, 'Active period-end subscription must stay visible');
    assert.equal(lifecycle.activeSubscription?.planId, 'pro');
    assert.equal(lifecycle.activeSubscription?.cancelAtPeriodEnd, true);
    assert.equal((lifecycle as any).latestSubscriptionLifecycle?.state, 'ACTIVE_CANCEL_SCHEDULED');
  });

  it('2. Cashfree Plus immediate cancellation preserves Plus entitlements until current_period_end', async () => {
    const p = uid('cf_plus_cancel');
    const gwSubId = `cf_plus_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'plus',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_plus_${Date.now()}`
    });

    global.fetch = (async () => new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 })) as any;
    await paymentGatewayService.cancelSubscription(p);

    const whBody = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const evId = `evt_cf_plus_cancel_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(whBody, signCashfree(whBody, ts), ts, evId);

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'plus');
    assert.equal(ent.availableCredits, 3100);
    assert.equal(ent.dailyStandardChatLimit, 50);
    assert.equal(ent.reasoningBoostsLimit, 50);
    assert.equal(ent.savedAgentsLimit, 3);
  });

  it('3. Razorpay Pro & Plus cancellation uses cancel_at_cycle_end: 1 and preserves paid entitlements cleanly', async () => {
    const p = uid('rzp_cancel');
    const gwSubId = `sub_rzp_${Date.now()}`;
    await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'razorpay',
      gatewaySubId: gwSubId,
      paymentId: `pay_rzp_${Date.now()}`
    });

    let sentCancelBody: any = null;
    global.fetch = (async (_url: any, init: any) => {
      sentCancelBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ id: gwSubId, status: 'active', cancel_at_cycle_end: 1 }), { status: 200 });
    }) as any;

    const cancelRes = await paymentGatewayService.cancelSubscription(p);
    assert.equal(cancelRes.success, true);
    assert.deepEqual(sentCancelBody, { cancel_at_cycle_end: 1 });

    // Even before end-of-cycle webhook or immediately if subscription.cancelled fires early:
    const whRaw = JSON.stringify({
      event_id: `evt_rzp_cancel_${Date.now()}`,
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { id: gwSubId, status: 'cancelled' } } }
    });
    const hookRes = await paymentGatewayService.processRazorpayWebhook(whRaw, signRazorpay(whRaw));
    assert.equal(hookRes.status, 'PROCESSED');

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'pro');
    assert.equal(ent.availableCredits, 7600);
    const subRow = await db('subscriptions').where({ gateway_subscription_id: gwSubId }).first();
    assert.equal(subRow.cancel_at_period_end, true);
  });

  it('4. Cashfree SUBSCRIPTION_STATUS_CHANGED CANCELLED webhook preserves historical paid invoice and period-end state', async () => {
    const p = uid('cf_wh_preserve');
    const gwSubId = `cf_wh_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_wh_${Date.now()}`
    });

    const whBody = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const evId = `evt_cf_wh4_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(whBody, signCashfree(whBody, ts), ts, evId);

    const invoices = await paymentGatewayService.getInvoices(p);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].status, 'Paid');
    assert.equal(invoices[0].totalAmount, 999);
  });

  it('5. Razorpay subscription.cancelled webhook after paid activation retains period-end access', async () => {
    const p = uid('rzp_wh5');
    const gwSubId = `sub_rzp5_${Date.now()}`;
    await seedPaidSubscription({
      principalId: p,
      planId: 'plus',
      gateway: 'razorpay',
      gatewaySubId: gwSubId,
      paymentId: `pay_rzp5_${Date.now()}`
    });

    const whRaw = JSON.stringify({
      event_id: `evt_rzp_wh5_${Date.now()}`,
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { id: gwSubId, status: 'cancelled' } } }
    });
    await paymentGatewayService.processRazorpayWebhook(whRaw, signRazorpay(whRaw));

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'plus');
    assert.equal(ent.availableCredits, 3100);
    const tier = await resolveCallerTier({ principal: { userId: p } } as any);
    assert.equal(tier, 'plus');
  });

  it('6. Duplicate / idempotent cancellation webhook delivery causes no corruption or duplicate audit anomalies', async () => {
    const p = uid('dup_cancel_wh');
    const gwSubId = `cf_dup_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_dup_${Date.now()}`
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const evId = `evt_dup_cancel_${Date.now()}`;
    createdEventIds.push(evId);

    const first = await paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, evId);
    const second = await paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, evId);
    assert.equal(first.status, 'PROCESSED');
    assert.equal(second.duplicate, true);

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'pro');
    assert.equal(ent.availableCredits, 7600);
  });

  it('7. Expired paid period (current_period_end <= now) falls back cleanly to Free tier', async () => {
    const p = uid('expired_fallback');
    const gwSubId = `cf_exp_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_exp_${Date.now()}`
    });

    const pastEnd = Date.now() - 60_000;
    await db('subscriptions').where({ id: subId }).update({
      status: 'cancelled',
      cancel_at_period_end: true,
      current_period_start: pastEnd - 30 * 86400_000,
      current_period_end: pastEnd
    });

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'free');
    assert.equal(ent.dailyStandardChatLimit, 15);
    assert.equal(ent.reasoningBoostsLimit, 5);
    assert.equal(ent.savedAgentsLimit, 0);

    const tier = await resolveCallerTier({ principal: { userId: p } } as any);
    assert.equal(tier, 'free');

    const lifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(p);
    assert.equal(lifecycle.activeSubscription, null);
    assert.equal((lifecycle as any).latestSubscriptionLifecycle?.state, 'EXPIRED');
  });

  it('8. Subscription credit expiry expires stale subscription grants while preserving unrelated/topup credits', async () => {
    const p = uid('credit_expiry');
    const gwSubId = `cf_cred_exp_${Date.now()}`;
    const pastEnd = Date.now() - 10_000;
    const { customer } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_cexp_${Date.now()}`,
      grantExtraTopupCredits: 500
    });

    // Spend 1,000 credits cleanly before expiration (leaves 7,100: 100 welcome + 7500 pro + 500 topup - 1000)
    const hold = await commercialBillingService.reserveCredits(p, 1000, 'deep_research', 'before_expiry');
    await commercialBillingService.settleReservation(hold.reservationId, 1000);

    // Expire ONLY the subscription_monthly grants by moving expires_at <= now (leave topup non-expiring and welcome grant unexpired)
    const acct = await db('credit_accounts').where({ customer_id: customer.id }).first();
    await db('credit_grants')
      .where({ account_id: acct.id })
      .whereRaw("metadata->>'note' IS NULL")
      .where({ grant_type: 'subscription_monthly' })
      .update({ expires_at: pastEnd });

    const entAfterExpiry = await commercialBillingService.getEntitlements(p);
    // Purchased topup (500) + whatever non-expired grants remain — expired subscription grant must NOT stay spendable
    assert.ok(entAfterExpiry.availableCredits < 1500, `Expired subscription credits must not remain spendable, got ${entAfterExpiry.availableCredits}`);
    assert.ok(entAfterExpiry.availableCredits >= 500, `Purchased top-up (500) must survive subscription expiry, got ${entAfterExpiry.availableCredits}`);

    // Attempting to spend the expired subscription balance fails closed
    await assert.rejects(
      () => commercialBillingService.reserveCredits(p, 2000, 'vision_generate', 'after_expiry_spend')
    );
  });

  it('9. Unpaid abandoned checkout cancellation stays Free, grants zero paid credits, and creates zero invoices', async () => {
    const p = uid('unpaid_cancel');
    const customer = await commercialBillingService.getOrCreateCustomer(p);
    const subId = `pur_unpaid_${Date.now()}`;
    const gwSubId = `cf_unpaid_${Date.now()}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: customer.id,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gwSubId,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: Date.now(),
      current_period_end: futureMonth(),
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: p }),
      created_at: Date.now(),
      updated_at: Date.now()
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      type: 'SUBSCRIPTION_CANCELLED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const evId = `evt_unpaid_cancel_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, evId);

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'free');
    assert.equal(ent.availableCredits, 100);
    assert.deepEqual(await paymentGatewayService.getInvoices(p), []);
  });

  it('10. Full refund revokes Pro access & subscription credits cleanly without wiping welcome/topup credits and preserves invoice + credit note', async () => {
    const p = uid('full_refund');
    const gwSubId = `cf_ref_${Date.now()}`;
    const payId = `cf_pay_ref_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: payId,
      grantExtraTopupCredits: 500
    });

    const whBody = JSON.stringify({
      type: 'REFUND_SUCCESS',
      event_time: new Date().toISOString(),
      data: {
        refund: { cf_refund_id: `rfnd_${Date.now()}`, cf_payment_id: payId, refund_amount: 999, refund_currency: 'INR', order_id: gwSubId },
        payment: { cf_payment_id: payId, order_id: gwSubId },
        order: { order_id: gwSubId }
      }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const evId = `evt_full_refund_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(whBody, signCashfree(whBody, ts), ts, evId);

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'free');
    assert.equal(ent.availableCredits, 600, 'Welcome 100 + Topup 500 must survive full refund of Pro subscription');

    const invoices = await paymentGatewayService.getInvoices(p);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].status, 'Refunded');
    assert.ok(invoices[0].creditNoteNumber, 'Credit note number must be preserved');

    const lifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(p);
    assert.equal(lifecycle.activeSubscription, null);
    assert.equal((lifecycle as any).latestSubscriptionLifecycle?.state, 'REFUNDED');
  });

  it('11. Partial refund preserves active period, issues partial credit note & proportional credit adjustment without wiping unrelated credits', async () => {
    const p = uid('partial_refund');
    const gwSubId = `sub_pref_${Date.now()}`;
    const payId = `pay_pref_${Date.now()}`;
    await seedPaidSubscription({
      principalId: p,
      planId: 'plus',
      gateway: 'razorpay',
      gatewaySubId: gwSubId,
      paymentId: payId,
      grantExtraTopupCredits: 200
    });

    const whRaw = JSON.stringify({
      event_id: `evt_pref_${Date.now()}`,
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: `rfnd_p_${Date.now()}`, payment_id: payId, amount: 19950, currency: 'INR' } },
        payment: { entity: { id: payId, order_id: gwSubId, currency: 'INR' } }
      }
    });
    await paymentGatewayService.processRazorpayWebhook(whRaw, signRazorpay(whRaw));

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'plus');
    // Welcome (100) + Topup (200) untouched; Plus 3000 adjusted by ~50% => ~1800 total remaining
    assert.equal(ent.availableCredits, 1800);

    const invoices = await paymentGatewayService.getInvoices(p);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].status, 'Partially Refunded');
  });

  it('12. Failed cancellation preserves active renewal, surfaces CANCELLATION_FAILED, and succeeds cleanly on retry', async () => {
    const p = uid('fail_retry_cancel');
    const gwSubId = `cf_fail_${Date.now()}`;
    await seedPaidSubscription({
      principalId: p,
      planId: 'plus',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_fail_${Date.now()}`
    });

    global.fetch = (async () => new Response('Upstream gateway timeout', { status: 503 })) as any;
    const failedRes = await paymentGatewayService.cancelSubscription(p);
    assert.equal(failedRes.success, false);
    assert.equal(failedRes.gatewayCancelled, false);

    const failedLifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(p);
    assert.equal(failedLifecycle.activeSubscription?.cancelAtPeriodEnd, false);
    assert.equal((failedLifecycle as any).latestSubscriptionLifecycle?.state, 'CANCELLATION_FAILED');

    // Retry succeeds
    global.fetch = (async () => new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 })) as any;
    const okRes = await paymentGatewayService.cancelSubscription(p);
    assert.equal(okRes.success, true);
    assert.equal(okRes.gatewayCancelled, true);
  });

  it('13. Attempting same-tier repurchase during active cancelled period is blocked; upgrading Plus->Pro is permitted', async () => {
    const p = uid('repurchase_rule');
    const gwSubId = `cf_re_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'plus',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_re_${Date.now()}`
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const evId = `evt_re_c_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, evId);

    // Same tier Plus checkout while Plus paid period is active -> blocked safely
    await assert.rejects(
      () => paymentGatewayService.createSubscriptionCheckout(p, 'plus', 'INR', 'cashfree', { userId: p, email: `${p}@virexa.test` }, { phone: '9876543210' }),
      (err: any) => /PAID_PERIOD_STILL_ACTIVE|ALREADY_SUBSCRIBED/i.test(String(err?.message))
    );

    // Upgrade to Pro IS permitted
    global.fetch = (async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com') || String(url).includes('razorpay.com')) {
        return new Response(JSON.stringify({
          subscription_id: `sub_cf_up_${Date.now()}`,
          subscription_session_id: 'sess_up_pro',
          auth_link: 'https://sandbox.cashfree.com/pg/subscriptions/test'
        }), { status: 200 });
      }
      return origFetch(url, init);
    }) as any;

    const proCo = await paymentGatewayService.createSubscriptionCheckout(
      p,
      'pro',
      'INR',
      'cashfree',
      { userId: p, email: `${p}@virexa.test` },
      { phone: '9876543210' }
    );
    assert.ok(proCo.purchaseId);
  });

  it('14. Late recurring charge / renewal webhook after cancellation is rejected terminally with zero extra credits or invoices', async () => {
    const p = uid('late_charge');
    const gwSubId = `sub_late_${Date.now()}`;
    await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'razorpay',
      gatewaySubId: gwSubId,
      paymentId: `pay_late_1_${Date.now()}`
    });

    global.fetch = (async () => new Response(JSON.stringify({ id: gwSubId, status: 'active' }), { status: 200 })) as any;
    await paymentGatewayService.cancelSubscription(p);

    const lateRaw = JSON.stringify({
      event_id: `evt_late_charge_${Date.now()}`,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: gwSubId, paid_count: 2, status: 'active' } },
        payment: { entity: { id: `pay_late_2_${Date.now()}`, amount: 99900, currency: 'INR', status: 'captured' } }
      }
    });
    await assert.rejects(
      () => paymentGatewayService.processRazorpayWebhook(lateRaw, signRazorpay(lateRaw)),
      (err: any) => err?.name === 'TerminalRejectionError' && /INVALID_STATE_TRANSITION/.test(String(err?.message))
    );

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.availableCredits, 7600, 'Must NOT grant second cycle credits after cancellation');
    assert.equal((await paymentGatewayService.getInvoices(p)).length, 1);
  });

  it('15. Concurrent cancel API + cancel webhook resolve cleanly without downgrading or corrupting period-end access', async () => {
    const p = uid('conc_cancel');
    const gwSubId = `cf_conc_${Date.now()}`;
    const { subId } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_conc_${Date.now()}`
    });

    global.fetch = (async () => new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 })) as any;

    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const evId = `evt_conc_c_${Date.now()}`;
    createdEventIds.push(evId);

    await Promise.all([
      paymentGatewayService.cancelSubscription(p),
      paymentGatewayService.processCashfreeWebhook(raw, signCashfree(raw, ts), ts, evId)
    ]);

    const ent = await commercialBillingService.getEntitlements(p);
    assert.equal(ent.plan, 'pro');
    assert.equal(ent.availableCredits, 7600);
    const lifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(p);
    assert.equal(lifecycle.activeSubscription?.cancelAtPeriodEnd, true);
  });

  it('16. Cross-account isolation: cancelling or refunding User A never alters User B subscriptions, credits, or HTTP summary', async () => {
    const userA = uid('iso_a');
    const userB = uid('iso_b');
    const gwA = `cf_iso_a_${Date.now()}`;
    const gwB = `cf_iso_b_${Date.now()}`;
    const { subId: subA } = await seedPaidSubscription({
      principalId: userA,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwA,
      paymentId: `cf_pay_iso_a_${Date.now()}`
    });
    await seedPaidSubscription({
      principalId: userB,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwB,
      paymentId: `cf_pay_iso_b_${Date.now()}`
    });

    global.fetch = (async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com') || String(url).includes('razorpay.com')) {
        return new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 });
      }
      return origFetch(url, init);
    }) as any;
    await origFetch(`${baseUrl}/api/billing/subscription/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': userA }
    });

    // Refund User A as well
    const ts = String(Math.floor(Date.now() / 1000));
    const refundBody = JSON.stringify({
      type: 'REFUND_SUCCESS',
      event_time: new Date().toISOString(),
      data: {
        refund: { cf_refund_id: `rfnd_iso_a_${Date.now()}`, refund_amount: 999, refund_currency: 'INR', order_id: gwA },
        order: { order_id: gwA }
      }
    });
    const evId = `evt_iso_ref_a_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(refundBody, signCashfree(refundBody, ts), ts, evId);

    const entA = await commercialBillingService.getEntitlements(userA);
    const entB = await commercialBillingService.getEntitlements(userB);
    assert.equal(entA.plan, 'free');
    assert.equal(entB.plan, 'pro');
    assert.equal(entB.availableCredits, 7600);

    const sumB = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { 'x-test-principal': userB }
    });
    const sumBBody: any = await sumB.json();
    assert.equal(sumBBody.planId, 'pro');
    assert.equal(sumBBody.activeSubscription?.cancelAtPeriodEnd, false);
    assert.notEqual(sumBBody.activeSubscription?.id, subA);
  });

  it('17. HTTP /api/billing/summary returns complete distinct lifecycle states & UI copy metadata across Active, Renewal Cancelled, Pending, Expired, Refunded', async () => {
    const p = uid('ui_summary');
    const gwSubId = `cf_ui_${Date.now()}`;
    const { subId, periodEnd } = await seedPaidSubscription({
      principalId: p,
      planId: 'pro',
      gateway: 'cashfree',
      gatewaySubId: gwSubId,
      paymentId: `cf_pay_ui_${Date.now()}`
    });

    const s1: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(s1.planId, 'pro');
    assert.equal(s1.subscriptionLifecycle?.state, 'ACTIVE_RENEWING');

    // Simulate CANCELLATION_PENDING (Cashfree requested, webhook not yet delivered)
    global.fetch = (async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com') || String(url).includes('razorpay.com')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return origFetch(url, init);
    }) as any;
    await paymentGatewayService.cancelSubscription(p);
    const sPendingCancel: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(sPendingCancel.planId, 'pro');
    assert.equal(sPendingCancel.subscriptionLifecycle?.state, 'CANCELLATION_PENDING');

    const ts = String(Math.floor(Date.now() / 1000));
    const whBody = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date().toISOString(),
      data: { subscription_details: { subscription_id: subId, cf_subscription_id: gwSubId, subscription_status: 'CANCELLED' } }
    });
    const evId = `evt_ui_c_${Date.now()}`;
    createdEventIds.push(evId);
    await paymentGatewayService.processCashfreeWebhook(whBody, signCashfree(whBody, ts), ts, evId);

    const s2: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(s2.planId, 'pro');
    assert.equal(s2.activeSubscription?.cancelAtPeriodEnd, true);
    assert.equal(s2.activeSubscription?.currentPeriodEnd, periodEnd);
    assert.equal(s2.subscriptionLifecycle?.state, 'ACTIVE_CANCEL_SCHEDULED');
    assert.equal(s2.subscriptionLifecycle?.planName, 'AIRA Pro');

    // Expired state after current_period_end passes
    await db('subscriptions').where({ id: subId }).update({ current_period_end: Date.now() - 1000 });
    const sExpired: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(sExpired.planId, 'free');
    assert.equal(sExpired.subscriptionLifecycle?.state, 'EXPIRED');

    // Refunded state
    await db('subscriptions').where({ id: subId }).update({
      status: 'refunded',
      current_period_end: periodEnd,
      metadata: JSON.stringify({ refunded: true, refundedAt: Date.now(), refundAmount: 999, creditNoteNumber: 'CN-2026-0001' })
    });
    const sRefunded: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(sRefunded.planId, 'free');
    assert.equal(sRefunded.subscriptionLifecycle?.state, 'REFUNDED');
    assert.equal(sRefunded.subscriptionLifecycle?.creditNoteNumber, 'CN-2026-0001');

    // Payment pending state
    await db('subscriptions').insert({
      id: `pur_pend_${Date.now()}`,
      customer_id: (await db('billing_customers').where({ principal_id: p }).first()).id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_pend_ui_${Date.now()}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: Date.now(),
      current_period_end: futureMonth(),
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: p }),
      created_at: Date.now(),
      updated_at: Date.now()
    });
    const sPendingPay: any = await (await origFetch(`${baseUrl}/api/billing/summary`, { headers: { 'x-test-principal': p } })).json();
    assert.equal(sPendingPay.subscriptionLifecycle?.state, 'PAYMENT_PENDING');
    assert.ok(sPendingPay.pendingSubscription);
  });
});
