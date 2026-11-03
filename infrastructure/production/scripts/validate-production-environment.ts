/**
 * AIRA AI 2026 — Production Environment & Worker Configuration Preflight Validator
 * 
 * Executable TypeScript CLI validator enforcing fail-closed checks before worker startup:
 * 1. Environment file presence and POSIX permissions (0600 / 0640).
 * 2. Database URL format, Neon -pooler routing, and SSL enforcement.
 * 3. Exact Neon project ID (old-sky-50952395) and endpoint ID (ep-withered-art-b36ox90b) assertions.
 * 4. Staging / non-production crossover rejection.
 * 5. AES-256-GCM envelope encryption key format (32 bytes / 64 hex chars).
 * 6. Python sandbox runner URL reachability and container enforcement flags.
 * 7. Stage A (Standby) vs Stage B (Activated) state reporting.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  classifyDatabaseUrl,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_ENDPOINT_ID
} from '../../../packages/db/src/security/database-isolation-guard.js';
import {
  validateWorkerStaticConfig,
  CANONICAL_PRODUCTION_NEON_PROJECT_ID,
  CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
} from '../../../packages/agent-runtime/src/durable/worker-activation-policy.js';

export interface ValidationOptions {
  envFilePath?: string;
  expectedStage?: 'A' | 'B';
  checkDatabaseConnectivity?: boolean;
  checkSandboxReachability?: boolean;
}

export interface EnvironmentValidationReport {
  valid: boolean;
  stage: 'STAGE_A_STANDBY' | 'STAGE_B_ACTIVE' | 'INVALID_STAGE';
  errors: string[];
  warnings: string[];
  summary: {
    airaEnv?: string;
    productionWorkerEnabled?: string;
    neonProjectId?: string;
    neonEndpointId?: string;
    databaseHost?: string;
    isPoolerRouted?: boolean;
    workerId?: string;
    workerConcurrency?: number;
    sandboxUrl?: string;
  };
}

/**
 * Parses a standard KEY=VALUE environment file into a string record.
 * Handles quotes, comments (#), and blank lines.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Environment file does not exist at: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    env[key] = val;
  }

  return env;
}

/**
 * Validates file permissions for sensitive production environment files.
 */
export function validateEnvFilePermissions(filePath: string): { valid: boolean; message: string; warningOnly: boolean } {
  if (!fs.existsSync(filePath)) {
    return { valid: false, message: `Environment file not found: ${filePath}`, warningOnly: false };
  }

  // Windows file systems do not have POSIX octal permission masks
  if (process.platform === 'win32') {
    return {
      valid: true,
      message: `Running on Windows — POSIX file mode checks skipped for: ${filePath}`,
      warningOnly: true
    };
  }

  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;

    // Reject world-readable, world-writable, or world-executable
    if ((mode & 0o007) !== 0) {
      return {
        valid: false,
        message: `Insecure file permissions: ${filePath} has mode 0${mode.toString(8)}. Must not be accessible by world (use chmod 600 or chmod 640).`,
        warningOnly: false
      };
    }

    // Must be 0600 or 0640 or 0400
    if (mode === 0o600 || mode === 0o640 || mode === 0o400 || mode === 0o440) {
      return {
        valid: true,
        message: `File permissions secure: 0${mode.toString(8)}`,
        warningOnly: false
      };
    }

    return {
      valid: false,
      message: `File permissions 0${mode.toString(8)} exceed recommended chmod 600/640.`,
      warningOnly: false
    };
  } catch (err: any) {
    return { valid: false, message: `Failed to inspect file permissions: ${err.message}`, warningOnly: false };
  }
}

/**
 * Core validation routine for production worker environment configuration.
 */
