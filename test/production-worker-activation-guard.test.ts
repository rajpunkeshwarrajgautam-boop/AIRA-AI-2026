import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateWorkerActivationPolicy,
  validateWorkerStaticConfig,
  assertWorkerActivationAuthorized,
  sanitizeActivationError,
  ActivationSecurityError,
  CANONICAL_PRODUCTION_NEON_PROJECT_ID,
  CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
  CANONICAL_STAGING_NEON_PROJECT_ID,
  CANONICAL_STAGING_NEON_ENDPOINT_ID,
  type WorkerActivationConfig,
  type ConnectedDatabaseIdentity
} from '../packages/agent-runtime/src/durable/worker-activation-policy.js';

import {
  classifyDatabaseUrl
} from '../packages/db/src/security/database-isolation-guard.js';

import {
  validateProductionEnvironmentConfig,
  validateEnvFilePermissions,
  parseEnvFile
} from '../infrastructure/production/scripts/validate-production-environment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test.describe('AIRA AI 2026 — Production Worker Architecture & Activation Guard Test Suite', () => {

  const validProdEnvVars: Record<string, string> = {
    NODE_ENV: 'production',
    AIRA_ENV: 'production',
    AIRA_PRODUCTION_WORKER_ENABLED: 'true',
    WORKER_ID: 'worker_oracle_ampere_production_01',
    WORKER_CONCURRENCY: '2',
    DATABASE_URL: 'postgresql://prod_user@ep-withered-art-b36ox90b-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    EXPECTED_NEON_PROJECT_ID: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
    EXPECTED_NEON_ENDPOINT_ID: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
    AGENT_ENCRYPTION_KEY: 'a'.repeat(64),
    BROWSER_SESSION_ENCRYPTION_KEY: 'b'.repeat(64),
    PORT: '8080',
    AIRA_REQUIRE_CONTAINER_SANDBOX: 'true',
    AIRA_ALLOW_LOCAL_SANDBOX: 'false',
    AIRA_SANDBOX_RUNNER_URL: 'http://sandbox-runner:8000'
  };

  const validProdIdentity: ConnectedDatabaseIdentity = {
    databaseName: 'neondb',
    user: 'aira_prod_owner',
    serverAddr: '10.0.1.10',
    neonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
    neonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
    neonBranchId: 'br-shiny-moon-b3vy9xj7',
    host: `${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech`
  };

  // =========================================================================
  // 1. STAGE A STANDBY VERIFICATION
  // =========================================================================

  test('Stage A Standby: Refuses queue polling when AIRA_PRODUCTION_WORKER_ENABLED=false', async () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'false',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    const staticResult = validateWorkerStaticConfig(config);
    assert.strictEqual(staticResult.valid, false, 'Static validation must fail when worker is disabled');
    assert.strictEqual(staticResult.code, 'ACTIVATION_DISABLED');
    assert.strictEqual(staticResult.isProduction, true);
    assert.match(staticResult.message, /must be explicitly set to true/i);

    // Mock client returning valid Neon production identity
    const mockClient = {
      raw: async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'prod_user',
          server_ip: '10.0.1.5',
          neon_project_id: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
          neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
        }]
      })
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(config, mockClient);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError, 'Must throw ActivationSecurityError');
        assert.strictEqual(err.code, 'ACTIVATION_DISABLED');
        assert.match(err.message, /ACTIVATION_SECURITY_REJECTED:ACTIVATION_DISABLED/);
        return true;
      },
      'Stage A standby worker must refuse authorization with ACTIVATION_SECURITY_REJECTED'
    );
  });

  test('Stage A Standby: Missing or unsupported boolean representations fail closed', () => {
    const falsyValues = [undefined, '', '0', 'no', 'TRUE', ' true ', 'false'];

    for (const val of falsyValues) {
      const config: WorkerActivationConfig = {
        airaEnv: 'production',
        productionWorkerEnabled: val,
        expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
        expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
      };

      const result = evaluateWorkerActivationPolicy(config, validProdIdentity);
      assert.strictEqual(result.authorized, false, `Value '${val}' must NOT authorize worker activation`);
      assert.strictEqual(result.runtimeAuthorized, false);
    }
  });

  // =========================================================================
  // 2. STAGE B ACTIVATION AUTHORIZATION
  // =========================================================================

  test('Stage B Activation: Authorizes only when Neon project & endpoint match production', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    const result = evaluateWorkerActivationPolicy(config, validProdIdentity);
    assert.strictEqual(result.authorized, true);
    assert.strictEqual(result.runtimeAuthorized, true);
    assert.strictEqual(result.code, 'ACTIVATION_AUTHORIZED');
    assert.strictEqual(result.isProduction, true);
  });

  test('Stage B Activation: Rejects mismatching Neon project ID', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    const mismatchProjectIdentity: ConnectedDatabaseIdentity = {
      ...validProdIdentity,
      neonProjectId: 'unauthorized-neon-project-99999'
    };

    const result = evaluateWorkerActivationPolicy(config, mismatchProjectIdentity);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.runtimeAuthorized, false);
    assert.strictEqual(result.code, 'DATABASE_PROJECT_MISMATCH');
  });

  test('Stage B Activation: Rejects mismatching Neon endpoint ID', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    const mismatchEndpointIdentity: ConnectedDatabaseIdentity = {
      ...validProdIdentity,
      neonEndpointId: 'ep-unauthorized-fake-endpoint'
    };

    const result = evaluateWorkerActivationPolicy(config, mismatchEndpointIdentity);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.runtimeAuthorized, false);
    assert.strictEqual(result.code, 'DATABASE_ENDPOINT_MISMATCH');
  });

  test('Stage B Activation: Rejects missing or unverified database identity telemetry', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    // No live identity provided (static preflight only)
    const staticOnly = evaluateWorkerActivationPolicy(config);
    assert.strictEqual(staticOnly.authorized, true);
    assert.strictEqual(staticOnly.runtimeAuthorized, false, 'Static preflight alone must NOT authorize runtime execution');
    assert.strictEqual(staticOnly.code, 'CONFIGURATION_VALID');

    // Live identity with empty identifiers
    const emptyIdentity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'unknown',
      neonProjectId: '',
      neonEndpointId: ''
    };
    const emptyResult = evaluateWorkerActivationPolicy(config, emptyIdentity);
    assert.strictEqual(emptyResult.authorized, false);
    assert.strictEqual(emptyResult.code, 'UNVERIFIED_DATABASE_IDENTITY');
  });

  // =========================================================================
  // 3. CROSSOVER PROTECTION
  // =========================================================================

  test('Crossover Protection: Staging database URL in production throws ACTIVATION_SECURITY_REJECTED', () => {
    const stagingDbUrl = `postgresql://user@${CANONICAL_STAGING_NEON_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
    
    // Test database URL classification directly
    const classification = classifyDatabaseUrl(stagingDbUrl);
    assert.strictEqual(classification.isProduction, false, 'Staging database URL must NOT classify as production');
    assert.strictEqual(classification.isStagingPermanent, true);
    assert.strictEqual(classification.category, 'staging_permanent');

    // Test production preflight validator rejects staging database URL
    const envWithStagingDb = {
      ...validProdEnvVars,
      DATABASE_URL: stagingDbUrl
    };

    const report = validateProductionEnvironmentConfig(envWithStagingDb);
    assert.strictEqual(report.valid, false, 'Validation report must fail when staging DB is used in production');
    const crossoverError = report.errors.find(e => e.includes('ACTIVATION_SECURITY_REJECTED'));
    assert.ok(crossoverError, 'Must emit ACTIVATION_SECURITY_REJECTED error for staging DB URL in production');
  });

  test('Crossover Protection: Staging live Neon identity in production worker fails closed', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };

    const stagingConnectedIdentity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'staging_user',
      neonProjectId: CANONICAL_STAGING_NEON_PROJECT_ID,
      neonEndpointId: CANONICAL_STAGING_NEON_ENDPOINT_ID,
      neonBranchId: 'br-autumn-star-b36dfu5w'
    };

    const result = evaluateWorkerActivationPolicy(config, stagingConnectedIdentity);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.runtimeAuthorized, false);
    assert.strictEqual(result.code, 'CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD');
  });

  test('Crossover Protection: Sanitized error reporting never leaks database credentials', () => {
    const sensitiveError = new Error('password authentication failed for user "neondb_owner": password="super_secret_production_password" host="ep-withered-art-b36ox90b.neon.tech"');
    const sanitized = sanitizeActivationError(sensitiveError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.doesNotMatch(sanitized.message, /super_secret_production_password/);
    assert.doesNotMatch(sanitized.message, /neondb_owner/);
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
  });

  // =========================================================================
  // 4. PRODUCTION DOCKER COMPOSE SPEC INVARIANTS
  // =========================================================================

  test('Docker Compose Spec: Contains zero Docker socket mounts and enforces non-root execution', () => {
    const composePath = path.join(REPO_ROOT, 'infrastructure', 'production', 'docker-compose.prod.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.prod.yml must exist');

    const content = fs.readFileSync(composePath, 'utf8');

    // 1. Zero Host Docker Socket Mounts
    assert.doesNotMatch(
      content,
      /\/var\/run\/docker\.sock/,
      'CRITICAL SECURITY: Host Docker socket (/var/run/docker.sock) must NEVER be mounted in production compose'
    );

    // 2. Project Name
    assert.match(content, /^name:\s*aira-autonomous-production/m, 'Must define top-level project name aira-autonomous-production');

    // 3. Specialist Worker Container & Security Hardening
    assert.match(content, /container_name:\s*\${CONTAINER_NAME:-aira-autonomous-worker-prod}/, 'Must define container_name aira-autonomous-worker-prod');
    assert.match(content, /user:\s*["']10001:10001["']/, 'Specialist worker must run as non-root user 10001:10001');
    assert.match(content, /no-new-privileges:true/, 'Specialist worker must enforce no-new-privileges:true');
    assert.match(content, /cap_drop:\r?\n\s+-\s+ALL/, 'Specialist worker must drop ALL capabilities');
    assert.match(content, /cap_add:\r?\n\s+-\s+NET_BIND_SERVICE/, 'Specialist worker must cap_add NET_BIND_SERVICE');

    // 4. Specialist Worker Resource Limits
    assert.match(content, /cpus:\s*['"]?1\.5['"]?/, 'Specialist worker cpus limit must be 1.5');
    assert.match(content, /memory:\s*2048M/, 'Specialist worker memory limit must be 2048M');

    // 5. Port Binding strictly to loopback 127.0.0.1:8080:8080
    assert.match(content, /127\.0\.0\.1:8080:8080/, 'Specialist worker must bind strictly to host loopback 127.0.0.1:8080');

    // 6. Sandbox Runner Sidecar Isolation & Hardening
    assert.match(content, /container_name:\s*\${SANDBOX_CONTAINER_NAME:-aira-sandbox-runner-prod}/, 'Sandbox container must be aira-sandbox-runner-prod');
    assert.match(content, /user:\s*["']nobody:nogroup["']/, 'Sandbox runner must execute as nobody:nogroup (UID 65534)');
    assert.match(content, /read_only:\s*true/, 'Sandbox runner root filesystem must be read_only: true');
    assert.match(content, /tmpfs:\r?\n\s+-\s+\/tmp:mode=1777,size=512M/, 'Sandbox runner must mount tmpfs /tmp:mode=1777,size=512M');

    // 7. Internal Network Architecture
    assert.match(content, /sandbox-net:\r?\n\s+internal:\s*true/, 'sandbox-net must be configured with internal: true');
    assert.match(content, /networks:\r?\n\s+default:\r?\n\s+sandbox-net:/, 'Both default and sandbox-net networks must be declared');
  });

  // =========================================================================
  // 5. PRODUCTION SYSTEMD SERVICE UNIT INVARIANTS
  // =========================================================================

  test('Systemd Unit: Enforces graceful timeout >= 30s and required operational directives', () => {
    const servicePath = path.join(REPO_ROOT, 'infrastructure', 'production', 'systemd', 'aira-production-worker.service');
    assert.ok(fs.existsSync(servicePath), 'aira-production-worker.service must exist');

    const content = fs.readFileSync(servicePath, 'utf8');

    // 1. EnvironmentFile
    assert.match(content, /EnvironmentFile=\/etc\/aira\/production-worker\.env/, 'Must load /etc/aira/production-worker.env');

    // 2. ExecStart and ExecStop
    assert.match(
      content,
      /ExecStart=\/usr\/bin\/docker compose -f \/opt\/aira\/infrastructure\/production\/docker-compose\.prod\.yml up -d/,
      'ExecStart must invoke docker compose up -d on docker-compose.prod.yml'
    );
    assert.match(
      content,
      /ExecStop=\/usr\/bin\/docker compose -f \/opt\/aira\/infrastructure\/production\/docker-compose\.prod\.yml down/,
      'ExecStop must invoke docker compose down on docker-compose.prod.yml'
    );

    // 3. Graceful Timeout >= 30s
    const timeoutMatch = content.match(/TimeoutStopSec=(\d+)/);
    assert.ok(timeoutMatch, 'TimeoutStopSec directive must be present in systemd unit');
    const timeoutSec = parseInt(timeoutMatch[1], 10);
    assert.ok(timeoutSec >= 30, `TimeoutStopSec must be >= 30s for graceful task checkpointing (found: ${timeoutSec}s)`);
    assert.strictEqual(timeoutSec, 35, 'TimeoutStopSec should be exactly 35s');

    // 4. Restart Policies & Cgroups
    assert.match(content, /Restart=on-failure/, 'Must configure Restart=on-failure');
    assert.match(content, /RestartSec=5s/, 'Must configure RestartSec=5s');
    assert.match(content, /CPUAccounting=true/, 'Must configure CPUAccounting=true');
    assert.match(content, /MemoryAccounting=true/, 'Must configure MemoryAccounting=true');
  });

  // =========================================================================
  // 6. PRODUCTION ENVIRONMENT TEMPLATE & VALIDATOR INTEGRATION
  // =========================================================================

  test('Environment Template: Conforms to Stage A standby specifications', () => {
    const templatePath = path.join(REPO_ROOT, 'infrastructure', 'production', 'env.production.worker.template');
    assert.ok(fs.existsSync(templatePath), 'env.production.worker.template must exist');

    const parsed = parseEnvFile(templatePath);
    assert.strictEqual(parsed.AIRA_ENV, 'production');
    assert.strictEqual(parsed.NODE_ENV, 'production');
    assert.strictEqual(parsed.AIRA_PRODUCTION_WORKER_ENABLED, 'false', 'Default template must be Stage A standby');
    assert.strictEqual(parsed.EXPECTED_NEON_PROJECT_ID, CANONICAL_PRODUCTION_NEON_PROJECT_ID);
    assert.strictEqual(parsed.EXPECTED_NEON_ENDPOINT_ID, CANONICAL_PRODUCTION_NEON_ENDPOINT_ID);
    assert.ok(parsed.DATABASE_URL.includes('-pooler'), 'DATABASE_URL placeholder must route to -pooler');
    assert.ok(parsed.DATABASE_URL.includes(CANONICAL_PRODUCTION_NEON_ENDPOINT_ID));
    assert.strictEqual(parsed.WORKER_CONCURRENCY, '2');
    assert.strictEqual(parsed.AIRA_REQUIRE_CONTAINER_SANDBOX, 'true');
    assert.strictEqual(parsed.AIRA_ALLOW_LOCAL_SANDBOX, 'false');

    const report = validateProductionEnvironmentConfig(parsed);
    assert.strictEqual(report.stage, 'STAGE_A_STANDBY');
    assert.strictEqual(report.valid, true);
    assert.strictEqual(report.errors.length, 0);
  });

  test('Environment Validator: Validates Stage B active environment and flags violations', () => {
    // Valid Stage B config
    const validStageB = {
      ...validProdEnvVars,
      AIRA_PRODUCTION_WORKER_ENABLED: 'true'
    };
    const reportB = validateProductionEnvironmentConfig(validStageB, { expectedStage: 'B' });
    assert.strictEqual(reportB.valid, true);
    assert.strictEqual(reportB.stage, 'STAGE_B_ACTIVE');

    // Missing pooler in database URL
    const noPooler = {
      ...validStageB,
      DATABASE_URL: 'postgresql://prod_user@ep-withered-art-b36ox90b.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'
    };
    const reportNoPooler = validateProductionEnvironmentConfig(noPooler);
    assert.strictEqual(reportNoPooler.valid, false);
    assert.ok(reportNoPooler.errors.some(e => e.includes('-pooler')));

    // Invalid non-hex encryption keys
    const invalidKey = {
      ...validStageB,
      AGENT_ENCRYPTION_KEY: 'not-a-valid-hex-key-too-short'
    };
    const reportInvalidKey = validateProductionEnvironmentConfig(invalidKey);
    assert.strictEqual(reportInvalidKey.valid, false);
    assert.ok(reportInvalidKey.errors.some(e => e.includes('64-character hexadecimal')));

    // Invalid sandbox local override
    const invalidSandbox = {
      ...validStageB,
      AIRA_ALLOW_LOCAL_SANDBOX: 'true'
    };
    const reportInvalidSandbox = validateProductionEnvironmentConfig(invalidSandbox);
    assert.strictEqual(reportInvalidSandbox.valid, false);
    assert.ok(reportInvalidSandbox.errors.some(e => e.includes('AIRA_ALLOW_LOCAL_SANDBOX')));
  });

  test('Environment Validator: Validates file permissions for sensitive env file', () => {
    const templatePath = path.join(REPO_ROOT, 'infrastructure', 'production', 'env.production.worker.template');
    const result = validateEnvFilePermissions(templatePath);
    assert.strictEqual(result.valid, true);

    const nonExistent = validateEnvFilePermissions('/non/existent/path/for/sure.env');
    assert.strictEqual(nonExistent.valid, false);
    assert.match(nonExistent.message, /not found/i);
  });

});
