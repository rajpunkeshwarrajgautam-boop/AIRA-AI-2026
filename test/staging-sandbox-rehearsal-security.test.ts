/**
 * AIRA AI 2026 — Staging Sandbox Rehearsal Security Regression Test Suite (Remediated Revision 2.0)
 *
 * Verifies all security invariants, fail-closed boundaries, and P0/P1 remediations:
 * 1. Disabled by default
 * 2. Production fence & commercial billing mutual exclusion
 * 3. Infrastructure & Git branch fencing (Vercel preview, project ID, staging branch)
 * 4. Database identity & Neon guard (strict fail-closed on missing DB, prod DB, PR #92 DB)
 * 5. Test gateway credential hardening (Razorpay test key, Cashfree TEST App ID, mock alias rejection)
 * 6. Authoritative synthetic principal enrollment (rejection of weak IDs, prefixes, client flags)
 * 7. End-to-end rehearsal checkout flow & metadata tagging
 * 8. Webhook integrity & forgery prevention (verification against persisted DB records)
 * 9. Statutory invoice sequence gap audit (gap detection, verified gapless, query failure, unsupported storage)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStagingSandboxRehearsalActive,
  isAuthorizedSyntheticTestPrincipal,
  validateTestGatewayCredentials,
  validateStagingDatabaseIdentity,
  assertStagingSandboxRehearsalAllowed,
  assertStagingSandboxRehearsalAllowedAsync,
  verifyLiveSessionDatabaseIdentity,
  isProductionRuntime,
  enrollSyntheticTestPrincipal,
  revokeSyntheticTestPrincipal,
  enrollSyntheticTestPrincipalForTesting,
  resetEnrolledSyntheticTestPrincipalsForTesting,
  DEFAULT_ENROLLED_SYNTHETIC_TEST_PRINCIPALS,
  AUTHORIZED_VERCEL_PROJECT_ID,
  AUTHORIZED_STAGING_GIT_BRANCH,
  AUTHORIZED_STAGING_NEON_PROJECT_ID,
  AUTHORIZED_STAGING_NEON_BRANCH,
  AUTHORIZED_STAGING_NEON_ENDPOINT
} from '../apps/api/src/billing/staging-sandbox-rehearsal-guard.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import {
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_ENDPOINT_ID,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_ENDPOINT_ID,
  COMMERCIAL_PR92_BRANCH_ID,
  COMMERCIAL_PR92_ENDPOINT_ID
} from '../packages/db/src/index.js';

describe('Staging Sandbox Rehearsal Security & Isolation Matrix', () => {
  const origEnv = { ...process.env };

  const validStagingDbUrl = `postgresql://aira_staging_user@${AUTHORIZED_STAGING_NEON_ENDPOINT}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED;
    delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.AIRA_ENVIRONMENT;
    delete process.env.AIRA_TEST_HARNESS_REHEARSAL;
    delete process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_ENV;
    delete process.env.DATABASE_URL;
    resetEnrolledSyntheticTestPrincipalsForTesting();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    resetEnrolledSyntheticTestPrincipalsForTesting();
  });

  // =========================================================================
  // 1. DISABLED BY DEFAULT
  // =========================================================================
  describe('1. Disabled by Default', () => {
    it('is disabled when AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED is unset', () => {
      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay' }),
        /REHEARSAL_DISABLED/
      );
    });

    it('is disabled when AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED is "false"', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'false';
      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay' }),
        /REHEARSAL_DISABLED/
      );
    });
  });

  // =========================================================================
  // 2. PRODUCTION ENFORCEMENT & COMMERCIAL BILLING MUTUAL EXCLUSION
  // =========================================================================
  describe('2. Production Fence & Anti-Crossover', () => {
    it('strictly rejects rehearsal when VERCEL_ENV is production', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL_ENV = 'production';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_sample123';

      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay' }),
        /CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal is strictly prohibited in production/
      );
    });

    it('rejects rehearsal if AIRA_COMMERCIAL_BILLING_ENABLED is true (strict mutual exclusion)', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.VERCEL_ENV = 'preview';

      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay' }),
        /CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal cannot operate while AIRA_COMMERCIAL_BILLING_ENABLED is true/
      );
    });

    it('isProductionRuntime accurately classifies Vercel and Node environments', () => {
      // Vercel Preview runtime with NODE_ENV=production (Vercel optimization) is NOT production
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';
      process.env.NODE_ENV = 'production';
      assert.equal(isProductionRuntime(), false);

      // Real Vercel production
      process.env.VERCEL_ENV = 'production';
      assert.equal(isProductionRuntime(), true);

      // Explicit AIRA_ENVIRONMENT=production override
      process.env.VERCEL_ENV = 'preview';
      process.env.AIRA_ENVIRONMENT = 'production';
      assert.equal(isProductionRuntime(), true);
      delete process.env.AIRA_ENVIRONMENT;

      // Non-Vercel environment with NODE_ENV=production
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      process.env.NODE_ENV = 'production';
      assert.equal(isProductionRuntime(), true);

      // Non-Vercel environment with NODE_ENV=test
      process.env.NODE_ENV = 'test';
      assert.equal(isProductionRuntime(), false);
    });

    it('permits rehearsal in Vercel Preview environment when NODE_ENV is production (Vercel optimization)', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';
      process.env.NODE_ENV = 'production';
      process.env.VERCEL_PROJECT_ID = AUTHORIZED_VERCEL_PROJECT_ID;
      process.env.VERCEL_GIT_COMMIT_REF = AUTHORIZED_STAGING_GIT_BRANCH;
      process.env.RAZORPAY_KEY_ID = 'rzp_test_previewKey123';
      process.env.RAZORPAY_KEY_SECRET = 'valid_test_secret_123';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'valid_test_webhook_secret_123';

      assert.equal(isStagingSandboxRehearsalActive(), true);
      assert.doesNotThrow(() => {
        assertStagingSandboxRehearsalAllowed({
          gateway: 'razorpay',
          databaseUrl: validStagingDbUrl,
          principal: { userId: 'usr_synth_plus_2026' }
        });
      });
    });

    it('deployed Vercel runtime strictly enforces deployment invariants and ignores test harness flags', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_PROJECT_ID = AUTHORIZED_VERCEL_PROJECT_ID;
      process.env.VERCEL_GIT_COMMIT_REF = 'wrong-feature-branch';
      // Attempt to spoof test fixture in deployed runtime
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';

      assert.throws(
        () => assertStagingSandboxRehearsalAllowed(
          { gateway: 'razorpay', databaseUrl: validStagingDbUrl },
          { isLocalTestFixture: true }
        ),
        /SECURITY_VIOLATION: Staging rehearsal is strictly restricted to branch 'staging'/
      );
    });
  });

  // =========================================================================
  // 3. INFRASTRUCTURE & GIT BRANCH FENCING
  // =========================================================================
  describe('3. Infrastructure & Git Branch Fencing', () => {
    it('strictly rejects rehearsal on wrong branch (e.g. main or prod-release)', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_PROJECT_ID = AUTHORIZED_VERCEL_PROJECT_ID;
      process.env.VERCEL_GIT_COMMIT_REF = 'main';

      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay', databaseUrl: validStagingDbUrl }),
        /SECURITY_VIOLATION: Staging rehearsal is strictly restricted to branch 'staging'/
      );
    });

    it('strictly rejects rehearsal on arbitrary PR branch', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_PROJECT_ID = AUTHORIZED_VERCEL_PROJECT_ID;
      process.env.VERCEL_GIT_COMMIT_REF = 'feat/unauthorized-branch';

      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay', databaseUrl: validStagingDbUrl }),
        /SECURITY_VIOLATION: Staging rehearsal is strictly restricted to branch 'staging'/
      );
    });

    it('strictly rejects rehearsal when Vercel project ID does not match aira-ai-2026', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_GIT_COMMIT_REF = AUTHORIZED_STAGING_GIT_BRANCH;
      process.env.VERCEL_PROJECT_ID = 'prj_WRONG_PROJECT_ATTEMPT';

      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay', databaseUrl: validStagingDbUrl }),
        /SECURITY_VIOLATION: Vercel project ID mismatch/
      );
    });

    it('fails closed when deployed on Vercel with missing VERCEL_PROJECT_ID or VERCEL_GIT_COMMIT_REF', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';
      // Missing project ID
      assert.equal(isStagingSandboxRehearsalActive(), false);
      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({ gateway: 'razorpay', databaseUrl: validStagingDbUrl }),
        /SECURITY_VIOLATION: Vercel project ID mismatch/
      );
    });
  });

  // =========================================================================
  // 4. DATABASE IDENTITY & NEON GUARD
  // =========================================================================
  describe('4. Database Classification & Neon Guard', () => {
    it('fails closed when database identity is missing (empty or unset DATABASE_URL)', () => {
      assert.throws(
        () => validateStagingDatabaseIdentity({ databaseUrl: '' }),
        /REHEARSAL_SECURITY_VIOLATION: Missing database identity/
      );
    });

    it('panics and aborts if connected database is Production Neon (old-sky-50952395)', () => {
      const prodDbUrl = `postgresql://aira_prod_test@${PRODUCTION_NEON_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
      assert.throws(
        () => validateStagingDatabaseIdentity({ databaseUrl: prodDbUrl }),
        /CRITICAL_SECURITY_VIOLATION: Connected database is PRODUCTION/
      );
    });

    it('panics and aborts if connected database is Commercial PR #92 branch', () => {
      const pr92Url = `postgresql://aira_pr92_test@ep-ancient-sound-b3drtnp5.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
      assert.throws(
        () => validateStagingDatabaseIdentity({ databaseUrl: pr92Url }),
        /CRITICAL_SECURITY_VIOLATION: Connected database is Commercial PR #92 branch/
      );
    });

    it('permits authorized Staging Neon database (mute-frost-50372225 / ep-twilight-cherry-b3iz2oqv)', () => {
      assert.doesNotThrow(() => validateStagingDatabaseIdentity({ databaseUrl: validStagingDbUrl }));
    });

    it('strictly forbids local test database URLs in deployed staging rehearsal', () => {
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';
      const localDbUrl = 'postgresql://aira:aira@127.0.0.1:5432/aira_db';
      assert.throws(
        () => validateStagingDatabaseIdentity({ databaseUrl: localDbUrl }),
        /SECURITY_VIOLATION: Local or test database URLs are strictly forbidden in deployed staging rehearsal/
      );
    });

    it('permits local test database exclusively in explicit local test fixtures', () => {
      const localDbUrl = 'postgresql://aira:aira@127.0.0.1:5432/aira_db';
      assert.doesNotThrow(() => validateStagingDatabaseIdentity({ databaseUrl: localDbUrl, isLocalTestFixture: true }));
    });
  });

  // =========================================================================
  // 5. TEST GATEWAY CREDENTIAL HARDENING
  // =========================================================================
  describe('5. Test Gateway Credential Hardening', () => {
    it('throws critical violation if live Razorpay key (rzp_live_*) is detected', () => {
      process.env.RAZORPAY_KEY_ID = 'rzp_live_abc1234567890';
      assert.throws(
        () => validateTestGatewayCredentials('razorpay'),
        /CRITICAL_SECURITY_VIOLATION: Production live Razorpay key \(rzp_live_\*\) detected/
      );
    });

    it('rejects invalid or malformed Razorpay keys in rehearsal', () => {
      process.env.RAZORPAY_KEY_ID = 'invalid_key_prefix';
      assert.throws(
        () => validateTestGatewayCredentials('razorpay'),
        /SECURITY_VIOLATION: Razorpay key must be a valid test-mode key/
      );
    });

    it('permits valid test-mode Razorpay key (rzp_test_*)', () => {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_validKey123';
      assert.doesNotThrow(() => validateTestGatewayCredentials('razorpay', { isLocalTestFixture: true }));
    });

    it('rejects mock credential aliases (rzp_test_mock) outside local test fixtures', () => {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_mock';
      assert.throws(
        () => validateTestGatewayCredentials('razorpay', { isLocalTestFixture: false }),
        /SECURITY_VIOLATION: Mock Razorpay credentials \(rzp_test_mock\) are strictly forbidden/
      );
    });

    it('throws critical violation if production Cashfree environment or live App ID is detected', () => {
      process.env.CASHFREE_APP_ID = 'PROD_APP_ID_123';
      process.env.CASHFREE_ENV = 'PROD';
      assert.throws(
        () => validateTestGatewayCredentials('cashfree'),
        /CRITICAL_SECURITY_VIOLATION: Production Cashfree credentials or production environment detected/
      );
    });

    it('permits valid test-mode Cashfree App ID (TEST*) with CASHFREE_ENV=TEST', () => {
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_ENV = 'TEST';
      assert.doesNotThrow(() => validateTestGatewayCredentials('cashfree', { isLocalTestFixture: true }));
    });

    it('rejects Cashfree App ID if CASHFREE_ENV is not TEST', () => {
      process.env.CASHFREE_APP_ID = 'TEST1234567890';
      process.env.CASHFREE_ENV = 'OTHER';
      assert.throws(
        () => validateTestGatewayCredentials('cashfree'),
        /SECURITY_VIOLATION: CASHFREE_ENV must be explicitly 'TEST'/
      );
    });
  });

  // =========================================================================
  // 6. AUTHORITATIVE SYNTHETIC PRINCIPAL ENROLLMENT
  // =========================================================================
  describe('6. Authoritative Synthetic Principal Enrollment', () => {
    it('strictly rejects weak identifiers and un-enrolled accounts', () => {
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'admin' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'account_1' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_test_qa_lead' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'test_user@example.com' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'any_arbitrary_user', isSynthetic: true }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_real_alice', email: 'alice@corporate.com' }), false);
    });

    it('permits pre-enrolled authorized synthetic test accounts', () => {
      for (const principal of DEFAULT_ENROLLED_SYNTHETIC_TEST_PRINCIPALS) {
        assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: principal }), true);
      }
    });

    it('permits dynamically enrolled synthetic test accounts via programmatic test helper', () => {
      const tempPrincipal = 'temp_synth_operator_2026';
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: tempPrincipal }), false);
      enrollSyntheticTestPrincipalForTesting(tempPrincipal);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: tempPrincipal }), true);
    });

    it('permits accounts enrolled via AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS environment variable', () => {
      process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS = 'env_synth_user_1,env_synth_user_2';
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'env_synth_user_1' }), true);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'env_synth_user_2' }), true);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'env_synth_user_3' }), false);
    });

    it('assertStagingSandboxRehearsalAllowed throws REHEARSAL_UNAUTHORIZED for un-enrolled accounts', () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';

      assert.throws(
        () => assertStagingSandboxRehearsalAllowed({
          gateway: 'razorpay',
          principal: { userId: 'unauthorized_customer_123' },
          databaseUrl: validStagingDbUrl,
          isLocalTestFixture: true
        }),
        /REHEARSAL_UNAUTHORIZED/
      );
    });

    it('revokes synthetic test account and strictly fails closed upon revocation', () => {
      const dynamicPrincipal = 'temp_revocable_principal_2026';
      enrollSyntheticTestPrincipal(dynamicPrincipal);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: dynamicPrincipal }), true);

      // Revoke the principal
      revokeSyntheticTestPrincipal(dynamicPrincipal);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: dynamicPrincipal }), false);

      // Verify that default pre-enrolled accounts can also be revoked if compromised
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_synth_test_2026' }), true);
      revokeSyntheticTestPrincipal('usr_synth_test_2026');
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_synth_test_2026' }), false);
    });

    it('strictly rejects arbitrary user ID prefixes or emails masquerading as synthetic test accounts', () => {
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_synth_attacker_unauthorized' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_test_attacker_unauthorized' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'synthetic@aira.internal' }), false);
      assert.equal(isAuthorizedSyntheticTestPrincipal({ userId: 'usr_real_victim', isSynthetic: true }), false);
    });
  });

  // =========================================================================
  // 7. END-TO-END REHEARSAL CHECKOUT FLOW
  // =========================================================================
  describe('7. End-to-End Rehearsal Checkout Flow', () => {
    it('allows subscription checkout creation when all rehearsal invariants are satisfied', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const subscriptions: any[] = [];
      const mockDb = ((table: string) => {
        return {
          insert: async (row: any) => {
            if (table === 'subscriptions') subscriptions.push(row);
            return [row];
          },
          where: () => ({
            first: async () => ({ id: 'cust_synthetic_1', principal_id: 'usr_synth_plus_2026' })
          })
        };
      }) as any;
      mockDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'neondb_owner',
          server_ip: '127.0.0.1',
          neon_project_id: 'mute-frost-50372225',
          neon_branch_id: 'br-snowy-bonus-b32thjlz',
          neon_endpoint_id: 'ep-twilight-cherry-b3iz2oqv'
        }]
      });

      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_rzp_mock_123',
        shortUrl: 'https://rzp.io/i/mockShortUrl'
      }));

      try {
        const result = await paymentGatewayService.createSubscriptionCheckout(
          'usr_synth_plus_2026',
          'plus',
          'INR',
          'razorpay',
          { userId: 'usr_synth_plus_2026', isSynthetic: true }
        );

        assert.equal(result.gateway, 'razorpay');
        assert.equal(result.currency, 'INR');
        assert.equal(result.orderId, 'sub_rzp_mock_123');
        assert.equal(result.amount, 39900);
        assert.equal(result.isSandbox, true);
        assert.equal(subscriptions.length, 1);

        // Verify metadata tagging
        const metadata = JSON.parse(subscriptions[0].metadata);
        assert.equal(metadata.rehearsal, true, 'Subscription must be tagged as rehearsal');
        assert.equal(metadata.isSandbox, true, 'Subscription must be tagged as sandbox');
      } finally {
        paymentGatewayService.setDbClient(null);
        paymentGatewayService.setGatewayTransport(null);
      }
    });

    it('rejects checkout creation when rehearsal is disabled and commercial billing is false', async () => {
      assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'usr_synth_plus_2026',
            'plus',
            'INR',
            'razorpay'
          );
        },
        /BILLING_UNAVAILABLE: Live checkout has not been approved or integrated/
      );
    });

    it('rejects checkout creation when route principalId mismatches authenticated principalContext userId', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';
      process.env.DATABASE_URL = validStagingDbUrl;

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'usr_synth_plus_2026',
            'plus',
            'INR',
            'razorpay',
            { userId: 'usr_synth_pro_2026', isSynthetic: true }
          );
        },
        /SECURITY_VIOLATION: Principal ID mismatch between route parameter and authenticated session context/
      );
    });

    it('rejects checkout creation when live database session belongs to production Neon project', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const mockProdDb = ((table: string) => ({
        where: () => ({ first: async () => null })
      })) as any;
      mockProdDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          neon_project_id: PRODUCTION_NEON_PROJECT_ID,
          neon_branch_id: 'br-shiny-moon-b3vy9xj7',
          neon_endpoint_id: PRODUCTION_NEON_ENDPOINT_ID
        }]
      });

      paymentGatewayService.setDbClient(mockProdDb);
      try {
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
          /CRITICAL_SECURITY_VIOLATION: Connected database session is PRODUCTION Neon project/
        );
      } finally {
        paymentGatewayService.setDbClient(null);
      }
    });

    it('verifies live session identity on the exact transaction connection during checkout record insertion', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';
      process.env.DATABASE_URL = validStagingDbUrl;

      let rawCallsOnTrx = 0;
      const subscriptions: any[] = [];
      const auditEvents: any[] = [];

      const mockTrx = ((table: string) => ({
        insert: async (data: any) => {
          if (table === 'subscriptions') subscriptions.push(data);
          if (table === 'billing_audit_events') auditEvents.push(data);
          return [1];
        }
      })) as any;
      mockTrx.raw = async () => {
        rawCallsOnTrx++;
        return {
          rows: [{
            db_name: 'neondb',
            neon_project_id: AUTHORIZED_STAGING_NEON_PROJECT_ID,
            neon_branch_id: AUTHORIZED_STAGING_NEON_BRANCH,
            neon_endpoint_id: AUTHORIZED_STAGING_NEON_ENDPOINT
          }]
        };
      };

      const mockDb = ((table: string) => ({
        where: () => ({ first: async () => null }),
        insert: async () => [1]
      })) as any;
      mockDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          neon_project_id: AUTHORIZED_STAGING_NEON_PROJECT_ID,
          neon_branch_id: AUTHORIZED_STAGING_NEON_BRANCH,
          neon_endpoint_id: AUTHORIZED_STAGING_NEON_ENDPOINT
        }]
      });
      mockDb.transaction = async (cb: (trx: any) => Promise<any>) => {
        return await cb(mockTrx);
      };

      paymentGatewayService.setDbClient(mockDb);
      paymentGatewayService.setGatewayTransport(async () => ({
        gatewayOrderId: 'sub_rzp_mock_pooled',
        shortUrl: 'https://rzp.io/i/pooled'
      }));

      try {
        const result = await paymentGatewayService.createSubscriptionCheckout(
          'usr_synth_plus_2026',
          'plus',
          'INR',
          'razorpay',
          { userId: 'usr_synth_plus_2026', isSynthetic: true }
        );

        assert.equal(result.orderId, 'sub_rzp_mock_pooled');
        assert.equal(subscriptions.length, 1);
        assert.equal(auditEvents.length, 1);
        assert.ok(rawCallsOnTrx >= 1, 'Live session verification must execute on the exact transaction connection');
      } finally {
        paymentGatewayService.setDbClient(null);
        paymentGatewayService.setGatewayTransport(null);
      }
    });
  });

  // =========================================================================
  // 8. WEBHOOK INTEGRITY & FORGERY DEFENSE
  // =========================================================================
  describe('8. Webhook Integrity & Rehearsal Verification', () => {
    it('rejects fulfillment when commercial billing is false and subscription is not rehearsal or owner is not synthetic', async () => {
      // In this scenario, attacker sends a forged webhook with notes claiming principal_id is synthetic,
      // but the database record has is_sandbox: false or owner is real
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_validKey123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const mockDb = ((table: string) => {
        return {
          where: () => ({
            first: async () => {
              if (table === 'subscriptions') {
                return {
                  id: 'sub_real_attack',
                  customer_id: 'cust_real',
                  plan_tier: 'plus',
                  currency: 'INR',
                  amount_minor_units: 39900,
                  is_sandbox: false, // NOT SANDBOX!
                  metadata: JSON.stringify({ principalId: 'usr_real_victim' })
                };
              }
              return null;
            }
          })
        };
      }) as any;
      mockDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'neondb_owner',
          server_ip: '127.0.0.1',
          neon_project_id: 'mute-frost-50372225',
          neon_branch_id: 'br-snowy-bonus-b32thjlz',
          neon_endpoint_id: 'ep-twilight-cherry-b3iz2oqv'
        }]
      });

      paymentGatewayService.setDbClient(mockDb);

      try {
        await assert.rejects(
          async () => {
            await (paymentGatewayService as any).handleGatewayEvent(
              'razorpay',
              'subscription.charged',
              {
                subscription: { id: 'sub_real_attack', currency: 'INR', amount: 39900 },
                payment: { id: 'pay_test_attack_123', status: 'captured', currency: 'INR', amount: 39900 },
                notes: { principal_id: 'usr_synth_plus_2026' } // Forged notes!
              },
              mockDb
            );
          },
          /REHEARSAL_SECURITY_VIOLATION/
        );
      } finally {
        paymentGatewayService.setDbClient(null);
      }
    });

    it('rejects fulfillment when subscription owner is not an enrolled synthetic test account', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_validKey123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const mockDb = ((table: string) => {
        return {
          where: () => ({
            first: async () => {
              if (table === 'subscriptions') {
                return {
                  id: 'sub_synth_but_real_owner',
                  customer_id: 'cust_real',
                  plan_tier: 'plus',
                  currency: 'INR',
                  amount_minor_units: 39900,
                  is_sandbox: true,
                  metadata: JSON.stringify({ principalId: 'usr_real_alice', rehearsal: true, is_sandbox: true })
                };
              }
              return null;
            }
          })
        };
      }) as any;
      mockDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'neondb_owner',
          server_ip: '127.0.0.1',
          neon_project_id: 'mute-frost-50372225',
          neon_branch_id: 'br-snowy-bonus-b32thjlz',
          neon_endpoint_id: 'ep-twilight-cherry-b3iz2oqv'
        }]
      });

      paymentGatewayService.setDbClient(mockDb);

      try {
        await assert.rejects(
          async () => {
            await (paymentGatewayService as any).handleGatewayEvent(
              'razorpay',
              'subscription.charged',
              {
                subscription: { id: 'sub_synth_but_real_owner', currency: 'INR', amount: 39900 },
                payment: { id: 'pay_test_attack_456', status: 'captured', currency: 'INR', amount: 39900 }
              },
              mockDb
            );
          },
          /REHEARSAL_UNAUTHORIZED/
        );
      } finally {
        paymentGatewayService.setDbClient(null);
      }
    });

    it('successfully processes rehearsal webhook fulfillment when subscription is tagged as rehearsal and owner is enrolled synthetic account', async () => {
      process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true';
      process.env.AIRA_TEST_HARNESS_REHEARSAL = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_validKey123';
      process.env.DATABASE_URL = validStagingDbUrl;

      const mockDb = ((table: string) => {
        return {
          where: () => ({
            first: async () => {
              if (table === 'subscriptions') {
                return {
                  id: 'sub_synth_valid',
                  customer_id: 'cust_synth',
                  plan_tier: 'plus',
                  currency: 'INR',
                  amount_minor_units: 39900,
                  status: 'active',
                  is_sandbox: true,
                  metadata: JSON.stringify({
                    principalId: 'usr_synth_plus_2026',
                    rehearsal: true,
                    is_sandbox: true,
                    lastPaymentId: 'pay_test_synth_123'
                  })
                };
              }
              return null;
            }
          })
        };
      }) as any;
      mockDb.raw = async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'neondb_owner',
          server_ip: '127.0.0.1',
          neon_project_id: 'mute-frost-50372225',
          neon_branch_id: 'br-snowy-bonus-b32thjlz',
          neon_endpoint_id: 'ep-twilight-cherry-b3iz2oqv'
        }]
      });

      paymentGatewayService.setDbClient(mockDb);

      try {
        await assert.doesNotReject(async () => {
          await (paymentGatewayService as any).handleGatewayEvent(
            'razorpay',
            'subscription.charged',
            {
              subscription: { id: 'sub_synth_valid', currency: 'INR', amount: 39900 },
              payment: { id: 'pay_test_synth_123', status: 'captured', currency: 'INR', amount: 39900 }
            },
            mockDb
          );
        });
      } finally {
        paymentGatewayService.setDbClient(null);
      }
    });
  });

  // =========================================================================
  // 9. STATUTORY INVOICE SEQUENCE AUDIT (GAP DETECTION)
  // =========================================================================
  describe('9. Statutory Invoice Sequence Gap Audit', () => {
    it('identifies uncommitted draft sequence gaps when sequences are consumed without completed invoices', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return {
              rows: [{ last_value: 5, is_called: true }]
            };
          }
          if (sql.includes('billing_invoices')) {
            return {
              rows: [
                { invoice_number: 'INV-2026-0001' },
                { invoice_number: 'INV-2026-0002' },
                { invoice_number: 'INV-2026-0004' }
              ]
            };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_GAP_DETECTED');
      assert.equal(audit.currentSeq, 5);
      assert.equal(audit.recordedInvoicesCount, 3);
      assert.equal(audit.isGapless, false);
      assert.deepEqual(audit.voidOrMissing, ['INV-2026-0003', 'INV-2026-0005']);
    });

    it('reports AUDIT_VERIFIED_GAPLESS when all allocated numbers match recorded invoices', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return {
              rows: [{ last_value: 3, is_called: true }]
            };
          }
          if (sql.includes('billing_invoices')) {
            return {
              rows: [
                { invoice_number: 'INV-2026-0001' },
                { invoice_number: 'INV-2026-0002' },
                { invoice_number: 'INV-2026-0003' }
              ]
            };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_VERIFIED_GAPLESS');
      assert.equal(audit.currentSeq, 3);
      assert.equal(audit.recordedInvoicesCount, 3);
      assert.equal(audit.isGapless, true);
      assert.deepEqual(audit.voidOrMissing, []);
    });

    it('returns AUDIT_QUERY_FAILED with isGapless: false when query throws an error', async () => {
      const failingTrx = {
        raw: async () => {
          throw new Error('Connection terminated unexpectedly');
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(failingTrx, 2026);
      assert.equal(audit.status, 'AUDIT_QUERY_FAILED');
      assert.equal(audit.isGapless, false);
      assert.match(audit.error || '', /Connection terminated unexpectedly/);
    });

    it('returns AUDIT_UNSUPPORTED_STORAGE with isGapless: false when trx does not support raw SQL', async () => {
      const nonPgTrx = {}; // no raw method

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(nonPgTrx, 2026);
      assert.equal(audit.status, 'AUDIT_UNSUPPORTED_STORAGE');
      assert.equal(audit.isGapless, false);
    });

    it('returns AUDIT_INCOMPLETE_EVIDENCE with isGapless: false when sequence row is missing from sequence relation', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return { rows: [] }; // No row returned
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_INCOMPLETE_EVIDENCE');
      assert.equal(audit.isGapless, false);
      assert.match(audit.error || '', /Sequence record missing from billing_invoice_number_seq/);
    });

    it('returns AUDIT_INCOMPLETE_EVIDENCE with isGapless: false when sequence is_called is false but invoices already exist', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return { rows: [{ last_value: 1, is_called: false }] };
          }
          if (sql.includes('billing_invoices')) {
            return {
              rows: [{ invoice_number: 'INV-2026-0001' }]
            };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_INCOMPLETE_EVIDENCE');
      assert.equal(audit.isGapless, false);
      assert.match(audit.error || '', /Sequence is uncalled but invoices already exist in series/);
    });

    it('returns AUDIT_VERIFIED_GAPLESS with isGapless: true when sequence is_called is false and 0 invoices exist', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return { rows: [{ last_value: 1, is_called: false }] };
          }
          if (sql.includes('billing_invoices')) {
            return { rows: [] };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_VERIFIED_GAPLESS');
      assert.equal(audit.isGapless, true);
      assert.equal(audit.currentSeq, 0);
      assert.equal(audit.recordedInvoicesCount, 0);
    });

    it('returns AUDIT_INCOMPLETE_EVIDENCE with isGapless: false when sequence value is invalid or <= 0', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return { rows: [{ last_value: -5, is_called: true }] };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_INCOMPLETE_EVIDENCE');
      assert.equal(audit.isGapless, false);
      assert.match(audit.error || '', /Invalid sequence counter value/);
    });

    it('returns AUDIT_GAP_DETECTED with isGapless: false and detects duplicate invoice numbers', async () => {
      const mockTrx = {
        raw: async (sql: string) => {
          if (sql.includes('billing_invoice_number_seq')) {
            return { rows: [{ last_value: 2, is_called: true }] };
          }
          if (sql.includes('billing_invoices')) {
            return {
              rows: [
                { invoice_number: 'INV-2026-0001' },
                { invoice_number: 'INV-2026-0001' }, // Duplicate!
                { invoice_number: 'INV-2026-0002' }
              ]
            };
          }
          return { rows: [] };
        }
      };

      const audit = await paymentGatewayService.auditInvoiceSequenceGaps(mockTrx, 2026);
      assert.equal(audit.status, 'AUDIT_GAP_DETECTED');
      assert.equal(audit.isGapless, false);
      assert.deepEqual(audit.duplicates, ['INV-2026-0001']);
      assert.match(audit.error || '', /Duplicate invoice numbers detected/);
    });
  });

  // =========================================================================
  // 10. LIVE DATABASE SESSION IDENTITY VERIFICATION (NEON GUCS)
  // =========================================================================
  describe('10. Live Database Session Identity Verification (Neon GUCs)', () => {
    it('successfully validates live database session matching staging Neon identity', async () => {
      const validTrx = {
        raw: async () => ({
          rows: [{
            db_name: 'neondb',
            db_user: 'aira_staging_user',
            server_ip: '10.0.0.1',
            neon_project_id: AUTHORIZED_STAGING_NEON_PROJECT_ID,
            neon_branch_id: AUTHORIZED_STAGING_NEON_BRANCH,
            neon_endpoint_id: AUTHORIZED_STAGING_NEON_ENDPOINT,
            neon_timeline_id: 't-12345'
          }]
        })
      };

      const identity = await verifyLiveSessionDatabaseIdentity(validTrx, { isLocalTestFixture: true });
      assert.equal(identity.neonProjectId, AUTHORIZED_STAGING_NEON_PROJECT_ID);
      assert.equal(identity.neonBranchId, AUTHORIZED_STAGING_NEON_BRANCH);
      assert.equal(identity.neonEndpointId, AUTHORIZED_STAGING_NEON_ENDPOINT);
      assert.equal(identity.databaseName, 'neondb');
    });

    it('panics and aborts with CRITICAL_SECURITY_VIOLATION if session returns Production Neon project', async () => {
      const prodTrx = {
        raw: async () => ({
          rows: [{
            db_name: 'neondb',
            neon_project_id: PRODUCTION_NEON_PROJECT_ID, // old-sky-50952395
            neon_branch_id: 'br-shiny-moon-b3vy9xj7',
            neon_endpoint_id: PRODUCTION_NEON_ENDPOINT_ID
          }]
        })
      };

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(prodTrx, { isLocalTestFixture: true });
        },
        /CRITICAL_SECURITY_VIOLATION: Connected database session is PRODUCTION Neon project/
      );
    });

    it('panics and aborts with CRITICAL_SECURITY_VIOLATION if session returns Commercial PR #92 branch', async () => {
      const pr92Trx = {
        raw: async () => ({
          rows: [{
            db_name: 'neondb',
            neon_project_id: 'mute-frost-50372225',
            neon_branch_id: COMMERCIAL_PR92_BRANCH_ID, // br-green-snow-b3dsci5u
            neon_endpoint_id: COMMERCIAL_PR92_ENDPOINT_ID
          }]
        })
      };

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(pr92Trx, { isLocalTestFixture: true });
        },
        /CRITICAL_SECURITY_VIOLATION: Connected database session is Commercial PR #92 branch/
      );
    });

    it('fails closed with SECURITY_VIOLATION when live session query throws an error', async () => {
      const brokenTrx = {
        raw: async () => {
          throw new Error('Connection terminated by server');
        }
      };

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(brokenTrx, { isLocalTestFixture: true });
        },
        /SECURITY_VIOLATION: Failed to query database session identity: Connection terminated by server/
      );
    });

    it('fails closed in deployed Vercel mode when session is missing required Neon GUCs', async () => {
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';

      const missingGucsTrx = {
        raw: async () => ({
          rows: [{
            db_name: 'neondb',
            db_user: 'postgres',
            server_ip: '127.0.0.1'
            // Missing neon_project_id, neon_branch_id, neon_endpoint_id
          }]
        })
      };

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(missingGucsTrx);
        },
        /SECURITY_VIOLATION: Connected database session lacks required Neon control-plane identity/
      );
    });

    it('fails closed in deployed Vercel mode when database name is not neondb', async () => {
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'preview';

      const wrongDbNameTrx = {
        raw: async () => ({
          rows: [{
            db_name: 'foreign_db', // Wrong database name!
            neon_project_id: AUTHORIZED_STAGING_NEON_PROJECT_ID,
            neon_branch_id: AUTHORIZED_STAGING_NEON_BRANCH,
            neon_endpoint_id: AUTHORIZED_STAGING_NEON_ENDPOINT
          }]
        })
      };

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(wrongDbNameTrx);
        },
        /SECURITY_VIOLATION: Live database session database name 'foreign_db' does not match expected 'neondb'/
      );
    });

    it('fails closed when clientOrTrx is null or does not support raw SQL execution', async () => {
      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity(null);
        },
        /SECURITY_VIOLATION: Database connection or transaction required for live session verification does not support SQL execution/
      );

      await assert.rejects(
        async () => {
          await verifyLiveSessionDatabaseIdentity({});
        },
        /SECURITY_VIOLATION: Database connection or transaction required for live session verification does not support SQL execution/
      );
    });
  });
});