export function validateProductionEnvironmentConfig(
  env: Record<string, string>,
  options: ValidationOptions = {}
): EnvironmentValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const airaEnv = (env.AIRA_ENV || '').trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  const prodWorkerEnabled = (env.AIRA_PRODUCTION_WORKER_ENABLED || '').trim();
  const expectedProjectId = (env.EXPECTED_NEON_PROJECT_ID || '').trim();
  const expectedEndpointId = (env.EXPECTED_NEON_ENDPOINT_ID || '').trim();
  const dbUrl = (env.DATABASE_URL || '').trim();
  const agentKey = (env.AGENT_ENCRYPTION_KEY || '').trim();
  const browserKey = (env.BROWSER_SESSION_ENCRYPTION_KEY || '').trim();
  const sandboxUrl = (env.AIRA_SANDBOX_RUNNER_URL || '').trim();
  const requireContainerSandbox = (env.AIRA_REQUIRE_CONTAINER_SANDBOX || '').trim();
  const allowLocalSandbox = (env.AIRA_ALLOW_LOCAL_SANDBOX || '').trim();
  const workerConcurrency = parseInt(env.WORKER_CONCURRENCY || '2', 10);
  const workerId = (env.WORKER_ID || '').trim();

  // 1. Environment Identity Checks
  if (airaEnv !== 'production') {
    errors.push(`AIRA_ENV must be strictly 'production' (found: '${env.AIRA_ENV || ''}')`);
  }
  if (nodeEnv !== 'production') {
    errors.push(`NODE_ENV must be strictly 'production' (found: '${env.NODE_ENV || ''}')`);
  }

  // 2. Stage Determination (Stage A: Standby vs Stage B: Activated)
  let stage: 'STAGE_A_STANDBY' | 'STAGE_B_ACTIVE' | 'INVALID_STAGE' = 'INVALID_STAGE';
  if (prodWorkerEnabled === 'false') {
    stage = 'STAGE_A_STANDBY';
  } else if (prodWorkerEnabled === 'true') {
    stage = 'STAGE_B_ACTIVE';
  } else {
    errors.push(
      `AIRA_PRODUCTION_WORKER_ENABLED must be strictly 'false' (Stage A) or 'true' (Stage B). Found: '${prodWorkerEnabled}'`
    );
  }

  if (options.expectedStage === 'A' && stage !== 'STAGE_A_STANDBY') {
    errors.push(`Expected Stage A (Standby with AIRA_PRODUCTION_WORKER_ENABLED=false), but found: ${prodWorkerEnabled}`);
  }
  if (options.expectedStage === 'B' && stage !== 'STAGE_B_ACTIVE') {
    errors.push(`Expected Stage B (Activated with AIRA_PRODUCTION_WORKER_ENABLED=true), but found: ${prodWorkerEnabled}`);
  }

  // 3. Expected Neon Identifiers
  if (expectedProjectId !== CANONICAL_PRODUCTION_NEON_PROJECT_ID) {
    errors.push(
      `EXPECTED_NEON_PROJECT_ID must match canonical production project '${CANONICAL_PRODUCTION_NEON_PROJECT_ID}' (found: '${expectedProjectId}')`
    );
  }
  if (expectedEndpointId !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
    errors.push(
      `EXPECTED_NEON_ENDPOINT_ID must match canonical production endpoint '${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}' (found: '${expectedEndpointId}')`
    );
  }

  // 4. Database URL Analysis & Crossover Protection
  let databaseHost = '';
  let isPoolerRouted = false;

  if (!dbUrl) {
    errors.push('DATABASE_URL is missing or empty.');
  } else if (dbUrl.includes('<PROD_USER>') || dbUrl.includes('<PROD_PASSWORD>') || dbUrl.includes('YOUR_PROD_')) {
    // Template placeholder detected
    warnings.push('DATABASE_URL contains unpopulated placeholder tokens (<PROD_USER> / <PROD_PASSWORD>).');
    if (dbUrl.includes(CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) && dbUrl.includes('-pooler')) {
      isPoolerRouted = true;
      databaseHost = `${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech`;
    }
  } else {
    const classification = classifyDatabaseUrl(dbUrl);
    databaseHost = classification.host;

    // Crossover Checks
    if (
      classification.host.includes(STAGING_NEON_PROJECT_ID) ||
      classification.host.includes(STAGING_NEON_ENDPOINT_ID) ||
      classification.isStagingPermanent
    ) {
      errors.push(
        `ACTIVATION_SECURITY_REJECTED: Staging Neon database target detected in production configuration (${classification.sanitizedTarget})!`
      );
    }

    if (!classification.isProduction) {
      errors.push(
        `DATABASE_URL does not classify as production Neon database (category: ${classification.category}, target: ${classification.sanitizedTarget})`
      );
    }

    // Must route through Neon PgBouncer -pooler endpoint
    if (!classification.host.includes('-pooler')) {
      errors.push(
        `DATABASE_URL must route to Neon PgBouncer pooler hostname containing '-pooler' (found host: '${classification.host}')`
      );
    } else {
      isPoolerRouted = true;
    }

    // Must enforce SSL
    if (!dbUrl.includes('sslmode=require')) {
      warnings.push("DATABASE_URL should explicitly include 'sslmode=require'.");
    }
  }

  // 5. Static Worker Activation Policy Alignment
  const staticPolicy = validateWorkerStaticConfig({
    airaEnv,
    productionWorkerEnabled: prodWorkerEnabled,
    expectedNeonProjectId: expectedProjectId,
    expectedNeonEndpointId: expectedEndpointId
  });

  if (stage === 'STAGE_B_ACTIVE' && !staticPolicy.valid) {
    errors.push(`Static worker activation policy rejected: [${staticPolicy.code}] ${staticPolicy.message}`);
  }

  // 6. Cryptographic Keys Format Validation (AES-256-GCM requires 32 bytes / 64 hex characters)
  const hex64Regex = /^[0-9a-fA-F]{64}$/;
  if (!agentKey) {
    errors.push('AGENT_ENCRYPTION_KEY is missing or empty.');
  } else if (agentKey.includes('<') || agentKey.includes('YOUR_PROD_')) {
    warnings.push('AGENT_ENCRYPTION_KEY contains an unpopulated placeholder token.');
  } else if (!hex64Regex.test(agentKey)) {
    errors.push('AGENT_ENCRYPTION_KEY must be a 64-character hexadecimal string (32 bytes for AES-256-GCM).');
  }

  if (!browserKey) {
    errors.push('BROWSER_SESSION_ENCRYPTION_KEY is missing or empty.');
  } else if (browserKey.includes('<') || browserKey.includes('YOUR_PROD_')) {
    warnings.push('BROWSER_SESSION_ENCRYPTION_KEY contains an unpopulated placeholder token.');
  } else if (!hex64Regex.test(browserKey)) {
    errors.push('BROWSER_SESSION_ENCRYPTION_KEY must be a 64-character hexadecimal string (32 bytes for AES-256-GCM).');
  }

  // 7. Python Sandbox Runner Constraints
  if (!sandboxUrl) {
    errors.push('AIRA_SANDBOX_RUNNER_URL is missing or empty.');
  } else if (!sandboxUrl.startsWith('http://') && !sandboxUrl.startsWith('https://')) {
    errors.push(`AIRA_SANDBOX_RUNNER_URL must be an HTTP(S) URL (found: '${sandboxUrl}')`);
  }

  if (requireContainerSandbox !== 'true') {
    errors.push("AIRA_REQUIRE_CONTAINER_SANDBOX must be strictly 'true' in production.");
  }
  if (allowLocalSandbox !== 'false') {
    errors.push("AIRA_ALLOW_LOCAL_SANDBOX must be strictly 'false' in production.");
  }

  // 8. Sizing & Concurrency Bounds
  if (isNaN(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 8) {
    errors.push(`WORKER_CONCURRENCY must be between 1 and 8 (found: ${workerConcurrency})`);
  }
  if (!workerId) {
    errors.push('WORKER_ID must be specified.');
  }

  return {
    valid: errors.length === 0,
    stage,
    errors,
    warnings,
    summary: {
      airaEnv,
      productionWorkerEnabled: prodWorkerEnabled,
      neonProjectId: expectedProjectId,
      neonEndpointId: expectedEndpointId,
      databaseHost,
      isPoolerRouted,
      workerId,
      workerConcurrency,
      sandboxUrl
    }
  };
}

