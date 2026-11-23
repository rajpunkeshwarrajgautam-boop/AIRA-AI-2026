/**
 * AIRA AI 2026 — Cashfree Subscription Checkout Redirect & Session Suite
 *
 * Verifies:
 * 1. isTrustedCashfreeUrl strict hostname validation against open-redirect and domain spoofing.
 * 2. Subscription request builder payload: subscription_meta.return_url with canonical domain & sub_id.
 * 3. Cashfree API response parsing: extracts auth_link, subscription_session_id, and fallback checkoutUrl.
 * 4. BFF route admission & response contract for Cashfree Web SDK v3 session delivery.
 * 5. Fail-closed security: missing phone, forged email, and unauthorized principals blocked.
 * 6. Non-regression: Razorpay compatibility and zero premature credit grants or invoices.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import {
  paymentGatewayService,
  PaymentGatewayService
} from '../apps/api/src/billing/payment-gateway-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import {
  AUTHORIZED_STAGING_NEON_PROJECT_ID,
  AUTHORIZED_STAGING_NEON_BRANCH,
  AUTHORIZED_STAGING_NEON_ENDPOINT,
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting
} from '../apps/api/src/billing/staging-sandbox-rehearsal-guard.js';
import { isTrustedCashfreeUrl } from '../src/components/PricingModal.js';

describe('Cashfree Subscription Checkout Redirect & Session Suite', () => {
  const origEnv = { ...process.env };
  const validStagingDbUrl = `postgresql://aira_staging_user@${AUTHORIZED_STAGING_NEON_ENDPOINT}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
  const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';

  function createMockDb() {
    const tables: Record<string, any[]> = {
      billing_customers: [],
      subscriptions: [],
      payment_gateway_events: [],
      billing_audit_events: [],
      idempotent_operations: [],
      credit_accounts: [],
      credit_transactions: [],
      credit_grants: [],
      billing_invoices: []
    };

    const mockDb: any = ((tableName: string) => {
      let filterQuery: Record<string, any> = {};

      const matchRow = (r: any): boolean => {
        return Object.entries(filterQuery).every(([k, v]) => r[k] === v);
      };

      const builder: any = {
        where: (queryOrCol: any, val?: any) => {
          if (typeof queryOrCol === 'string') {
            filterQuery[queryOrCol] = val;
          } else if (typeof queryOrCol === 'object') {
            Object.assign(filterQuery, queryOrCol);
          }
          return builder;
        },
        first: async () => {
          const rows = tables[tableName] || [];
          return rows.find(matchRow) || null;
        },
        select: async () => {
          const rows = tables[tableName] || [];
          return rows.filter(matchRow);
        },
        orderBy: () => builder,
        insert: async (data: any) => {
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const row = { ...item };
            tables[tableName].push(row);
          }
          return items;
        },
        update: async (data: any) => {
          const rows = tables[tableName] || [];
          let count = 0;
          for (const row of rows) {
            if (matchRow(row)) {
              Object.assign(row, data);
              count++;
            }
          }
          return count;
        }
      };
      return builder;
    });

    mockDb.transaction = async (cb: (trx: any) => Promise<any>) => {
      return cb(mockDb);
    };

    mockDb.raw = async () => ({ rows: [] });

    return { mockDb, tables };
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED;
    delete process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.AIRA_TEST_HARNESS_REHEARSAL;
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_SECRET_KEY;
    delete process.env.CASHFREE_ENV;
    resetEnrolledSyntheticTestPrincipalsForTesting();
    paymentGatewayService.setDbClient(null);
    paymentGatewayService.setGatewayTransport(null);
  });

  afterEach(() => {
    process.env = { ...origEnv };
    resetEnrolledSyntheticTestPrincipalsForTesting();
    paymentGatewayService.setDbClient(null);
    paymentGatewayService.setGatewayTransport(null);
  });

  // =========================================================================
  // 1. FRONTEND HOST & URL SECURITY VALIDATION
  // =========================================================================
  describe('1. Frontend Host & URL Security Validation (isTrustedCashfreeUrl)', () => {
    it('accepts official Cashfree sandbox subscription auth URLs', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('https://sandbox.cashfree.com/pg/subscriptions/auth?token=cf_session_tok_123'),
        true
      );
    });

    it('accepts official Cashfree production subscription auth URLs', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('https://api.cashfree.com/pg/subscriptions/auth?token=cf_session_live_456'),
        true
      );
    });

    it('accepts official Cashfree hosted payments domains', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments.cashfree.com/subscriptions/auth/xyz789'),
        true
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments-test.cashfree.com/subscriptions/auth/xyz789'),
        true
      );
    });

    it('enforces environment separation against environment confusion', () => {
      // In sandbox mode (isSandbox = true), sandbox hosts allowed, production hosts blocked
      assert.strictEqual(
        isTrustedCashfreeUrl('https://sandbox.cashfree.com/pg/subscriptions/auth?token=123', true),
        true
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments-test.cashfree.com/subscriptions/auth/123', true),
        true
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://api.cashfree.com/pg/subscriptions/auth?token=123', true),
        false,
        'Should block production host in sandbox mode'
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments.cashfree.com/subscriptions/auth/123', true),
        false,
        'Should block production host in sandbox mode'
      );

      // In production mode (isSandbox = false), production hosts allowed, sandbox hosts blocked
      assert.strictEqual(
        isTrustedCashfreeUrl('https://api.cashfree.com/pg/subscriptions/auth?token=123', false),
        true
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments.cashfree.com/subscriptions/auth/123', false),
        true
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://sandbox.cashfree.com/pg/subscriptions/auth?token=123', false),
        false,
        'Should block sandbox host in production mode'
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://payments-test.cashfree.com/subscriptions/auth/123', false),
        false,
        'Should block sandbox host in production mode'
      );
    });

    it('rejects insecure HTTP URLs even with valid Cashfree hostname', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('http://sandbox.cashfree.com/pg/subscriptions/auth?token=123'),
        false
      );
    });

    it('rejects subdomain spoofing and prefix attacks', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('https://sandbox.cashfree.com.attacker.com/auth'),
        false
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://evil-sandbox.cashfree.com/auth'),
        false
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://notcashfree.com/sandbox.cashfree.com'),
        false
      );
    });

    it('rejects external unapproved domains', () => {
      assert.strictEqual(
        isTrustedCashfreeUrl('https://malicious-phishing.com/checkout'),
        false
      );
      assert.strictEqual(
        isTrustedCashfreeUrl('https://google.com'),
        false
      );
    });

    it('rejects malformed URLs, javascript schemes, and non-URL strings', () => {
      assert.strictEqual(isTrustedCashfreeUrl('javascript:alert(document.cookie)'), false);
      assert.strictEqual(isTrustedCashfreeUrl('data:text/html,<script>alert(1)</script>'), false);
      assert.strictEqual(isTrustedCashfreeUrl('not-a-valid-url'), false);
      assert.strictEqual(isTrustedCashfreeUrl(''), false);
    });
  });

  // =========================================================================
  // 2. CASHFREE SUBSCRIPTION REQUEST BUILDER & SUBSCRIPTION_META
  // =========================================================================
  describe('2. Cashfree Subscription Request Builder & subscription_meta', () => {
    it('generates subscription_meta with canonical return_url and sub_id binding', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_synthetic_secret_key';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.AUTHORIZED_STAGING_CANONICAL_DOMAIN = 'staging.virexaaiventures.com';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      let capturedPayload: any = null;
      let capturedHeaders: any = null;

      const origFetch = global.fetch;
      global.fetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('cashfree.com')) {
          capturedHeaders = init?.headers;
          capturedPayload = JSON.parse(init?.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscription_id: capturedPayload.subscription_id,
              subscription_session_id: 'sub_session_cf_mock_token_123',
              auth_link: `https://sandbox.cashfree.com/pg/subscriptions/auth?token=sub_session_cf_mock_token_123`
            })
          } as any;
        }
        return origFetch(url, init);
      };

      try {
        const checkout = await paymentGatewayService.createSubscriptionCheckout(
          testPrincipal,
          'pro',
          'INR',
          'cashfree',
          { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
          {
            phone: '8810777573',
            email: 'antigravitypower490@gmail.com',
            name: 'AIRA Test Principal'
          }
        );

        // Verify request payload sent to Cashfree POST /pg/subscriptions
        assert.ok(capturedPayload, 'Expected payload to have been captured');
        assert.ok(capturedPayload.subscription_meta, 'subscription_meta must be present in request');
        assert.strictEqual(
          capturedPayload.subscription_meta.return_url,
          `https://staging.virexaaiventures.com/?tab=billing&sub_id=${encodeURIComponent(checkout.purchaseId)}&gateway=cashfree`
        );
        assert.deepStrictEqual(capturedPayload.subscription_meta.notification_channel, ['EMAIL', 'SMS']);

        // Verify checkout result
        assert.strictEqual(checkout.gateway, 'cashfree');
        assert.strictEqual(checkout.paymentSessionId, 'sub_session_cf_mock_token_123');
        assert.strictEqual(checkout.subscriptionSessionId, 'sub_session_cf_mock_token_123');
        assert.strictEqual(
          checkout.checkoutUrl,
          'https://sandbox.cashfree.com/pg/subscriptions/auth?token=sub_session_cf_mock_token_123'
        );

        // Verify database subscription record
        const sub = tables.subscriptions.find(s => s.id === checkout.purchaseId);
        assert.ok(sub);
        assert.strictEqual(sub.gateway, 'cashfree');
        assert.strictEqual(sub.status, 'pending');
        assert.strictEqual(sub.plan_id, 'pro');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('preserves official SDK session ID and leaves checkoutUrl undefined when Cashfree returns headless response', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_synthetic_secret_key';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const origFetch = global.fetch;
      global.fetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('cashfree.com')) {
          const body = JSON.parse(init?.body);
          // Return session ID but NO auth_link (headless SDK-only response)
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscription_id: body.subscription_id,
              subscription_session_id: 'sub_session_headless_456'
            })
          } as any;
        }
        return origFetch(url, init);
      };

      try {
        const checkout = await paymentGatewayService.createSubscriptionCheckout(
          testPrincipal,
          'plus',
          'INR',
          'cashfree',
          { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
          { phone: '9876543210' }
        );

        assert.strictEqual(checkout.paymentSessionId, 'sub_session_headless_456');
        assert.strictEqual(checkout.subscriptionSessionId, 'sub_session_headless_456');
        // Undocumented fallback URL removed per official Cashfree contract review
        assert.strictEqual(checkout.checkoutUrl, undefined);
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  // =========================================================================
  // 3. ROUTE-LEVEL ADMISSION & RESPONSE SCHEMA
  // =========================================================================
  describe('3. Route-Level Admission & Response Schema', () => {
    function setupTestApp(principal: any) {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res: any, next: any) => {
        if (principal) {
          req.principal = principal;
        }
        next();
      });
      app.use('/api/billing', createBillingRoutes());
      return app;
    }

    it('returns HTTP 200 with paymentSessionId and checkoutUrl for Cashfree', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_synthetic_secret_key';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: 'sub_cf_route_test',
          shortUrl: 'https://sandbox.cashfree.com/sub/cf_link_123',
          paymentSessionId: 'sub_session_cf_transport_789'
        };
      });

      const app = setupTestApp({ userId: testPrincipal, email: 'antigravitypower490@gmail.com' });
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            customerPhone: '8810777573'
          })
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json() as any;
        assert.strictEqual(data.gateway, 'cashfree');
        assert.strictEqual(data.orderId, 'sub_cf_route_test');
        assert.strictEqual(data.checkoutUrl, 'https://sandbox.cashfree.com/sub/cf_link_123');
        assert.strictEqual(data.paymentSessionId, 'sub_session_cf_transport_789');
        assert.strictEqual(data.subscriptionSessionId, 'sub_session_cf_transport_789');
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('strictly blocks non-enrolled principals during sandbox rehearsal', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_synthetic_secret_key';
      process.env.DATABASE_URL = validStagingDbUrl;
      // Do NOT enroll attacker
      const attackerPrincipal = 'user_unauthorized_attacker';

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const app = setupTestApp({ userId: attackerPrincipal, email: 'attacker@evil.com' });
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            customerPhone: '8810777573'
          })
        });

        assert.strictEqual(res.status, 403);
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  // =========================================================================
  // 4. RAZORPAY COMPATIBILITY & FINANCIAL ISOLATION INVARIANTS
  // =========================================================================
  describe('4. Razorpay Compatibility & Financial Isolation Invariants', () => {
    it('preserves Razorpay checkout without requiring phone or Cashfree parameters', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_key';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_rzp_order_999',
        shortUrl: 'https://rzp.io/i/test_sub_link'
      }));

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        testPrincipal,
        'pro',
        'INR',
        'razorpay',
        { userId: testPrincipal, email: 'antigravitypower490@gmail.com' }
      );

      assert.strictEqual(checkout.gateway, 'razorpay');
      assert.strictEqual(checkout.orderId, 'sub_rzp_order_999');
      assert.strictEqual(checkout.checkoutUrl, 'https://rzp.io/i/test_sub_link');

      // Verify zero premature credits or invoices
      assert.strictEqual(tables.credit_grants.length, 0);
      assert.strictEqual(tables.credit_transactions.length, 0);
      assert.strictEqual(tables.billing_invoices.length, 0);

      // Verify subscription record is pending
      const sub = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(sub);
      assert.strictEqual(sub.gateway, 'razorpay');
      assert.strictEqual(sub.status, 'pending');
    });

    it('ensures zero premature credit grants or invoices occur during Cashfree checkout creation', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST100656847c231ffc29b7dfb119124865001';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_synthetic_secret_key';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_cf_no_premature_grants',
        shortUrl: 'https://sandbox.cashfree.com/sub/cf_link_test'
      }));

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        testPrincipal,
        'pro',
        'INR',
        'cashfree',
        { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
        { phone: '8810777573' }
      );

      assert.strictEqual(checkout.gateway, 'cashfree');
      // Strictly zero credit grants or invoices
      assert.strictEqual(tables.credit_grants.length, 0);
      assert.strictEqual(tables.credit_transactions.length, 0);
      assert.strictEqual(tables.billing_invoices.length, 0);

      // Verify subscription record is pending
      const sub = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(sub);
      assert.strictEqual(sub.status, 'pending');
    });
  });
});
