/**
 * AIRA AI 2026 — Milestone 2A: Specialist Worker Production Activation Policy
 * 
 * Enforces explicit, fail-closed production activation boundaries:
 * 1. Default-deny: Production worker execution is refused unless explicitly enabled.
 * 2. Explicit boolean activation: Requires AIRA_PRODUCTION_WORKER_ENABLED strictly equal to "true".
 * 3. Exact Neon project identity assertion: Must match EXPECTED_NEON_PROJECT_ID (old-sky-50952395).
 * 4. Exact Neon endpoint identity assertion: Must match EXPECTED_NEON_ENDPOINT_ID (ep-withered-art-b36ox90b).
 * 5. Runtime identity verification: Live database query to current_setting('neon.project_id')
 *    and current_setting('neon.endpoint_id') must match the asserted production identity.
 * 6. Non-production crossover protection: Staging/preview workers cannot be configured with production flags,
 *    and cannot connect to production databases.
 * 7. Zero payload spoofing: Activation policy only reads environment/orchestrator context,
 *    strictly ignoring user-supplied mission or task payloads.
 * 8. Sanitized reporting: Never logs database passwords, tokens, or raw connection strings.
 */

import type { Knex } from 'knex';

export const CANONICAL_PRODUCTION_NEON_PROJECT_ID = 'old-sky-50952395';
export const CANONICAL_PRODUCTION_NEON_ENDPOINT_ID = 'ep-withered-art-b36ox90b';

export const CANONICAL_STAGING_NEON_PROJECT_ID = 'mute-frost-50372225';
export const CANONICAL_STAGING_NEON_ENDPOINT_ID = 'ep-shiny-bird-b3xundyt';

export interface WorkerActivationConfig {
  airaEnv?: string;
  productionWorkerEnabled?: string | boolean;
  expectedNeonProjectId?: string;
  expectedNeonEndpointId?: string;
}

export interface ConnectedDatabaseIdentity {
  databaseName?: string;
  user?: string;
  serverAddr?: string;
  neonProjectId?: string;
  neonEndpointId?: string;
  neonBranchId?: string;
  host?: string;
}

export interface WorkerActivationResult {
  authorized: boolean;
  code: string;
  message: string;
  isProduction: boolean;
  sanitizedConfig: {
    airaEnv: string;
    productionWorkerEnabled: boolean;
    expectedNeonProjectId?: string;
    expectedNeonEndpointId?: string;
  };
}

export class ActivationSecurityError extends Error {
  public readonly code: string;
  public readonly sanitizedTarget?: string;

  constructor(code: string, message: string, sanitizedTarget?: string) {
    super(`[ACTIVATION_SECURITY_REJECTED:${code}] ${message}`);
    this.name = 'ActivationSecurityError';
    this.code = code;
    this.sanitizedTarget = sanitizedTarget;
  }
}

/**
 * Evaluates the static and runtime activation policy for specialist workers.
 * Fully deterministic; suitable for unit tests and container startup preflight.
 */
