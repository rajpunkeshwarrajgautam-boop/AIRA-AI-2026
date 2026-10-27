/**
 * AIRA AI 2026 — Milestone 2A: Specialist Worker Production Activation Policy
 * 
 * Enforces explicit, fail-closed production activation boundaries:
 * 1. Default-deny: Production worker execution is refused unless explicitly enabled.
 * 2. Explicit boolean activation: Requires AIRA_PRODUCTION_WORKER_ENABLED strictly equal to "true".
 * 3. Exact Neon project identity assertion: Must match EXPECTED_NEON_PROJECT_ID (old-sky-50952395).
 * 4. Exact Neon endpoint identity assertion: Must match EXPECTED_NEON_ENDPOINT_ID (ep-withered-art-b36ox90b).
 * 5. Structural separation between static configuration validation (CONFIGURATION_VALID)
 *    and authoritative runtime activation authorization (ACTIVATION_AUTHORIZED).
 * 6. Non-production crossover protection: Staging/preview workers cannot be configured with production flags,
 *    and cannot connect to production databases.
 * 7. Zero payload spoofing: Activation policy only reads environment/orchestrator context,
 *    strictly ignoring user-supplied mission or task payloads.
 * 8. Fixed non-sensitive error reporting: Never leaks connection strings, passwords, or raw driver strings.
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

export interface WorkerStaticConfigResult {
  valid: boolean;
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

export interface WorkerActivationResult {
  authorized: boolean;
  runtimeAuthorized: boolean;
  stage: 'STATIC_VALIDATION' | 'RUNTIME_AUTHORIZATION';
  code:
    | 'CONFIGURATION_VALID'
    | 'ACTIVATION_AUTHORIZED'
    | 'PRODUCTION_ACTIVATION_AUTHORIZED'
    | 'NON_PROD_WORKER_AUTHORIZED'
    | string;
  message: string;
  isProduction: boolean;
  sanitizedConfig: {
    airaEnv: string;
    productionWorkerEnabled: boolean;
    expectedNeonProjectId?: string;
    expectedNeonEndpointId?: string;
  };
  connectedIdentity?: ConnectedDatabaseIdentity;
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
 * Validates deterministic static environment configuration for specialist workers.
 * Verifies boolean representations, presence of required expected identifiers,
 * and environment consistency. Never authorizes task claiming on its own.
 */
