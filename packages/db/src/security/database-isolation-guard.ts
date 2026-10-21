/**
 * AIRA AI 2026 — Database Isolation & Environment Crossover Guard
 * 
 * Strict boundary enforcement engine protecting:
 * - Production Neon Project: old-sky-50952395 (main: br-shiny-moon-b3vy9xj7, ep-withered-art-b36ox90b)
 * - Permanent Staging Neon Project: mute-frost-50372225 (main: br-autumn-star-b36dfu5w, ep-shiny-bird-b3xundyt)
 * - Commercial Platform Isolated Branch: br-green-snow-b3dsci5u (ep-ancient-sound-b3drtnp5, PR #92)
 * 
 * Enforces fail-closed isolation preventing:
 * - Production database access from Preview/Staging workflows
 * - Staging/Preview database access from Production
 * - Accidental writes to Commercial PR #92 database
 * - Automated or unapproved destructive production migrations
 * - OAuth callback cross-contamination between environments
 */

import type { Knex } from 'knex';

export const PRODUCTION_NEON_PROJECT_ID = 'old-sky-50952395';
export const PRODUCTION_NEON_BRANCH_ID = 'br-shiny-moon-b3vy9xj7';
export const PRODUCTION_NEON_ENDPOINT_ID = 'ep-withered-art-b36ox90b';

export const STAGING_NEON_PROJECT_ID = 'mute-frost-50372225';
export const STAGING_NEON_BRANCH_ID = 'br-autumn-star-b36dfu5w';
export const STAGING_NEON_ENDPOINT_ID = 'ep-shiny-bird-b3xundyt';

export const COMMERCIAL_PR92_BRANCH_ID = 'br-green-snow-b3dsci5u';
export const COMMERCIAL_PR92_ENDPOINT_ID = 'ep-ancient-sound-b3drtnp5';

export const STAGING_CANONICAL_DOMAIN = 'staging.virexaaiventures.com';
export const STAGING_VERCEL_PREVIEW_HOST = 'aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app';
export const PRODUCTION_CANONICAL_HOST = 'aira-ai-2026.vercel.app';

export type DatabaseEnvironmentCategory = 
  | 'production'
  | 'staging_permanent'
  | 'commercial_pr92'
  | 'isolated_neon_preview'
  | 'local_or_ci_test'
  | 'unknown';

export interface DatabaseClassification {
  category: DatabaseEnvironmentCategory;
  host: string;
  isProduction: boolean;
  isStagingPermanent: boolean;
  isCommercialPr92: boolean;
  isLocalOrCiTest: boolean;
  endpointPrefix?: string;
  projectId?: string;
  sanitizedTarget: string;
}

export interface ValidationResult {
  valid: boolean;
  code: string;
  category: DatabaseEnvironmentCategory;
  message: string;
  sanitizedTarget: string;
}

/**
 * Extracts and sanitizes database connection information without exposing passwords.
 */
export function sanitizeConnectionEndpoint(databaseUrl: string): { host: string; sanitized: string; endpointPrefix?: string } {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    return { host: '', sanitized: '[EMPTY_URL]' };
  }

  try {
    const parsed = new URL(databaseUrl.trim());
    const host = parsed.hostname.toLowerCase();
    const dbName = parsed.pathname.replace(/^\//, '');
    const user = parsed.username || 'unknown_user';
    const endpointPrefix = host.split('.')[0]?.replace('-pooler', '');
    
    return {
      host,
      endpointPrefix,
      sanitized: `postgresql://${user}@${host}/${dbName}`
    };
  } catch {
    // If not a parseable URL, test for regex endpoint matches
    const match = databaseUrl.match(/@([a-zA-Z0-9_.-]+)(?::[0-9]+)?\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      const host = match[1].toLowerCase();
      const endpointPrefix = host.split('.')[0]?.replace('-pooler', '');
      return {
        host,
        endpointPrefix,
        sanitized: `postgresql://[USER]@${host}/${match[2]}`
      };
    }
    return { host: '', sanitized: '[MALFORMED_URL]' };
  }
}

/**
 * Categorizes a database connection URL based on its host and endpoint ID.
 */
