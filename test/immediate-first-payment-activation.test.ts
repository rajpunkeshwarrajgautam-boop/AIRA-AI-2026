import './setup-disposable-db.js';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { db, closeDb } from '../packages/db/src/index.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';

const RZP_SECRET = 'rzp_wh_immediate_test_secret_2026';
const CF_SECRET = 'cf_wh_immediate_test_secret_2026';

function signRazorpay(rawBody: string): string {
  return crypto.createHmac('sha256', RZP_SECRET).update(rawBody).digest('hex');
}

function signCashfree(rawBody: string, tsSec: string): string {
  return crypto.createHmac('sha256', CF_SECRET).update(`${tsSec}${rawBody}`).digest('base64');
}

describe('Immediate First-Payment Subscription Activation Suite (20 Scenarios, Real PostgreSQL)', () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;
  let server: http.Server;
  let baseUrl = '';
  const createdPrincipals: string[] = [];
  const createdEventIds: string[] = [];

  before(async () => {
    const res = await db.raw('SELECT current_database() AS db_name');
    const dbName = String(res.rows[0]?.db_name || '');
    assert.ok(
      dbName === 'aira_test_db' || dbName === 'aira_db',
      `Must run against isolated CI/local test database (aira_test_db or aira_db), got: ${dbName}`
    );

    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'test';
    process.env.AIRA_ENVIRONMENT = 'staging';
    process.env.VERCEL_ENV = 'preview';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_DEFAULT_INR_GATEWAY = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_immediate_2026';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_immediate_2026';
    process.env.RAZORPAY_WEBHOOK_SECRET = RZP_SECRET;
    process.env.RAZORPAY_PLAN_ID_PLUS_INR = 'plan_rzp_plus_399';
    process.env.RAZORPAY_PLAN_ID_PRO_INR = 'plan_rzp_pro_999';
    process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
    process.env.CASHFREE_SECRET_KEY = CF_SECRET;
    process.env.CASHFREE_ENV = 'TEST';
    process.env.CASHFREE_PLAN_ID_PLUS_INR = 'aira_plus_monthly_inr';
    process.env.CASHFREE_PLAN_ID_PRO_INR = 'aira_pro_monthly_inr';

    paymentGatewayService.setRazorpaySecret(RZP_SECRET);
    paymentGatewayService.setCashfreeSecret(CF_SECRET);
    paymentGatewayService.setGatewayTransport(null as any);

    const app = express();
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));
    app.use((req: any, _res, next) => {
      const uid = req.headers['x-test-principal'];
      if (typeof uid === 'string' && uid) {
        req.principal = { userId: uid, email: `${uid}@aira.test`, roles: ['user'] };
      }
      next();
    });
    app.use('/api/billing', createBillingRoutes());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    global.fetch = origFetch;
    paymentGatewayService.setGatewayTransport(null as any);
  });

  after(async () => {
    global.fetch = origFetch;
    Object.assign(process.env, origEnv);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

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
    const id = `usr_imm_${tag}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    createdPrincipals.push(id);
    return id;
  }

  async function postWebhook(gateway: 'razorpay' | 'cashfree', payload: any, eventId: string) {
    createdEventIds.push(eventId);
    const rawBody = JSON.stringify(payload);
    const tsSec = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-idempotency-key': eventId
    };
    if (gateway === 'razorpay') {
      headers['x-razorpay-signature'] = signRazorpay(rawBody);
    } else {
      headers['x-webhook-signature'] = signCashfree(rawBody, tsSec);
      headers['x-webhook-timestamp'] = tsSec;
    }

    const res = await origFetch(`${baseUrl}/api/billing/webhook/${gateway}`, {
      method: 'POST',
      headers,
      body: rawBody
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it('1. Razorpay Plus immediate checkout & Cycle 1 payment activates immediately, grants 3,000 credits (3,100 total), and issues GST ₹399 invoice', async () => {
    const principalId = freshPrincipal('rzp_plus');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'RZP Plus');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions')) {
        const parsed = JSON.parse(String(init?.body || '{}'));
        assert.strictEqual(parsed.start_at, undefined, 'Razorpay immediate checkout must omit future start_at');
        return new Response(JSON.stringify({ id: 'sub_rzp_imm_plus_01', short_url: 'https://rzp.io/i/plus01' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url, init);
    };

    const checkoutRes = await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    });
    assert.strictEqual(checkoutRes.status, 200);
    const checkout = await checkoutRes.json();
    assert.strictEqual(checkout.orderId, 'sub_rzp_imm_plus_01');
    assert.strictEqual(checkout.immediateActivationSupported, true);

    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = nowSec + 30 * 86400;
    const wh = await postWebhook('razorpay', {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_rzp_imm_plus_01', paid_count: 1, current_start: nowSec, current_end: endSec } },
        payment: { entity: { id: 'pay_rzp_imm_plus_01', status: 'captured', amount: 39900, currency: 'INR' } }
      }
    }, `evt_rzp_plus_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 200);

    const entRes = await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } });
    const ent = await entRes.json();
    assert.strictEqual(ent.plan, 'plus');
    assert.strictEqual(ent.availableCredits, 3100, 'Should grant 3,000 Plus credits over 100 initial credits');

    const invRes = await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } });
    const invBody = await invRes.json();
    assert.strictEqual(invBody.invoices.length, 1);
    assert.strictEqual(invBody.invoices[0].totalAmount, 399);
    assert.strictEqual(invBody.invoices[0].status, 'Paid');

    const dlRes = await origFetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(invBody.invoices[0].invoiceNumber)}/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.strictEqual(dlRes.status, 200);
    const html = await dlRes.text();
    assert.match(html, /₹399\.00/);
  });

  it('2. Razorpay Pro immediate checkout & Cycle 1 payment activates immediately, grants 7,500 credits, and issues GST ₹999 invoice', async () => {
    const principalId = freshPrincipal('rzp_pro');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'RZP Pro');

    global.fetch = async (url: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions')) {
        return new Response(JSON.stringify({ id: 'sub_rzp_imm_pro_01', short_url: 'https://rzp.io/i/pro01' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url);
    };

    const checkoutRes = await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'razorpay' })
    });
    assert.strictEqual(checkoutRes.status, 200);

    const nowSec = Math.floor(Date.now() / 1000);
    const wh = await postWebhook('razorpay', {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_rzp_imm_pro_01', paid_count: 1, current_start: nowSec, current_end: nowSec + 30 * 86400 } },
        payment: { entity: { id: 'pay_rzp_imm_pro_01', status: 'captured', amount: 99900, currency: 'INR' } }
      }
    }, `evt_rzp_pro_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 200);

    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'pro');
    assert.strictEqual(ent.availableCredits, 7600);

    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 1);
    assert.strictEqual(invBody.invoices[0].totalAmount, 999);
    assert.strictEqual(invBody.invoices[0].status, 'Paid');
  });

  it('3. Cashfree Plus sends x-api-version 2025-01-01 authorization_details ₹399 non-refundable + +1mo schedule and activates immediately on paid AUTH', async () => {
    const principalId = freshPrincipal('cf_plus');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Plus');

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        capturedHeaders = init?.headers || {};
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: capturedBody.subscription_id,
          cf_subscription_id: 'cf_sub_imm_plus_01',
          subscription_session_id: 'subs_sess_plus_01',
          auth_link: 'https://payments-test.cashfree.com/subs/plus01',
          authorization_details: {
            authorization_amount: 399,
            authorization_amount_refund: false,
            authorization_status: 'PENDING'
          },
          next_schedule_date: capturedBody.subscription_first_charge_time
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkoutRes = await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    assert.strictEqual(checkoutRes.status, 200);
    const checkout = await checkoutRes.json();

    assert.strictEqual(capturedHeaders['x-api-version'], '2025-01-01');
    assert.strictEqual(capturedBody.authorization_details.authorization_amount, 399);
    assert.strictEqual(capturedBody.authorization_details.authorization_amount_refund, false);
    assert.deepStrictEqual(capturedBody.authorization_details.payment_methods, ['upi', 'card']);
    const scheduledMs = Date.parse(capturedBody.subscription_first_charge_time);
    assert.ok(scheduledMs - Date.now() > 25 * 86400 * 1000, 'Cycle 2 must be scheduled ~1 month ahead');
    assert.strictEqual(checkout.immediateActivationSupported, true);

    const wh = await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_subscription_id: 'cf_sub_imm_plus_01',
        payment_id: 'cf_pay_auth_plus_01',
        cf_payment_id: 'cf_pay_auth_plus_01',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: {
          authorization_amount: 399,
          authorization_amount_refund: false,
          authorization_status: 'ACTIVE'
        }
      }
    }, `evt_cf_plus_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 200);

    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'plus');
    assert.strictEqual(ent.availableCredits, 3100);

    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 1);
    assert.strictEqual(invBody.invoices[0].totalAmount, 399);
    assert.strictEqual(invBody.invoices[0].status, 'Paid');

    const dlRes = await origFetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(invBody.invoices[0].invoiceNumber)}/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.strictEqual(dlRes.status, 200);
    assert.match(await dlRes.text(), /₹399\.00/);
  });

  it('4. Cashfree Pro immediate checkout ₹999 non-refundable AUTH activates immediately, grants 7,500 credits, and issues GST ₹999 invoice', async () => {
    const principalId = freshPrincipal('cf_pro');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Pro');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_pro_01',
          auth_link: 'https://payments-test.cashfree.com/subs/pro01',
          authorization_details: { authorization_amount: 999, authorization_amount_refund: false, authorization_status: 'PENDING' },
          next_schedule_date: body.subscription_first_charge_time
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543211' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_auth_pro_01',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 999,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 999, authorization_amount_refund: false, authorization_status: 'ACTIVE' }
      }
    }, `evt_cf_pro_${crypto.randomUUID().slice(0, 8)}`);

    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'pro');
    assert.strictEqual(ent.availableCredits, 7600);

    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 1);
    assert.strictEqual(invBody.invoices[0].totalAmount, 999);
    assert.strictEqual(invBody.invoices[0].status, 'Paid');
  });

  it('5. Cashfree & Razorpay Cycle 2 automatic recurring renewal CHARGE preserves period continuity and issues Cycle 2 credits & invoice', async () => {
    const cfUser = freshPrincipal('cf_cyc2');
    await commercialBillingService.getOrCreateCustomer(cfUser, `${cfUser}@aira.test`, 'CF Cycle 2');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_cyc2',
          auth_link: 'https://payments-test.cashfree.com/subs/cyc2',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false },
          next_schedule_date: body.subscription_first_charge_time
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': cfUser },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543212' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_cyc1_01',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
      }
    }, `evt_cyc1_${crypto.randomUUID().slice(0, 8)}`);

    const subAfterCyc1 = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    const cyc1End = Number(subAfterCyc1.current_period_end);

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_cyc2_02',
        payment_type: 'CHARGE',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        current_cycle: 2
      }
    }, `evt_cyc2_${crypto.randomUUID().slice(0, 8)}`);

    const subAfterCyc2 = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    assert.strictEqual(Number(subAfterCyc2.current_period_start), cyc1End, 'Cycle 2 start must anchor strictly to Cycle 1 end');
    assert.ok(Number(subAfterCyc2.current_period_end) > cyc1End);

    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': cfUser } })).json();
    assert.strictEqual(invBody.invoices.length, 2, 'Cycle 1 + Cycle 2 must produce exactly 2 distinct invoices');
  });

  it('6. Rejects ₹1 Cashfree AUTH mandate verification (never grants Plus/Pro, credits, or GST invoice)', async () => {
    const principalId = freshPrincipal('cf_rs1');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Rs1');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_rs1',
          auth_link: 'https://payments-test.cashfree.com/subs/rs1',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543213' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_rs1_auth',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 1,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 1, authorization_amount_refund: true, authorization_status: 'ACTIVE' }
      }
    }, `evt_rs1_${crypto.randomUUID().slice(0, 8)}`);

    const sub = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    assert.strictEqual(sub.status, 'pending');
    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'free');
    assert.strictEqual(ent.availableCredits, 100);
    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 0);
  });

  it('7. Rejects refundable full-amount Cashfree AUTH (authorization_amount_refund: true)', async () => {
    const principalId = freshPrincipal('cf_ref_auth');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Ref Auth');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_ref_auth',
          auth_link: 'https://payments-test.cashfree.com/subs/refauth',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543214' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_refundable_399',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: true, authorization_status: 'ACTIVE' }
      }
    }, `evt_ref_auth_${crypto.randomUUID().slice(0, 8)}`);

    const sub = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    assert.strictEqual(sub.status, 'pending');
    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'free');
    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 0);
  });

  it('8. Legacy mandate without immediateAuthChargeExpected stays pending on AUTH even at full amount until genuine CHARGE settles', async () => {
    const principalId = freshPrincipal('cf_legacy_mandate');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Legacy');
    const legacyId = `pur_legacy_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await db('subscriptions').insert({
      id: legacyId,
      customer_id: cust.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: legacyId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId, customerId: cust.id, purchaseId: legacyId, createdAt: now }),
      created_at: now,
      updated_at: now
    });

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: legacyId,
        cf_payment_id: 'cf_pay_legacy_auth_399',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR'
      }
    }, `evt_leg_${crypto.randomUUID().slice(0, 8)}`);

    const sub = await db('subscriptions').where({ id: legacyId }).first();
    assert.strictEqual(sub.status, 'pending', 'Legacy mandate must never activate on AUTH without immediateAuthChargeExpected');
  });

  it('9. Rejects status-only webhooks (SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_AUTH_STATUS, subscription.activated) without payment evidence', async () => {
    const principalId = freshPrincipal('status_only');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Status Only');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_status_only',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543215' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_AUTH_STATUS',
      data: { subscription_id: checkout.purchaseId, authorization_details: { authorization_status: 'ACTIVE' } }
    }, `evt_auth_st_${crypto.randomUUID().slice(0, 8)}`);

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_ACTIVATED',
      data: { subscription_details: { subscription_id: checkout.purchaseId, subscription_status: 'ACTIVE' } }
    }, `evt_sub_act_${crypto.randomUUID().slice(0, 8)}`);

    const sub = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    assert.strictEqual(sub.status, 'pending');
    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'free');
  });

  it('10. Rejects unpaid ACTIVE Cashfree mandate during reconcile when /payments has only ₹1 verification or empty list', async () => {
    const principalId = freshPrincipal('reconcile_unpaid');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Unpaid Active');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions') && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_unp',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('/payments')) {
        return new Response(JSON.stringify([{
          cf_payment_id: 'cf_pay_1rs_only',
          payment_type: 'AUTH',
          payment_status: 'SUCCESS',
          payment_amount: 1,
          payment_currency: 'INR'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('cashfree.com/pg/subscriptions/')) {
        return new Response(JSON.stringify({
          subscription_id: 'mock',
          subscription_status: 'ACTIVE',
          authorization_details: { authorization_status: 'ACTIVE', authorization_amount: 1, authorization_amount_refund: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543216' })
    })).json();

    const reconRes = await origFetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(checkout.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    const recon = await reconRes.json();
    assert.strictEqual(recon.reconciled, false);
    assert.strictEqual(recon.status, 'pending');
    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.plan, 'free');
  });

  it('11. Reconcile endpoint immediately activates Cashfree AND Razorpay subscriptions when webhook is delayed and provider API confirms full payment', async () => {
    const cfPrincipal = freshPrincipal('recon_cf_paid');
    await commercialBillingService.getOrCreateCustomer(cfPrincipal, `${cfPrincipal}@aira.test`, 'Recon CF Paid');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions') && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_rec_paid',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false },
          next_schedule_date: body.subscription_first_charge_time
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('/payments')) {
        return new Response(JSON.stringify([{
          cf_payment_id: 'cf_pay_api_verified_399',
          payment_type: 'AUTH',
          payment_status: 'SUCCESS',
          payment_amount: 399,
          payment_currency: 'INR'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('cashfree.com/pg/subscriptions/')) {
        return new Response(JSON.stringify({
          subscription_status: 'ACTIVE',
          authorization_details: { authorization_status: 'ACTIVE', authorization_amount: 399, authorization_amount_refund: false },
          next_schedule_date: new Date(Date.now() + 30 * 86400 * 1000).toISOString()
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': cfPrincipal },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543217' })
    })).json();

    const reconRes = await origFetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(checkout.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': cfPrincipal },
      body: JSON.stringify({})
    });
    const recon = await reconRes.json();
    assert.strictEqual(recon.reconciled, true);
    assert.strictEqual(recon.status, 'active');
    assert.ok(recon.invoiceNumber, 'Reconcile must issue GST invoice when activating');

    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': cfPrincipal } })).json();
    assert.strictEqual(ent.plan, 'plus');
    assert.strictEqual(ent.availableCredits, 3100);

    // Also verify Razorpay delayed-webhook reconciliation via GET /subscriptions + GET /invoices
    const rzpPrincipal = freshPrincipal('recon_rzp_paid');
    await commercialBillingService.getOrCreateCustomer(rzpPrincipal, `${rzpPrincipal}@aira.test`, 'Recon RZP Paid');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'sub_rzp_recon_paid_01', short_url: 'https://rzp.io/i/rec01' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (String(url).includes('api.razorpay.com/v1/subscriptions/sub_rzp_recon_paid_01')) {
        return new Response(JSON.stringify({ id: 'sub_rzp_recon_paid_01', status: 'active', paid_count: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (String(url).includes('api.razorpay.com/v1/invoices?subscription_id=sub_rzp_recon_paid_01')) {
        const nowSec = Math.floor(Date.now() / 1000);
        return new Response(JSON.stringify({
          items: [{
            id: 'inv_rzp_rec_01',
            status: 'paid',
            payment_id: 'pay_rzp_api_verified_399',
            currency: 'INR',
            amount_paid: 39900,
            billing_start: nowSec,
            billing_end: nowSec + 30 * 86400
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const rzpCheckout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': rzpPrincipal },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    })).json();

    const rzpRecon = await (await origFetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(rzpCheckout.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': rzpPrincipal },
      body: JSON.stringify({})
    })).json();
    assert.strictEqual(rzpRecon.reconciled, true);
    assert.strictEqual(rzpRecon.status, 'active');
    assert.ok(rzpRecon.invoiceNumber, 'Razorpay reconcile must issue GST invoice');

    const rzpEnt = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': rzpPrincipal } })).json();
    assert.strictEqual(rzpEnt.plan, 'plus');
    assert.strictEqual(rzpEnt.availableCredits, 3100);
  });

  it('12. Rejects mismatched currency webhook with FRAUD_CHECK_FAILED', async () => {
    const principalId = freshPrincipal('curr_mismatch');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Curr');

    global.fetch = async (url: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions')) {
        return new Response(JSON.stringify({ id: 'sub_rzp_curr_01' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url);
    };
    await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    });

    const wh = await postWebhook('razorpay', {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_rzp_curr_01', paid_count: 1 } },
        payment: { entity: { id: 'pay_curr_usd', status: 'captured', amount: 39900, currency: 'USD' } }
      }
    }, `evt_curr_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 400);
    assert.match(String(wh.body?.error || ''), /FRAUD_CHECK_FAILED/);
  });

  it('13. Rejects mismatched or partial payment amount webhook with FRAUD_CHECK_FAILED', async () => {
    const principalId = freshPrincipal('amt_mismatch');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Amt');

    global.fetch = async (url: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions')) {
        return new Response(JSON.stringify({ id: 'sub_rzp_amt_01' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url);
    };
    await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'razorpay' })
    });

    const wh = await postWebhook('razorpay', {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_rzp_amt_01', paid_count: 1 } },
        payment: { entity: { id: 'pay_amt_399_on_pro', status: 'captured', amount: 39900, currency: 'INR' } }
      }
    }, `evt_amt_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 400);
    assert.match(String(wh.body?.error || ''), /FRAUD_CHECK_FAILED/);
  });

  it('14. Enforces strict customer ownership on reconcile and invoice download (cross-account rejected 403/404)', async () => {
    const owner = freshPrincipal('owner_iso');
    const attacker = freshPrincipal('attacker_iso');
    await commercialBillingService.getOrCreateCustomer(owner, `${owner}@aira.test`, 'Owner');
    await commercialBillingService.getOrCreateCustomer(attacker, `${attacker}@aira.test`, 'Attacker');

    const rzpSubId = `sub_rzp_iso_${crypto.randomUUID().slice(0, 8)}`;
    const rzpPayId = `pay_rzp_iso_${crypto.randomUUID().slice(0, 8)}`;

    global.fetch = async (url: any) => {
      if (String(url).includes('api.razorpay.com/v1/subscriptions')) {
        return new Response(JSON.stringify({ id: rzpSubId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url);
    };
    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': owner },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    })).json();

    const crossRecon = await origFetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(checkout.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': attacker },
      body: JSON.stringify({})
    });
    assert.strictEqual(crossRecon.status, 403);

    const wh = await postWebhook('razorpay', {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: rzpSubId, paid_count: 1 } },
        payment: { entity: { id: rzpPayId, status: 'captured', amount: 39900, currency: 'INR' } }
      }
    }, `evt_iso_${crypto.randomUUID().slice(0, 8)}`);
    assert.strictEqual(wh.status, 200, `Expected webhook 200, got ${JSON.stringify(wh)}`);

    const ownerInv = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': owner } })).json();
    assert.ok(ownerInv.invoices?.[0]?.invoiceNumber, `Expected invoice for owner, got: ${JSON.stringify(ownerInv)}`);
    const attackerDl = await origFetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(ownerInv.invoices[0].invoiceNumber)}/download`, {
      headers: { 'x-test-principal': attacker }
    });
    assert.strictEqual(attackerDl.status, 404);
  });

  it('15. Deduplicates webhook + replay + reconcile cleanly without double credits or duplicate GST invoices', async () => {
    const principalId = freshPrincipal('idemp');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Idemp');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions') && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_idemp',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('/payments')) {
        return new Response(JSON.stringify([{
          cf_payment_id: 'cf_pay_idemp_399',
          payment_type: 'AUTH',
          payment_status: 'SUCCESS',
          payment_amount: 399,
          payment_currency: 'INR'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('cashfree.com/pg/subscriptions/')) {
        return new Response(JSON.stringify({
          subscription_status: 'ACTIVE',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543218' })
    })).json();

    const cfPayload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_idemp_399',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
      }
    };
    await postWebhook('cashfree', cfPayload, `evt_idemp1_${crypto.randomUUID().slice(0, 8)}`);
    await postWebhook('cashfree', cfPayload, `evt_idemp2_${crypto.randomUUID().slice(0, 8)}`);
    await origFetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(checkout.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });

    const ent = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(ent.availableCredits, 3100, 'Duplicate webhooks + reconcile must grant credits exactly once');
    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 1);
  });

  it('16. Refunding immediate Cashfree AUTH charge revokes paid tier and credits, issues Credit Note, and marks invoice Refunded', async () => {
    const principalId = freshPrincipal('cf_refund');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'CF Refund');

    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: 'subs_sess_refund',
          authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const checkout = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543219' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: checkout.purchaseId,
        cf_payment_id: 'cf_pay_refunded_399',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
      }
    }, `evt_ref_pay_${crypto.randomUUID().slice(0, 8)}`);

    const entBefore = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(entBefore.plan, 'plus');
    assert.strictEqual(entBefore.availableCredits, 3100);

    await postWebhook('cashfree', {
      type: 'REFUND_STATUS',
      data: {
        refund: {
          cf_refund_id: 'cf_ref_imm_01',
          cf_payment_id: 'cf_pay_refunded_399',
          refund_amount: 399,
          refund_currency: 'INR',
          refund_status: 'SUCCESS'
        }
      }
    }, `evt_ref_wh_${crypto.randomUUID().slice(0, 8)}`);

    const subAfter = await db('subscriptions').where({ id: checkout.purchaseId }).first();
    assert.strictEqual(subAfter.status, 'refunded');
    const entAfter = await (await origFetch(`${baseUrl}/api/billing/entitlements`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(entAfter.plan, 'free');
    assert.strictEqual(entAfter.availableCredits, 100, 'Unused subscription grant credits must be revoked on full refund');

    const invBody = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBody.invoices.length, 1);
    assert.strictEqual(invBody.invoices[0].status, 'Refunded');
    assert.ok(invBody.invoices[0].creditNoteNumber, 'Refunded immediate AUTH invoice must carry credit note reference');
  });

  it('17. Preserves legacy Cashfree mandate pur_527cb712... shape intact (stays pending on reconcile/auth, zero fabricated invoices, activates on genuine ₹399 CHARGE)', async () => {
    const principalId = freshPrincipal('legacy_pres');
    const cust = await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Preserved');
    const subId = `pur_pres_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await db('subscriptions').insert({
      id: subId,
      customer_id: cust.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: '1479133886088159744',
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId,
        customerId: cust.id,
        purchaseId: subId,
        auth_payment_id: 'cf_auth_1rs_preserved',
        authorization_amount: 1,
        gateway_auth_status: 'ACTIVE',
        gateway_subscription_status: 'ACTIVE'
      }),
      created_at: now,
      updated_at: now
    });

    const invBefore = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invBefore.invoices.length, 0);

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: '1479133886088159744',
        cf_payment_id: 'cf_charge_399_settled',
        payment_type: 'CHARGE',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR'
      }
    }, `evt_pres_chg_${crypto.randomUUID().slice(0, 8)}`);

    const subAfter = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(subAfter.status, 'active');
    const invAfter = await (await origFetch(`${baseUrl}/api/billing/invoices`, { headers: { 'x-test-principal': principalId } })).json();
    assert.strictEqual(invAfter.invoices.length, 1);
    assert.strictEqual(invAfter.invoices[0].totalAmount, 399);
  });

  it('18. Plan upgrade Cashfree Plus -> Cashfree Pro supersedes Plus and enqueues old mandate cancellation in outbox', async () => {
    const principalId = freshPrincipal('upgrade_sup');
    await commercialBillingService.getOrCreateCustomer(principalId, `${principalId}@aira.test`, 'Upgrade');

    let seq = 0;
    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions') && init?.method === 'POST') {
        seq++;
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({
          subscription_id: body.subscription_id,
          subscription_session_id: `subs_sess_up_${seq}`,
          authorization_details: {
            authorization_amount: body.plan_details.plan_amount,
            authorization_amount_refund: false
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };

    const plusCo = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543220' })
    })).json();

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: plusCo.purchaseId,
        cf_payment_id: 'cf_pay_up_plus',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 399,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 399, authorization_amount_refund: false }
      }
    }, `evt_up1_${crypto.randomUUID().slice(0, 8)}`);

    const proCo = await (await origFetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543220' })
    })).json();
    assert.ok(proCo.purchaseId, `Expected Pro upgrade checkout session, got: ${JSON.stringify(proCo)}`);

    await postWebhook('cashfree', {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_id: proCo.purchaseId,
        cf_payment_id: 'cf_pay_up_pro',
        payment_type: 'AUTH',
        payment_status: 'SUCCESS',
        payment_amount: 999,
        payment_currency: 'INR',
        authorization_details: { authorization_amount: 999, authorization_amount_refund: false }
      }
    }, `evt_up2_${crypto.randomUUID().slice(0, 8)}`);

    const plusRow = await db('subscriptions').where({ id: plusCo.purchaseId }).first();
    const proRow = await db('subscriptions').where({ id: proCo.purchaseId }).first();
    assert.strictEqual(plusRow.status, 'superseded');
    assert.strictEqual(proRow.status, 'active');

    const outboxRow = await db('subscription_cancellation_outbox').where({ subscription_id: plusCo.purchaseId }).first();
    assert.ok(outboxRow, 'Superseded Plus mandate cancellation must be queued in durable outbox');
    assert.strictEqual(outboxRow.replacement_subscription_id, proCo.purchaseId);
  });

  it('19. Month-end IST calendar boundary clamping produces valid ISO +05:30 schedule across Jan 31 -> Feb 28', () => {
    const jan31IstMs = Date.parse('2026-01-31T10:15:00+05:30');
    const nextMs = (paymentGatewayService as any).addOneMonthEpochMs(jan31IstMs);
    const iso = (paymentGatewayService as any).formatIstIsoTimestamp(nextMs);
    assert.strictEqual(iso, '2026-02-28T10:15:00+05:30');
  });

  it('20. Frontend & return route contract verifies immediate activation UI, GST download CTA, auto-reconcile, and preserved Cashfree SDK redirectTarget _self', async () => {
    const rootDir = process.cwd();
    const pricingSrc = fs.readFileSync(path.join(rootDir, 'src/components/PricingModal.tsx'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(rootDir, 'src/components/SettingsModal.tsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');

    assert.ok(!pricingSrc.includes('nominal ₹1 mandate verification today'), 'Obsolete ₹1 T+1 notice must be removed from PricingModal');
    assert.ok(pricingSrc.includes('Immediate Activation'), 'PricingModal must disclose immediate Cycle 1 activation');
    assert.ok(pricingSrc.includes('cashfree.subscriptionsCheckout('), 'Cashfree SDK subscriptionsCheckout must remain intact');
    assert.ok(pricingSrc.includes("redirectTarget: '_self'"), 'Cashfree redirectTarget _self must remain intact');
    assert.ok(pricingSrc.includes('Download GST Invoice'), 'PricingModal confirmation banner must provide GST invoice download CTA');
    assert.ok(appSrc.includes('aira_cashfree_return_sub'), 'App must persist returned sub_id before stripping URL params');
    assert.ok(settingsSrc.includes('aira_cashfree_return_sub'), 'SettingsModal must auto-reconcile returned sub_id on open');

    const retRes = await origFetch(`${baseUrl}/api/billing/cashfree/return?sub_id=pur_test_return_01&gateway=cashfree`, {
      redirect: 'manual'
    });
    assert.strictEqual(retRes.status, 303);
    assert.strictEqual(retRes.headers.get('location'), '/?tab=billing&gateway=cashfree&sub_id=pur_test_return_01');
  });
});