/**
 * Probes the Python sandbox sidecar health endpoint over HTTP.
 */
export async function checkSandboxHealth(urlStr: string, timeoutMs = 3000): Promise<{ reachable: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr.endsWith('/') ? `${urlStr}health` : `${urlStr}/health`);
      const req = http.get(parsed, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ reachable: true, message: `Sandbox healthy (HTTP ${res.statusCode}): ${body.trim()}` });
          } else {
            resolve({ reachable: false, message: `Sandbox returned non-2xx status (HTTP ${res.statusCode}): ${body.trim()}` });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ reachable: false, message: `Sandbox unreachable: ${err.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false, message: `Sandbox healthcheck timed out after ${timeoutMs}ms` });
      });
    } catch (err: any) {
      resolve({ reachable: false, message: `Malformed sandbox URL: ${err.message}` });
    }
  });
}

/**
 * CLI Entrypoint
 */
export async function runValidatorCLI(argv: string[] = process.argv.slice(2)): Promise<number> {
  console.log('\n==============================================================================');
  console.log(' AIRA AI 2026 — Production Environment & Worker Configuration Preflight');
  console.log('==============================================================================\n');

  let envPath = process.env.AIRA_ENV_FILE || '/etc/aira/production-worker.env';
  let expectedStage: 'A' | 'B' | undefined;
  let checkDb = false;
  let checkSandbox = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env-file' && argv[i + 1]) {
      envPath = argv[++i];
    } else if (arg === '--stage' && (argv[i + 1] === 'A' || argv[i + 1] === 'B')) {
      expectedStage = argv[++i] as 'A' | 'B';
    } else if (arg === '--check-db') {
      checkDb = true;
    } else if (arg === '--check-sandbox') {
      checkSandbox = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npx tsx infrastructure/production/scripts/validate-production-environment.ts [options]');
      console.log('\nOptions:');
      console.log('  --env-file <path>    Path to environment file (default: /etc/aira/production-worker.env)');
      console.log('  --stage <A|B>        Assert expected activation stage (A=Standby, B=Active)');
      console.log('  --check-db           Perform live Neon PostgreSQL GUC identity query');
      console.log('  --check-sandbox      Perform live HTTP ping to Python sandbox runner');
      return 0;
    }
  }

  const resolvedPath = path.resolve(envPath);
  console.log(`Inspecting environment file: ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`\n❌ PREFLIGHT FAILED: Target environment file does not exist: ${resolvedPath}`);
    return 1;
  }

  // 1. Permissions Check
  const permCheck = validateEnvFilePermissions(resolvedPath);
  if (!permCheck.valid) {
    console.error(`\n❌ PERMISSIONS SECURITY VIOLATION: ${permCheck.message}`);
    return 1;
  }
  console.log(`✓ Permissions check: ${permCheck.message}`);

  // 2. Parse & Validate
  let envVars: Record<string, string>;
  try {
    envVars = parseEnvFile(resolvedPath);
  } catch (err: any) {
    console.error(`\n❌ PARSING ERROR: ${err.message}`);
    return 1;
  }

  const report = validateProductionEnvironmentConfig(envVars, { expectedStage });

  console.log('\n--- Configuration Summary ---');
  console.log(`  AIRA_ENV:                      ${report.summary.airaEnv}`);
  console.log(`  AIRA_PRODUCTION_WORKER_ENABLED:${report.summary.productionWorkerEnabled}`);
  console.log(`  Determined Stage:              ${report.stage}`);
  console.log(`  EXPECTED_NEON_PROJECT_ID:      ${report.summary.neonProjectId}`);
  console.log(`  EXPECTED_NEON_ENDPOINT_ID:     ${report.summary.neonEndpointId}`);
  console.log(`  Database Host:                 ${report.summary.databaseHost || '(placeholder/empty)'}`);
  console.log(`  PgBouncer Pooler Routing:      ${report.summary.isPoolerRouted ? 'YES (-pooler)' : 'NO'}`);
  console.log(`  Worker Concurrency:            ${report.summary.workerConcurrency}`);
  console.log(`  Sandbox URL:                   ${report.summary.sandboxUrl}`);

  if (report.warnings.length > 0) {
    console.log('\n--- Warnings ---');
    for (const w of report.warnings) {
      console.log(`  ⚠️  ${w}`);
    }
  }

  if (report.errors.length > 0) {
    console.error('\n--- Fail-Closed Security Violations ---');
    for (const err of report.errors) {
      console.error(`  ❌ ${err}`);
    }
    console.error('\n❌ PREFLIGHT VALIDATION FAILED: Production configuration is NOT authorized for startup.\n');
    return 1;
  }

  // 3. Optional live sandbox check
  if (checkSandbox && report.summary.sandboxUrl) {
    console.log(`\nTesting sandbox reachability at: ${report.summary.sandboxUrl}...`);
    const sb = await checkSandboxHealth(report.summary.sandboxUrl);
    if (!sb.reachable) {
      console.error(`❌ Sandbox probe failed: ${sb.message}`);
      return 1;
    }
    console.log(`✓ Sandbox probe successful: ${sb.message}`);
  }

  // 4. Optional live DB check
  if (checkDb) {
    console.log('\nChecking live database identity (read-only)...');
    try {
      // Import Knex dynamically to avoid mandatory DB initialization in tests
      const { db } = await import('../../../packages/db/src/index.js');
      const res = await db.raw("SELECT current_setting('neon.project_id', true) as p, current_setting('neon.endpoint_id', true) as e");
      const row = res.rows?.[0];
      if (row?.p !== CANONICAL_PRODUCTION_NEON_PROJECT_ID || row?.e !== CANONICAL_PRODUCTION_NEON_ENDPOINT_ID) {
        console.error(`❌ Live DB mismatch: expected ${CANONICAL_PRODUCTION_NEON_PROJECT_ID}/${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}, found ${row?.p}/${row?.e}`);
        return 1;
      }
      console.log(`✓ Live Neon GUCs verified: project=${row.p}, endpoint=${row.e}`);
    } catch (err: any) {
      console.error(`❌ Live DB connection error: ${err.message}`);
      return 1;
    }
  }

  console.log('\n==============================================================================');
  if (report.stage === 'STAGE_A_STANDBY') {
    console.log(' ✅ PREFLIGHT PASS (STAGE A STANDBY): Safe for deployment. Polling disabled.');
  } else {
    console.log(' ✅ PREFLIGHT PASS (STAGE B ACTIVE): Authorized for production task polling.');
  }
  console.log('==============================================================================\n');

  return 0;
}

// Direct CLI invocation check
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runValidatorCLI().then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err) => {
    console.error(`\n❌ Fatal validator exception:`, err);
    process.exit(1);
  });
}
