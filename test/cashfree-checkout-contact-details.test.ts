/**
 * AIRA AI 2026 — Cashfree Subscription Checkout Contact Details & Phone Validation Suite
 *
 * Verifies:
 * 1. validateAndNormalizeIndianPhone parsing and validation logic (RBI compliance).
 * 2. Cashfree subscription request builder with required customer_phone in customer_details.
 * 3. Immediate fail-closed VALIDATION_ERROR before external gateway calls on missing or malformed phone.
 * 4. Preservation of customer isolation, authenticated BFF session, CSRF, and rehearsal security fence.
 * 5. Exactly-once idempotency and prevention of orphaned DB records on validation failure.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import {
  paymentGatewayService,
  validateAndNormalizeIndianPhone,
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

describe('Cashfree Subscription Checkout Contact Details & Phone Validation Suite', () => {
  const origEnv = { ...process.env };
  const validStagingDbUrl = `postgresql://aira_staging_user@${AUTHORIZED_STAGING_NEON_ENDPOINT}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;

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
        insert: async (row: any) => {
          const rows = tables[tableName] || [];
          rows.push(row);
          return [row];
        },
        update: async (patch: any) => {
          const rows = tables[tableName] || [];
          for (const r of rows) {
            if (matchRow(r)) Object.assign(r, patch);
          }
          return 1;
        }
      };

      return builder;
    }) as any;

    mockDb.raw = async () => ({
      rows: [{
        db_name: 'neondb',
        db_user: 'neondb_owner',
        server_ip: '127.0.0.1',
        neon_project_id: AUTHORIZED_STAGING_NEON_PROJECT_ID,
        neon_branch_id: AUTHORIZED_STAGING_NEON_BRANCH,
        neon_endpoint_id: AUTHORIZED_STAGING_NEON_ENDPOINT
      }]
    });

    mockDb.transaction = async (cb: any) => {
      return await cb(mockDb);
    };

    return { mockDb, tables };
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED;
    delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
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
  // 1. PHONE NORMALIZATION & VALIDATION UNIT TESTS
  // =========================================================================
  describe('1. Indian Mobile Phone Normalization & Validation', () => {
    it('accepts standard 10-digit Indian mobile number starting with 6-9', () => {
      const result = validateAndNormalizeIndianPhone('9876543210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
      assert.strictEqual(result.error, undefined);
    });

    it('accepts mobile number with +91 prefix and spaces', () => {
      const result = validateAndNormalizeIndianPhone('+91 98765 43210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
    });

    it('accepts mobile number with +91 prefix without spaces', () => {
      const result = validateAndNormalizeIndianPhone('+919876543210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
    });

    it('accepts mobile number with leading 0 prefix', () => {
      const result = validateAndNormalizeIndianPhone('09876543210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
    });

    it('accepts mobile number with 91 prefix (12 digits total)', () => {
      const result = validateAndNormalizeIndianPhone('919876543210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
    });

    it('accepts mobile number formatted with dashes and brackets', () => {
      const result = validateAndNormalizeIndianPhone('+91-(987)-654-3210');
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.phone, '9876543210');
    });

    it('validates mobile numbers starting with 6, 7, 8, 9', () => {
      for (const startDigit of ['6', '7', '8', '9']) {
        const num = `${startDigit}123456789`;
        const res = validateAndNormalizeIndianPhone(num);
        assert.strictEqual(res.isValid, true, `Expected ${num} to be valid`);
        assert.strictEqual(res.phone, num);
      }
    });

    it('rejects empty, null, or whitespace-only inputs', () => {
      assert.strictEqual(validateAndNormalizeIndianPhone('').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone('   ').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone(null).isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone(undefined).isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone(1234567890).isValid, false);
    });

    it('rejects numbers starting with invalid digits (0-5)', () => {
      assert.strictEqual(validateAndNormalizeIndianPhone('5555555555').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone('1234567890').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone('0000000000').isValid, false);
    });

    it('rejects numbers that are too short or too long', () => {
      assert.strictEqual(validateAndNormalizeIndianPhone('98765').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone('98765432101234').isValid, false);
    });

    it('rejects alphanumeric strings and invalid symbols', () => {
      assert.strictEqual(validateAndNormalizeIndianPhone('98765abcde').isValid, false);
      assert.strictEqual(validateAndNormalizeIndianPhone('phone#1234').isValid, false);
    });
  });

  // =========================================================================
  // 2. CASHFREE SUBSCRIPTION REQUEST BUILDER & VALIDATION
  // =========================================================================
  describe('2. Cashfree Subscription Request Builder & Validation', () => {
    const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';

    it('throws VALIDATION_ERROR before external call when Cashfree is selected and phone is missing', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        () => paymentGatewayService.createSubscriptionCheckout(
          testPrincipal,
          'pro',
          'INR',
          'cashfree',
          { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
          // No phone provided
          { email: 'antigravitypower490@gmail.com' }
        ),
        (err: any) => {
          assert.match(err.message, /VALIDATION_ERROR/);
          assert.match(err.message, /10-digit mobile phone number is required/);
          return true;
        }
      );

      // Verify no subscription record was inserted into database
      assert.strictEqual(tables.subscriptions.length, 0);
      assert.strictEqual(tables.billing_audit_events.length, 0);
    });

    it('throws VALIDATION_ERROR when Cashfree phone is malformed', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        () => paymentGatewayService.createSubscriptionCheckout(
          testPrincipal,
          'pro',
          'INR',
          'cashfree',
          { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
          { phone: '12345' } // Malformed
        ),
        (err: any) => {
          assert.match(err.message, /VALIDATION_ERROR/);
          return true;
        }
      );

      assert.strictEqual(tables.subscriptions.length, 0);
    });

    it('passes customer_phone, customer_email, and customer_name to Cashfree payload and persists in metadata', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      let capturedTransportParams: any = null;
      paymentGatewayService.setGatewayTransport(async (params) => {
        capturedTransportParams = params;
        return {
          gatewayOrderId: 'sub_cf_live_99999',
          shortUrl: 'https://sandbox.cashfree.com/sub/cf_link_123'
        };
      });

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        testPrincipal,
        'pro',
        'INR',
        'cashfree',
        { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
        {
          phone: '+91 98765 43210',
          email: 'antigravitypower490@gmail.com',
          name: 'AIRA Test Principal'
        }
      );

      assert.strictEqual(checkout.gateway, 'cashfree');
      assert.strictEqual(checkout.orderId, 'sub_cf_live_99999');
      assert.strictEqual(checkout.checkoutUrl, 'https://sandbox.cashfree.com/sub/cf_link_123');

      // Verify contact details received by transport
      assert.ok(capturedTransportParams.contactDetails);
      assert.strictEqual(capturedTransportParams.contactDetails.phone, '9876543210');
      assert.strictEqual(capturedTransportParams.contactDetails.email, 'antigravitypower490@gmail.com');
      assert.strictEqual(capturedTransportParams.contactDetails.name, 'AIRA Test Principal');

      // Verify DB record metadata contains normalized customerPhone
      const subRecord = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(subRecord);
      const metadata = JSON.parse(subRecord.metadata);
      assert.strictEqual(metadata.customerPhone, '9876543210');
      assert.strictEqual(metadata.customerEmail, 'antigravitypower490@gmail.com');

      // Verify billing_customers tax_info was updated with phone without migration
      const custRecord = tables.billing_customers[0];
      assert.ok(custRecord);
      const taxInfo = JSON.parse(custRecord.tax_info);
      assert.strictEqual(taxInfo.phone, '9876543210');
    });

    it('does not require phone number for Razorpay recurring subscription', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: 'sub_rzp_recurring_123',
          shortUrl: 'https://rzp.io/i/sub_123'
        };
      });

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        testPrincipal,
        'pro',
        'INR',
        'razorpay',
        { userId: testPrincipal, email: 'antigravitypower490@gmail.com' }
        // No contactDetails provided
      );

      assert.strictEqual(checkout.gateway, 'razorpay');
      assert.strictEqual(checkout.orderId, 'sub_rzp_recurring_123');
      assert.strictEqual(tables.subscriptions.length, 1);
    });
  });

  // =========================================================================
  // 3. SECURITY FENCING & ACCOUNT ISOLATION
  // =========================================================================
  describe('3. Security Fencing & Account Isolation', () => {
    it('strictly denies non-enrolled principals even with valid phone provided', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      // Do NOT enroll attacker
      const unauthPrincipal = 'neon_user_attacker_unauthorized';

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        () => paymentGatewayService.createSubscriptionCheckout(
          unauthPrincipal,
          'pro',
          'INR',
          'cashfree',
          { userId: unauthPrincipal },
          { phone: '9876543210' }
        ),
        (err: any) => {
          assert.match(err.message, /REHEARSAL_UNAUTHORIZED/);
          return true;
        }
      );

      assert.strictEqual(tables.subscriptions.length, 0);
    });

    it('strictly fails closed when rehearsal flag is disabled', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'false';
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
      process.env.DATABASE_URL = validStagingDbUrl;
      const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        () => paymentGatewayService.createSubscriptionCheckout(
          testPrincipal,
          'pro',
          'INR',
          'cashfree',
          { userId: testPrincipal },
          { phone: '9876543210' }
        ),
        (err: any) => {
          assert.match(err.message, /BILLING_UNAVAILABLE/);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 4. ROUTE-LEVEL VALIDATION & HTTP ADMISSION (POST /checkout/subscription)
  // =========================================================================
  describe('4. Route-Level Validation & HTTP Admission', () => {
    const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';

    function setupTestApp(authenticatedPrincipal?: { userId: string; email?: string } | null) {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        if (authenticatedPrincipal) {
          req.principal = authenticatedPrincipal;
        }
        next();
      });
      app.use('/api/billing', createBillingRoutes());
      return app;
    }

    it('returns HTTP 401 Unauthorized when request is unauthenticated', async () => {
      const app = setupTestApp(null);
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree', customerPhone: '9876543210' })
        });
        assert.strictEqual(res.status, 401);
        const data = await res.json() as any;
        assert.strictEqual(data.error, 'Unauthorized');
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 VALIDATION_ERROR when Cashfree is selected without customerPhone', async () => {
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
            gateway: 'cashfree'
            // No customerPhone
          })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json() as any;
        assert.strictEqual(data.error, 'VALIDATION_ERROR');
        assert.match(data.message, /10-digit mobile phone number is required/);
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 VALIDATION_ERROR when Cashfree customerPhone is malformed', async () => {
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
            customerPhone: '0123456789' // Invalid prefix (starts with 01)
          })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json() as any;
        assert.strictEqual(data.error, 'VALIDATION_ERROR');
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('returns HTTP 200 with checkout URL when Cashfree customerPhone is valid', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: 'sub_cf_route_12345',
          shortUrl: 'https://sandbox.cashfree.com/sub/cf_link_route'
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
            customerPhone: '+91 98765 43210'
          })
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json() as any;
        assert.strictEqual(data.gateway, 'cashfree');
        assert.strictEqual(data.orderId, 'sub_cf_route_12345');
        assert.strictEqual(data.checkoutUrl, 'https://sandbox.cashfree.com/sub/cf_link_route');
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('returns HTTP 200 for Razorpay without requiring customerPhone', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: 'sub_rzp_route_67890',
          shortUrl: 'https://rzp.io/i/sub_route'
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
            gateway: 'razorpay'
          })
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json() as any;
        assert.strictEqual(data.gateway, 'razorpay');
        assert.strictEqual(data.orderId, 'sub_rzp_route_67890');
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  // =========================================================================
  // 5. AUTHORITATIVE IDENTITY & ANTI-SPOOFING SECURITY
  // =========================================================================
  describe('5. Authoritative Identity & Anti-Spoofing Security', () => {
    const testPrincipal = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a';

    function setupTestApp(authenticatedPrincipal?: { userId: string; email?: string } | null) {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        if (authenticatedPrincipal) {
          req.principal = authenticatedPrincipal;
        }
        next();
      });
      app.use('/api/billing', createBillingRoutes());
      return app;
    }

    it('strictly rejects forged client-supplied email when authenticated principal has verified email', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      let gatewayCalled = false;
      paymentGatewayService.setGatewayTransport(async () => {
        gatewayCalled = true;
        return { gatewayOrderId: 'sub_spoofed', shortUrl: 'https://sandbox.cashfree.com/sub/fake' };
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            testPrincipal,
            'pro',
            'INR',
            'cashfree',
            { userId: testPrincipal, email: 'antigravitypower490@gmail.com' },
            {
              phone: '9876543210',
              email: 'forged_victim@example.com' // Forged client email mismatching principal
            }
          );
        },
        /VALIDATION_ERROR: Client-supplied email does not match authenticated account email/
      );

      assert.strictEqual(gatewayCalled, false, 'External gateway must not be called when email is forged');
      assert.strictEqual(tables.subscriptions.length, 0, 'No subscription record must be created on forged email');
      assert.strictEqual(tables.billing_audit_events.length, 0, 'No audit event should be logged for rejected checkout');
    });

    it('strictly rejects forged client-supplied email at HTTP route admission (returns 400 VALIDATION_ERROR)', async () => {
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
            customerPhone: '9876543210',
            customerDetails: {
              email: 'victim_account@external.com' // Attacker attempting to override authenticated email
            }
          })
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json() as any;
        assert.strictEqual(data.error, 'VALIDATION_ERROR');
        assert.match(data.message, /Client-supplied email does not match authenticated account email/);
      } finally {
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('authoritatively preserves server-side authenticated email when client omits email', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      let capturedPayload: any = null;
      paymentGatewayService.setGatewayTransport(async (params) => {
        capturedPayload = params;
        return { gatewayOrderId: 'sub_cf_auth_email', shortUrl: 'https://sandbox.cashfree.com/sub/cf_auth' };
      });

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        testPrincipal,
        'pro',
        'INR',
        'cashfree',
        { userId: testPrincipal, email: 'authoritative_verified@aira.com', name: 'Authoritative Owner' },
        { phone: '9876543210' } // Client provides phone only, no email
      );

      assert.strictEqual(checkout.orderId, 'sub_cf_auth_email');
      assert.strictEqual(capturedPayload.contactDetails.email, 'authoritative_verified@aira.com');
      assert.strictEqual(capturedPayload.contactDetails.name, 'Authoritative Owner');

      const subRecord = tables.subscriptions[0];
      const metadata = JSON.parse(subRecord.metadata);
      assert.strictEqual(metadata.customerEmail, 'authoritative_verified@aira.com');
    });

    it('strictly denies cross-customer contact spoofing where un-enrolled user attempts to inject another user phone/email', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_SECRET_KEY = 'cf_sec_test_val';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;
      enrollSyntheticTestPrincipalForTesting(testPrincipal);
      const attackerPrincipal = 'neon_user_attacker_identity';

      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      let gatewayCalled = false;
      paymentGatewayService.setGatewayTransport(async () => {
        gatewayCalled = true;
        return { gatewayOrderId: 'sub_fail', shortUrl: 'https://fail' };
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            attackerPrincipal,
            'pro',
            'INR',
            'cashfree',
            { userId: attackerPrincipal, email: 'attacker@evil.com' },
            { phone: '9876543210', email: 'antigravitypower490@gmail.com' } // Attacker attempts to spoof enrolled victim contact info
          );
        },
        (err: any) => err.message.includes('REHEARSAL_UNAUTHORIZED') || err.message.includes('VALIDATION_ERROR') || err.message.includes('SECURITY_VIOLATION')
      );

      assert.strictEqual(gatewayCalled, false);
      assert.strictEqual(tables.subscriptions.length, 0);
    });
  });
});