export function validateWorkerStaticConfig(
  config: WorkerActivationConfig
): WorkerStaticConfigResult {
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
      return {
        valid: false,
        code: 'UNSUPPORTED_BOOLEAN_REPRESENTATION',
        message: "AIRA_PRODUCTION_WORKER_ENABLED must be strictly lowercase 'true' without whitespace.",
        isProduction,
        sanitizedConfig: {
          airaEnv,
          productionWorkerEnabled: false,
          expectedNeonProjectId: config.expectedNeonProjectId ? String(config.expectedNeonProjectId).trim() : undefined,
          expectedNeonEndpointId: config.expectedNeonEndpointId ? String(config.expectedNeonEndpointId).trim() : undefined
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

  // Case 1: Production Environment
  if (isProduction) {
    if (!isExplicitlyEnabled) {
      const code = config.productionWorkerEnabled === undefined || config.productionWorkerEnabled === ''
        ? 'MISSING_ACTIVATION_FLAG'
        : 'ACTIVATION_DISABLED';
      return {
        valid: false,
        code,
        message: 'Production execution denied: AIRA_PRODUCTION_WORKER_ENABLED must be explicitly set to true.',
        isProduction: true,
        sanitizedConfig
      };
    }

    if (!sanitizedConfig.expectedNeonProjectId) {
      return {
        valid: false,
        code: 'MISSING_EXPECTED_PROJECT_ID',
        message: 'Production execution denied: EXPECTED_NEON_PROJECT_ID must be configured.',
        isProduction: true,
        sanitizedConfig
      };
    }
    if (sanitizedConfig.expectedNeonProjectId !== CANONICAL_PRODUCTION_NEON_PROJECT_ID) {
      return {
        valid: false,
        code: 'INCORRECT_EXPECTED_PROJECT_ID',
        message: `Production execution denied: EXPECTED_NEON_PROJECT_ID does not match canonical production Neon project (${CANONICAL_PRODUCTION_NEON_PROJECT_ID}).`,
        isProduction: true,
        sanitizedConfig
      };
    }

    if (!sanitizedConfig.expectedNeonEndpointId) {
      return {
        valid: false,
        code: 'MISSING_EXPECTED_ENDPOINT_ID',
        message: 'Production execution denied: EXPECTED_NEON_ENDPOINT_ID must be configured.',
        isProduction: true,
        sanitizedConfig
      };
    }
    if (sanitizedConfig.expectedNeonEndpointId !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
      return {
        valid: false,
        code: 'INCORRECT_EXPECTED_ENDPOINT_ID',
        message: `Production execution denied: EXPECTED_NEON_ENDPOINT_ID does not match canonical production Neon endpoint (${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}).`,
        isProduction: true,
        sanitizedConfig
      };
    }

    return {
      valid: true,
      code: 'CONFIGURATION_VALID',
      message: 'Production worker static environment configuration is valid (preflight only).',
      isProduction: true,
      sanitizedConfig
    };
  }

  // Case 2: Non-Production Environment (Staging, Preview, Local, Test)
  if (
    isExplicitlyEnabled ||
    sanitizedConfig.expectedNeonProjectId === CANONICAL_PRODUCTION_NEON_PROJECT_ID ||
    sanitizedConfig.expectedNeonEndpointId === CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
  ) {
    return {
      valid: false,
      code: 'INCONSISTENT_NON_PROD_ACTIVATION_CONFIG',
      message: `Non-production environment ('${airaEnv}') cannot be configured with production activation settings (AIRA_PRODUCTION_WORKER_ENABLED or production expected IDs).`,
      isProduction: false,
      sanitizedConfig
    };
  }

  return {
    valid: true,
    code: 'CONFIGURATION_VALID',
    message: `Specialist worker static environment configuration is valid for non-production environment: '${airaEnv}'.`,
    isProduction: false,
    sanitizedConfig
  };
}

/**
 * Evaluates the static and runtime activation policy for specialist workers.
 * Enforces structural distinction between static preflight and runtime authorization.
 */
export function evaluateWorkerActivationPolicy(
  config: WorkerActivationConfig,
  connectedIdentity?: ConnectedDatabaseIdentity
): WorkerActivationResult {
  const staticResult = validateWorkerStaticConfig(config);
  const airaEnv = staticResult.sanitizedConfig.airaEnv;

  // If static configuration checks fail, reject immediately
  if (!staticResult.valid) {
    return {
      authorized: false,
      runtimeAuthorized: false,
      stage: 'STATIC_VALIDATION',
      code: staticResult.code,
      message: staticResult.message,
      isProduction: staticResult.isProduction,
      sanitizedConfig: staticResult.sanitizedConfig
    };
  }

  // =========================================================================
  // CASE 1: PRODUCTION ENVIRONMENT (AIRA_ENV=production)
  // =========================================================================
  if (staticResult.isProduction) {
    // If connected database identity is absent: STATIC CONFIGURATION VALIDATION ONLY
    // Crucial invariant: CONFIGURATION_VALID does NOT authorize runtime execution.
    if (!connectedIdentity) {
      return {
        authorized: true,
        runtimeAuthorized: false,
        stage: 'STATIC_VALIDATION',
        code: 'CONFIGURATION_VALID',
        message: 'Production worker static configuration is valid, but runtime database identity has not been verified. Production execution remains unauthorized.',
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig
      };
    }

    // RUNTIME ACTIVATION AUTHORIZATION PATH: Validate actual live Neon identity
    const liveProject = (connectedIdentity.neonProjectId || '').trim();
    const liveEndpoint = (connectedIdentity.neonEndpointId || '').trim();

    // Check 4a: Staging database in Production worker (Critical crossover)
    if (
      liveProject === CANONICAL_STAGING_NEON_PROJECT_ID ||
      liveEndpoint === CANONICAL_STAGING_NEON_ENDPOINT_ID
    ) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD',
        message: `CRITICAL SECURITY VIOLATION: Production worker connected to STAGING Neon database (${CANONICAL_STAGING_NEON_PROJECT_ID})!`,
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    // Check 4b: Both identifiers missing or empty
    if (!liveProject && !liveEndpoint) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'UNVERIFIED_DATABASE_IDENTITY',
        message: 'Production execution denied: Database identity could not be established from server telemetry.',
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    // Check 4c: Missing, null, undefined, empty or whitespace-only live project ID (partial identity)
    if (!liveProject) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'MISSING_CONNECTED_PROJECT_ID',
        message: 'Production execution denied: Connected Neon project identity is missing or empty.',
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    // Check 4d: Exact equality against canonical production project ID
    if (liveProject !== CANONICAL_PRODUCTION_NEON_PROJECT_ID) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'DATABASE_PROJECT_MISMATCH',
        message: `Connected Neon project ID does not match canonical production project (${CANONICAL_PRODUCTION_NEON_PROJECT_ID}).`,
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    // Check 4e: Missing, null, undefined, empty or whitespace-only live endpoint ID (partial identity)
    if (!liveEndpoint) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'MISSING_CONNECTED_ENDPOINT_ID',
        message: 'Production execution denied: Connected Neon endpoint identity is missing or empty.',
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    // Check 4f: Exact equality against canonical production endpoint ID
    if (liveEndpoint !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
      return {
        authorized: false,
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'DATABASE_ENDPOINT_MISMATCH',
        message: `Connected Neon endpoint ID does not match canonical production endpoint (${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}).`,
        isProduction: true,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }

    return {
      authorized: true,
      runtimeAuthorized: true,
      stage: 'RUNTIME_AUTHORIZATION',
      code: 'ACTIVATION_AUTHORIZED',
      message: 'Production specialist worker activation successfully authorized under verified live Neon identity.',
      isProduction: true,
      sanitizedConfig: staticResult.sanitizedConfig,
      connectedIdentity
    };
  }

  // =========================================================================
  // CASE 2: NON-PRODUCTION ENVIRONMENT (Staging, Preview, Local, Test)
  // =========================================================================

  // Check 5: Non-production worker connected to production database (Crossover check)
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
        runtimeAuthorized: false,
        stage: 'RUNTIME_AUTHORIZATION',
        code: 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_NON_PROD',
        message: `CRITICAL SECURITY VIOLATION: Non-production worker ('${airaEnv}') connected to PRODUCTION Neon database (${CANONICAL_PRODUCTION_NEON_PROJECT_ID})!`,
        isProduction: false,
        sanitizedConfig: staticResult.sanitizedConfig,
        connectedIdentity
      };
    }
  }

  return {
    authorized: true,
    runtimeAuthorized: true,
    stage: connectedIdentity ? 'RUNTIME_AUTHORIZATION' : 'STATIC_VALIDATION',
    code: 'NON_PROD_WORKER_AUTHORIZED',
    message: `Specialist worker authorized for non-production environment: '${airaEnv}'.`,
    isProduction: false,
    sanitizedConfig: staticResult.sanitizedConfig,
    connectedIdentity
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
  const airaEnv = (config.airaEnv || 'staging').trim().toLowerCase();
  const isProduction = airaEnv === 'production';

  // Step 1: Preflight static configuration
  const staticResult = validateWorkerStaticConfig(config);
  if (!staticResult.valid) {
    throw new ActivationSecurityError(staticResult.code, staticResult.message);
  }

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
    const row = res.rows?.[0];
    if (!row) {
      throw new ActivationSecurityError(
        'UNVERIFIED_DATABASE_IDENTITY',
        'Unable to verify database identity during worker startup.'
      );
    }
    connectedIdentity = {
      databaseName: row.db_name,
      user: row.db_user,
      serverAddr: String(row.server_ip || 'unknown'),
      neonProjectId: row.neon_project_id ? String(row.neon_project_id).trim() : undefined,
      neonBranchId: row.neon_branch_id ? String(row.neon_branch_id).trim() : undefined,
      neonEndpointId: row.neon_endpoint_id ? String(row.neon_endpoint_id).trim() : undefined
    };
  } catch (err: any) {
    if (err instanceof ActivationSecurityError) {
      throw err;
    }
    // Fixed, non-sensitive public error message (PHASE 2 requirement)
    throw new ActivationSecurityError(
      'DATABASE_UNAVAILABLE',
      'Unable to verify database identity during worker startup.'
    );
  }

  // Runtime authorization path guard: connectedIdentity cannot be omitted in production
  if (isProduction && !connectedIdentity) {
    throw new ActivationSecurityError(
      'UNVERIFIED_DATABASE_IDENTITY',
      'Unable to verify database identity during worker startup.'
    );
  }

  const result = evaluateWorkerActivationPolicy(config, connectedIdentity);
  if (!result.authorized || !result.runtimeAuthorized) {
    throw new ActivationSecurityError(result.code, result.message);
  }

  return result;
}

/**
 * Sanitizes any unknown runtime or database error into a fixed, non-sensitive structure.
 * Guaranteed never to expose connection strings, passwords, auth headers, or raw driver strings.
 */
export function sanitizeActivationError(err: unknown): { code: string; message: string } {
  if (err instanceof ActivationSecurityError) {
    return {
      code: err.code,
      message: err.message
    };
  }

  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as any).code === 'string') {
    const code = (err as any).code;
    if (code === 'DATABASE_UNAVAILABLE' || code === 'UNVERIFIED_DATABASE_IDENTITY') {
      return {
        code,
        message: 'Unable to verify database identity during worker startup.'
      };
    }
  }

  return {
    code: 'DATABASE_UNAVAILABLE',
    message: 'Unable to verify database identity during worker startup.'
  };
}
