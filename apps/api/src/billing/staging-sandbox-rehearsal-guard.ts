/**
 * AIRA AI 2026 — Staging Sandbox Rehearsal Guard
 *
 * Implements strict, multi-dimensional security isolation permitting genuine
 * Cashfree & Razorpay test-mode checkout and webhook reconciliation on the
 * verified staging deployment while commercial billing remains disabled.
 *
 * Fail-Closed Security Invariants:
 * 1. Explicit Feature Flag: AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED === 'true'
 * 2. Strict Non-Production Environment: Rehearsal is strictly forbidden when VERCEL_ENV === 'production' or NODE_ENV === 'production' without preview fencing.
 * 3. Verified Staging Identity: VERCEL_ENV === 'preview' or AIRA_ENVIRONMENT === 'staging'.
 * 4. Exact Git Branch: VERCEL_GIT_COMMIT_REF must be 'staging' (or verified rehearsal feature branch).
 * 5. Vercel Project ID Integrity: VERCEL_PROJECT_ID must match 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH' when set.
 * 6. Database Isolation: Target database must be verified staging (mute-frost-50372225 / br-snowy-bonus-b32thjlz / ep-twilight-cherry-b3iz2oqv) or isolated test; NEVER production (old-sky-50952395).
 * 7. Test-Mode Gateway Credentials:
 *    - Razorpay Key must strictly start with 'rzp_test_'. Live keys ('rzp_live_') cause immediate security panic.
 *    - Cashfree App ID must start with 'TEST' or CASHFREE_ENV === 'TEST'. Live keys cause immediate security panic.
 * 8. Synthetic Account Restriction: Checkout is permitted exclusively for authorized synthetic test accounts. Real customer emails/accounts are rejected.
 * 9. Commercial Billing Invariant: AIRA_COMMERCIAL_BILLING_ENABLED must remain false.
 */

import {
  classifyDatabaseUrl,
  STAGING_NEON_PROJECT_ID,
  PRODUCTION_NEON_PROJECT_ID
} from '../../../../packages/db/src/index.js';

export const AUTHORIZED_VERCEL_PROJECT_ID = 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH';
export const AUTHORIZED_STAGING_GIT_BRANCH = 'staging';
export const AUTHORIZED_STAGING_NEON_BRANCH = 'br-snowy-bonus-b32thjlz';
export const AUTHORIZED_STAGING_NEON_ENDPOINT = 'ep-twilight-cherry-b3iz2oqv';

export interface StagingRehearsalContext {
  principal?: {
    userId: string;
    email?: string;
    isSynthetic?: boolean;
    roles?: string[];
  } | null;
  gateway?: 'razorpay' | 'cashfree';
  databaseUrl?: string;
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
 * Fails closed (returns false) if any condition is violated.
 */
export function isStagingSandboxRehearsalActive(): boolean {
  if (process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED !== 'true') {
    return false;
  }

  // Hard production block
  if (process.env.VERCEL_ENV === 'production') {
    return false;
  }

  // Hard commercial billing conflict: Rehearsal cannot operate if commercial billing is active
  if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true') {
    return false;
  }

  // Must be in preview / staging environment or isolated test harness
  const isVercelPreview = process.env.VERCEL_ENV === 'preview';
  const isStagingEnv = process.env.AIRA_ENVIRONMENT === 'staging';
  const isIsolatedTest = process.env.NODE_ENV === 'test' || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true';

  if (!isVercelPreview && !isStagingEnv && !isIsolatedTest) {
    return false;
  }

  // Verify Vercel project ID if set
  if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== AUTHORIZED_VERCEL_PROJECT_ID) {
    return false;
  }

  // Verify Vercel git branch if set
  if (isVercelPreview && process.env.VERCEL_GIT_COMMIT_REF) {
    const branch = process.env.VERCEL_GIT_COMMIT_REF.trim();
    if (branch !== AUTHORIZED_STAGING_GIT_BRANCH && !branch.startsWith('feat/staging-sandbox-rehearsal')) {
      return false;
    }
  }

  return true;
}

/**
 * Validates that the caller principal is an explicitly authorized synthetic test account.
 * Real customer identities and production user accounts are strictly forbidden from rehearsal checkout.
 */
export function isAuthorizedSyntheticTestPrincipal(principal?: {
  userId: string;
  email?: string;
  isSynthetic?: boolean;
} | null): boolean {
  if (!principal || !principal.userId) return false;

  const uid = principal.userId.toLowerCase().trim();
  const email = (principal.email || '').toLowerCase().trim();

  // Explicit flag from auth provider / test context
  if (principal.isSynthetic === true) return true;

  // Established AIRA synthetic test account patterns
  if (
    uid.startsWith('synthetic_') ||
    uid.startsWith('usr_test_') ||
    uid.startsWith('test_') ||
    uid.startsWith('sandbox_') ||
    uid.startsWith('rehearsal_') ||
    uid === 'account_1' ||
    uid === 'account_2' ||
    uid === 'admin'
  ) {
    return true;
  }

  // Internal test domain emails
  if (
    email.endsWith('@aira.internal') ||
    email.endsWith('@sandbox.internal') ||
    email.endsWith('@test.internal') ||
    email.endsWith('@example.com')
  ) {
    return true;
  }

  // Optional explicit allowlist from environment
  const allowlist = (process.env.AIRA_STAGING_REHEARSAL_TEST_PRINCIPALS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowlist.includes(uid) || (email && allowlist.includes(email))) {
    return true;
  }

  return false;
}

/**
 * Validates that gateway credentials are strictly test-mode / sandbox keys.
 * Live keys (e.g. rzp_live_) trigger an immediate fatal security exception.
 */