export function evaluateWorkerActivationPolicy(
  config: WorkerActivationConfig,
  connectedIdentity?: ConnectedDatabaseIdentity
): WorkerActivationResult {
  const airaEnv = (config.airaEnv || 'staging').trim().toLowerCase();
  const isProduction = airaEnv === 'production';

  // Strict boolean validation: must be exact boolean true or exact string "true"
  let isExplicitlyEnabled = false;
  if (config.productionWorkerEnabled === true) {
    isExplicitlyEnabled = true;
  } else if (typeof config.productionWorkerEnabled === 'string') {
    if (config.productionWorkerEnabled === 'true') {
      isExplicitlyEnabled = true;
    } else if (
      config.productionWorkerEnabled.trim().toLowerCase() === 'true' ||
      config.productionWorkerEnabled.includes('true')
    ) {
      // e.g. "TRUE", "True", "true ", " true" - reject unsupported representation
      return {
        authorized: false,
        code: 'UNSUPPORTED_BOOLEAN_REPRESENTATION',
        message: `AIRA_PRODUCTION_WORKER_ENABLED must be strictly lowercase 'true' without whitespace. Got: '${config.productionWorkerEnabled}'`,
        isProduction,
        sanitizedConfig: {
          airaEnv,
          productionWorkerEnabled: false,
          expectedNeonProjectId: config.expectedNeonProjectId,
          expectedNeonEndpointId: config.expectedNeonEndpointId
        }
      };
    }
  }

  const sanitizedConfig = {
    airaEnv,
    productionWorkerEnabled: isExplicitlyEnabled,
    expectedNeonProjectId: config.expectedNeonProjectId ? String(config.expectedNeonProjectId).trim() : undefined,
    expectedNeonEndpointId: config.expectedNeonEndpointId ? String(config.expectedNeonEndpointId).trim() : undefined
  };

  // =========================================================================
  // CASE 1: PRODUCTION ENVIRONMENT (AIRA_ENV=production)
  // =========================================================================
  if (isProduction) {
    // Check 1: Explicit production activation flag
    if (!isExplicitlyEnabled) {
      const code = config.productionWorkerEnabled === undefined || config.productionWorkerEnabled === ''
        ? 'MISSING_ACTIVATION_FLAG'
        : 'ACTIVATION_DISABLED';
      return {
        authorized: false,
        code,
        message: 'Production execution denied: AIRA_PRODUCTION_WORKER_ENABLED must be explicitly set to true.',
        isProduction: true,
        sanitizedConfig
      };
    }

    // Check 2: Mandatory Expected Neon Project ID
    if (!sanitizedConfig.expectedNeonProjectId) {
      return {
        authorized: false,
        code: 'MISSING_EXPECTED_PROJECT_ID',
        message: 'Production execution denied: EXPECTED_NEON_PROJECT_ID must be configured.',
        isProduction: true,
        sanitizedConfig
      };
    }
    if (sanitizedConfig.expectedNeonProjectId !== CANONICAL_PRODUCTION_NEON_PROJECT_ID) {
      return {
        authorized: false,
        code: 'INCORRECT_EXPECTED_PROJECT_ID',
        message: `Production execution denied: EXPECTED_NEON_PROJECT_ID '${sanitizedConfig.expectedNeonProjectId}' does not match canonical production Neon project (${CANONICAL_PRODUCTION_NEON_PROJECT_ID}).`,
        isProduction: true,
        sanitizedConfig
      };
    }

    // Check 3: Mandatory Expected Neon Endpoint ID
    if (!sanitizedConfig.expectedNeonEndpointId) {
      return {
        authorized: false,
        code: 'MISSING_EXPECTED_ENDPOINT_ID',
        message: 'Production execution denied: EXPECTED_NEON_ENDPOINT_ID must be configured.',
        isProduction: true,
        sanitizedConfig
      };
    }
    if (sanitizedConfig.expectedNeonEndpointId !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
      return {
        authorized: false,
        code: 'INCORRECT_EXPECTED_ENDPOINT_ID',
        message: `Production execution denied: EXPECTED_NEON_ENDPOINT_ID '${sanitizedConfig.expectedNeonEndpointId}' does not match canonical production Neon endpoint (${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}).`,
        isProduction: true,
        sanitizedConfig
      };
    }

    // Check 4: Connected Database Identity Validation (if provided)
    if (connectedIdentity) {
      const liveProject = (connectedIdentity.neonProjectId || '').trim();
      const liveEndpoint = (connectedIdentity.neonEndpointId || '').trim();

      // Check if connected identity is completely missing GUCs
      if (!liveProject && !liveEndpoint && !connectedIdentity.host) {
        return {
          authorized: false,
          code: 'UNVERIFIED_DATABASE_IDENTITY',
          message: 'Production execution denied: Database identity could not be established from server telemetry.',
          isProduction: true,
          sanitizedConfig
        };
      }

      // Check for Staging database in Production worker (Critical crossover)
      if (
        liveProject === CANONICAL_STAGING_NEON_PROJECT_ID ||
        liveEndpoint === CANONICAL_STAGING_NEON_ENDPOINT_ID
      ) {
        return {
          authorized: false,
          code: 'CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD',
          message: `CRITICAL SECURITY VIOLATION: Production worker connected to STAGING Neon database (${CANONICAL_STAGING_NEON_PROJECT_ID})!`,
          isProduction: true,
          sanitizedConfig
        };
      }

      // Project match
      if (liveProject && liveProject !== CANONICAL_PRODUCTION_NEON_PROJECT_ID) {
        return {
          authorized: false,
          code: 'DATABASE_PROJECT_MISMATCH',
          message: `Connected Neon project ID '${liveProject}' does not match canonical production project (${CANONICAL_PRODUCTION_NEON_PROJECT_ID}).`,
          isProduction: true,
          sanitizedConfig
        };
      }

      // Endpoint match
      if (liveEndpoint && liveEndpoint !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
        return {
          authorized: false,
          code: 'DATABASE_ENDPOINT_MISMATCH',
          message: `Connected Neon endpoint ID '${liveEndpoint}' does not match canonical production endpoint (${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}).`,
          isProduction: true,
          sanitizedConfig
        };
      }
    }

    return {
      authorized: true,
      code: 'PRODUCTION_ACTIVATION_AUTHORIZED',
      message: 'Production specialist worker activation successfully authorized under verified policy.',
      isProduction: true,
      sanitizedConfig
    };
  }

  // =========================================================================
  // CASE 2: NON-PRODUCTION ENVIRONMENT (Staging, Preview, Local, Test)
  // =========================================================================

  // Check 5: Staging environment with production-targeted activation configuration (Inconsistency check / TEST A13)
  if (
    isExplicitlyEnabled ||
    sanitizedConfig.expectedNeonProjectId === CANONICAL_PRODUCTION_NEON_PROJECT_ID ||
    sanitizedConfig.expectedNeonEndpointId === CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
  ) {
    return {
      authorized: false,
      code: 'INCONSISTENT_NON_PROD_ACTIVATION_CONFIG',
      message: `Non-production environment ('${airaEnv}') cannot be configured with production activation settings (AIRA_PRODUCTION_WORKER_ENABLED or production expected IDs).`,
      isProduction: false,
      sanitizedConfig
    };
  }

  // Check 6: Non-production worker connected to production database (Crossover check)
  if (connectedIdentity) {
    const liveProject = (connectedIdentity.neonProjectId || '').trim();
    const liveEndpoint = (connectedIdentity.neonEndpointId || '').trim();
    const host = (connectedIdentity.host || '').toLowerCase();

    if (
      liveProject === CANONICAL_PRODUCTION_NEON_PROJECT_ID ||
      liveEndpoint === CANONICAL_PRODUCTION_NEON_ENDPOINT_ID ||
      host.includes(CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) ||
      host.includes(CANONICAL_PRODUCTION_NEON_PROJECT_ID)
    ) {
      return {
        authorized: false,
        code: 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_NON_PROD',
        message: `CRITICAL SECURITY VIOLATION: Non-production worker ('${airaEnv}') connected to PRODUCTION Neon database (${CANONICAL_PRODUCTION_NEON_PROJECT_ID})!`,
        isProduction: false,
        sanitizedConfig
      };
    }
  }

  return {
    authorized: true,
    code: 'NON_PROD_WORKER_AUTHORIZED',
    message: `Specialist worker authorized for non-production environment: '${airaEnv}'.`,
    isProduction: false,
    sanitizedConfig
  };
}

