import './setup-disposable-db.js';
import test, { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db, closeDb } from '../packages/db/src/index.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { PricingModal } from '../src/components/PricingModal.tsx';
import { SettingsModal } from '../src/components/SettingsModal.tsx';

describe('Abandoned Checkout Cancellation, Recovery & Plan-Switching Suite (PG18)', () => {
  const origEnv = { ...process.env };
  const testSecret = 'whsec_abandon_recovery_pg18_9988';
  let app: express.Express;
  let server: any;
  let baseUrl: string;

  const prefix = 'cust_acr_';
  const principalPrefix = 'neon_user_acr_';

  async function cleanup() {
    const tables = [
      ['subscription_cancellation_outbox', 'customer_id'],
      ['billing_invoice_reconciliation_outbox', 'customer_id'],
      ['billing_credit_notes', 'customer_id'],
      ['billing_invoices', 'customer_id'],
      ['billing_audit_events', 'customer_id'],
      ['credit_transactions', 'account_id'],
      ['credit_grants', 'account_id'],
      ['subscriptions', 'customer_id'],
      ['credit_accounts', 'customer_id'],
      ['billing_customers', 'id']
    ] as const;

    for (const [tbl, col] of tables) {
      try {
        if (await db.schema.hasTable(tbl)) {
          const pattern = col === 'account_id' ? `%${prefix}%` : `${prefix}%`;
          await db(tbl).where(col, 'like', pattern).delete();
        }
      } catch {}
    }
    try {
      await db('idempotent_operations')
        .where('principal_id', 'like', `${principalPrefix}%`)
        .orWhere('key', 'like', `%${prefix}%`)
        .delete();
    } catch {}
    try {
      await db('payment_gateway_events')
        .where('event_id', 'like', 'evt_acr_%')
        .delete();
    } catch {}
  }

  async function seedCustomer(suffix: string) {
    const custId = `${prefix}${suffix}`;
    const principalId = `${principalPrefix}${suffix}`;
    const accId = `acc_${custId}`;
    const now = Date.now();
    await db('billing_customers').insert({
      id: custId,
      principal_id: principalId,
      email: `${suffix}@aira.test`,
      name: `ACR User ${suffix}`,
      default_currency: 'INR',
      country_code: 'IN',
      tax_info: JSON.stringify({ phone: '9876543210' }),
      created_at: now,
      updated_at: now
    });
    await db('credit_accounts').insert({
      id: accId,
      customer_id: custId,
      balance_credits: 100,
      reserved_credits: 0,
      lifetime_granted_credits: 100,
      lifetime_spent_credits: 0,
      created_at: now,
      updated_at: now
    });
    return { custId, principalId, accId };
  }

  async function getCustomerSnapshot(custId: string, principalId: string) {
    const subs = await db('subscriptions').where({ customer_id: custId }).orderBy('created_at', 'asc');
    const acc = await db('credit_accounts').where({ customer_id: custId }).first();
    const invoices = await db('billing_invoices').where({ customer_id: custId });
    const summary = await paymentGatewayService.getCustomerBillingLifecycleState(principalId);
    const audits = await db('billing_audit_events').where({ customer_id: custId }).orderBy('created_at', 'asc');
    return { subs, acc, invoices, summary, audits };
  }

  function signRzpWebhook(body: string) {
    return crypto.createHmac('sha256', testSecret).update(body).digest('hex');
  }

  before(async () => {
    await db.raw('SELECT 1');
    app = express();
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));
    app.use((req: any, _res, next) => {
      const p = req.headers['x-test-principal'];
      if (p) {
        req.principal = { userId: String(p), email: `${p}@aira.test`, roles: ['user'] };
      }
      next();
    });
    app.use('/api/billing', createBillingRoutes());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_acr';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_acr_secret';
    process.env.CASHFREE_APP_ID = 'cf_test_acr';
    process.env.CASHFREE_SECRET_KEY = 'cf_test_acr_secret';
    paymentGatewayService.setRazorpaySecret(testSecret);
    paymentGatewayService.setCashfreeSecret(testSecret);
    paymentGatewayService.setGatewayTransport(null as any);
    await cleanup();
  });

  afterEach(async () => {
    paymentGatewayService.setGatewayTransport(null as any);
    await cleanup();
  });

  after(async () => {
    if (server) server.close();
    await cleanup();
    process.env = { ...origEnv };
    await closeDb();
  });

  function installMockGateway(opts?: {
    initialProviderStatus?: 'CREATED' | 'INITIALIZED' | 'ACTIVE' | 'AUTHENTICATED';
    paid?: boolean;
    failCancel?: boolean;
    timeoutCancel?: boolean;
    failQuery?: boolean;
  }) {
    const counts = { create: 0, query: 0, cancel: 0 };
    const providerSubs = new Map<string, { gateway: string; status: string; paid: boolean; planTier: string }>();

    paymentGatewayService.setGatewayTransport(async (req: any) => {
      if (req.action === 'create_subscription') {
        counts.create++;
        const gwId = req.gateway === 'razorpay'
          ? `sub_rzp_mock_${counts.create}`
          : req.orderId;
        const defaultStatus = opts?.initialProviderStatus || (req.gateway === 'razorpay' ? 'CREATED' : 'INITIALIZED');
        providerSubs.set(gwId, {
          gateway: req.gateway,
          status: defaultStatus,
          paid: Boolean(opts?.paid),
          planTier: req.planTier
        });
        return {
          success: true,
          orderId: gwId,
          gatewayOrderId: gwId,
          shortUrl: req.gateway === 'razorpay'
            ? `https://rzp.io/i/${gwId}`
            : `https://sandbox.cashfree.com/pg/subscriptions/${gwId}`,
          subsSessionId: req.gateway === 'cashfree' ? `sub_session_mock_${counts.create}` : undefined
        };
      }
      if (req.action === 'query_subscription') {
        counts.query++;
        if (opts?.failQuery) {
          throw new Error('ETIMEDOUT querying provider status');
        }
        const entry = providerSubs.get(req.gatewaySubscriptionId || req.orderId);
        if (!entry) return { exists: false, status: 'NOT_FOUND', paid: false };
        return {
          exists: true,
          status: entry.status,
          subscription_status: entry.status,
          authorizationStatus: (entry.status === 'ACTIVE' || entry.status === 'AUTHENTICATED') ? 'ACTIVE' : undefined,
          paid: entry.paid,
          gatewaySubscriptionId: req.gatewaySubscriptionId || req.orderId
        };
      }
      if (req.action === 'cancel_subscription') {
        counts.cancel++;
        if (opts?.timeoutCancel) {
          throw new Error('AbortError: Provider cancel timeout');
        }
        if (opts?.failCancel) {
          return { cancelled: false, error: 'Upstream 502 Bad Gateway' };
        }
        const entry = providerSubs.get(req.gatewaySubscriptionId || req.orderId);
        if (entry) {
          entry.status = 'CANCELLED';
        }
        return { cancelled: true };
      }
      return { success: false };
    });

    return { counts, providerSubs };
  }

  for (const gw of ['razorpay', 'cashfree'] as const) {
    it(`1. [${gw}] Plus checkout -> cancel -> Pro checkout succeeds cleanly`, async () => {
      const { custId, principalId } = await seedCustomer(`s1_${gw}_${Date.now()}`);
      const { counts } = installMockGateway();

      const plusRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_plus_${Date.now()}` },
        body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(plusRes.status, 200);
      const plusData: any = await plusRes.json();

      // Immediate Pro attempt while Plus is pending must STILL remain blocked (409) until cancelled/reconciled
      const blockedProRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_pro_blk_${Date.now()}` },
        body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(blockedProRes.status, 409);
      const blockedData: any = await blockedProRes.json();
      assert.strictEqual(blockedData.error, 'CONCURRENT_CHECKOUT_IN_PROGRESS');
      assert.ok(blockedData.pendingSubscription, '409 response must carry structured pendingSubscription metadata');
      assert.ok(blockedData.customerMessage && !blockedData.customerMessage.includes('CONCURRENT_CHECKOUT_IN_PROGRESS'), '409 must provide friendly customerMessage');

      // Cancel abandoned Plus checkout via dedicated endpoint
      const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(plusData.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({ reason: 'switch_plan' })
      });
      assert.strictEqual(cancelRes.status, 200);
      const cancelData: any = await cancelRes.json();
      assert.strictEqual(cancelData.cancelled, true);
      assert.strictEqual(cancelData.safeToRetry, true);

      // Subsequent Pro checkout succeeds
      const proRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_pro_${Date.now()}` },
        body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(proRes.status, 200);
      const proData: any = await proRes.json();
      assert.notStrictEqual(proData.purchaseId, plusData.purchaseId);

      assert.strictEqual(counts.create, 2);
      assert.strictEqual(counts.query, 1);
      assert.strictEqual(counts.cancel, 1);

      const snap = await getCustomerSnapshot(custId, principalId);
      assert.strictEqual(snap.subs.length, 2, 'Original transaction history must be preserved');
      assert.strictEqual(snap.subs[0].status, 'canceled');
      assert.strictEqual(snap.subs[1].status, 'pending');
      assert.strictEqual(snap.subs[1].plan_id, 'pro');
      assert.strictEqual(Number(snap.acc.balance_credits), 100);
      assert.strictEqual(snap.invoices.length, 0);
      assert.strictEqual(snap.summary.activeSubscription, null);
    });

    it(`2. [${gw}] Pro checkout -> cancel -> Plus checkout succeeds cleanly`, async () => {
      const { custId, principalId } = await seedCustomer(`s2_${gw}_${Date.now()}`);
      const { counts } = installMockGateway();

      const proRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_p2_${Date.now()}` },
        body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(proRes.status, 200);
      const proData: any = await proRes.json();

      const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(proData.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({ reason: 'switch_plan' })
      });
      assert.strictEqual(cancelRes.status, 200);
      const cancelData: any = await cancelRes.json();
      assert.strictEqual(cancelData.cancelled, true);

      const plusRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_l2_${Date.now()}` },
        body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(plusRes.status, 200);
      assert.strictEqual(counts.create, 2);
      assert.strictEqual(counts.cancel, 1);

      const snap = await getCustomerSnapshot(custId, principalId);
      assert.strictEqual(snap.subs.length, 2);
      assert.strictEqual(snap.subs[0].status, 'canceled');
      assert.strictEqual(snap.subs[1].plan_id, 'plus');
      assert.strictEqual(Number(snap.acc.balance_credits), 100);
      assert.strictEqual(snap.invoices.length, 0);
    });

    it(`3. [${gw}] Plus checkout -> cancel -> retry Plus creates clean fresh checkout`, async () => {
      const { custId, principalId } = await seedCustomer(`s3_${gw}_${Date.now()}`);
      const { counts } = installMockGateway();

      const res1 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_r1_${Date.now()}` },
        body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      const d1: any = await res1.json();

      const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({ reason: 'modal_dismissed' })
      });
      assert.strictEqual(cancelRes.status, 200);

      const res2 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_r2_${Date.now()}` },
        body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: gw, customerPhone: '9876543210' })
      });
      assert.strictEqual(res2.status, 200);
      const d2: any = await res2.json();
      assert.notStrictEqual(d2.purchaseId, d1.purchaseId);
      assert.strictEqual(counts.create, 2);
      assert.strictEqual(counts.cancel, 1);
      const snap = await getCustomerSnapshot(custId, principalId);
      assert.strictEqual(snap.subs.length, 2);
      assert.strictEqual(snap.subs[0].status, 'canceled');
      assert.strictEqual(snap.subs[1].status, 'pending');
    });
  }

  it('4. Cashfree checkout -> cancel -> switch to Razorpay succeeds', async () => {
    const { custId, principalId } = await seedCustomer(`s4_${Date.now()}`);
    const { counts } = installMockGateway();

    const cfRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_cf_${Date.now()}` },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    const cfData: any = await cfRes.json();

    const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(cfData.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(cancelRes.status, 200);

    const rzpRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_rzp_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'razorpay' })
    });
    assert.strictEqual(rzpRes.status, 200);
    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs[0].gateway, 'cashfree');
    assert.strictEqual(snap.subs[0].status, 'canceled');
    assert.strictEqual(snap.subs[1].gateway, 'razorpay');
    assert.strictEqual(snap.subs[1].status, 'pending');
    assert.strictEqual(counts.create, 2);
    assert.strictEqual(counts.cancel, 1);
  });

  it('5. Razorpay checkout -> cancel -> switch to Cashfree succeeds', async () => {
    const { custId, principalId } = await seedCustomer(`s5_${Date.now()}`);
    const { counts } = installMockGateway();

    const rzpRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_rzp5_${Date.now()}` },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    });
    const rzpData: any = await rzpRes.json();

    const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(rzpData.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(cancelRes.status, 200);

    const cfRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_cf5_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    assert.strictEqual(cfRes.status, 200);
    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs[0].gateway, 'razorpay');
    assert.strictEqual(snap.subs[0].status, 'canceled');
    assert.strictEqual(snap.subs[1].gateway, 'cashfree');
    assert.strictEqual(snap.subs[1].status, 'pending');
    assert.strictEqual(counts.create, 2);
    assert.strictEqual(counts.cancel, 1);
  });

  it('6. Close checkout -> refresh page -> Verify/Reconcile reports unpaid CREATED/INITIALIZED cleanly & cancel enables retry', async () => {
    const { custId, principalId } = await seedCustomer(`s6_${Date.now()}`);
    installMockGateway();

    const plusRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s6_${Date.now()}` },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    });
    const plusData: any = await plusRes.json();

    // Simulate closing modal / page refresh: fetch /api/billing/summary + click Verify / Reconcile Status (< 15m old!)
    const sumRes = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.strictEqual(sumRes.status, 200);
    const sumBody: any = await sumRes.json();
    assert.strictEqual(sumBody.pendingSubscription.id, plusData.purchaseId);
    assert.strictEqual(sumBody.pendingSubscription.canCancelPending, true);
    assert.strictEqual(sumBody.pendingSubscription.hasAuthorizedMandate, false);

    const recRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(plusData.purchaseId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(recRes.status, 200);
    const recBody: any = await recRes.json();
    assert.strictEqual(recBody.providerStatus, 'CREATED');
    assert.strictEqual(recBody.canCancelPending, true);
    assert.strictEqual(recBody.paidEvidence, false);
    assert.ok(!String(recBody.message).includes("remains 'pending'"), 'Reconcile must give actionable unpaid guidance instead of generic message');

    // Customer explicitly cancels abandoned session and switches to Pro
    const cancelRes = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(plusData.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(cancelRes.status, 200);
    const proRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s6_pro_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'razorpay' })
    });
    assert.strictEqual(proRes.status, 200);
    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs.length, 2);
  });

  it('7. Provider cancellation fails or times out: safety restriction retained until retry succeeds', async () => {
    const { custId, principalId } = await seedCustomer(`s7_${Date.now()}`);
    const gw1 = installMockGateway({ timeoutCancel: true });

    const r1 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s7_${Date.now()}` },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    const d1: any = await r1.json();

    const failCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(failCancel.status, 409);
    const failBody: any = await failCancel.json();
    assert.strictEqual(failBody.cancelled, false);
    assert.strictEqual(failBody.uncertain, true);
    assert.strictEqual(failBody.safeToRetry, false);
    assert.strictEqual(gw1.counts.cancel, 1);

    // Must STILL block new Pro checkout while provider state uncertain
    const blockedPro = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s7_blk_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    assert.strictEqual(blockedPro.status, 409);

    const subRowMid = await db('subscriptions').where({ id: d1.purchaseId }).first();
    assert.strictEqual(subRowMid.status, 'pending', 'Pending status must stay pending when provider cancel times out');

    // Now provider recovers -> retry succeeds (preserves existing providerSubs via new healthy handler)
    paymentGatewayService.setGatewayTransport(async (req: any) => {
      if (req.action === 'query_subscription') return { exists: true, status: 'INITIALIZED', paid: false, gatewaySubscriptionId: req.gatewaySubscriptionId };
      if (req.action === 'cancel_subscription') return { cancelled: true };
      return { success: true, gatewayOrderId: 'sub_s7_pro', shortUrl: 'https://sandbox.cashfree.com/pg/s7pro', subsSessionId: 'sess_s7_pro' };
    });

    const retryCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(retryCancel.status, 200);
    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs[0].status, 'canceled');
  });

  it('8. Concurrent payment succeeds during cancellation: cancellation aborted, entitlements & credits preserved', async () => {
    const { custId, principalId } = await seedCustomer(`s8_${Date.now()}`);
    const gw = installMockGateway();

    const r1 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s8_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'razorpay' })
    });
    const d1: any = await r1.json();
    const rzpSubId = d1.orderId;

    // 8a: Provider query shows payment succeeded concurrently BEFORE webhook arrived
    gw.providerSubs.get(rzpSubId)!.status = 'ACTIVE';
    gw.providerSubs.get(rzpSubId)!.paid = true;

    const abortCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(abortCancel.status, 409);
    const abortData: any = await abortCancel.json();
    assert.strictEqual(abortData.cancelled, false);
    assert.strictEqual(abortData.paymentSucceeded, true);
    assert.strictEqual(gw.counts.cancel, 0, 'Must NEVER invoke provider cancel when paidEvidence is true');

    // 8b: Webhook activates Pro + grants 7500 credits + 1 invoice -> subsequent cancel-pending refuses
    const whPayload = JSON.stringify({
      event: 'subscription.activated',
      payload: {
        payment: { entity: { id: `pay_s8_${Date.now()}`, amount: 99900, currency: 'INR', status: 'captured', method: 'upi' } },
        subscription: {
          entity: {
            id: rzpSubId,
            status: 'active',
            paid_count: 1,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
            notes: { purchase_id: d1.purchaseId, customer_id: custId, principal_id: principalId, plan_tier: 'pro' }
          }
        }
      }
    });
    const whRes = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signRzpWebhook(whPayload) },
      body: whPayload
    });
    assert.strictEqual(whRes.status, 200);

    const postActiveCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({})
    });
    assert.strictEqual(postActiveCancel.status, 409);
    const postActiveBody: any = await postActiveCancel.json();
    assert.strictEqual(postActiveBody.alreadyPaid, true);
    assert.strictEqual(gw.counts.cancel, 0);

    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs[0].status, 'active');
    assert.strictEqual(Number(snap.acc.balance_credits), 7600);
    assert.strictEqual(snap.invoices.length, 1);
  });

  it('9. Authorized mandate with unpaid first charge: passive cancel blocked, explicit mandate cancel supported', async () => {
    const { custId, principalId } = await seedCustomer(`s9_${Date.now()}`);
    const gw = installMockGateway({ initialProviderStatus: 'ACTIVE', paid: false });

    const r1 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s9_${Date.now()}` },
      body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
    });
    const d1: any = await r1.json();

    // Passive abandonment (e.g. modal close without explicit authorized mandate confirmation) must NOT kill authorized mandate
    const passiveCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ reason: 'modal_dismissed', allowCancelAuthorizedMandate: false })
    });
    assert.strictEqual(passiveCancel.status, 409);
    const passiveBody: any = await passiveCancel.json();
    assert.strictEqual(passiveBody.cancelled, false);
    assert.strictEqual(passiveBody.hasAuthorizedMandate, true);
    assert.strictEqual(gw.counts.cancel, 0, 'Passive dismiss must NOT cancel an authorized mandate');

    // Explicit Cancel Authorized Mandate cancels Cashfree mandate and unblocks customer
    const explicitCancel = await fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
      body: JSON.stringify({ reason: 'user_cancel_authorized_mandate', allowCancelAuthorizedMandate: true })
    });
    assert.strictEqual(explicitCancel.status, 200);
    const explicitBody: any = await explicitCancel.json();
    assert.strictEqual(explicitBody.cancelled, true);
    assert.strictEqual(gw.counts.cancel, 1);

    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs[0].status, 'canceled');
    assert.strictEqual(Number(snap.acc.balance_credits), 100);
    assert.strictEqual(snap.invoices.length, 0);
  });

  it('10. Duplicate clicks & concurrent cancel-pending requests remain idempotent with exact invocation counts', async () => {
    const { custId, principalId } = await seedCustomer(`s10_${Date.now()}`);
    const gw = installMockGateway();

    const r1 = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId, 'x-idempotency-key': `op_s10_${Date.now()}` },
      body: JSON.stringify({ planId: 'plus', currency: 'INR', gateway: 'razorpay' })
    });
    const d1: any = await r1.json();

    const [c1, c2, c3] = await Promise.all([
      fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({})
      }),
      fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({})
      }),
      fetch(`${baseUrl}/api/billing/subscriptions/${encodeURIComponent(d1.purchaseId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-principal': principalId },
        body: JSON.stringify({})
      })
    ]);

    assert.strictEqual(c1.status, 200);
    assert.strictEqual(c2.status, 200);
    assert.strictEqual(c3.status, 200);
    assert.strictEqual(gw.counts.cancel, 1, 'Serialized concurrent cancel-pending must invoke provider cancel at most once');

    const snap = await getCustomerSnapshot(custId, principalId);
    assert.strictEqual(snap.subs.length, 1);
    assert.strictEqual(snap.subs[0].status, 'canceled');
    assert.strictEqual(Number(snap.acc.balance_credits), 100);
    assert.strictEqual(snap.invoices.length, 0);
  });

  it('11. UI contracts: fixes clipped buttons, horizontal scrollbar, duplicate Billing label, raw purchase ID, and adds Cancel Pending Checkout', () => {
    const settingsSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    const pricingSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/PricingModal.tsx'), 'utf8');

    // SettingsModal fixes
    assert.ok(!settingsSrc.includes('`Billing: ${usageData.billingStatus}`'), 'Must not duplicate Billing: Billing: label');
    assert.ok(!settingsSrc.includes('whitespace-nowrap') || settingsSrc.includes('Cancel Pending Checkout'), 'SettingsModal must expose Cancel Pending Checkout');
    assert.ok(settingsSrc.includes('Cancel Pending Checkout'), 'SettingsModal must expose Cancel Pending Checkout');
    assert.ok(settingsSrc.includes('Upgrade to Plus') || settingsSrc.includes('Upgrade to Pro'), 'SettingsModal comparison buttons must use non-clipping concise labels');
    assert.ok(!settingsSrc.includes('overflow-x-auto gap-1 pt-2') && !settingsSrc.includes('lg:flex-nowrap'), 'SettingsModal must wrap tabs cleanly with zero horizontal scrollbar or clipped tabs');
    assert.ok(!settingsSrc.includes('{usageData.pendingSubscription.id}'), 'SettingsModal must not display raw internal pur_ ID in visible customer UI');

    // PricingModal fixes
    assert.ok(pricingSrc.includes('Cancel Pending Checkout'), 'PricingModal must expose Cancel Pending Checkout action');
    assert.ok(pricingSrc.includes('cancel-pending'), 'PricingModal must call /cancel-pending API');
    assert.ok(!pricingSrc.includes('(${p.id})'), 'PricingModal must not embed raw internal pur_ ID in visible customer notice');

    // Static render check passes cleanly
    const pricingHtml = renderToStaticMarkup(React.createElement(PricingModal, { isOpen: true, onClose: () => {}, currentPlan: 'free' }));
    assert.ok(pricingHtml.includes('Choose Your Intelligence Tier'));
    assert.ok(pricingSrc.includes('Upgrade to Plus'));
    assert.ok(pricingSrc.includes('Upgrade to Pro'));
    const settingsHtml = renderToStaticMarkup(React.createElement(SettingsModal, {
      isOpen: true,
      initialTab: 'plan',
      onClose: () => {},
      settings: {} as any,
      onSaveSettings: () => {},
      conversations: [],
      projects: [],
      onImportData: () => {}
    }));
    assert.ok(settingsHtml.includes('Workspace Settings'));
  });
});