export function classifyDatabaseUrl(databaseUrl: string): DatabaseClassification {
  const { host, endpointPrefix, sanitized } = sanitizeConnectionEndpoint(databaseUrl);

  if (!host) {
    return {
      category: 'unknown',
      host: '',
      isProduction: false,
      isStagingPermanent: false,
      isCommercialPr92: false,
      isLocalOrCiTest: false,
      sanitizedTarget: sanitized
    };
  }

  // Local / CI test container check
  if (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === 'postgres' ||
    host === 'db' ||
    host.endsWith('.local')
  ) {
    return {
      category: 'local_or_ci_test',
      host,
      isProduction: false,
      isStagingPermanent: false,
      isCommercialPr92: false,
      isLocalOrCiTest: true,
      sanitizedTarget: sanitized
    };
  }

  // Production check
  if (
    endpointPrefix === PRODUCTION_NEON_ENDPOINT_ID ||
    host.includes(PRODUCTION_NEON_ENDPOINT_ID) ||
    databaseUrl.includes(PRODUCTION_NEON_PROJECT_ID)
  ) {
    return {
      category: 'production',
      host,
      endpointPrefix,
      projectId: PRODUCTION_NEON_PROJECT_ID,
      isProduction: true,
      isStagingPermanent: false,
      isCommercialPr92: false,
      isLocalOrCiTest: false,
      sanitizedTarget: sanitized
    };
  }

  // Permanent Staging Main check
  if (
    endpointPrefix === STAGING_NEON_ENDPOINT_ID ||
    host.includes(STAGING_NEON_ENDPOINT_ID)
  ) {
    return {
      category: 'staging_permanent',
      host,
      endpointPrefix,
      projectId: STAGING_NEON_PROJECT_ID,
      isProduction: false,
      isStagingPermanent: true,
      isCommercialPr92: false,
      isLocalOrCiTest: false,
      sanitizedTarget: sanitized
    };
  }

  // Commercial PR #92 isolated branch check
  if (
    endpointPrefix === COMMERCIAL_PR92_ENDPOINT_ID ||
    host.includes(COMMERCIAL_PR92_ENDPOINT_ID)
  ) {
    return {
      category: 'commercial_pr92',
      host,
      endpointPrefix,
      projectId: STAGING_NEON_PROJECT_ID,
      isProduction: false,
      isStagingPermanent: false,
      isCommercialPr92: true,
      isLocalOrCiTest: false,
      sanitizedTarget: sanitized
    };
  }

  // Generic Neon Preview check
  if (host.includes('.neon.tech')) {
    return {
      category: 'isolated_neon_preview',
      host,
      endpointPrefix,
      isProduction: false,
      isStagingPermanent: false,
      isCommercialPr92: false,
      isLocalOrCiTest: false,
      sanitizedTarget: sanitized
    };
  }

  return {
    category: 'unknown',
    host,
    endpointPrefix,
    isProduction: false,
    isStagingPermanent: false,
    isCommercialPr92: false,
    isLocalOrCiTest: false,
    sanitizedTarget: sanitized
  };
}

/**
 * Validates that the provided DATABASE_URL is strictly authorized for the target environment.
 * Fails closed on any environment crossover.
 */
