/**
 * AIRA AI 2026 — Gate 4 Upgrade Flow & Recurring Subscription Security Suite
 *
 * Verifies:
 * 1. Genuine monthly recurring subscription semantics (no silent fallback to one-time orders)
 * 2. Razorpay recurring plan creation & subscription contract
 * 3. Cashfree periodic subscription contract
 * 4. Staging rehearsal principal isolation (enrolled test account vs. personal owner account)
 * 5. Rehearsal disabled / fail-closed security boundary
 * 6. Prevention of premature payment-success claims (pending checkout status)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  paymentGatewayService,
  CANDIDATE_RAZORPAY_PLANS,
  CANDIDATE_CASHFREE_PLANS
} from '../apps/api/src/billing/payment-gateway-service.js';
import {
  isStagingSandboxRehearsalActive,
  isAuthorizedSyntheticTestPrincipal,
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting,
  AUTHORIZED_STAGING_NEON_PROJECT_ID,
  AUTHORIZED_STAGING_NEON_BRANCH,
  AUTHORIZED_STAGING_NEON_ENDPOINT
} from '../apps/api/src/billing/staging-sandbox-rehearsal-guard.js';

describe('Gate 4 Upgrade Button & Recurring Subscription Security', () => {
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
  // 1. GENUINE RECURRING SUBSCRIPTION SEMANTICS
  // =========================================================================
  describe('1. Genuine Recurring Subscription Semantics', () => {
    it('creates Razorpay recurring subscription via customGatewayTransport with subscription action', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.RAZORPAY_KEY_SECRET = 'secret_test_456';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb, tables } = createMockDb();
      let transportCall: any = null;

      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async (params) => {
        transportCall = params;
        return {
          gatewayOrderId: 'sub_rzp_mock_recurring_123',
          shortUrl: 'https://rzp.io/i/sub_mock'
        };
      });

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        'usr_synth_plus_2026',
        'plus',
        'INR',
        'razorpay',
        { userId: 'usr_synth_plus_2026' }
      );

      assert.strictEqual(checkout.gateway, 'razorpay');
      assert.strictEqual(checkout.orderId, 'sub_rzp_mock_recurring_123');
      assert.strictEqual(checkout.checkoutUrl, 'https://rzp.io/i/sub_mock');
      assert.strictEqual(transportCall.action, 'create_subscription');
      assert.strictEqual(transportCall.planTier, 'plus');
      assert.strictEqual(transportCall.currency, 'INR');

      // Assert persisted status is strictly 'pending' (never prematurely 'active')
      const subRecord = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(subRecord, 'Subscription record must be persisted in database');
      assert.strictEqual(subRecord.status, 'pending');
      assert.strictEqual(subRecord.gateway_subscription_id, 'sub_rzp_mock_recurring_123');
      assert.strictEqual(subRecord.amount_minor_units, 39900);
    });

    it('creates Cashfree recurring subscription via customGatewayTransport with periodic plan', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.CASHFREE_APP_ID = 'TEST1002345';
      process.env.CASHFREE_SECRET_KEY = 'cf_secret_789';
      process.env.CASHFREE_ENV = 'TEST';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb, tables } = createMockDb();
      let transportCall: any = null;

      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async (params) => {
        transportCall = params;
        return {
          gatewayOrderId: 'sub_cf_periodic_monthly_789',
          shortUrl: 'https://sandbox.cashfree.com/sub/cf_link'
        };
      });

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        'usr_synth_plus_2026',
        'plus',
        'INR',
        'cashfree',
        { userId: 'usr_synth_plus_2026' }
      );

      assert.strictEqual(checkout.gateway, 'cashfree');
      assert.strictEqual(checkout.orderId, 'sub_cf_periodic_monthly_789');
      assert.strictEqual(checkout.checkoutUrl, 'https://sandbox.cashfree.com/sub/cf_link');
      assert.strictEqual(transportCall.action, 'create_subscription');

      const subRecord = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(subRecord);
      assert.strictEqual(subRecord.status, 'pending');
    });

    it('throws error without silent fallback to one-time orders when subscription creation fails', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.RAZORPAY_KEY_SECRET = 'secret_test_456';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async () => {
        throw new Error('GATEWAY_SUBSCRIPTION_FAILED: Recurring e-mandates rejected in test environment');
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'usr_synth_plus_2026',
            'plus',
            'INR',
            'razorpay',
            { userId: 'usr_synth_plus_2026' }
          );
        },
        /GATEWAY_SUBSCRIPTION_FAILED/
      );
    });
  });

  // =========================================================================
  // 2. ACCOUNT ISOLATION: TEST PRINCIPAL VS PERSONAL OWNER ACCOUNT
  // =========================================================================
  describe('2. Account Isolation in Rehearsal Mode', () => {
    it('allows enrolled test principal neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS = 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_test_123',
        shortUrl: 'https://rzp.io/test'
      }));

      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7',
        'pro',
        'INR',
        'razorpay',
        { userId: 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7' }
      );

      assert.ok(checkout.purchaseId);
      assert.strictEqual(checkout.orderId, 'sub_test_123');
    });

    it('strictly denies personal owner account rajpunkeshwarrajgautam@gmail.com from staging rehearsal', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS = 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sec123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_test_123'
      }));

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'usr_personal_owner_raj',
            'plus',
            'INR',
            'razorpay',
            { userId: 'usr_personal_owner_raj', email: 'rajpunkeshwarrajgautam@gmail.com' }
          );
        },
        /REHEARSAL_UNAUTHORIZED/
      );
    });

    it('strictly denies unauthenticated / null principal from staging rehearsal', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            '',
            'plus',
            'INR',
            'razorpay',
            null as any
          );
        },
        /REHEARSAL_UNAUTHORIZED|SECURITY_VIOLATION|Invalid principal/
      );
    });
  });

  // =========================================================================
  // 3. FAIL-CLOSED BOUNDARIES: REHEARSAL DISABLED SHUTDOWN
  // =========================================================================
  describe('3. Rehearsal Disabled / Shutdown Invariants', () => {
    it('blocks checkout when rehearsal flag is false even for enrolled principals', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'false';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS = 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7',
            'plus',
            'INR',
            'razorpay',
            { userId: 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7' }
          );
        },
        /REHEARSAL_DISABLED|BILLING_UNAVAILABLE/
      );
    });

    it('rejects live gateway keys in staging rehearsal', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_live_productionDangerousKey999';
      process.env.DATABASE_URL = validStagingDbUrl;

      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'usr_synth_plus_2026',
            'plus',
            'INR',
            'razorpay',
            { userId: 'usr_synth_plus_2026' }
          );
        },
        /CRITICAL_SECURITY_VIOLATION/
      );
    });
  });
});
