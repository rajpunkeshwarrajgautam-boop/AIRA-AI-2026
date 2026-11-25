import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

// Configure safe isolated test environment prior to importing app
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = process.env.AIRA_SESSION_SECRET || 'test-secret-at-least-32-chars-long-for-testing';
process.env.ALLOWED_ORIGINS = 'https://staging.virexaaiventures.com,https://aira-ai-2026.vercel.app,http://localhost:5173';
process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
process.env.AIRA_INTERNAL_WORKER_KEY = 'worker_integration_test_key_2026';
process.env.CRON_SECRET = 'worker_integration_test_key_2026';
process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_integration_secret_2026';
process.env.CASHFREE_ENV = 'TEST';

const { default: app } = await import('../apps/api/src/index.js');
const { paymentGatewayService } = await import('../apps/api/src/billing/payment-gateway-service.js');
const { commercialBillingService } = await import('../apps/api/src/billing/commercial-billing-service.js');
const {
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting
} = await import('../apps/api/src/billing/staging-sandbox-rehearsal-guard.js');

function createMockDb(seed?: {
  subscriptions?: any[];
  customers?: any[];
  creditAccounts?: any[];
  idempotentOps?: any[];
  outboxCancel?: any[];
  outboxInvoice?: any[];
}) {
  const tables: Record<string, any[]> = {
    billing_customers: [...(seed?.customers || [])],
    subscriptions: [...(seed?.subscriptions || [])],
    payment_gateway_events: [],
    billing_audit_events: [],
    idempotent_operations: [...(seed?.idempotentOps || [])],
    credit_accounts: [...(seed?.creditAccounts || [])],
    credit_transactions: [],
    credit_grants: [],
    billing_invoices: [],
    subscription_cancellation_outbox: [...(seed?.outboxCancel || [])],
    billing_invoice_reconciliation_outbox: [...(seed?.outboxInvoice || [])]
  };

  const mockDb: any = ((tableName: string) => {
    let filterQuery: Record<string, any> = {};
    let notFilterQuery: Record<string, any> = {};
    let cmpFilters: Array<(r: any) => boolean> = [];
    let limitCount: number | null = null;

    const matchRow = (r: any): boolean => {
      const eqOk = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
      const notOk = Object.entries(notFilterQuery).every(([k, v]) => r[k] !== v);
      const cmpOk = cmpFilters.every(fn => fn(r));
      return eqOk && notOk && cmpOk;
    };

    const builder: any = {
      where: (queryOrCol: any, opOrVal?: any, val?: any) => {
        if (typeof queryOrCol === 'function') {
          cmpFilters.push(r => {
            if (r.state !== undefined) {
              const stateOk = r.state === 'PENDING' || (r.state === 'CLAIMED' && Number(r.lease_until) <= Date.now());
              const nextOk = r.next_attempt_at == null || Number(r.next_attempt_at) <= Date.now();
              return stateOk && nextOk;
            }
            return true;
          });
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
      orderBy: () => builder,
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      forUpdate: () => builder,
      skipLocked: () => builder,
      first: async () => {
        const list = tables[tableName] || [];
        return list.find(matchRow) || null;
      },
      select: async () => {
        const list = tables[tableName] || [];
        const matched = list.filter(matchRow);
        return limitCount !== null ? matched.slice(0, limitCount) : matched;
      },
      then: (resolve: any, reject: any) => {
        const list = tables[tableName] || [];
        const matched = list.filter(matchRow);
        return Promise.resolve(limitCount !== null ? matched.slice(0, limitCount) : matched).then(resolve, reject);
      },
      insert: (data: any) => {
        if (!tables[tableName]) tables[tableName] = [];
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          tables[tableName].push({ ...item });
        }
        const insertedPromise = Promise.resolve([1]);
        return {
          then: (res: any, rej: any) => insertedPromise.then(res, rej),
          onConflict: () => ({
            merge: async () => [1],
            ignore: async () => [1]
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
  mockDb.raw = async (sql: string) => {
    if (sql.includes('UPDATE')) return { rows: [], rowCount: 0 };
    return { rows: [] };
  };
  mockDb.schema = { hasTable: async () => true };

  return { mockDb, tables };
}

describe('Cashfree Return Bridge, Worker Routing, Password Reset & Live Webhook Schema', () => {
  let server: http.Server;
  let baseUrl: string;
  const origFetch = global.fetch;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    global.fetch = origFetch;
    paymentGatewayService.setDbClient(null as any);
    paymentGatewayService.setGatewayTransport(null as any);
    resetEnrolledSyntheticTestPrincipalsForTesting();
    process.env.AIRA_INTERNAL_WORKER_KEY = 'worker_integration_test_key_2026';
    process.env.CRON_SECRET = 'worker_integration_test_key_2026';
    process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_integration_secret_2026';
  });

  it('1. Full Express stack: /api/billing/cashfree/return accepts cross-site POST & GET and 303-redirects with sanitized sub_id', async () => {
    const postRes = await fetch(
      `${baseUrl}/api/billing/cashfree/return?sub_id=pur_8bdd514f84e140d78edb80d9a53d2a6f&gateway=cashfree`,
      {
        method: 'POST',
        headers: {
          'Origin': 'https://payments-test.cashfree.com',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'status=SUCCESS',
        redirect: 'manual'
      }
    );

    assert.strictEqual(postRes.status, 303, 'Cashfree cross-site form POST must 303 redirect cleanly without 405/403');
    assert.strictEqual(
      postRes.headers.get('location'),
      '/?tab=billing&gateway=cashfree&sub_id=pur_8bdd514f84e140d78edb80d9a53d2a6f'
    );

    const injectedRes = await fetch(
      `${baseUrl}/api/billing/cashfree/return?sub_id=${encodeURIComponent('<script>alert(1)</script>')}`,
      { method: 'GET', redirect: 'manual' }
    );
    assert.strictEqual(injectedRes.status, 303);
    assert.strictEqual(injectedRes.headers.get('location'), '/?tab=billing&gateway=cashfree');
  });

  it('2. Full Express stack: /api/billing/worker/process-outbox allows GET Bearer and originless POST worker key above principal/CSRF barrier', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    // GET with Bearer token must bypass user-session createPrincipalMiddleware()
    const getRes = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer worker_integration_test_key_2026',
        'x-environment-target': 'sandbox'
      }
    });
    assert.strictEqual(getRes.status, 200);
    const getData: any = await getRes.json();
    assert.strictEqual(getData.ok, true);

    // POST with x-internal-worker-key and NO Origin header (as GitHub workflow_dispatch does) must bypass CSRF
    const postRes = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-worker-key': 'worker_integration_test_key_2026',
        'x-environment-target': 'sandbox'
      },
      body: JSON.stringify({ batchSize: 10, budgetMs: 8000 })
    });
    assert.strictEqual(postRes.status, 200);
    const postData: any = await postRes.json();
    assert.strictEqual(postData.ok, true);

    // Security check: unauthenticated & wrong-key requests STILL fail with 401
    const unauthRes = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, { method: 'GET' });
    assert.strictEqual(unauthRes.status, 401);

    // Browser navigation STILL fails with 403
    const navRes = await fetch(`${baseUrl}/api/billing/worker/process-outbox`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer worker_integration_test_key_2026',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document'
      }
    });
    assert.strictEqual(navRes.status, 403);
  });

  it('3. Full Express stack: BFF /api/auth/request-password-reset & /api/auth/reset-password proxy cleanly instead of 404', async () => {
    const capturedCalls: Array<{ url: string; body: any }> = [];
    global.fetch = async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('neonauth') && (urlStr.endsWith('/request-password-reset') || urlStr.endsWith('/reset-password'))) {
        capturedCalls.push({ url: urlStr, body: JSON.parse(String(init?.body || '{}')) });
        return new Response(JSON.stringify({ status: true, message: 'Reset instructions sent' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url, init);
    };

    const csrfBlocked = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil-site.example.com'
      },
      body: JSON.stringify({ email: 'user@aira.test' })
    });
    assert.strictEqual(csrfBlocked.status, 403, 'Untrusted Origin must be blocked');

    const okRes = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://staging.virexaaiventures.com',
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({ email: 'user@aira.test' })
    });
    assert.strictEqual(okRes.status, 200);
    const okBody: any = await okRes.json();
    assert.strictEqual(okBody.status, true);
    assert.strictEqual(capturedCalls.length, 1);
    assert.ok(capturedCalls[0].url.endsWith('/request-password-reset'));
    assert.strictEqual(capturedCalls[0].body.email, 'user@aira.test');
  });

  it('4. Live Cashfree 2023-08-01 AUTH webhook (₹1) records auth without unknown error or free paid access; CHARGE (₹999) fulfills idempotently', async () => {
    const now = Date.now();
    const custId = 'cust_cf_2023_test';
    const principalId = 'neon_user_cf_2023_test';
    const subId = 'pur_cf_2023_real_payload_01';

    enrollSyntheticTestPrincipalForTesting(principalId);
    const { mockDb, tables } = createMockDb({
      customers: [{ id: custId, principal_id: principalId, name: 'Cashfree Test' }],
      creditAccounts: [{ customer_id: custId, balance_credits: 100, reserved_credits: 0, lifetime_granted_credits: 100 }],
      subscriptions: [
        {
          id: subId,
          customer_id: custId,
          plan_id: 'pro',
          price_id: 'price_pro_inr',
          status: 'pending',
          gateway: 'cashfree',
          gateway_subscription_id: subId,
          currency: 'INR',
          amount_minor_units: 99900,
          current_period_start: now,
          current_period_end: now,
          cancel_at_period_end: false,
          metadata: JSON.stringify({
            principalId,
            customerId: custId,
            planTier: 'pro',
            isSandbox: true,
            rehearsal: true,
            customerState: '07'
          }),
          created_at: now,
          updated_at: now
        }
      ]
    });
    paymentGatewayService.setDbClient(mockDb);

    // Mock commercialBillingService grant/invoice safely on mock DB
    const origGrantCredits = commercialBillingService.grantCredits.bind(commercialBillingService);
    const origIssueInvoice = (paymentGatewayService as any).issueGstInvoice;
    let grantedCount = 0;
    let invoicedCount = 0;
    (commercialBillingService as any).grantCredits = async (_p: string, amount: number) => {
      grantedCount += amount;
      tables.credit_accounts[0].balance_credits += amount;
      tables.credit_accounts[0].lifetime_granted_credits += amount;
    };
    (paymentGatewayService as any).issueGstInvoice = async () => {
      invoicedCount += 1;
      tables.billing_invoices.push({
        id: `inv_test_${invoicedCount}`,
        invoice_number: `INV-2026-000${invoicedCount}`,
        subscription_id: subId,
        status: 'Paid',
        total_amount: '999.00'
      });
    };

    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const sign = (raw: string) =>
        crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${ts}${raw}`).digest('base64');

      // A. Actual Cashfree live SUBSCRIPTION_PAYMENT_SUCCESS with payment_type=AUTH, amount=1, flat data.*
      const authPayload = {
        type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
        event_time: '2026-11-25T13:02:50+05:30',
        data: {
          cf_payment_id: '1479018821122136064',
          payment_id: '11363169_211_1795591965788',
          payment_type: 'AUTH',
          payment_amount: 1,
          payment_status: 'SUCCESS',
          payment_currency: 'INR',
          subscription_id: subId,
          cf_subscription_id: '1479013188264138752',
          authorization_details: {
            authorization_amount: 1,
            authorization_status: 'ACTIVE'
          }
        }
      };
      const authRaw = JSON.stringify(authPayload);
      const authRes = await paymentGatewayService.processCashfreeWebhook(authRaw, sign(authRaw), ts);
      assert.strictEqual(authRes.status, 'PROCESSED', 'AUTH webhook must process cleanly without unknown error');
      assert.strictEqual(tables.subscriptions[0].status, 'pending', 'AUTH ₹1 debit must NOT activate Pro tier');
      assert.strictEqual(tables.credit_accounts[0].balance_credits, 100, 'AUTH ₹1 debit must NOT grant Pro credits');
      assert.strictEqual(tables.billing_invoices.length, 0, 'AUTH ₹1 debit must NOT issue Pro Paid invoice');
      assert.ok(tables.billing_audit_events.some(e => e.event_type === 'SUBSCRIPTION_MANDATE_AUTH_RECORDED'));

      // B. Uppercase SUBSCRIPTION_ACTIVATED without payment evidence must remain status-only
      const statusOnlyPayload = {
        type: 'SUBSCRIPTION_ACTIVATED',
        data: {
          subscription_details: {
            subscription_id: subId,
            subscription_status: 'ACTIVE'
          }
        }
      };
      const statusRaw = JSON.stringify(statusOnlyPayload);
      const statusRes = await paymentGatewayService.processCashfreeWebhook(statusRaw, sign(statusRaw), ts);
      assert.strictEqual(statusRes.status, 'PROCESSED');
      assert.strictEqual(tables.subscriptions[0].status, 'pending');
      assert.strictEqual(tables.billing_invoices.length, 0);

      // C. Forged ₹1 payment with payment_type=CHARGE must STILL be rejected with FRAUD_CHECK_FAILED
      const forgedCharge = {
        type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
        data: {
          cf_payment_id: 'cf_pay_forged_1rs',
          payment_type: 'CHARGE',
          payment_amount: 1,
          payment_status: 'SUCCESS',
          payment_currency: 'INR',
          subscription_id: subId
        }
      };
      const forgedRaw = JSON.stringify(forgedCharge);
      await assert.rejects(
        async () => paymentGatewayService.processCashfreeWebhook(forgedRaw, sign(forgedRaw), ts),
        /FRAUD_CHECK_FAILED/
      );

      // D. Real ₹999 SUBSCRIPTION_PAYMENT_SUCCESS CHARGE webhook fulfills subscription & idempotently ignores replay
      const realChargePayload = {
        type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
        data: {
          cf_payment_id: 'cf_pay_real_999_001',
          payment_type: 'CHARGE',
          payment_amount: 999,
          payment_status: 'SUCCESS',
          payment_currency: 'INR',
          subscription_id: subId,
          cf_subscription_id: '1479013188264138752',
          current_cycle: 1
        }
      };
      const chargeRaw = JSON.stringify(realChargePayload);
      const chargeRes = await paymentGatewayService.processCashfreeWebhook(chargeRaw, sign(chargeRaw), ts);
      assert.strictEqual(chargeRes.status, 'PROCESSED');
      assert.strictEqual(tables.subscriptions[0].status, 'active');
      assert.strictEqual(
        tables.billing_audit_events.filter(e => e.event_type === 'SUBSCRIPTION_ACTIVATED').length,
        1,
        'Must record SUBSCRIPTION_ACTIVATED exactly once'
      );
      assert.strictEqual(tables.billing_invoices.length, 1, 'Must issue 1 Paid GST invoice');

      // Duplicate delivery with same event signature/timestamp is acknowledged idempotently
      const dupRes = await paymentGatewayService.processCashfreeWebhook(chargeRaw, sign(chargeRaw), ts);
      assert.strictEqual(dupRes.status, 'ALREADY_PROCESSED');
      assert.strictEqual(tables.billing_audit_events.filter(e => e.event_type === 'SUBSCRIPTION_ACTIVATED').length, 1);
      assert.strictEqual(tables.billing_invoices.length, 1);

      // Distinct webhook delivery for already fulfilled payment must NEVER grant duplicate credits or invoice
      await paymentGatewayService.processCashfreeWebhook(chargeRaw, sign(chargeRaw), ts, {
        idempotencyHeader: 'replay_evt_different_id'
      });
      assert.strictEqual(
        tables.billing_audit_events.filter(e => e.event_type === 'SUBSCRIPTION_ACTIVATED').length,
        1,
        'Replay with new event ID must NOT emit second SUBSCRIPTION_ACTIVATED'
      );
      assert.strictEqual(tables.billing_invoices.length, 1, 'Replay with new event ID must issue zero additional invoices');
    } finally {
      (commercialBillingService as any).grantCredits = origGrantCredits;
      (paymentGatewayService as any).issueGstInvoice = origIssueInvoice;
    }
  });

  it('5. Cashfree checkout sets subscription_first_charge_time (+25h IST) and reconciles stale unpaid INITIALIZED pending checkouts cleanly', async () => {
    const prevDbUrl = process.env.DATABASE_URL;
    const prevCanonical = process.env.AUTHORIZED_STAGING_CANONICAL_DOMAIN;
    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevProjectId = process.env.VERCEL_PROJECT_ID;
    const prevBranch = process.env.VERCEL_GIT_COMMIT_REF;
    const prevBilling = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
    const prevVercel = process.env.VERCEL;
    process.env.DATABASE_URL = 'postgresql://aira_staging_user@ep-twilight-cherry-b3iz2oqv.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
    process.env.AUTHORIZED_STAGING_CANONICAL_DOMAIN = 'staging.virexaaiventures.com';
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
    try {
    const now = Date.now();
    const principalId = 'neon_user_stale_recover';
    const custId = 'cust_stale_recover';
    const staleSubId = 'pur_stale_init_older_than_15m';
    enrollSyntheticTestPrincipalForTesting(principalId);

    const { mockDb, tables } = createMockDb({
      customers: [{ id: custId, principal_id: principalId, name: 'Stale User', email: 'stale@aira.test' }],
      subscriptions: [
        {
          id: staleSubId,
          customer_id: custId,
          plan_id: 'plus',
          price_id: 'price_plus_inr',
          status: 'pending',
          gateway: 'cashfree',
          gateway_subscription_id: staleSubId,
          currency: 'INR',
          amount_minor_units: 39900,
          current_period_start: now - 40 * 60 * 1000,
          current_period_end: now - 40 * 60 * 1000,
          cancel_at_period_end: false,
          metadata: JSON.stringify({ principalId, customerId: custId }),
          created_at: now - 40 * 60 * 1000,
          updated_at: now - 40 * 60 * 1000
        }
      ]
    });
    paymentGatewayService.setDbClient(mockDb);

    // Provider confirms stale subscription was left INITIALIZED (unpaid) -> reconcile expires it, never grants active
    paymentGatewayService.setGatewayTransport(async (req: any) => {
      if (req.action === 'query_subscription') {
        return { exists: true, subscription_status: 'INITIALIZED', status: 'initialized' };
      }
      throw new Error('Unexpected transport action');
    });

    const reconRes = await paymentGatewayService.reconcileAmbiguousSubscription(staleSubId, mockDb);
    assert.strictEqual(reconRes.reconciled, true);
    assert.strictEqual(reconRes.status, 'expired');
    assert.strictEqual(reconRes.providerStatus, 'INITIALIZED');
    assert.strictEqual(tables.subscriptions[0].status, 'expired');

    // Now test Cashfree POST /pg/subscriptions payload generated on new Pro checkout
    let capturedBody: any = null;
    global.fetch = async (url: any, init?: any) => {
      if (String(url).includes('cashfree.com/pg/subscriptions')) {
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            subscription_id: capturedBody.subscription_id,
            subscription_session_id: 'sub_session_fresh_999',
            auth_link: 'https://payments-test.cashfree.com/subs-checkout/checkout/mock'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(url, init);
    };
    paymentGatewayService.setGatewayTransport(null as any);

    const checkout = await paymentGatewayService.createSubscriptionCheckout(
      principalId,
      'pro',
      'INR',
      'cashfree',
      { userId: principalId, email: 'stale@aira.test' },
      { phone: '9876543210', email: 'stale@aira.test', name: 'Stale User' }
    );

    assert.ok(capturedBody, 'Must dispatch Cashfree POST /pg/subscriptions');
    assert.match(
      String(capturedBody.subscription_first_charge_time || ''),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/,
      'Must include valid IST +05:30 ISO8601 subscription_first_charge_time'
    );
    assert.strictEqual(
      capturedBody.subscription_meta?.return_url,
      `https://staging.virexaaiventures.com/api/billing/cashfree/return?sub_id=${encodeURIComponent(checkout.purchaseId)}&gateway=cashfree`
    );

    // Ensure unpaid ACTIVE Cashfree mandate stays pending (no free paid access) and blocks duplicate checkout
    tables.subscriptions.push({
      id: 'pur_active_mandate_unpaid',
      customer_id: custId,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: 'pur_active_mandate_unpaid',
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now - 30 * 60 * 1000,
      current_period_end: now - 30 * 60 * 1000,
      metadata: JSON.stringify({ principalId, customerId: custId }),
      created_at: now - 30 * 60 * 1000,
      updated_at: now - 30 * 60 * 1000
    });
    // Mark first fresh sub expired to isolate unpaid ACTIVE sub check
    tables.subscriptions.find(s => s.id === checkout.purchaseId)!.status = 'expired';

    global.fetch = async (url: any) => {
      if (String(url).includes('pur_active_mandate_unpaid')) {
        return new Response(
          JSON.stringify({ subscription_id: 'pur_active_mandate_unpaid', subscription_status: 'ACTIVE' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(url);
    };

    const unpaidActiveRecon = await paymentGatewayService.reconcileAmbiguousSubscription('pur_active_mandate_unpaid', mockDb);
    assert.strictEqual(unpaidActiveRecon.reconciled, false);
    assert.strictEqual(unpaidActiveRecon.status, 'pending', 'ACTIVE mandate without payment must NEVER grant active paid status');
    assert.strictEqual(unpaidActiveRecon.providerStatus, 'ACTIVE');
    } finally {
      if (prevVercel !== undefined) process.env.VERCEL = prevVercel;
      else delete process.env.VERCEL;
      if (prevVercelEnv !== undefined) process.env.VERCEL_ENV = prevVercelEnv;
      else delete process.env.VERCEL_ENV;
      if (prevProjectId !== undefined) process.env.VERCEL_PROJECT_ID = prevProjectId;
      else delete process.env.VERCEL_PROJECT_ID;
      if (prevBranch !== undefined) process.env.VERCEL_GIT_COMMIT_REF = prevBranch;
      else delete process.env.VERCEL_GIT_COMMIT_REF;
      if (prevBilling !== undefined) process.env.AIRA_COMMERCIAL_BILLING_ENABLED = prevBilling;
      else delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
      else delete process.env.DATABASE_URL;
      if (prevCanonical !== undefined) process.env.AUTHORIZED_STAGING_CANONICAL_DOMAIN = prevCanonical;
      else delete process.env.AUTHORIZED_STAGING_CANONICAL_DOMAIN;
    }
  });

  it('6. Customer reconcile endpoint enforces ownership (403 cross-tenant) and expires unpaid abandoned pending checkout', async () => {
    const now = Date.now();
    const ownerPrincipal = 'test_user_owner_recon';
    const ownerCust = 'cust_owner_recon_1';
    const otherSubId = 'pur_other_customer_sub';

    const { mockDb, tables } = createMockDb({
      customers: [{ id: ownerCust, principal_id: ownerPrincipal, name: 'Owner' }],
      subscriptions: [
        {
          id: otherSubId,
          customer_id: ownerCust,
          plan_id: 'pro',
          price_id: 'price_pro_inr',
          status: 'pending',
          gateway: 'cashfree',
          gateway_subscription_id: otherSubId,
          currency: 'INR',
          amount_minor_units: 99900,
          current_period_start: now - 30 * 60000,
          current_period_end: now - 30 * 60000,
          metadata: JSON.stringify({ principalId: ownerPrincipal, customerId: ownerCust }),
          created_at: now - 30 * 60000,
          updated_at: now - 30 * 60000
        }
      ]
    });
    paymentGatewayService.setDbClient(mockDb);
    paymentGatewayService.setGatewayTransport(async () => ({
      exists: true,
      subscription_status: 'EXPIRED',
      status: 'expired'
    }));

    await assert.rejects(
      async () => paymentGatewayService.reconcileCustomerPendingSubscription('attacker_user', otherSubId, mockDb),
      /OWNERSHIP_MISMATCH/
    );

    const okRes = await paymentGatewayService.reconcileCustomerPendingSubscription(ownerPrincipal, otherSubId, mockDb);
    assert.strictEqual(okRes.reconciled, true);
    assert.strictEqual(okRes.status, 'expired');
    assert.strictEqual(tables.subscriptions[0].status, 'expired');
  });

  it('7. PricingModal UI exposes Verify / Reconcile Status action and INR Cashfree schedule disclosure', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pricingModalSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/PricingModal.tsx'),
      'utf8'
    );
    assert.match(pricingModalSrc, /Verify \/ Reconcile Status/);
    assert.match(pricingModalSrc, /\/api\/billing\/subscriptions\/\$\{encodeURIComponent\(pendingSubId\)\}\/reconcile/);
    assert.match(pricingModalSrc, /NPCI/);
  });

  it('8. Cashfree 2023-08-01 cancelSubscription and worker outbox use POST /manage { action: CANCEL }', async () => {
    const now = Date.now();
    const custId = 'cust_cf_cancel_manage';
    const principalId = 'test_user_cf_cancel_manage';
    const subId = 'pur_cf_active_manage_01';

    const { mockDb, tables } = createMockDb({
      customers: [{ id: custId, principal_id: principalId, name: 'Cancel Test' }],
      subscriptions: [{
        id: subId,
        customer_id: custId,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'active',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId: custId }),
        created_at: now,
        updated_at: now
      }],
      outboxCancel: [{
        id: 'cxl_outbox_cf_01',
        subscription_id: 'pur_cf_old_superseded',
        customer_id: custId,
        principal_id: principalId,
        gateway: 'cashfree',
        gateway_subscription_id: 'pur_cf_old_superseded',
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        fencing_token: 0,
        created_at: now,
        updated_at: now
      }]
    });
    paymentGatewayService.setDbClient(mockDb);

    const manageCalls: Array<{ url: string; method: string; body: any }> = [];
    global.fetch = async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('sandbox.cashfree.com/pg/subscriptions/')) {
        manageCalls.push({ url: u, method: init?.method, body: JSON.parse(String(init?.body || '{}')) });
        return new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url, init);
    };

    const cancelRes = await paymentGatewayService.cancelSubscription(principalId);
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(cancelRes.gatewayCancelled, true);
    assert.strictEqual(tables.subscriptions[0].cancel_at_period_end, true);

    const outboxRes = await paymentGatewayService.processCancellationOutboxTasks({ batchSize: 5, workerId: 'wkr_manage_test' });
    assert.strictEqual(outboxRes.succeeded, 1);

    assert.strictEqual(manageCalls.length, 2);
    assert.ok(manageCalls[0].url.endsWith(`/pg/subscriptions/${subId}/manage`));
    assert.deepStrictEqual(manageCalls[0].body, { subscription_id: subId, action: 'CANCEL' });
    assert.ok(manageCalls[1].url.endsWith('/pg/subscriptions/pur_cf_old_superseded/manage'));
    assert.deepStrictEqual(manageCalls[1].body, { subscription_id: 'pur_cf_old_superseded', action: 'CANCEL' });

    // Re-cancelling an already scheduled cancellation returns idempotently without duplicate gateway call
    const repeatCancel = await paymentGatewayService.cancelSubscription(principalId);
    assert.strictEqual(repeatCancel.success, true);
    assert.strictEqual(manageCalls.length, 2);
  });

  it('9. SUBSCRIPTION_PAYMENT_FAILED records audit & failure metadata safely without rejecting webhook', async () => {
    const now = Date.now();
    const custId = 'cust_cf_fail_rec';
    const principalId = 'neon_user_cf_fail_rec';
    const subId = 'pur_cf_fail_rec_01';

    enrollSyntheticTestPrincipalForTesting(principalId);
    const { mockDb, tables } = createMockDb({
      customers: [{ id: custId, principal_id: principalId, name: 'Fail Test' }],
      subscriptions: [{
        id: subId,
        customer_id: custId,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: subId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: now,
        current_period_end: now,
        metadata: JSON.stringify({ principalId, customerId: custId, planTier: 'pro' }),
        created_at: now,
        updated_at: now
      }]
    });
    paymentGatewayService.setDbClient(mockDb);

    const failPayload = JSON.stringify({
      type: 'SUBSCRIPTION_PAYMENT_FAILED',
      data: {
        subscription_id: subId,
        cf_subscription_id: '1479013188264999999',
        cf_payment_id: 'cf_pay_fail_01',
        payment_type: 'AUTH',
        payment_status: 'FAILED',
        payment_message: 'UPI mandate declined by bank'
      }
    });
    const ts = String(Math.floor(now / 1000));
    const sig = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${ts}${failPayload}`).digest('base64');

    const res = await paymentGatewayService.processCashfreeWebhook(failPayload, sig, ts);
    assert.strictEqual(res.status, 'PROCESSED');
    assert.strictEqual(tables.subscriptions[0].status, 'pending');
    const updatedMeta = JSON.parse(tables.subscriptions[0].metadata);
    assert.strictEqual(updatedMeta.lastPaymentError, 'UPI mandate declined by bank');
    assert.ok(tables.billing_audit_events.some(e => e.event_type === 'PAYMENT_FAILED'));
  });

  it('10. GET /api/billing/invoices/:invoiceNumber/download requires auth, enforces ownership, and returns GST HTML', async () => {
    // 1. Real full Express app rejects unauthenticated caller with 401
    const unauthRes = await fetch(`${baseUrl}/api/billing/invoices/INV-2026-9001/download`, { method: 'GET' });
    assert.strictEqual(unauthRes.status, 401);

    const { mockDb, tables } = createMockDb({
      customers: [
        { id: 'cust_inv_owner', principal_id: 'usr_inv_owner' },
        { id: 'cust_inv_other', principal_id: 'usr_inv_other' }
      ]
    });
    tables.billing_audit_events.push({
      id: 'bae_inv_1',
      customer_id: 'cust_inv_owner',
      event_type: 'TAX_INVOICE_ISSUED',
      actor_type: 'system',
      actor_id: 'INV-2026-9001',
      payload: JSON.stringify({
        invoiceNumber: 'INV-2026-9001',
        date: '2026-11-25',
        plan: 'AIRA Pro',
        currency: 'INR',
        totalAmount: 999,
        taxableBase: 846.61,
        gstAmount: 152.39,
        cgstAmount: 76.2,
        sgstAmount: 76.19,
        sacCode: '998431',
        supplierName: 'Virexa AI Ventures Private Limited',
        taxComplianceStatus: 'COMPLIANT',
        placeOfSupply: 'Maharashtra',
        status: 'Paid'
      }),
      created_at: Date.now()
    });
    paymentGatewayService.setDbClient(mockDb);

    const express = (await import('express')).default;
    const { createBillingRoutes } = await import('../apps/api/src/billing-routes.js');
    const billingApp = express();
    billingApp.use(express.json());
    billingApp.use((req: any, _res: any, next: any) => {
      const uid = req.headers['x-test-principal'];
      if (typeof uid === 'string' && uid) req.principal = { userId: uid };
      next();
    });
    billingApp.use('/api/billing', createBillingRoutes());

    const bServer = await new Promise<http.Server>(resolve => {
      const s = billingApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const bUrl = `http://127.0.0.1:${(bServer.address() as any).port}`;

    try {
      // 2. Owner download succeeds with GST HTML tax invoice
      const ownerRes = await fetch(`${bUrl}/api/billing/invoices/INV-2026-9001/download`, {
        method: 'GET',
        headers: { 'x-test-principal': 'usr_inv_owner' }
      });
      assert.strictEqual(ownerRes.status, 200);
      assert.match(ownerRes.headers.get('content-type') || '', /text\/html/);
      assert.match(ownerRes.headers.get('content-disposition') || '', /AIRA-GST-Invoice-INV-2026-9001\.html/);
      const html = await ownerRes.text();
      assert.match(html, /INV-2026-9001/);
      assert.match(html, /SAC: 998431/);
      assert.match(html, /₹999\.00/);

      // 3. Cross-tenant principal gets 404
      const attackerRes = await fetch(`${bUrl}/api/billing/invoices/INV-2026-9001/download`, {
        method: 'GET',
        headers: { 'x-test-principal': 'usr_inv_other' }
      });
      assert.strictEqual(attackerRes.status, 404);

      // 4. Lifecycle helper returns pending/active subscription states cleanly without error
      const emptyLifecycle = await paymentGatewayService.getCustomerBillingLifecycleState('usr_inv_owner');
      assert.strictEqual(emptyLifecycle.activeSubscription, null);
      assert.strictEqual(emptyLifecycle.pendingSubscription, null);

      const seededLifecycleDb = createMockDb({
        customers: [{ id: 'cust_lc_1', principal_id: 'usr_lc_1' }],
        subscriptions: [
          {
            id: 'pur_lc_pending_1',
            customer_id: 'cust_lc_1',
            plan_id: 'pro',
            status: 'pending',
            gateway: 'cashfree',
            amount_minor_units: 99900,
            currency: 'INR',
            metadata: JSON.stringify({
              gateway_subscription_status: 'ACTIVE',
              gateway_auth_status: 'ACTIVE',
              next_schedule_date: '2026-12-25T13:02:50+05:30',
              lastPaymentError: null
            }),
            created_at: Date.now(),
            updated_at: Date.now()
          }
        ]
      });
      paymentGatewayService.setDbClient(seededLifecycleDb.mockDb);
      const pendingLifecycle = await paymentGatewayService.getCustomerBillingLifecycleState('usr_lc_1');
      assert.ok(pendingLifecycle.pendingSubscription);
      assert.strictEqual(pendingLifecycle.pendingSubscription?.id, 'pur_lc_pending_1');
      assert.strictEqual(pendingLifecycle.pendingSubscription?.gatewaySubscriptionStatus, 'ACTIVE');
      assert.strictEqual(pendingLifecycle.pendingSubscription?.nextScheduleDate, '2026-12-25T13:02:50+05:30');
    } finally {
      await new Promise<void>(resolve => bServer.close(() => resolve()));
    }
  });
});