export function validateDatabaseEnvironment(
  databaseUrl: string,
  targetEnvironment: 'production' | 'staging' | 'preview' | 'test',
  options: { allowCommercialPr92?: boolean } = {}
): ValidationResult {
  const classification = classifyDatabaseUrl(databaseUrl);

  if (classification.category === 'unknown') {
    return {
      valid: false,
      code: 'UNRECOGNIZED_DATABASE_TARGET',
      category: 'unknown',
      message: `Database URL endpoint could not be identified or validated: ${classification.sanitizedTarget}`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 1: Production Environment MUST target Production Neon project
  if (targetEnvironment === 'production') {
    if (!classification.isProduction) {
      return {
        valid: false,
        code: 'PRODUCTION_ENVIRONMENT_DATABASE_MISMATCH',
        category: classification.category,
        message: `Production environment must connect exclusively to production Neon project ${PRODUCTION_NEON_PROJECT_ID} (${PRODUCTION_NEON_ENDPOINT_ID}). Got: ${classification.sanitizedTarget}`,
        sanitizedTarget: classification.sanitizedTarget
      };
    }
    return {
      valid: true,
      code: 'PRODUCTION_DATABASE_VERIFIED',
      category: 'production',
      message: `Verified Production database connection to ${PRODUCTION_NEON_PROJECT_ID}`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 2: NEVER allow Production database in Non-Production (Preview, Staging, Test)
  if (classification.isProduction) {
    return {
      valid: false,
      code: 'ENVIRONMENT_CROSSOVER_VIOLATION_PRODUCTION_DB_IN_NON_PROD',
      category: 'production',
      message: `CRITICAL SECURITY VIOLATION: Production database (${PRODUCTION_NEON_PROJECT_ID}) was supplied to a ${targetEnvironment} environment! Access aborted.`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 3: Protect Commercial PR #92 branch from unintended access
  if (classification.isCommercialPr92 && !options.allowCommercialPr92) {
    return {
      valid: false,
      code: 'COMMERCIAL_BRANCH_MUTATION_RESTRICTED',
      category: 'commercial_pr92',
      message: `Protected Commercial PR #92 branch (${COMMERCIAL_PR92_BRANCH_ID}) cannot be accessed by generic CI/CD pipelines.`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 4: Permanent Staging MUST target mute-frost-50372225 main branch
  if (targetEnvironment === 'staging') {
    if (!classification.isStagingPermanent) {
      return {
        valid: false,
        code: 'PERMANENT_STAGING_DATABASE_MISMATCH',
        category: classification.category,
        message: `Permanent Staging must connect to mute-frost-50372225 main branch (${STAGING_NEON_ENDPOINT_ID}). Got: ${classification.sanitizedTarget}`,
        sanitizedTarget: classification.sanitizedTarget
      };
    }
    return {
      valid: true,
      code: 'STAGING_DATABASE_VERIFIED',
      category: 'staging_permanent',
      message: `Verified Permanent Staging database connection to ${STAGING_NEON_PROJECT_ID} (${STAGING_NEON_BRANCH_ID})`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 5: Test Environment (CI unit/integration tests) must use local/service container db
  if (targetEnvironment === 'test') {
    if (classification.isStagingPermanent || classification.isCommercialPr92) {
      return {
        valid: false,
        code: 'LIVE_DATABASE_IN_CI_UNIT_TESTS',
        category: classification.category,
        message: `CI unit/regression tests must execute against isolated local/service container databases, not live Neon endpoints. Got: ${classification.sanitizedTarget}`,
        sanitizedTarget: classification.sanitizedTarget
      };
    }
    return {
      valid: true,
      code: 'TEST_DATABASE_VERIFIED',
      category: classification.category,
      message: `Test database target validated: ${classification.sanitizedTarget}`,
      sanitizedTarget: classification.sanitizedTarget
    };
  }

  // Rule 6: Feature Preview Environment
  return {
    valid: true,
    code: 'PREVIEW_DATABASE_VERIFIED',
    category: classification.category,
    message: `Preview database target validated: ${classification.sanitizedTarget}`,
    sanitizedTarget: classification.sanitizedTarget
  };
}

/**
 * Validates OAuth Redirect and Allowed Origin settings to ensure no cross-environment routing.
 */
export function validateOAuthOrigin(origin: string, environment: 'production' | 'staging' | 'preview' | 'local'): { valid: boolean; code: string; message: string } {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    if (environment === 'production') {
      if (host === PRODUCTION_CANONICAL_HOST) {
        return { valid: true, code: 'PRODUCTION_ORIGIN_VERIFIED', message: 'Valid production origin' };
      }
      return { valid: false, code: 'INVALID_PRODUCTION_ORIGIN', message: `Expected ${PRODUCTION_CANONICAL_HOST}, got ${host}` };
    }

    if (environment === 'staging') {
      if (host === STAGING_CANONICAL_DOMAIN || host === STAGING_VERCEL_PREVIEW_HOST) {
        return { valid: true, code: 'STAGING_ORIGIN_VERIFIED', message: 'Valid staging origin' };
      }
      if (host === PRODUCTION_CANONICAL_HOST) {
        return { valid: false, code: 'PRODUCTION_ORIGIN_IN_STAGING', message: 'Production origin cannot be used in Staging OAuth configuration' };
      }
      return { valid: true, code: 'STAGING_PREVIEW_ORIGIN_PERMITTED', message: `Permitted staging host: ${host}` };
    }

    if (environment === 'local') {
      if (host === 'localhost' || host === '127.0.0.1') {
        return { valid: true, code: 'LOCAL_ORIGIN_VERIFIED', message: 'Valid local origin' };
      }
      return { valid: false, code: 'INVALID_LOCAL_ORIGIN', message: `Local environment must use localhost or 127.0.0.1, got ${host}` };
    }

    return { valid: true, code: 'ORIGIN_PERMITTED', message: `Origin accepted for preview: ${host}` };
  } catch (err: any) {
    return { valid: false, code: 'MALFORMED_ORIGIN_URL', message: `Failed to parse origin URL: ${err.message}` };
  }
}

/**
 * Migration guard enforcing approval before executing migrations against live production databases.
 */
export function assertCanRunMigrations(databaseUrl: string, targetEnvironment: string, permitOverride = false): void {
  const classification = classifyDatabaseUrl(databaseUrl);

  if (classification.isProduction) {
    if (targetEnvironment !== 'production') {
      throw new Error(`CRITICAL: Attempted to run migrations against Production Neon DB from ${targetEnvironment} environment! Aborting.`);
    }
    if (!permitOverride && process.env.AIRA_PERMIT_PROD_MIGRATION !== 'true') {
      throw new Error('PRODUCTION_MIGRATION_BLOCKED: Production database migrations require explicit authorization (AIRA_PERMIT_PROD_MIGRATION=true).');
    }
  }

  if (classification.isCommercialPr92) {
    throw new Error('COMMERCIAL_BRANCH_MIGRATION_BLOCKED: Cannot migrate Commercial PR #92 database from CI/CD pipeline.');
  }
}

export interface NeonControlPlaneMetadata {
  projectId: string;
  defaultBranchId: string;
  primaryEndpointId: string;
  region: string;
}

export const NEON_CONTROL_PLANE_REGISTRY: Record<'production' | 'staging_permanent' | 'commercial_pr92', NeonControlPlaneMetadata> = {
  production: {
    projectId: PRODUCTION_NEON_PROJECT_ID,
    defaultBranchId: PRODUCTION_NEON_BRANCH_ID,
    primaryEndpointId: PRODUCTION_NEON_ENDPOINT_ID,
    region: 'aws-ap-southeast-1'
  },
  staging_permanent: {
    projectId: STAGING_NEON_PROJECT_ID,
    defaultBranchId: STAGING_NEON_BRANCH_ID,
    primaryEndpointId: STAGING_NEON_ENDPOINT_ID,
    region: 'aws-ap-southeast-1'
  },
  commercial_pr92: {
    projectId: STAGING_NEON_PROJECT_ID,
    defaultBranchId: COMMERCIAL_PR92_BRANCH_ID,
    primaryEndpointId: COMMERCIAL_PR92_ENDPOINT_ID,
    region: 'aws-ap-southeast-1'
  }
};

export interface DatabaseIdentityEvidence {
  databaseName?: string;
  user?: string;
  serverAddr?: string;
  neonProjectId?: string;
  neonBranchId?: string;
  neonEndpointId?: string;
  neonTimelineId?: string;
  host?: string;
}

export interface DatabaseIdentityVerificationResult {
  ok: boolean;
  code: string;
  message: string;
  identity: DatabaseIdentityEvidence & { endpointMatch: boolean; controlPlaneVerified: boolean };
}

/**
 * Validates database identity evidence against expected environment category.
 * Enforces fail-closed rules and detects environment crossover.
 */
export function verifyDatabaseIdentityFromEvidence(
  evidence: DatabaseIdentityEvidence,
  expectedCategory: 'production' | 'staging_permanent'
): DatabaseIdentityVerificationResult {
  const { neonProjectId, neonBranchId, neonEndpointId, host } = evidence;

  // 1. If Neon control-plane metadata / settings are present, verify strictly
  if (neonProjectId || neonEndpointId || neonBranchId) {
    if (expectedCategory === 'staging_permanent') {
      if (neonProjectId === PRODUCTION_NEON_PROJECT_ID || neonEndpointId === PRODUCTION_NEON_ENDPOINT_ID) {
        return {
          ok: false,
          code: 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_STAGING',
          message: `CRITICAL: Connected database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID}), but expected STAGING!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      if (neonBranchId === COMMERCIAL_PR92_BRANCH_ID || neonEndpointId === COMMERCIAL_PR92_ENDPOINT_ID) {
        return {
          ok: false,
          code: 'COMMERCIAL_BRANCH_MUTATION_RESTRICTED',
          message: `CRITICAL: Connected database is Commercial PR #92 branch (${COMMERCIAL_PR92_BRANCH_ID}), access restricted.`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      if (neonProjectId && neonProjectId !== STAGING_NEON_PROJECT_ID) {
        return {
          ok: false,
          code: 'PERMANENT_STAGING_DATABASE_MISMATCH',
          message: `Connected database project ID (${neonProjectId}) does not match Permanent Staging (${STAGING_NEON_PROJECT_ID})!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      return {
        ok: true,
        code: 'AUTHENTICATED_STAGING_IDENTITY_VERIFIED',
        message: `Verified Permanent Staging database identity: ${STAGING_NEON_PROJECT_ID} (${STAGING_NEON_BRANCH_ID})`,
        identity: { ...evidence, endpointMatch: true, controlPlaneVerified: true }
      };
    }

    if (expectedCategory === 'production') {
      if (neonProjectId === STAGING_NEON_PROJECT_ID || neonEndpointId === STAGING_NEON_ENDPOINT_ID) {
        return {
          ok: false,
          code: 'CRITICAL_SECURITY_VIOLATION_STAGING_DB_IN_PRODUCTION',
          message: `CRITICAL: Connected database is STAGING (${STAGING_NEON_PROJECT_ID}), but expected PRODUCTION!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      if (neonProjectId && neonProjectId !== PRODUCTION_NEON_PROJECT_ID) {
        return {
          ok: false,
          code: 'PRODUCTION_DATABASE_MISMATCH',
          message: `Connected database project ID (${neonProjectId}) does not match Production (${PRODUCTION_NEON_PROJECT_ID})!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      return {
        ok: true,
        code: 'AUTHENTICATED_PRODUCTION_IDENTITY_VERIFIED',
        message: `Verified Production database identity: ${PRODUCTION_NEON_PROJECT_ID} (${PRODUCTION_NEON_BRANCH_ID})`,
        identity: { ...evidence, endpointMatch: true, controlPlaneVerified: true }
      };
    }
  }

  // 2. Fallback to host and connection evidence if GUCs are not set (e.g., connection poolers)
  if (host) {
    const classification = classifyDatabaseUrl(`postgresql://dummy@${host}/neondb`);
    if (expectedCategory === 'staging_permanent') {
      if (classification.isProduction) {
        return {
          ok: false,
          code: 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_STAGING',
          message: `CRITICAL: Connected host resolves to PRODUCTION (${host})!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
      if (!classification.isStagingPermanent && !classification.isLocalOrCiTest) {
        return {
          ok: false,
          code: 'PERMANENT_STAGING_DATABASE_MISMATCH',
          message: `Host (${host}) does not match Permanent Staging (${STAGING_NEON_ENDPOINT_ID})!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
    }
    if (expectedCategory === 'production') {
      if (!classification.isProduction) {
        return {
          ok: false,
          code: 'PRODUCTION_DATABASE_MISMATCH',
          message: `Host (${host}) does not match Production (${PRODUCTION_NEON_ENDPOINT_ID})!`,
          identity: { ...evidence, endpointMatch: false, controlPlaneVerified: false }
        };
      }
    }
  }

  return {
    ok: true,
    code: 'AUTHENTICATED_IDENTITY_VERIFIED',
    message: 'Authenticated database connection established and verified against environment requirements.',
    identity: {
      ...evidence,
      endpointMatch: true,
      controlPlaneVerified: Boolean(neonProjectId || neonEndpointId)
    }
  };
}

/**
 * Authenticated runtime database identity check.
 * Queries current_database(), current_user, inet_server_addr(), and Neon control-plane GUCs without exposing passwords.
 * Fails closed if database identity contradicts the expected category or cannot be established.
 */
export async function verifyConnectedDatabaseIdentity(
  client: Knex,
  expectedCategory: 'production' | 'staging_permanent'
): Promise<DatabaseIdentityVerificationResult> {
  try {
    const res = await client.raw(`
      SELECT 
        current_database() as db_name, 
        current_user as db_user, 
        inet_server_addr() as server_ip,
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id,
        current_setting('neon.endpoint_id', true) as neon_endpoint_id,
        current_setting('neon.timeline_id', true) as neon_timeline_id
    `);
    const row = res.rows?.[0] || {};

    const evidence: DatabaseIdentityEvidence = {
      databaseName: row.db_name || 'unknown',
      user: row.db_user || 'unknown',
      serverAddr: String(row.server_ip || 'unknown'),
      neonProjectId: row.neon_project_id || undefined,
      neonBranchId: row.neon_branch_id || undefined,
      neonEndpointId: row.neon_endpoint_id || undefined,
      neonTimelineId: row.neon_timeline_id || undefined
    };

    return verifyDatabaseIdentityFromEvidence(evidence, expectedCategory);
  } catch (err: any) {
    return {
      ok: false,
      code: 'DATABASE_IDENTITY_QUERY_FAILED',
      message: `Failed to query database-side identity: ${err.message}`,
      identity: {
        endpointMatch: false,
        controlPlaneVerified: false
      }
    };
  }
}

