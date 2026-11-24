/**
 * AIRA AI 2026 — Cashfree Recurring Plan Dynamic Provisioning & Protection Test Suite
 *
 * Verifies:
 * 1. Plus (₹399/mo) and Pro (₹999/mo) plan specifications, INR currency, PERIODIC billing, and ongoing cycles.
 * 2. Existing matching plans: verified and reused without unnecessary provider mutation.
 * 3. Missing plans: detected safely; requires explicit operator authorization before calling Create Plan API.
 * 4. Existing plans with mismatched terms: strictly rejected with PLAN_TERMS_MISMATCH (never overwritten).
 * 5. Concurrent provisioning attempts: serialized via mutex lock to prevent duplicate creation.
 * 6. Provider network timeouts and ambiguous results: fail closed with PROVISIONING_AMBIGUOUS_ERROR.
 * 7. Normal customer checkout: fails closed with BILLING_UNAVAILABLE on plan_not_found and does NOT auto-create plans.
 * 8. Sanitized customer-facing error responses: HTTP 500 CHECKOUT_FAILED redacts raw provider JSON payloads.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import {
  CashfreePlanProvisioningService,
  getAuthoritativeCashfreeSpec,
  AUTHORITATIVE_CASHFREE_SPECS,
  CashfreePlanSpecification
} from '../apps/api/src/billing/cashfree-plan-provisioning-service.js';
import {
  paymentGatewayService,
  PaymentGatewayService,
  CANDIDATE_CASHFREE_PLANS
} from '../apps/api/src/billing/payment-gateway-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import {
  AUTHORIZED_STAGING_NEON_PROJECT_ID,
  AUTHORIZED_STAGING_NEON_BRANCH,
  AUTHORIZED_STAGING_NEON_ENDPOINT,
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting
} from '../apps/api/src/billing/staging-sandbox-rehearsal-guard.js';

describe('Cashfree Recurring Plan Dynamic Provisioning & Safety Suite', () => {
  const origEnv = { ...process.env };
  const validStagingDbUrl = `postgresql://aira_staging_user@${AUTHORIZED_STAGING_NEON_ENDPOINT}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
  const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';
  const testEmail = 'antigravitypower490@gmail.com';
  const testPhone = '9876543210';

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

      const queryBuilder = {
        where(clause: any) {
          if (typeof clause === 'object') {
            filterQuery = { ...filterQuery, ...clause };
          }
          return queryBuilder;
        },
        whereNull(col: string) {
          return queryBuilder;
        },
        whereIn(col: string, vals: any[]) {
          return queryBuilder;
        },
        orderBy() {
          return queryBuilder;
        },
        async first() {
          const table = tables[tableName] || [];
          return table.find(matchRow) || null;
        },
        async select() {
          const table = tables[tableName] || [];
          return table.filter(matchRow);
        },
        async insert(data: any) {
          const table = tables[tableName] || (tables[tableName] = []);
          const rows = Array.isArray(data) ? data : [data];
          for (const row of rows) {
            table.push({ ...row });
          }
          return [1];
        },
        async update(data: any) {
          const table = tables[tableName] || [];
          let updatedCount = 0;
          for (let i = 0; i < table.length; i++) {
            if (matchRow(table[i])) {
              table[i] = { ...table[i], ...data };
              updatedCount++;
            }
          }
          return updatedCount;
        },
        async del() {
          const table = tables[tableName] || [];
          const remaining = table.filter(r => !matchRow(r));
          tables[tableName] = remaining;
          return table.length - remaining.length;
        },
        async delete() {
          return this.del();
        }
      };

      return queryBuilder;
    });

    mockDb.transaction = async (cb: any) => {
      return cb(mockDb);
    };

    mockDb.raw = async (query: string) => {
      if (query.includes('nextval')) {
        return { rows: [{ seq: 1 }] };
      }
      return { rows: [] };
    };

    return { mockDb, tables };
  }

  function setupTestApp(principal?: any) {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);
    paymentGatewayService.setGatewayTransport(null);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.principal = principal || {
        userId: testPrincipal,
        email: testEmail,
        name: 'AIRA Subscriber',
        isSynthetic: true
      };
      next();
    });
    app.use('/api/billing', createBillingRoutes());
    return app;
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.AIRA_ENVIRONMENT = 'staging';
    process.env.DATABASE_URL = validStagingDbUrl;
    process.env.NEON_PROJECT_ID = AUTHORIZED_STAGING_NEON_PROJECT_ID;
    process.env.NEON_BRANCH_NAME = AUTHORIZED_STAGING_NEON_BRANCH;
    process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
    process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
    process.env.CASHFREE_APP_ID = 'TEST1067527636e054452077e5d8ff6767257601';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_mock_secret_key_for_testing';
    process.env.CASHFREE_ENV = 'TEST';
    process.env.CASHFREE_PLAN_ID_PLUS_INR = 'plan_cf_plus_inr_monthly';
    process.env.CASHFREE_PLAN_ID_PRO_INR = 'plan_cf_pro_inr_monthly';

    resetEnrolledSyntheticTestPrincipalsForTesting();
    enrollSyntheticTestPrincipalForTesting(testPrincipal);
  });

  afterEach(() => {
    process.env = { ...origEnv };
    resetEnrolledSyntheticTestPrincipalsForTesting();
  });

  describe('1. Plan Specifications & Mappings (Plus ₹399 & Pro ₹999)', () => {
    it('provides authoritative specifications for AIRA Plus ₹399/month', () => {
      const spec = getAuthoritativeCashfreeSpec('plus');
      assert.strictEqual(spec.planTier, 'plus');
      assert.strictEqual(spec.planId, 'plan_cf_plus_inr_monthly');
      assert.strictEqual(spec.currency, 'INR');
      assert.strictEqual(spec.recurringAmount, 399);
      assert.strictEqual(spec.maxAmount, 399);
      assert.strictEqual(spec.intervalType, 'MONTH');
      assert.strictEqual(spec.intervals, 1);
      assert.strictEqual(spec.maxCycles, undefined); // Ongoing SaaS
    });

    it('provides authoritative specifications for AIRA Pro ₹999/month', () => {
      const spec = getAuthoritativeCashfreeSpec('pro');
      assert.strictEqual(spec.planTier, 'pro');
      assert.strictEqual(spec.planId, 'plan_cf_pro_inr_monthly');
      assert.strictEqual(spec.currency, 'INR');
      assert.strictEqual(spec.recurringAmount, 999);
      assert.strictEqual(spec.maxAmount, 999);
      assert.strictEqual(spec.intervalType, 'MONTH');
      assert.strictEqual(spec.intervals, 1);
      assert.strictEqual(spec.maxCycles, undefined); // Ongoing SaaS
    });

    it('supports dynamic env override of plan identifiers without restart', () => {
      process.env.CASHFREE_PLAN_ID_PLUS_INR = 'plan_cf_plus_custom_v2';
      process.env.CASHFREE_PLAN_ID_PRO_INR = 'plan_cf_pro_custom_v2';

      const plusSpec = getAuthoritativeCashfreeSpec('plus');
      const proSpec = getAuthoritativeCashfreeSpec('pro');

      assert.strictEqual(plusSpec.planId, 'plan_cf_plus_custom_v2');
      assert.strictEqual(proSpec.planId, 'plan_cf_pro_custom_v2');
    });

    it('supports optional CASHFREE_PLAN_MAX_CYCLES configuration when explicitly set', () => {
      process.env.CASHFREE_PLAN_MAX_CYCLES = '24';
      const spec = getAuthoritativeCashfreeSpec('pro');
      assert.strictEqual(spec.maxCycles, 24);
    });

    it('strictly rejects when target environment is TEST but CASHFREE_APP_ID is not a TEST credential', () => {
      const service = new CashfreePlanProvisioningService();
      assert.throws(
        () => service.resolveCredentials({ appId: 'PROD_APP_ID_12345', secretKey: 'sec', env: 'TEST' }),
        /ENVIRONMENT_CREDENTIAL_MISMATCH.*Target environment is TEST but CASHFREE_APP_ID does not begin with TEST/
      );
    });

    it('strictly rejects when target environment is PROD but CASHFREE_APP_ID is a TEST sandbox credential', () => {
      const service = new CashfreePlanProvisioningService();
      assert.throws(
        () => service.resolveCredentials({ appId: 'TEST_SANDBOX_12345', secretKey: 'sec', env: 'PROD' }),
        /ENVIRONMENT_CREDENTIAL_MISMATCH.*Target environment is PROD but CASHFREE_APP_ID is a TEST sandbox credential/
      );
    });
  });

  describe('2. Existing Matching Plan Verification (Read-Only Reuse)', () => {
    it('verifies and reuses existing plan when all terms match exactly (zero POST calls)', async () => {
      const existingPlan = {
        plan_id: 'plan_cf_pro_inr_monthly',
        plan_name: 'AIRA Pro Monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_recurring_amount: 999,
        plan_max_amount: 999,
        plan_interval_type: 'MONTH',
        plan_intervals: 1
      };

      let postCalled = false;
      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        const method = init?.method || 'GET';

        if (method === 'GET' && urlStr.includes('/plans/plan_cf_pro_inr_monthly')) {
          return new Response(JSON.stringify(existingPlan), { status: 200 });
        }
        if (method === 'POST') {
          postCalled = true;
          return new Response(JSON.stringify({ error: 'Should not create' }), { status: 500 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      const result = await service.provisionPlan(spec, {
        operatorAuthorized: true
      });

      assert.strictEqual(result.status, 'ALREADY_EXISTS_AND_MATCHED');
      assert.strictEqual(result.planId, 'plan_cf_pro_inr_monthly');
      assert.strictEqual(postCalled, false, 'POST /pg/plans must NOT be called for an existing matching plan');
    });
  });

  describe('3. Missing Plan Detection & Operator Authorization Gate', () => {
    it('strictly throws OPERATOR_AUTHORIZATION_REQUIRED when operatorAuthorized is false or missing', async () => {
      const service = new CashfreePlanProvisioningService();
      const spec = getAuthoritativeCashfreeSpec('pro');

      await assert.rejects(
        () => service.provisionPlan(spec, { operatorAuthorized: false }),
        /OPERATOR_AUTHORIZATION_REQUIRED/
      );
    });

    it('successfully provisions missing plan when operatorAuthorized is true', async () => {
      let createdPayload: any = null;
      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        const method = init?.method || 'GET';

        if (method === 'GET' && urlStr.includes('/plans/plan_cf_pro_inr_monthly')) {
          return new Response(JSON.stringify({ code: 'plan_not_found', message: 'Plan does not exist.' }), { status: 400 });
        }
        if (method === 'POST' && urlStr.endsWith('/plans')) {
          createdPayload = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ ...createdPayload, status: 'ACTIVE' }), { status: 201 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      const result = await service.provisionPlan(spec, {
        operatorAuthorized: true
      });

      assert.strictEqual(result.status, 'CREATED');
      assert.strictEqual(result.planId, 'plan_cf_pro_inr_monthly');
      assert.ok(createdPayload);
      assert.strictEqual(createdPayload.plan_id, 'plan_cf_pro_inr_monthly');
      assert.strictEqual(createdPayload.plan_recurring_amount, 999);
      assert.strictEqual(createdPayload.plan_currency, 'INR');
      assert.strictEqual(createdPayload.plan_type, 'PERIODIC');
      assert.strictEqual(createdPayload.plan_interval_type, 'MONTH');
      assert.strictEqual(createdPayload.plan_intervals, 1);
    });
  });

  describe('4. Existing Plan with Mismatched Terms (Strict Rejection)', () => {
    it('strictly rejects with PLAN_TERMS_MISMATCH when recurring amount conflicts (does not overwrite)', async () => {
      const existingConflictingPlan = {
        plan_id: 'plan_cf_pro_inr_monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_recurring_amount: 499, // Mismatched (expected 999)
        plan_interval_type: 'MONTH',
        plan_intervals: 1
      };

      let postCalled = false;
      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';
        if (method === 'GET') {
          return new Response(JSON.stringify(existingConflictingPlan), { status: 200 });
        }
        if (method === 'POST') {
          postCalled = true;
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      await assert.rejects(
        () => service.provisionPlan(spec, { operatorAuthorized: true }),
        /PLAN_TERMS_MISMATCH.*Amount mismatch.*Refusing to mutate or overwrite/
      );

      assert.strictEqual(postCalled, false, 'POST /pg/plans must NEVER be called when existing plan has mismatched terms');
    });

    it('strictly rejects when interval type is WEEK instead of MONTH', async () => {
      const existingWeeklyPlan = {
        plan_id: 'plan_cf_plus_inr_monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_recurring_amount: 399,
        plan_interval_type: 'WEEK', // Mismatched
        plan_intervals: 1
      };

      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        return new Response(JSON.stringify(existingWeeklyPlan), { status: 200 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('plus');

      await assert.rejects(
        () => service.provisionPlan(spec, { operatorAuthorized: true }),
        /PLAN_TERMS_MISMATCH.*Interval type mismatch/
      );
    });

    it('strictly rejects when currency is USD instead of INR', async () => {
      const existingUsdPlan = {
        plan_id: 'plan_cf_plus_inr_monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'USD', // Mismatched
        plan_recurring_amount: 399,
        plan_interval_type: 'MONTH',
        plan_intervals: 1
      };

      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        return new Response(JSON.stringify(existingUsdPlan), { status: 200 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('plus');

      await assert.rejects(
        () => service.provisionPlan(spec, { operatorAuthorized: true }),
        /PLAN_TERMS_MISMATCH.*Currency mismatch/
      );
    });
  });

  describe('5. Concurrent Provisioning Attempts & Mutex Synchronization', () => {
    it('serializes concurrent calls and executes exactly ONE POST request', async () => {
      let getCount = 0;
      let postCount = 0;

      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';
        if (method === 'GET') {
          getCount++;
          return new Response(JSON.stringify({ code: 'plan_not_found' }), { status: 400 });
        }
        if (method === 'POST') {
          postCount++;
          // Simulate latency
          await new Promise(r => setTimeout(r, 20));
          return new Response(JSON.stringify({
            plan_id: 'plan_cf_pro_inr_monthly',
            plan_recurring_amount: 999,
            plan_currency: 'INR',
            status: 'ACTIVE'
          }), { status: 201 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      // Run 5 simultaneous provisioning calls
      const results = await Promise.all([
        service.provisionPlan(spec, { operatorAuthorized: true }),
        service.provisionPlan(spec, { operatorAuthorized: true }),
        service.provisionPlan(spec, { operatorAuthorized: true }),
        service.provisionPlan(spec, { operatorAuthorized: true }),
        service.provisionPlan(spec, { operatorAuthorized: true })
      ]);

      assert.strictEqual(postCount, 1, 'Only exactly 1 POST /pg/plans request should be sent across concurrent calls');
      for (const res of results) {
        assert.strictEqual(res.status, 'CREATED');
        assert.strictEqual(res.planId, 'plan_cf_pro_inr_monthly');
      }
    });

    it('safely recovers when concurrent remote operator created plan (handles 409 / plan_already_exists)', async () => {
      let getCount = 0;
      const matchingPlan = {
        plan_id: 'plan_cf_pro_inr_monthly',
        plan_name: 'AIRA Pro Monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_recurring_amount: 999,
        plan_interval_type: 'MONTH',
        plan_intervals: 1
      };

      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';
        if (method === 'GET') {
          getCount++;
          // First GET says not found; second GET (after 409 race) returns the matching plan
          if (getCount === 1) {
            return new Response(JSON.stringify({ code: 'plan_not_found' }), { status: 400 });
          }
          return new Response(JSON.stringify(matchingPlan), { status: 200 });
        }
        if (method === 'POST') {
          return new Response(JSON.stringify({ code: 'plan_already_exists', message: 'Plan already exists.' }), { status: 409 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      const result = await service.provisionPlan(spec, { operatorAuthorized: true });
      assert.strictEqual(result.status, 'ALREADY_EXISTS_AND_MATCHED');
      assert.strictEqual(result.planId, 'plan_cf_pro_inr_monthly');
    });
  });

  describe('6. Ambiguous Provider Failures & Network Timeouts', () => {
    it('fails closed with PROVISIONING_AMBIGUOUS_ERROR on network timeout/failure during POST', async () => {
      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';
        if (method === 'GET') {
          return new Response(JSON.stringify({ code: 'plan_not_found' }), { status: 400 });
        }
        if (method === 'POST') {
          throw new Error('ETIMEDOUT: Connection timed out');
        }
        return new Response('Not Found', { status: 404 });
      };

      const service = new CashfreePlanProvisioningService(mockFetch);
      const spec = getAuthoritativeCashfreeSpec('pro');

      await assert.rejects(
        () => service.provisionPlan(spec, { operatorAuthorized: true }),
        /PROVISIONING_AMBIGUOUS_ERROR.*Connection timed out.*Verify provider state/
      );
    });
  });

  describe('7. Normal Checkout Fails Closed on Missing Plan (Zero Auto-Mutation)', () => {
    it('fails closed with BILLING_UNAVAILABLE on plan_not_found and does NOT auto-create plans', async () => {
      const origFetch = globalThis.fetch;
      let postPlanCalled = false;

      try {
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = input.toString();
          if (urlStr.includes('/pg/plans')) {
            postPlanCalled = true;
            return new Response(JSON.stringify({}), { status: 200 });
          }
          if (urlStr.includes('/pg/subscriptions')) {
            return new Response(
              JSON.stringify({
                code: 'plan_not_found',
                message: 'Plan does not exist.'
              }),
              { status: 400 }
            );
          }
          return new Response('Not Found', { status: 404 });
        };

        const { mockDb, tables } = createMockDb();
        paymentGatewayService.setDbClient(mockDb);
        paymentGatewayService.setGatewayTransport(null);

        await assert.rejects(
          async () => {
            await paymentGatewayService.createSubscriptionCheckout(
              testPrincipal,
              'pro',
              'INR',
              'cashfree',
              { userId: testPrincipal, email: testEmail, isSynthetic: true },
              { phone: testPhone, email: testEmail }
            );
          },
          (err: any) => {
            assert.match(err.message, /BILLING_UNAVAILABLE/);
            assert.match(err.message, /Cashfree recurring plan "plan_cf_pro_inr_monthly" is not configured/);
            assert.match(err.message, /Operator provisioning is required/);
            return true;
          }
        );

        assert.strictEqual(postPlanCalled, false, 'Normal checkout must NEVER attempt to create plans on the fly');
        assert.strictEqual(tables.subscriptions.length, 0, 'No subscriptions should be persisted on plan_not_found');
        assert.strictEqual(tables.billing_invoices.length, 0, 'No invoices should be created on plan_not_found');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('8. Sanitized Customer-Facing Error Responses (Zero Provider Payload Leakage)', () => {
    it('returns sanitized HTTP 500 CHECKOUT_FAILED message without leaking raw provider JSON', async () => {
      const origFetch = globalThis.fetch;
      let server: http.Server;

      try {
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = input.toString();
          if (urlStr.includes('cashfree.com') || urlStr.includes('/pg/subscriptions')) {
            // Simulate upstream internal provider crash with sensitive raw payload
            return new Response(
              JSON.stringify({
                code: 'internal_upstream_gateway_crash',
                trace_id: 'cf_trace_secret_xyz123',
                debug_info: 'Database connection failed at internal-cashfree-cluster:5432'
              }),
              { status: 500 }
            );
          }
          return origFetch(input, init);
        };

        const app = setupTestApp();
        server = app.listen(0);
        const port = (server.address() as any).port;

        const response = await fetch(`http://127.0.0.1:${port}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            customerDetails: {
              phone: testPhone,
              email: testEmail
            }
          })
        });

        const data: any = await response.json();

        assert.strictEqual(response.status, 500);
        assert.strictEqual(data.error, 'CHECKOUT_FAILED');
        assert.strictEqual(
          data.message,
          'Unable to initiate subscription checkout with the payment provider. Please try again later or contact support.'
        );
        // Verify sensitive upstream details are strictly omitted from response body
        const jsonStr = JSON.stringify(data);
        assert.ok(!jsonStr.includes('internal-cashfree-cluster'), 'Upstream host/debug info must not be leaked');
        assert.ok(!jsonStr.includes('cf_trace_secret_xyz123'), 'Upstream trace secrets must not be leaked');
        assert.ok(!jsonStr.includes('internal_upstream_gateway_crash'), 'Raw upstream error code must not be leaked');
      } finally {
        globalThis.fetch = origFetch;
        server?.close();
      }
    });

    it('returns HTTP 503 BILLING_UNAVAILABLE with clean message when Cashfree plan is un-provisioned', async () => {
      const origFetch = globalThis.fetch;
      let server: http.Server;

      try {
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = input.toString();
          if (urlStr.includes('cashfree.com') || urlStr.includes('/pg/subscriptions')) {
            return new Response(
              JSON.stringify({
                code: 'plan_not_found',
                message: 'Plan does not exist.'
              }),
              { status: 400 }
            );
          }
          return origFetch(input, init);
        };

        const app = setupTestApp();
        server = app.listen(0);
        const port = (server.address() as any).port;

        const response = await fetch(`http://127.0.0.1:${port}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            customerDetails: {
              phone: testPhone,
              email: testEmail
            }
          })
        });

        const data: any = await response.json();

        assert.strictEqual(response.status, 503);
        assert.strictEqual(data.error, 'BILLING_UNAVAILABLE');
        assert.match(data.message, /Cashfree recurring plan "plan_cf_pro_inr_monthly" is not configured/);
        assert.match(data.message, /Operator provisioning is required/);
        // Raw JSON like {"code":"plan_not_found"} is not in the message
        assert.ok(!data.message.includes('{"code":"plan_not_found"'));
      } finally {
        globalThis.fetch = origFetch;
        server?.close();
      }
    });
  });
});
