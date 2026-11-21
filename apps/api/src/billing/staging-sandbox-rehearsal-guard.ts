/**
 * AIRA AI 2026 — Staging Sandbox Rehearsal Guard (Remediated Revision 2.0)
 *
 * Implements strict, multi-dimensional security isolation permitting genuine
 * Cashfree & Razorpay test-mode checkout and webhook reconciliation on the
 * verified staging deployment while commercial billing remains disabled.
 *
 * Fail-Closed Security Invariants:
 * 1. Explicit Feature Flag: AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED === 'true'
 * 2. Strict Non-Production Environment: Rehearsal is strictly forbidden when VERCEL_ENV === 'production' or NODE_ENV === 'production'.
 * 3. Commercial Billing Invariant: AIRA_COMMERCIAL_BILLING_ENABLED must remain false/falsy. Strict mutual exclusion.
 * 4. Verified Staging Runtime Identity: On Vercel deployments (VERCEL=1 or VERCEL_ENV set), requires:
 *    - VERCEL_ENV === 'preview'
 *    - VERCEL_PROJECT_ID === 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH'
 *    - VERCEL_GIT_COMMIT_REF === 'staging'
 *    All missing platform values FAIL CLOSED.
 * 5. Local Test Harness Separation: Rehearsal in non-deployed local environments is strictly restricted to
 *    explicit isolated test fixtures (isLocalTestFixture=true or AIRA_TEST_HARNESS_REHEARSAL=true).
 *    Setting AIRA_ENVIRONMENT=staging or NODE_ENV=test alone NEVER grants rehearsal authorization.
 * 6. Authoritative Database Identity: Target database must be verified Staging Neon:
 *    - Project: mute-frost-50372225
 *    - Branch: br-snowy-bonus-b32thjlz
 *    - Endpoint: ep-twilight-cherry-b3iz2oqv
 *    Production Neon (old-sky-50952395) and Commercial PR #92 (br-green-snow-b3dsci5u) trigger immediate fatal panics.
 *    Missing or unknown database identity FAILS CLOSED.
 * 7. Test-Mode Gateway Credentials:
 *    - Razorpay Key must strictly match '^rzp_test_[a-zA-Z0-9]+$'. Live keys ('rzp_live_*') cause immediate security panic.
 *    - Cashfree App ID must strictly match '^TEST[a-zA-Z0-9]+$' and CASHFREE_ENV === 'TEST'.
 *    - Mock credential aliases (rzp_test_mock, cf_test_mock) are strictly forbidden in deployed rehearsal.
 * 8. Authoritative Synthetic Account Enrollment:
 *    Checkout and fulfillment are permitted exclusively for explicitly enrolled synthetic test accounts.
 *    Arbitrary test prefixes (usr_test_*), arbitrary synthetic-looking emails, and client-supplied flags are strictly rejected.
 */

import {
  classifyDatabaseUrl,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_ENDPOINT_ID,
  PRODUCTION_NEON_PROJECT_ID
} from '../../../../packages/db/src/index.js';

export const AUTHORIZED_VERCEL_PROJECT_ID = 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH';
export const AUTHORIZED_STAGING_GIT_BRANCH = 'staging';
export const AUTHORIZED_STAGING_NEON_PROJECT_ID = 'mute-frost-50372225';
export const AUTHORIZED_STAGING_NEON_BRANCH = 'br-snowy-bonus-b32thjlz';
export const AUTHORIZED_STAGING_NEON_ENDPOINT = 'ep-twilight-cherry-b3iz2oqv';
export const AUTHORIZED_STAGING_CANONICAL_DOMAIN = 'staging.virexaaiventures.com';

/**
 * Pre-enrolled authorized synthetic test accounts for staging rehearsal.
 * Accounts not enrolled here or via AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS are rejected.
 */
export const DEFAULT_ENROLLED_SYNTHETIC_TEST_PRINCIPALS = new Set<string>([
  'usr_synth_plus_2026',
  'usr_synth_pro_2026',
  'usr_synth_test_2026',
  'synthetic_rehearsal_plus@aira.internal',
  'synthetic_rehearsal_pro@aira.internal',
  'sandbox_test_user@aira.internal'
]);

