import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = process.env.AIRA_SESSION_SECRET || 'test-secret-at-least-32-chars-long-for-testing';
process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_integration_secret_2026';
process.env.CASHFREE_ENV = 'TEST';
process.env.RAZORPAY_KEY_ID = 'rzp_test_invoice_regression';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_invoice_regression';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_wh_secret_invoice_regression_2026';

const { PaymentGatewayService, paymentGatewayService } = await import('../apps/api/src/billing/payment-gateway-service.js');
const { createBillingRoutes } = await import('../apps/api/src/billing-routes.js');
const {
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting
} = await import('../apps/api/src/billing/staging-sandbox-rehearsal-guard.js');

function createMockDb(seed?: {
  subscriptions?: any[];
  customers?: any[];
  creditAccounts?: any[];
  invoices?: any[];
  creditNotes?: any[];
  auditEvents?: any[];
  gatewayEvents?: any[];
  idempotentOps?: any[];
}) {
  const tables: Record<string, any[]> = {
    billing_customers: [...(seed?.customers || [])],
    subscriptions: [...(seed?.subscriptions || [])],
    payment_gateway_events: [...(seed?.gatewayEvents || [])],
    billing_audit_events: [...(seed?.auditEvents || [])],
    idempotent_operations: [...(seed?.idempotentOps || [])],
    credit_accounts: [...(seed?.creditAccounts || [])],
    credit_transactions: [],
    credit_grants: [],
    billing_invoices: [...(seed?.invoices || [])],
    billing_credit_notes: [...(seed?.creditNotes || [])],
    subscription_cancellation_outbox: [],
    billing_invoice_reconciliation_outbox: []
  };

  const mockDb: any = ((tableName: string) => {
    let filterQuery: Record<string, any> = {};
    let notFilterQuery: Record<string, any> = {};
    let cmpFilters: Array<(r: any) => boolean> = [];
    let limitCount: number | null = null;
    let sortCol: string | null = null;
    let sortDir: 'asc' | 'desc' = 'asc';

    const matchRow = (r: any): boolean => {
      const eqOk = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
      const notOk = Object.entries(notFilterQuery).every(([k, v]) => r[k] !== v);
      const cmpOk = cmpFilters.every(fn => fn(r));
      return eqOk && notOk && cmpOk;
    };

    const runSelect = () => {
      const list = tables[tableName] || [];
      let matched = list.filter(matchRow);
      if (sortCol) {
        const col = sortCol;
        const factor = sortDir === 'desc' ? -1 : 1;
        matched = [...matched].sort((a, b) => (Number(a[col] || 0) - Number(b[col] || 0)) * factor);
      }
      return limitCount !== null ? matched.slice(0, limitCount) : matched;
    };

    const builder: any = {
      where: (queryOrCol: any, opOrVal?: any, val?: any) => {
        if (typeof queryOrCol === 'function') {
          cmpFilters.push(() => true);
        } else if (typeof queryOrCol === 'string') {
          if (val !== undefined) {
            if (opOrVal === '>') cmpFilters.push(r => Number(r[queryOrCol]) > Number(val));
            else if (opOrVal === '<') cmpFilters.push(r => Number(r[queryOrCol]) < Number(val));
            else if (opOrVal === '<=') cmpFilters.push(r => Number(r[queryOrCol]) <= Number(val));
            else if (opOrVal === '>=') cmpFilters.push(r => Number(r[queryOrCol]) >= Number(val));
            else filterQuery[queryOrCol] = val;
          } else {
            filterQuery[queryOrCol] = opOrVal;
          }
        } else if (typeof queryOrCol === 'object' && queryOrCol !== null) {
          Object.assign(filterQuery, queryOrCol);
        }
        return builder;
      },
      andWhere: (q: any, op?: any, v?: any) => builder.where(q, op, v),
      whereIn: (col: string, vals: any[]) => {
        cmpFilters.push(r => Array.isArray(vals) && vals.includes(r[col]));
        return builder;
      },
      whereNot: (q: Record<string, any>) => {
        Object.assign(notFilterQuery, q);
        return builder;
      },
      whereNull: (col: string) => {
        cmpFilters.push(r => r[col] === null || r[col] === undefined);
        return builder;
      },
      orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
        sortCol = col;
        sortDir = dir;
        return builder;
      },
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      forUpdate: () => builder,
      skipLocked: () => builder,
      first: async () => runSelect()[0] || null,
      select: async () => runSelect(),
      then: (resolve: any, reject: any) => Promise.resolve(runSelect()).then(resolve, reject),
      insert: (data: any) => {
        if (!tables[tableName]) tables[tableName] = [];
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (tableName === 'billing_invoices') {
            const conflict = tables[tableName].find(
              r => r.invoice_number === item.invoice_number ||
                (r.subscription_id === item.subscription_id && r.cycle_number === item.cycle_number)
            );
            if (conflict) {
              const dupErr: any = new Error('duplicate key value violates unique constraint');
              dupErr.code = '23505';
              return {
                then: (_res: any, rej: any) => Promise.reject(dupErr).then(_res, rej),
                onConflict: () => ({
                  ignore: async () => ({ rowCount: 0 }),
                  merge: async () => ({ rowCount: 0 })
                })
              };
            }
          }
          tables[tableName].push({ ...item });
        }
        const insertedPromise = Promise.resolve([1]);
        return {
          then: (res: any, rej: any) => insertedPromise.then(res, rej),
          onConflict: () => ({
            merge: async () => [1],
            ignore: async () => ({ rowCount: 1 })
          })
        };
      },
      update: async (data: any) => {
        const list = tables[tableName] || [];
        let count = 0;
        for (const row of list) {
          if (matchRow(row)) {
            Object.assign(row, data);
            count++;
          }
        }
        return count;
      },
      del: async () => {
        const list = tables[tableName] || [];
        tables[tableName] = list.filter(r => !matchRow(r));
        return 1;
      }
    };
    return builder;
  });

  mockDb.transaction = async (cb: (trx: any) => Promise<any>) => cb(mockDb);
  mockDb.raw = async () => ({ rows: [] });
  mockDb.schema = { hasTable: async () => true };

  return { mockDb, tables };
}