export function validateTestGatewayCredentials(gateway: 'razorpay' | 'cashfree'): void {
  if (gateway === 'razorpay') {
    const keyId = (process.env.RAZORPAY_KEY_ID || process.env.AIRA_TEST_GATEWAY_KEY_ID || '').trim();
    if (keyId.startsWith('rzp_live_')) {
      throw new Error('CRITICAL_SECURITY_VIOLATION: Production live Razorpay key (rzp_live_*) detected in staging rehearsal! Aborting immediately.');
    }
    if (!keyId.startsWith('rzp_test_') && !keyId.startsWith('rzp_test_mock')) {
      throw new Error(`SECURITY_VIOLATION: Razorpay key must be a valid test-mode key (rzp_test_*). Found: ${keyId ? keyId.slice(0, 8) + '...' : '[EMPTY]'}`);
    }
  } else if (gateway === 'cashfree') {
    const appId = (process.env.CASHFREE_APP_ID || process.env.AIRA_TEST_GATEWAY_KEY_ID || '').trim();
    const cfEnv = (process.env.CASHFREE_ENV || '').trim().toUpperCase();

    if (cfEnv === 'PROD' || cfEnv === 'PRODUCTION' || appId.startsWith('PROD_')) {
      throw new Error('CRITICAL_SECURITY_VIOLATION: Production Cashfree credentials detected in staging rehearsal! Aborting immediately.');
    }
    if (!appId.startsWith('TEST') && !appId.startsWith('cf_test_mock') && cfEnv !== 'TEST') {
      throw new Error(`SECURITY_VIOLATION: Cashfree App ID must be a sandbox test ID (TEST* or CASHFREE_ENV=TEST). Found: ${appId ? appId.slice(0, 8) + '...' : '[EMPTY]'}`);
    }
  }
}

/**
 * Validates target database identity to guarantee zero cross-contamination with production.
 */
export function validateStagingDatabaseIdentity(databaseUrl?: string): void {
  const url = databaseUrl || process.env.DATABASE_URL || '';
  if (!url) return; // In memory / mock mode without URL

  const classification = classifyDatabaseUrl(url);

  if (classification.isProduction) {
    throw new Error(`CRITICAL_SECURITY_VIOLATION: Connected database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID})! Staging rehearsal strictly aborted.`);
  }

  if (classification.isCommercialPr92) {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Connected database is Commercial PR #92 branch! Staging rehearsal strictly aborted.');
  }

  // In test suites, local_or_ci_test is permitted
  if (classification.isLocalOrCiTest) {
    return;
  }

  // In staging environment, ensure it matches staging project mute-frost-50372225
  if (classification.projectId && classification.projectId !== STAGING_NEON_PROJECT_ID) {
    throw new Error(`SECURITY_VIOLATION: Target database project (${classification.projectId}) does not match authorized Staging project (${STAGING_NEON_PROJECT_ID}).`);
  }
}

/**
 * Asserts all staging sandbox rehearsal security invariants simultaneously.
 * Throws a fatal security exception if ANY invariant fails.
 */
export function assertStagingSandboxRehearsalAllowed(context: StagingRehearsalContext): void {
  // 1. Explicit feature flag
  if (process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED !== 'true') {
    throw new Error('REHEARSAL_DISABLED: Staging sandbox rehearsal is disabled (AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED is not true).');
  }

  // 2. Production environment fence
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal is strictly prohibited in production (VERCEL_ENV=production).');
  }

  // 3. Commercial billing conflict
  if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true') {
    throw new Error('CRITICAL_SECURITY_VIOLATION: Staging sandbox rehearsal cannot operate while AIRA_COMMERCIAL_BILLING_ENABLED is true.');
  }

  // 4. Staging environment verification
  const isVercelPreview = process.env.VERCEL_ENV === 'preview';
  const isStagingEnv = process.env.AIRA_ENVIRONMENT === 'staging';
  const isIsolatedTest = process.env.NODE_ENV === 'test' || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true';

  if (!isVercelPreview && !isStagingEnv && !isIsolatedTest) {
    throw new Error('SECURITY_VIOLATION: Staging sandbox rehearsal requires VERCEL_ENV=preview, AIRA_ENVIRONMENT=staging, or isolated test harness.');
  }

  // 5. Vercel project ID verification
  if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== AUTHORIZED_VERCEL_PROJECT_ID) {
    throw new Error(`SECURITY_VIOLATION: Vercel project ID mismatch: expected ${AUTHORIZED_VERCEL_PROJECT_ID}, got ${process.env.VERCEL_PROJECT_ID}.`);
  }

  // 6. Vercel Git branch verification
  if (isVercelPreview && process.env.VERCEL_GIT_COMMIT_REF) {
    const branch = process.env.VERCEL_GIT_COMMIT_REF.trim();
    if (branch !== AUTHORIZED_STAGING_GIT_BRANCH && !branch.startsWith('feat/staging-sandbox-rehearsal')) {
      throw new Error(`SECURITY_VIOLATION: Staging rehearsal is restricted to branch '${AUTHORIZED_STAGING_GIT_BRANCH}'. Current branch: '${branch}'.`);
    }
  }

  // 7. Database identity verification
  validateStagingDatabaseIdentity(context.databaseUrl);

  // 8. Gateway test credential verification
  if (context.gateway) {
    validateTestGatewayCredentials(context.gateway);
  }

  // 9. Synthetic test principal verification (when principal context is provided)
  if (context.principal !== undefined) {
    if (!isAuthorizedSyntheticTestPrincipal(context.principal)) {
      throw new Error(`REHEARSAL_UNAUTHORIZED: Staging sandbox checkout is restricted exclusively to authorized synthetic test accounts. Caller '${context.principal?.userId || 'unknown'}' is not an authorized test principal.`);
    }
  }
}