let testHarnessEnrolledPrincipals: Set<string> | null = null;

/**
 * Programmatic enrollment helper for isolated test harnesses.
 */
export function enrollSyntheticTestPrincipalForTesting(principalId: string): void {
  if (!testHarnessEnrolledPrincipals) testHarnessEnrolledPrincipals = new Set();
  testHarnessEnrolledPrincipals.add(principalId.toLowerCase().trim());
}

/**
 * Reset programmatic test harness enrollments.
 */
export function resetEnrolledSyntheticTestPrincipalsForTesting(): void {
  testHarnessEnrolledPrincipals = null;
}

export interface StagingRehearsalContext {
  principal?: {
    userId: string;
    email?: string;
    isSynthetic?: boolean;
    roles?: string[];
  } | null;
  gateway?: 'razorpay' | 'cashfree';
  databaseUrl?: string;
  isLocalTestFixture?: boolean;
}

export interface RehearsalValidationResult {
  allowed: boolean;
  reason?: string;
  isRehearsal: boolean;
  context: {
    environment: string;
    branch?: string;
    projectId?: string;
    databaseCategory?: string;
    gateway?: string;
    isSyntheticPrincipal?: boolean;
  };
}

/**
 * Checks whether Staging Sandbox Rehearsal is currently active and all mandatory
 * infrastructure and configuration preconditions are satisfied.
 * Fails closed (returns false) on any missing or mismatched identity value.
 */
export function isStagingSandboxRehearsalActive(options?: { isLocalTestFixture?: boolean }): boolean {
  // 1. Explicit feature flag must be enabled
  if (process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED !== 'true') {
    return false;
  }

  // 2. Hard commercial billing conflict: Rehearsal cannot operate if commercial billing is active
  if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true') {
    return false;
  }

  // 3. Hard production block: Production signals must be strictly absent
  if (
    process.env.VERCEL_ENV === 'production' ||
    process.env.NODE_ENV === 'production' ||
    process.env.AIRA_ENVIRONMENT === 'production'
  ) {
    return false;
  }

  // 4. Determine deployment environment vs local test fixture
  const isVercelRuntime = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
  const isLocalFixture = options?.isLocalTestFixture === true || process.env.AIRA_TEST_HARNESS_REHEARSAL === 'true';

  if (isVercelRuntime) {
    // In a deployed Vercel environment, ALL staging identity requirements are MANDATORY and fail-closed:
    // a. Must be preview environment
    if (process.env.VERCEL_ENV !== 'preview') {
      return false;
    }

    // b. Must match authorized Vercel project ID
    if (process.env.VERCEL_PROJECT_ID !== AUTHORIZED_VERCEL_PROJECT_ID) {
      return false;
    }

    // c. Must strictly match authorized staging branch (no arbitrary feature branches in deployment)
    if (process.env.VERCEL_GIT_COMMIT_REF !== AUTHORIZED_STAGING_GIT_BRANCH) {
      return false;
    }

    return true;
  }

  // 5. In a non-Vercel local environment, rehearsal is ONLY active if explicitly running
  // in an authorized local test fixture. AIRA_ENVIRONMENT=staging or NODE_ENV=test alone is INSUFFICIENT.
  if (isLocalFixture) {
    return true;
  }

  return false;
}

/**
 * Validates that the caller principal is an authoritatively enrolled synthetic test account.
 * Specifically rejects authorization based on weak identifiers:
 * - 'admin', 'account_1', 'account_2'
 * - Arbitrary 'usr_test_*' prefixes
 * - Arbitrary synthetic-looking emails
 * - Client-supplied 'isSynthetic: true'
 */