function signCashfree(payload: unknown, secret: string, ts = String(Math.floor(Date.now() / 1000))) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${ts}${rawBody}`).digest('base64');
  return { rawBody, signature, timestamp: ts };
}

function signRazorpay(payload: unknown, secret: string) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('Invoice Payment Evidence & Cancellation Lifecycle Regression Suite (12 Cases)', () => {
  let billingServer: http.Server;
  let billingUrl: string;
  const origFetch = global.fetch;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      const uid = req.headers['x-test-principal'];
      if (typeof uid === 'string' && uid) req.principal = { userId: uid };
      next();
    });
    app.use('/api/billing', createBillingRoutes());
    await new Promise<void>(resolve => {
      billingServer = app.listen(0, '127.0.0.1', () => {
        billingUrl = `http://127.0.0.1:${(billingServer.address() as any).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>(resolve => billingServer.close(() => resolve()));
  });

  afterEach(() => {
    global.fetch = origFetch;
    resetEnrolledSyntheticTestPrincipalsForTesting();
    paymentGatewayService.setDbClient(null as any);
  });

  it('1. Unpaid cancelled Cashfree subscription produces no invoice and preserves explicit unpaid lifecycle semantics', async () => {
    const customerId = 'cust_unpaid_cf';
    const principalId = 'usr_unpaid_cf';
    const subId = 'pur_a705cae8ec444041bb98a74eac3a1200';
    const now = Date.now();

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        status: 'canceled',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({
          principalId,
          customerId,
          reconciliationStatus: 'CUSTOMER_ABANDONED_CANCELLED',
          lifecycleStage: 'UNPAID_CHECKOUT_CANCELLED'
        }),
        created_at: now - 10000,
        updated_at: now - 5000
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);

    // Cashfree subsequently delivers SUBSCRIPTION_CANCELLED webhook
    const { rawBody, signature, timestamp } = signCashfree({
      type: 'SUBSCRIPTION_CANCELLED',
      event_time: new Date(now).toISOString(),
      data: {
        subscription_details: {
          subscription_id: subId,
          cf_subscription_id: '1479130000001',
          subscription_status: 'CANCELLED'
        }
      }
    }, process.env.CASHFREE_SECRET_KEY!);

    const whRes = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(whRes.status, 'PROCESSED');

    const updatedSub = tables.subscriptions.find(s => s.id === subId);
    const updatedMeta = JSON.parse(updatedSub.metadata);
    assert.equal(updatedMeta.hadPaidSubscription, false, 'Unpaid abandoned checkout must never be classified as previously paid');
    assert.equal(updatedMeta.lifecycleStage, 'UNPAID_CHECKOUT_CANCELLED');

    const invoices = await service.getInvoices(principalId);
    assert.deepEqual(invoices, [], 'Unpaid cancelled Cashfree subscription must produce zero invoices');

    // Verify invoice endpoints (listing & download) with shared singleton
    paymentGatewayService.setDbClient(mockDb);
    const listRes = await fetch(`${billingUrl}/api/billing/invoices`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(listRes.status, 200);
    const listBody: any = await listRes.json();
    assert.deepEqual(listBody.invoices, []);

    const dlRes = await fetch(`${billingUrl}/api/billing/invoices/INV-2026-LEGACY-0001/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(dlRes.status, 404);
  });

  it('2. Unpaid cancelled Razorpay subscription produces no invoice (both abandoned canceled and webhook cancelled)', async () => {
    const customerId = 'cust_unpaid_rzp';
    const principalId = 'usr_unpaid_rzp';
    const now = Date.now();
    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [
        {
          id: 'pur_rzp_abandoned_1',
          customer_id: customerId,
          plan_id: 'plus',
          status: 'canceled',
          gateway: 'razorpay',
          gateway_subscription_id: 'sub_rzp_ab_1',
          currency: 'INR',
          amount_minor_units: 39900,
          metadata: JSON.stringify({ principalId, customerId }),
          created_at: now - 20000,
          updated_at: now - 10000
        },
        {
          id: 'pur_rzp_webhook_cancelled_2',
          customer_id: customerId,
          plan_id: 'pro',
          status: 'pending',
          gateway: 'razorpay',
          gateway_subscription_id: 'sub_rzp_wh_2',
          currency: 'INR',
          amount_minor_units: 99900,
          metadata: JSON.stringify({ principalId, customerId }),
          created_at: now - 15000,
          updated_at: now - 9000
        }
      ]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    service.setRazorpaySecret(process.env.RAZORPAY_WEBHOOK_SECRET!);

    const { rawBody, signature } = signRazorpay({
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { id: 'sub_rzp_wh_2', status: 'cancelled' } } }
    }, process.env.RAZORPAY_WEBHOOK_SECRET!);

    const res = await service.processRazorpayWebhook(rawBody, signature);
    assert.equal(res.status, 'PROCESSED');

    const sub2 = tables.subscriptions.find(s => s.id === 'pur_rzp_webhook_cancelled_2');
    const sub2Meta = JSON.parse(sub2.metadata);
    assert.equal(sub2Meta.hadPaidSubscription, false);
    assert.equal(sub2Meta.lifecycleStage, 'UNPAID_CHECKOUT_CANCELLED');

    const invoices = await service.getInvoices(principalId);
    assert.deepEqual(invoices, []);
  });

  it('3. Expired subscription produces no invoice even if metadata contains a payment ID without successful payment evidence', async () => {
    const customerId = 'cust_exp_01';
    const principalId = 'usr_exp_01';
    const now = Date.now();
    const { mockDb } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [{
        id: 'pur_exp_01',
        customer_id: customerId,
        plan_id: 'pro',
        status: 'expired',
        gateway: 'cashfree',
        gateway_subscription_id: 'pur_exp_01',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({
          principalId,
          initialPaymentId: 'cf_pay_unsettled_id_only',
          lastPaymentId: 'cf_pay_unsettled_id_only'
        }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    const invoices = await service.getInvoices(principalId);
    assert.deepEqual(invoices, []);
  });

  it('4. ₹1 mandate authorization produces no paid subscription invoice (even with ACTIVE status or payment_type=AUTH)', async () => {
    const customerId = 'cust_auth_only';
    const principalId = 'neon_user_auth_only_plus';
    const subId = 'pur_cf_auth_only_plus';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      creditAccounts: [{ id: 'cacc_auth', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: '07' }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);

    const cfNowSec = Math.floor(Date.now() / 1000);
    const authWh = signCashfree({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      event_time: new Date(now).toISOString(),
      data: {
        payment_type: 'AUTH',
        payment_amount: 1,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        cf_payment_id: '1479134207078244864',
        subscription_id: subId,
        cf_subscription_id: '1479133886088159744',
        authorization_details: { authorization_amount: 1, authorization_status: 'ACTIVE' }
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfNowSec));

    const statusWh = signCashfree({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: new Date(now + 500).toISOString(),
      data: {
        subscription_details: {
          subscription_id: subId,
          cf_subscription_id: '1479133886088159744',
          subscription_status: 'ACTIVE'
        }
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfNowSec + 1));

    await service.processCashfreeWebhook(authWh.rawBody, authWh.signature, authWh.timestamp);
    await service.processCashfreeWebhook(statusWh.rawBody, statusWh.signature, statusWh.timestamp);

    assert.equal(tables.billing_invoices.length, 0);
    const invoices = await service.getInvoices(principalId);
    assert.deepEqual(invoices, []);

    // Even if a rogue invoice row were attached specifically to the ₹1 authPaymentId, exclude it
    tables.billing_invoices.push({
      id: 'inv_rogue_auth',
      invoice_number: 'INV-2026-9991',
      customer_id: customerId,
      subscription_id: subId,
      cycle_number: 1,
      billing_event_id: '1479134207078244864',
      plan_tier: 'plus',
      currency: 'INR',
      total_amount: 1.00,
      taxable_base: 0.85,
      gst_amount: 0.15,
      status: 'Paid',
      gateway: 'cashfree',
      created_at: now
    });
    assert.deepEqual(await service.getInvoices(principalId), []);
  });

  it('5. Genuine successful ₹399 payment produces exactly one correct invoice & downloadable GST HTML', async () => {
    const customerId = 'cust_plus_399';
    const principalId = 'neon_user_plus_399';
    const subId = 'pur_plus_399_paid';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      creditAccounts: [{ id: 'cacc_399', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: '07' }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);

    const chargeWh = signCashfree({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      event_time: new Date(now).toISOString(),
      data: {
        payment_type: 'CHARGE',
        payment_amount: 399,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        cf_payment_id: 'cf_charge_399_001',
        subscription_id: subId,
        cf_subscription_id: 'cf_sub_399_001',
        cycle_number: 1
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(Math.floor(Date.now() / 1000)));

    const res = await service.processCashfreeWebhook(chargeWh.rawBody, chargeWh.signature, chargeWh.timestamp);
    assert.equal(res.status, 'PROCESSED');
    assert.equal(tables.billing_invoices.length, 1);

    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].totalAmount, 399);
    assert.equal(invoices[0].plan, 'AIRA Plus');
    assert.equal(invoices[0].currency, 'INR');
    assert.equal(invoices[0].status, 'Paid');

    paymentGatewayService.setDbClient(mockDb);
    const dlRes = await fetch(`${billingUrl}/api/billing/invoices/${encodeURIComponent(invoices[0].invoiceNumber)}/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(dlRes.status, 200);
    const html = await dlRes.text();
    assert.match(html, /₹399\.00/);
  });

  it('6. Genuine successful ₹999 payment produces exactly one correct invoice & downloadable GST HTML', async () => {
    const customerId = 'cust_pro_999';
    const principalId = 'neon_user_pro_999';
    const subId = 'pur_pro_999_paid';
    const rzpSubId = 'sub_pro_999_paid';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      creditAccounts: [{ id: 'cacc_999', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: rzpSubId,
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: 'Karnataka' }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    service.setRazorpaySecret(process.env.RAZORPAY_WEBHOOK_SECRET!);

    const { rawBody, signature } = signRazorpay({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: rzpSubId, status: 'active', paid_count: 1, current_start: Math.floor(now / 1000), current_end: Math.floor(now / 1000) + 2592000 } },
        payment: { entity: { id: 'pay_rzp_999_001', order_id: 'ord_999', amount: 99900, currency: 'INR', status: 'captured' } }
      }
    }, process.env.RAZORPAY_WEBHOOK_SECRET!);

    await service.processRazorpayWebhook(rawBody, signature);
    assert.equal(tables.billing_invoices.length, 1);

    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].totalAmount, 999);
    assert.equal(invoices[0].plan, 'AIRA Pro');
    assert.equal(invoices[0].status, 'Paid');

    paymentGatewayService.setDbClient(mockDb);
    const dlRes = await fetch(`${billingUrl}/api/billing/invoices/${encodeURIComponent(invoices[0].invoiceNumber)}/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(dlRes.status, 200);
    const html = await dlRes.text();
    assert.match(html, /₹999\.00/);
  });

  it('7. Legitimate historical paid invoices remain accessible in listing and download', async () => {
    const customerId = 'cust_9e1e096ced03407aba9db0a71f6c3253';
    const principalId = 'neon_user_hist_owner';
    const subId = 'pur_8150add7f93743e38138b5617f727188';
    const now = Date.now() - 86400000;

    const { mockDb } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_U3VmcSATvHNdhX',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({
          principalId,
          customerId,
          initialPaymentId: 'pay_U3W8gDtuakYZGC',
          lastPaymentId: 'pay_U3W8gDtuakYZGC',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      }],
      invoices: [{
        id: 'inv_hist_1',
        invoice_number: 'INV-2026-0001',
        customer_id: customerId,
        subscription_id: subId,
        cycle_number: 1,
        billing_event_id: 'pay_U3W8gDtuakYZGC',
        plan_tier: 'pro',
        currency: 'INR',
        total_amount: '999.00',
        taxable_base: '846.61',
        gst_amount: '152.39',
        igst_amount: '152.39',
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        tax_compliance_status: 'SANDBOX_REHEARSAL',
        place_of_supply: 'UNKNOWN',
        status: 'Paid',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      }],
      auditEvents: [
        {
          id: 'bae_hist_act',
          customer_id: customerId,
          event_type: 'SUBSCRIPTION_ACTIVATED',
          actor_type: 'gateway_webhook',
          actor_id: 'sub_U3VmcSATvHNdhX',
          payload: JSON.stringify({
            purchaseId: subId,
            principalId,
            planTier: 'pro',
            currency: 'INR',
            amount: 99900,
            actualPaymentId: 'pay_U3W8gDtuakYZGC'
          }),
          created_at: now
        },
        {
          id: 'bae_hist_inv',
          customer_id: customerId,
          event_type: 'TAX_INVOICE_ISSUED',
          actor_type: 'system',
          actor_id: 'INV-2026-0001',
          payload: JSON.stringify({
            invoiceNumber: 'INV-2026-0001',
            subscriptionId: subId,
            paymentId: 'pay_U3W8gDtuakYZGC',
            cycleNumber: 1,
            gateway: 'razorpay',
            currency: 'INR',
            totalAmount: 999,
            status: 'Paid'
          }),
          created_at: now
        }
      ]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].invoiceNumber, 'INV-2026-0001');
    assert.equal(invoices[0].status, 'Paid');

    paymentGatewayService.setDbClient(mockDb);
    const dlRes = await fetch(`${billingUrl}/api/billing/invoices/INV-2026-0001/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(dlRes.status, 200);
  });

  it('8. Refunded payments retain accurate Refunded status & credit note history without displaying as Paid (and unpaid refunded row produces no invoice)', async () => {
    const customerId = 'cust_ref_hist';
    const principalId = 'neon_user_ref_hist';
    const subId = 'pur_ref_hist_1';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [
        {
          id: subId,
          customer_id: customerId,
          plan_id: 'plus',
          status: 'pending',
          gateway: 'razorpay',
          gateway_subscription_id: 'sub_ref_hist_1',
          currency: 'INR',
          amount_minor_units: 39900,
          metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: '07' }),
          created_at: now,
          updated_at: now
        },
        // Unpaid corrupt/orphaned row marked 'refunded' without any payment must NEVER synthesize a legacy invoice
        {
          id: 'pur_unpaid_refunded_orphan',
          customer_id: customerId,
          plan_id: 'pro',
          status: 'refunded',
          gateway: 'cashfree',
          currency: 'INR',
          amount_minor_units: 99900,
          metadata: JSON.stringify({ principalId, customerId }),
          created_at: now - 1000,
          updated_at: now - 1000
        }
      ],
      creditAccounts: [{ id: 'cacc_ref', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    service.setRazorpaySecret(process.env.RAZORPAY_WEBHOOK_SECRET!);

    const charge = signRazorpay({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_ref_hist_1', status: 'active', paid_count: 1, current_start: Math.floor(now / 1000), current_end: Math.floor(now / 1000) + 2592000 } },
        payment: { entity: { id: 'pay_ref_399', order_id: 'ord_ref_399', amount: 39900, currency: 'INR', status: 'captured' } }
      }
    }, process.env.RAZORPAY_WEBHOOK_SECRET!);
    await service.processRazorpayWebhook(charge.rawBody, charge.signature);

    const refund = signRazorpay({
      event: 'refund.processed',
      payload: {
        payment: { entity: { id: 'pay_ref_399', order_id: 'sub_ref_hist_1' } },
        refund: { entity: { id: 'rfnd_399_01', payment_id: 'pay_ref_399', amount: 39900, status: 'processed' } }
      }
    }, process.env.RAZORPAY_WEBHOOK_SECRET!);
    await service.processRazorpayWebhook(refund.rawBody, refund.signature);

    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1, 'Only the genuinely paid-then-refunded transaction should appear');
    assert.equal(invoices[0].status, 'Refunded', 'Refunded transaction must never display as Paid');
    assert.equal(invoices[0].refundAmount, 399);
    assert.ok(
      invoices[0].creditNoteNumber?.startsWith('SCN/26-27/') ||
      invoices[0].creditNoteNumber?.startsWith('CN/26-27/') ||
      invoices[0].creditNoteNumber?.startsWith('CN-2026-'),
      `Expected creditNoteNumber to match FY-scoped or legacy format, got: ${invoices[0].creditNoteNumber}`
    );
  });

  it('9. Fabricated legacy invoice download requests and status-only active subscriptions are rejected', async () => {
    const customerId = 'cust_fab_dl';
    const principalId = 'usr_fab_dl';
    const now = Date.now();
    const { mockDb } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [{
        id: 'pur_bare_active_no_payment',
        customer_id: customerId,
        plan_id: 'pro',
        status: 'active',
        gateway: 'cashfree',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({ principalId, customerId }),
        created_at: now,
        updated_at: now
      }]
    });

    paymentGatewayService.setDbClient(mockDb);
    const listRes = await fetch(`${billingUrl}/api/billing/invoices`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(listRes.status, 200);
    assert.deepEqual(((await listRes.json()) as any).invoices, []);

    const dlRes = await fetch(`${billingUrl}/api/billing/invoices/INV-2026-LEGACY-0001/download`, {
      headers: { 'x-test-principal': principalId }
    });
    assert.equal(dlRes.status, 404);
  });

  it('10. Cross-customer invoice access and mismatched customer/gateway/amount invoice evidence are rejected', async () => {
    const ownerCust = 'cust_owner_x';
    const ownerPrincipal = 'usr_owner_x';
    const attackerCust = 'cust_attacker_y';
    const attackerPrincipal = 'usr_attacker_y';
    const now = Date.now();

    const { mockDb } = createMockDb({
      customers: [
        { id: ownerCust, principal_id: ownerPrincipal },
        { id: attackerCust, principal_id: attackerPrincipal }
      ],
      subscriptions: [
        {
          id: 'pur_owner_real',
          customer_id: ownerCust,
          plan_id: 'plus',
          status: 'active',
          gateway: 'cashfree',
          currency: 'INR',
          amount_minor_units: 39900,
          metadata: JSON.stringify({ principalId: ownerPrincipal, initialPaymentId: 'cf_pay_owner_1', fulfilledCycle: 1 }),
          created_at: now,
          updated_at: now
        },
        {
          id: 'pur_mismatch_sub',
          customer_id: ownerCust,
          plan_id: 'plus',
          status: 'active',
          gateway: 'razorpay',
          currency: 'INR',
          amount_minor_units: 39900,
          metadata: JSON.stringify({ principalId: ownerPrincipal }),
          created_at: now,
          updated_at: now
        }
      ],
      invoices: [
        {
          id: 'inv_owner_real',
          invoice_number: 'INV-2026-5001',
          customer_id: ownerCust,
          subscription_id: 'pur_owner_real',
          cycle_number: 1,
          billing_event_id: 'cf_pay_owner_1',
          plan_tier: 'plus',
          currency: 'INR',
          total_amount: '399.00',
          taxable_base: '338.14',
          gst_amount: '60.86',
          status: 'Paid',
          gateway: 'cashfree',
          created_at: now,
          updated_at: now
        },
        // Mismatched gateway + amount tampering in attacker's customer scope pointing to owner's subscription
        {
          id: 'inv_mismatched_gateway',
          invoice_number: 'INV-2026-5002',
          customer_id: attackerCust,
          subscription_id: 'pur_owner_real',
          cycle_number: 1,
          billing_event_id: 'pay_forged_1',
          plan_tier: 'pro',
          currency: 'USD',
          total_amount: '999.00',
          taxable_base: '999.00',
          gst_amount: '0.00',
          status: 'Paid',
          gateway: 'razorpay',
          created_at: now,
          updated_at: now
        }
      ],
      auditEvents: [
        {
          id: 'bae_owner_act',
          customer_id: ownerCust,
          event_type: 'SUBSCRIPTION_ACTIVATED',
          actor_type: 'gateway_webhook',
          actor_id: 'pur_owner_real',
          payload: JSON.stringify({ purchaseId: 'pur_owner_real', actualPaymentId: 'cf_pay_owner_1', amount: 39900, currency: 'INR' }),
          created_at: now
        }
      ]
    });

    paymentGatewayService.setDbClient(mockDb);

    // Attacker cannot download owner's legitimate invoice
    const crossDl = await fetch(`${billingUrl}/api/billing/invoices/INV-2026-5001/download`, {
      headers: { 'x-test-principal': attackerPrincipal }
    });
    assert.equal(crossDl.status, 404);

    // Mismatched customer/subscription/gateway/currency/amount invoice cannot list or download
    const attackerList = await paymentGatewayService.getInvoices(attackerPrincipal);
    assert.deepEqual(attackerList, []);

    const ownerList = await paymentGatewayService.getInvoices(ownerPrincipal);
    assert.equal(ownerList.length, 1);
    assert.equal(ownerList[0].invoiceNumber, 'INV-2026-5001');
  });

  it('11. Duplicate payment events do not generate duplicate invoices', async () => {
    const customerId = 'cust_dup_pay';
    const principalId = 'neon_user_dup_pay';
    const subId = 'pur_dup_pay_1';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      creditAccounts: [{ id: 'cacc_dup', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: '07' }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);

    const cfDupBase = Math.floor(Date.now() / 1000);
    const wh1 = signCashfree({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      event_time: new Date(now).toISOString(),
      data: {
        payment_type: 'CHARGE',
        payment_amount: 399,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        cf_payment_id: 'cf_dup_pay_399',
        subscription_id: subId,
        cf_subscription_id: 'cf_sub_dup',
        cycle_number: 1
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfDupBase));

    // Second distinct webhook delivery with same payment ID
    const wh2 = signCashfree({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      event_time: new Date(now + 1000).toISOString(),
      data: {
        payment_type: 'CHARGE',
        payment_amount: 399,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        cf_payment_id: 'cf_dup_pay_399',
        subscription_id: subId,
        cf_subscription_id: 'cf_sub_dup',
        cycle_number: 1
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfDupBase + 1));

    const r1 = await service.processCashfreeWebhook(wh1.rawBody, wh1.signature, wh1.timestamp);
    const r2 = await service.processCashfreeWebhook(wh2.rawBody, wh2.signature, wh2.timestamp);
    assert.equal(r1.status, 'PROCESSED');
    assert.ok(r2.status === 'ALREADY_PROCESSED' || r2.status === 'PROCESSED');
    assert.equal(tables.billing_invoices.length, 1);

    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1);
  });

  it('12. Concurrent payment and cancellation preserve legitimate financial obligations', async () => {
    const customerId = 'cust_concurrent_fin';
    const principalId = 'neon_user_concurrent_fin';
    const subId = 'pur_concurrent_fin_1';
    const now = Date.now();
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      creditAccounts: [{ id: 'cacc_conc', customer_id: customerId, balance_credits: 100, lifetime_granted_credits: 100 }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId, customerId, isSandbox: true, rehearsal: true, customerState: '07' }),
        created_at: now,
        updated_at: now
      }]
    });

    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);

    // Simulate gateway confirming paid charge concurrently while customer calls cancelPendingCheckout
    global.fetch = (async () => new Response(JSON.stringify({
      subscription_id: subId,
      cf_subscription_id: 'cf_sub_conc_1',
      subscription_status: 'ACTIVE',
      authorisation_details: { authorization_status: 'ACTIVE', authorization_amount: 1 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;

    const cfConcBase = Math.floor(Date.now() / 1000);
    const chargeWh = signCashfree({
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      event_time: new Date(now).toISOString(),
      data: {
        payment_type: 'CHARGE',
        payment_amount: 399,
        payment_currency: 'INR',
        payment_status: 'SUCCESS',
        cf_payment_id: 'cf_conc_pay_399',
        subscription_id: subId,
        cf_subscription_id: 'cf_sub_conc_1',
        cycle_number: 1
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfConcBase));

    const [whResult, cancelResult] = await Promise.all([
      service.processCashfreeWebhook(chargeWh.rawBody, chargeWh.signature, chargeWh.timestamp),
      service.cancelPendingCheckout(principalId, subId, { reason: 'customer_cancelled_pending' })
    ]);

    assert.equal(whResult.status, 'PROCESSED');
    assert.equal(cancelResult.cancelled, false, 'Concurrent cancellation must fail closed when payment succeeded');

    // Now even if customer cancels AFTER payment has legitimately settled, the paid invoice remains preserved
    const laterCancelWh = signCashfree({
      type: 'SUBSCRIPTION_CANCELLED',
      event_time: new Date(now + 5000).toISOString(),
      data: {
        subscription_details: {
          subscription_id: subId,
          cf_subscription_id: 'cf_sub_conc_1',
          subscription_status: 'CANCELLED'
        }
      }
    }, process.env.CASHFREE_SECRET_KEY!, String(cfConcBase + 5));
    await service.processCashfreeWebhook(laterCancelWh.rawBody, laterCancelWh.signature, laterCancelWh.timestamp);

    const subRow = tables.subscriptions.find(s => s.id === subId);
    const meta = JSON.parse(subRow.metadata);
    assert.equal(meta.hadPaidSubscription, true);
    assert.equal(meta.lifecycleStage, 'PAID_SUBSCRIPTION_CANCELLED');

    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1, 'Legitimate paid invoice must remain preserved after subsequent subscription cancellation');
    assert.equal(invoices[0].totalAmount, 399);
    assert.equal(invoices[0].status, 'Paid');
  });

  it('13. Propagates BILLING_INVOICE_QUERY_FAILED and API unavailable status on database/query failures without returning empty array', async () => {
    const failingMockDb: any = () => {
      const builder: any = {
        where: () => builder,
        orderBy: () => builder,
        first: async () => ({ id: 'cust_db_down', principal_id: 'usr_db_down' }),
        select: async () => {
          throw new Error('Neon connection terminated during financial ledger query');
        }
      };
      return builder;
    };
    failingMockDb.schema = {
      hasTable: async (name: string) => {
        if (name === 'billing_credit_notes') return false;
        return true;
      }
    };

    const service = new PaymentGatewayService();
    service.setDbClient(failingMockDb);

    await assert.rejects(
      async () => service.getInvoices('usr_db_down'),
      /BILLING_INVOICE_QUERY_FAILED:/
    );

    paymentGatewayService.setDbClient(failingMockDb);
    const apiRes = await fetch(`${billingUrl}/api/billing/invoices`, {
      headers: { 'x-test-principal': 'usr_db_down' }
    });
    assert.ok(apiRes.status >= 500, `Expected 5xx on invoice query outage, got ${apiRes.status}`);
    const body: any = await apiRes.json();
    assert.match(String(body.error || ''), /BILLING_INVOICE_QUERY_FAILED/);
    assert.equal(body.billingHistoryUnavailable, true);
    assert.equal(body.invoices, undefined, 'Unavailable error response must never mimic empty invoices array');
  });

  it('14. Tolerates genuinely absent optional tables (billing_credit_notes=false) while SettingsModal renders distinct unavailable error state', async () => {
    const now = Date.now();
    const customerId = 'cust_opt_tbl';
    const principalId = 'usr_opt_tbl';
    const subId = 'pur_opt_tbl_1';
    const { mockDb } = createMockDb({
      customers: [{ id: customerId, principal_id: principalId }],
      subscriptions: [{
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId, customerId, initialPaymentId: 'pay_opt_1', lastPaymentId: 'pay_opt_1', fulfilledCycle: 1 }),
        created_at: now,
        updated_at: now
      }],
      invoices: [{
        id: 'inv_opt_1',
        invoice_number: 'INV-2026-7701',
        customer_id: customerId,
        subscription_id: subId,
        cycle_number: 1,
        billing_event_id: 'pay_opt_1',
        plan_tier: 'plus',
        currency: 'INR',
        total_amount: '399.00',
        taxable_base: '338.14',
        gst_amount: '60.86',
        status: 'Paid',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      }],
      auditEvents: [{
        id: 'bae_opt_act',
        customer_id: customerId,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: subId,
        payload: JSON.stringify({ purchaseId: subId, actualPaymentId: 'pay_opt_1', amount: 39900, currency: 'INR' }),
        created_at: now
      }]
    });

    // Simulate genuinely missing billing_credit_notes table (hasTable returns false cleanly, no exception)
    mockDb.schema = {
      hasTable: async (name: string) => name !== 'billing_credit_notes'
    };
    const service = new PaymentGatewayService();
    service.setDbClient(mockDb);
    const invoices = await service.getInvoices(principalId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].invoiceNumber, 'INV-2026-7701');

    // Verify SettingsModal distinguishes unavailable billing history error from empty invoice history
    const settingsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    assert.match(settingsSrc, /invoicesError/, 'SettingsModal must track distinct invoicesError state');
    assert.match(settingsSrc, /Unable to load billing history/i, 'SettingsModal must render explicit unavailable billing history feedback');
  });
});