/**
 * Authoritative runtime validation asserting that the live database connection
 * matches the worker activation policy.
 * Queries live Neon GUCs without exposing sensitive connection strings.
 */
export async function assertWorkerActivationAuthorized(
  config: WorkerActivationConfig,
  client: Knex
): Promise<WorkerActivationResult> {
  let connectedIdentity: ConnectedDatabaseIdentity;

  try {
    const res = await client.raw(`
      SELECT 
        current_database() as db_name, 
        current_user as db_user, 
        inet_server_addr() as server_ip,
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id,
        current_setting('neon.endpoint_id', true) as neon_endpoint_id
    `);
    const row = res.rows?.[0] || {};
    connectedIdentity = {
      databaseName: row.db_name,
      user: row.db_user,
      serverAddr: String(row.server_ip || 'unknown'),
      neonProjectId: row.neon_project_id ? String(row.neon_project_id).trim() : undefined,
      neonBranchId: row.neon_branch_id ? String(row.neon_branch_id).trim() : undefined,
      neonEndpointId: row.neon_endpoint_id ? String(row.neon_endpoint_id).trim() : undefined
    };
  } catch (err: any) {
    throw new ActivationSecurityError(
      'DATABASE_UNAVAILABLE',
      `Live database query failed during worker activation validation: ${err.message}`
    );
  }

  const result = evaluateWorkerActivationPolicy(config, connectedIdentity);
  if (!result.authorized) {
    throw new ActivationSecurityError(result.code, result.message);
  }

  return result;
}