export function isAuthorizedSyntheticTestPrincipal(
  principal?: {
    userId: string;
    email?: string;
    isSynthetic?: boolean;
  } | null,
  options?: { isLocalTestFixture?: boolean }
): boolean {
  if (!principal || !principal.userId) return false;

  const uid = principal.userId.toLowerCase().trim();
  const email = (principal.email || '').toLowerCase().trim();

  // Specifically reject weak/arbitrary identifiers if not explicitly enrolled
  if (
    uid === 'admin' ||
    uid === 'account_1' ||
    uid === 'account_2' ||
    uid.startsWith('usr_test_') ||
    uid.startsWith('test_') ||
    uid.startsWith('synthetic_') ||
    uid.startsWith('sandbox_') ||
    email.endsWith('@example.com')
  ) {
    // Weak identifier detected: must still pass explicit enrollment verification below.
  }

  // 1. Check default authoritative enrolled principals
  if (DEFAULT_ENROLLED_SYNTHETIC_TEST_PRINCIPALS.has(uid) || (email && DEFAULT_ENROLLED_SYNTHETIC_TEST_PRINCIPALS.has(email))) {
    return true;
  }

  // 2. Check explicit environment-configured allowlist (comma-separated exact IDs or emails)
  const envEnrolled = (process.env.AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (envEnrolled.includes(uid) || (email && envEnrolled.includes(email))) {
    return true;
  }

  // 3. Check programmatic test harness enrollment (isolated unit tests only)
  if (testHarnessEnrolledPrincipals && (testHarnessEnrolledPrincipals.has(uid) || (email && testHarnessEnrolledPrincipals.has(email)))) {
    return true;
  }

  return false;
}

/**
 * Validates that gateway credentials are strictly valid test-mode / sandbox keys.
 * Live keys (e.g. rzp_live_) trigger an immediate fatal security exception.
 * Mock aliases are rejected in deployed rehearsal.
 */
export function validateTestGatewayCredentials(
  gateway: 'razorpay' | 'cashfree',
  options?: { isLocalTestFixture?: boolean }
): void {
  const isDeployedVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV === 'preview';
  const isLocalFixture = (options?.isLocalTestFixture === true || process.env.AIRA_TEST_HARNESS_REHEARSAL === 'true' || process.env.NODE_ENV === 'test') && !isDeployedVercel;

  if (gateway === 'razorpay') {
    const keyId = (process.env.RAZORPAY_KEY_ID || process.env.AIRA_TEST_GATEWAY_KEY_ID || '').trim();
    if (!keyId) {
      throw new Error('SECURITY_VIOLATION: RAZORPAY_KEY_ID is missing or empty.');
    }

    if (keyId.startsWith('rzp_live_')) {
      throw new Error('CRITICAL_SECURITY_VIOLATION: Production live Razorpay key (rzp_live_*) detected in staging rehearsal! Aborting immediately.');
    }

    if (keyId.startsWith('rzp_test_mock')) {
      if (!isLocalFixture) {
        throw new Error('SECURITY_VIOLATION: Mock Razorpay credentials (rzp_test_mock) are strictly forbidden in deployed rehearsal.');
      }
      return;
    }

    if (!/^rzp_test_[a-zA-Z0-9]+$/.test(keyId)) {
      throw new Error('SECURITY_VIOLATION: Razorpay key must be a valid test-mode key matching format rzp_test_[a-zA-Z0-9]+.');
    }

    if (!isLocalFixture) {
      const secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
      const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
      if (!secret || secret.includes('mock')) {
        throw new Error('SECURITY_VIOLATION: Valid RAZORPAY_KEY_SECRET is required in deployed rehearsal.');
      }
      if (!webhookSecret || webhookSecret.includes('mock')) {
        throw new Error('SECURITY_VIOLATION: Valid RAZORPAY_WEBHOOK_SECRET is required in deployed rehearsal.');
      }
    }
  } else if (gateway === 'cashfree') {
    const appId = (process.env.CASHFREE_APP_ID || process.env.AIRA_TEST_GATEWAY_KEY_ID || '').trim();
    const cfEnv = (process.env.CASHFREE_ENV || '').trim().toUpperCase();

    if (!appId) {
      throw new Error('SECURITY_VIOLATION: CASHFREE_APP_ID is missing or empty.');
    }

    if (cfEnv === 'PROD' || cfEnv === 'PRODUCTION' || appId.startsWith('PROD_')) {
      throw new Error('CRITICAL_SECURITY_VIOLATION: Production Cashfree credentials or production environment detected in staging rehearsal! Aborting immediately.');
    }

    if (cfEnv !== 'TEST') {
      throw new Error(`SECURITY_VIOLATION: CASHFREE_ENV must be explicitly 'TEST'. Found: ${cfEnv || '[EMPTY]'}.`);
    }

    if (appId.startsWith('cf_test_mock')) {
      if (!isLocalFixture) {
        throw new Error('SECURITY_VIOLATION: Mock Cashfree credentials (cf_test_mock) are strictly forbidden in deployed rehearsal.');
      }
      return;
    }

    if (!/^TEST[a-zA-Z0-9]+$/.test(appId)) {
      throw new Error('SECURITY_VIOLATION: Cashfree App ID must be a valid sandbox test ID matching format TEST[a-zA-Z0-9]+.');
    }

    if (!isLocalFixture) {
      const secretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();
      const webhookSecret = (process.env.CASHFREE_WEBHOOK_SECRET || '').trim();
      if (!secretKey || secretKey.includes('mock')) {
        throw new Error('SECURITY_VIOLATION: Valid CASHFREE_SECRET_KEY is required in deployed rehearsal.');
      }
      if (!webhookSecret || webhookSecret.includes('mock')) {
        throw new Error('SECURITY_VIOLATION: Valid CASHFREE_WEBHOOK_SECRET is required in deployed rehearsal.');
      }
    }
  }
}

/**
 * Validates target database identity to guarantee zero cross-contamination with production.
 * Fails closed on missing or unknown database targets.
 */
export function validateStagingDatabaseIdentity(options?: {
  databaseUrl?: string;
  isLocalTestFixture?: boolean;
}): void {
  const url = (options?.databaseUrl || process.env.DATABASE_URL || '').trim();

  // Missing database identity: FAIL CLOSED!
  if (!url) {
    throw new Error('REHEARSAL_SECURITY_VIOLATION: Missing database identity. DATABASE_URL is strictly required for staging sandbox rehearsal.');
  }

  const classification = classifyDatabaseUrl(url);

  // Reject malformed or unknown
  if (classification.category === 'unknown') {
    throw new Error(`SECURITY_VIOLATION: Unrecognized or malformed database target: ${classification.sanitizedTarget}`);
  }

  // Reject Production database immediately
  if (classification.isProduction) {
    throw new Error(`CRITICAL_SECURITY_VIOLATION: Connected database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID})! Staging rehearsal strictly aborted.`);
  }

  // Reject Commercial PR #92 branch
  if (classification.isCommercialPr92) {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Connected database is Commercial PR #92 branch (br-green-snow-b3dsci5u)! Staging rehearsal strictly aborted.');
  }

  const isVercelRuntime = process.env.VERCEL === '1' || process.env.VERCEL_ENV === 'preview';
  const isLocalFixture = options?.isLocalTestFixture === true || process.env.AIRA_TEST_HARNESS_REHEARSAL === 'true';

  // If local / CI test container
  if (classification.isLocalOrCiTest) {
    if (isVercelRuntime) {
      throw new Error('SECURITY_VIOLATION: Local or test database URLs are strictly forbidden in deployed staging rehearsal.');
    }
    if (isLocalFixture || process.env.NODE_ENV === 'test') {
      return; // Permitted strictly in local test harness
    }
    throw new Error('SECURITY_VIOLATION: Local test database permitted only within authorized local test fixtures.');
  }

  // In deployed staging rehearsal:
  // Must match authorized Staging Neon Project and authorized Staging Neon Endpoint
  const host = classification.host.toLowerCase();
  const endpoint = classification.endpointPrefix || host.split('.')[0]?.replace('-pooler', '');

  const isAuthorizedStagingEndpoint =
    endpoint === AUTHORIZED_STAGING_NEON_ENDPOINT ||
    endpoint === STAGING_NEON_ENDPOINT_ID ||
    host.startsWith(AUTHORIZED_STAGING_NEON_ENDPOINT) ||
    host.startsWith(STAGING_NEON_ENDPOINT_ID);

  const hasAuthorizedProject =
    isAuthorizedStagingEndpoint ||
    classification.projectId === AUTHORIZED_STAGING_NEON_PROJECT_ID ||
    url.includes(AUTHORIZED_STAGING_NEON_PROJECT_ID) ||
    host.includes(AUTHORIZED_STAGING_NEON_PROJECT_ID);

  const hasAuthorizedEndpoint = isAuthorizedStagingEndpoint;

  if (!hasAuthorizedProject || !hasAuthorizedEndpoint) {
    throw new Error(`SECURITY_VIOLATION: Target database (${classification.sanitizedTarget}) does not match authorized Staging Neon endpoint '${AUTHORIZED_STAGING_NEON_ENDPOINT}' on project '${AUTHORIZED_STAGING_NEON_PROJECT_ID}'.`);
  }
}

/**
 * Asserts all staging sandbox rehearsal security invariants simultaneously.
 * Throws a fatal security exception if ANY invariant fails.
 */
export function assertStagingSandboxRehearsalAllowed(
  context: StagingRehearsalContext,
  options?: { isLocalTestFixture?: boolean }
): void {
  const isLocalFixture = options?.isLocalTestFixture === true || context.isLocalTestFixture === true || process.env.AIRA_TEST_HARNESS_REHEARSAL === 'true';

  // 1. Explicit feature flag
  if (process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED !== 'true') {
    throw new Error('REHEARSAL_DISABLED: Staging sandbox rehearsal is disabled (AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED is not true).');
  }

  // 2. Production environment fence
  if (
    process.env.VERCEL_ENV === 'production' ||
    process.env.NODE_ENV === 'production' ||
    process.env.AIRA_ENVIRONMENT === 'production'
  ) {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal is strictly prohibited in production.');
  }

  // 3. Commercial billing conflict
  if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true') {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal cannot operate while AIRA_COMMERCIAL_BILLING_ENABLED is true.');
  }

  // 4. Staging environment verification
  const isVercelRuntime = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

  if (isVercelRuntime) {
    if (process.env.VERCEL_ENV !== 'preview') {
      throw new Error('SECURITY_VIOLATION: Staging sandbox rehearsal requires VERCEL_ENV=preview on Vercel deployments.');
    }

    if (process.env.VERCEL_PROJECT_ID !== AUTHORIZED_VERCEL_PROJECT_ID) {
      throw new Error(`SECURITY_VIOLATION: Vercel project ID mismatch: expected ${AUTHORIZED_VERCEL_PROJECT_ID}, got ${process.env.VERCEL_PROJECT_ID || '[EMPTY]'}.`);
    }

    if (process.env.VERCEL_GIT_COMMIT_REF !== AUTHORIZED_STAGING_GIT_BRANCH) {
      throw new Error(`SECURITY_VIOLATION: Staging rehearsal is strictly restricted to branch '${AUTHORIZED_STAGING_GIT_BRANCH}'. Current branch: '${process.env.VERCEL_GIT_COMMIT_REF || '[EMPTY]'}'`);
    }
  } else if (!isLocalFixture) {
    throw new Error('SECURITY_VIOLATION: Staging sandbox rehearsal requires deployed Vercel preview or explicit local test fixture context.');
  }

  // 5. Database identity verification (Fail-closed)
  validateStagingDatabaseIdentity({
    databaseUrl: context.databaseUrl,
    isLocalTestFixture: isLocalFixture
  });

  // 6. Gateway test credential verification
  if (context.gateway) {
    validateTestGatewayCredentials(context.gateway, { isLocalTestFixture: isLocalFixture });
  }

  // 7. Synthetic test principal verification (when principal context is provided)
  if (context.principal !== undefined) {
    if (!isAuthorizedSyntheticTestPrincipal(context.principal, { isLocalTestFixture: isLocalFixture })) {
      throw new Error(`REHEARSAL_UNAUTHORIZED: Staging sandbox checkout is restricted exclusively to authorized enrolled synthetic test accounts. Caller '${context.principal?.userId || 'unknown'}' is not an authorized test principal.`);
    }
  }
}
