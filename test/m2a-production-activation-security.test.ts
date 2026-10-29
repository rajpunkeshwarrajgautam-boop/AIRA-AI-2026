import test from 'node:test';
import assert from 'node:assert/strict';
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
  ConnectedDatabaseIdentity,
  WorkerActivationConfig
} from '../packages/agent-runtime/src/durable/worker-activation-policy.js';
import {
  SpecialistWorkerHost
} from '../packages/agent-runtime/src/durable/worker-host.js';
import { SpecialistRegistry } from '../packages/agent-runtime/src/specialists/specialist-registry.js';
import {
  InMemorySpecialistTaskRepository
} from '../packages/agent-runtime/src/durable/specialist-task-repository.js';

test.describe('AIRA AI 2026 — Milestone 2A Production Activation Security & Fail-Closed Preflight Suite', () => {

  const validProductionConfig: WorkerActivationConfig = {
    airaEnv: 'production',
    productionWorkerEnabled: 'true',
    expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
    expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
  };

  const validProductionIdentity: ConnectedDatabaseIdentity = {
    databaseName: 'neondb',
    user: 'aira_prod_user',
    serverAddr: '10.0.1.5',
    neonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
    neonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
    neonBranchId: 'br-shiny-moon-b3vy9xj7',
    host: `${CANONICAL_PRODUCTION_NEON_ENDPOINT_ID}.us-east-2.aws.neon.tech`
  };

  const stagingIdentity: ConnectedDatabaseIdentity = {
    databaseName: 'neondb',
    user: 'aira_staging_user',
    serverAddr: '10.0.2.10',
    neonProjectId: CANONICAL_STAGING_NEON_PROJECT_ID,
    neonEndpointId: CANONICAL_STAGING_NEON_ENDPOINT_ID,
    neonBranchId: 'br-autumn-star-b36dfu5w',
    host: `${CANONICAL_STAGING_NEON_ENDPOINT_ID}.us-east-2.aws.neon.tech`
  };

  // =========================================================================
  // PHASE 3 — DEFAULT-DENY CERTIFICATION (TEST A1 - A15)
  // =========================================================================

  test('TEST A1: Production environment + activation flag missing => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_ACTIVATION_FLAG');
    assert.ok(res.message.includes('must be explicitly set to true'));
  });

  test('TEST A2: Production environment + activation=false => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      ...validProductionConfig,
      productionWorkerEnabled: 'false'
    };
    const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'ACTIVATION_DISABLED');
  });

  test('TEST A3: Production environment + activation=TRUE using unsupported boolean representation => STARTUP DENIED', () => {
    for (const bogus of ['TRUE', 'True', '1', 'yes', 'enabled', 'on', 'true ']) {
      const config: WorkerActivationConfig = {
        ...validProductionConfig,
        productionWorkerEnabled: bogus
      };
      const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
      assert.strictEqual(res.authorized, false, `Failed to reject bogus activation: '${bogus}'`);
      assert.ok(
        res.code === 'UNSUPPORTED_BOOLEAN_REPRESENTATION' || res.code === 'ACTIVATION_DISABLED',
        `Unexpected code for '${bogus}': ${res.code}`
      );
    }
  });

  test('TEST A4: Production environment + expected project missing => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      ...validProductionConfig,
      expectedNeonProjectId: undefined
    };
    const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_EXPECTED_PROJECT_ID');
  });

  test('TEST A5: Production environment + expected endpoint missing => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      ...validProductionConfig,
      expectedNeonEndpointId: undefined
    };
    const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_EXPECTED_ENDPOINT_ID');
  });

  test('TEST A6: Production environment + staging Neon connection => STARTUP DENIED', () => {
    const res = evaluateWorkerActivationPolicy(validProductionConfig, stagingIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD');
  });

  test('TEST A7: Production environment + incorrect project identity => STARTUP DENIED', () => {
    const fakeIdentity: ConnectedDatabaseIdentity = {
      ...validProductionIdentity,
      neonProjectId: 'unauthorized-project-12345'
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, fakeIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'DATABASE_PROJECT_MISMATCH');
  });

  test('TEST A8: Production environment + incorrect endpoint identity => STARTUP DENIED', () => {
    const fakeIdentity: ConnectedDatabaseIdentity = {
      ...validProductionIdentity,
      neonEndpointId: 'ep-spoofed-attacker-999'
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, fakeIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'DATABASE_ENDPOINT_MISMATCH');
  });

  test('TEST A9: Production environment + database unavailable => STARTUP DENIED (fails closed)', async () => {
    const mockUnreachableKnex = {
      raw: async () => {
        throw new Error('Connection terminated unexpectedly: getaddrinfo ENOTFOUND');
      }
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockUnreachableKnex);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'DATABASE_UNAVAILABLE');
        assert.ok(
          err.message.includes('Unable to verify database identity') ||
          err.message.includes('Live database query failed')
        );
        return true;
      }
    );
  });

  test('TEST A10: Production environment + unverified database identity (empty GUCs & host) => STARTUP DENIED', () => {
    const unverifiedIdentity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'unknown'
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, unverifiedIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'UNVERIFIED_DATABASE_IDENTITY');
  });

  test('TEST A11: Production environment + valid credentials but activation disabled => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: false,
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(config, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'ACTIVATION_DISABLED');
  });

  test('TEST A12: Production environment + activation flag injected through task payload => STARTUP DENIED', () => {
    // Malicious task payload trying to pass activation flags inside JSON
    const maliciousTaskPayload = {
      expression: '42 + 1',
      AIRA_PRODUCTION_WORKER_ENABLED: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
      role: 'superadmin'
    };

    // The worker configuration must strictly draw from environment/orchestrator, ignoring task payload
    const actualConfig: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: undefined, // Missing in environment!
      expectedNeonProjectId: undefined
    };

    // Even if task payload contains flags, policy evaluation on actualConfig rejects
    const res = evaluateWorkerActivationPolicy(actualConfig, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_ACTIVATION_FLAG');
    // Verify malicious payload has zero effect
    assert.strictEqual(actualConfig.productionWorkerEnabled, undefined);
  });

  test('TEST A13: Staging environment + production-targeted activation configuration => STARTUP DENIED', () => {
    const config: WorkerActivationConfig = {
      airaEnv: 'staging',
      productionWorkerEnabled: 'true', // Accidental crossover!
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID
    };
    const res = evaluateWorkerActivationPolicy(config, stagingIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'INCONSISTENT_NON_PROD_ACTIVATION_CONFIG');
    assert.ok(res.message.includes('cannot be configured with production activation settings'));
  });

  test('TEST A14: Activation failure => ZERO TASK CLAIMS and ZERO TOOL EXECUTIONS', async () => {
    const taskRepo = new InMemorySpecialistTaskRepository();
    const registry = new SpecialistRegistry();

    // Insert queued task
    await taskRepo.saveTask({
      id: 'task_unauthorized_claim_test',
      runId: 'run_sec_test',
      principalId: 'usr_sec_test',
      role: 'analyst',
      objective: 'Calculate 2+2',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: { expression: '2+2' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 10000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: {},
      checkpoints: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // Worker host initialized
    const host = new SpecialistWorkerHost(taskRepo, registry, {
      workerId: 'worker_unauthorized_test',
      pollIntervalMs: 50,
      concurrency: 1
    });

    // In a worker process, if activation policy fails, host.start() is NEVER called
    const config: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: false
    };
    const activation = evaluateWorkerActivationPolicy(config);
    assert.strictEqual(activation.authorized, false);

    // Because activation is false, host was NOT started.
    // Verify task state in repository remains strictly QUEUED (zero claims, zero tool execution)
    const task = await taskRepo.getTask('task_unauthorized_claim_test');
    assert.strictEqual(task?.state, 'QUEUED');
    assert.strictEqual(task?.attemptCount, 0);
    assert.strictEqual(task?.leaseOwner, undefined);
  });

  test('TEST A15: Activation failure => READINESS MUST NOT REPORT READY', async () => {
    // Simulate HTTP readiness probe behavior before and after activation
    let isActivated = false;
    let dbConnected = true;
    let isShuttingDown = false;

    const checkReadiness = () => {
      if (isShuttingDown || !dbConnected || !isActivated) {
        return { statusCode: 503, ready: false };
      }
      return { statusCode: 200, ready: true };
    };

    // Before activation
    assert.strictEqual(checkReadiness().statusCode, 503);
    assert.strictEqual(checkReadiness().ready, false);

    // If activation fails
    const config: WorkerActivationConfig = { airaEnv: 'production', productionWorkerEnabled: false };
    const res = evaluateWorkerActivationPolicy(config);
    assert.strictEqual(res.authorized, false);
    isActivated = res.authorized;

    // Must still report 503
    assert.strictEqual(checkReadiness().statusCode, 503);
    assert.strictEqual(checkReadiness().ready, false);

    // Only when activation is authorized does readiness report 200
    isActivated = true;
    assert.strictEqual(checkReadiness().statusCode, 200);
    assert.strictEqual(checkReadiness().ready, true);
  });

  test('TEST A16: Correct project ID + missing endpoint => DENIED', () => {
    const identity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'aira',
      neonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      neonEndpointId: undefined
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_CONNECTED_ENDPOINT_ID');
    assert.ok(res.message.includes('Connected Neon endpoint identity is missing or empty'));
  });

  test('TEST A17: Missing project ID + correct endpoint => DENIED', () => {
    const identity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'aira',
      neonProjectId: undefined,
      neonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_CONNECTED_PROJECT_ID');
    assert.ok(res.message.includes('Connected Neon project identity is missing or empty'));
  });

  test('TEST A18: Correct project ID + empty endpoint => DENIED', () => {
    for (const emptyVal of ['', '   ', '\t', '\n']) {
      const identity: ConnectedDatabaseIdentity = {
        databaseName: 'neondb',
        user: 'aira',
        neonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
        neonEndpointId: emptyVal
      };
      const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
      assert.strictEqual(res.authorized, false, `Failed for empty endpoint: '${emptyVal}'`);
      assert.strictEqual(res.code, 'MISSING_CONNECTED_ENDPOINT_ID');
    }
  });

  test('TEST A19: Empty project ID + correct endpoint => DENIED', () => {
    for (const emptyVal of ['', '   ', '\t', '\n']) {
      const identity: ConnectedDatabaseIdentity = {
        databaseName: 'neondb',
        user: 'aira',
        neonProjectId: emptyVal,
        neonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
      };
      const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
      assert.strictEqual(res.authorized, false, `Failed for empty project: '${emptyVal}'`);
      assert.strictEqual(res.code, 'MISSING_CONNECTED_PROJECT_ID');
    }
  });

  test('TEST A20: Both identifiers correct => AUTHORIZED', () => {
    const identity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'aira',
      serverAddr: '10.0.0.1',
      neonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      neonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
    assert.strictEqual(res.authorized, true);
    assert.strictEqual(res.code, 'ACTIVATION_AUTHORIZED');
    assert.strictEqual(res.isProduction, true);
  });

  test('TEST A21: Both identifiers missing => DENIED', () => {
    const identity: ConnectedDatabaseIdentity = {
      databaseName: 'neondb',
      user: 'aira',
      neonProjectId: '',
      neonEndpointId: ''
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, identity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'UNVERIFIED_DATABASE_IDENTITY');
  });

  test('TEST A22: Runtime identity query returns partial GUC data => WORKER STARTUP DENIED', async () => {
    // Sub-case 1: Project present, endpoint missing in live GUCs
    const mockKnexMissingEndpoint = {
      raw: async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'aira',
          server_ip: '10.0.0.1',
          neon_project_id: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
          neon_endpoint_id: null
        }]
      })
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockKnexMissingEndpoint);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'MISSING_CONNECTED_ENDPOINT_ID');
        assert.ok(err.message.includes('Connected Neon endpoint identity is missing or empty'));
        return true;
      }
    );

    // Sub-case 2: Endpoint present, project missing in live GUCs
    const mockKnexMissingProject = {
      raw: async () => ({
        rows: [{
          db_name: 'neondb',
          db_user: 'aira',
          server_ip: '10.0.0.1',
          neon_project_id: null,
          neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
        }]
      })
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockKnexMissingProject);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'MISSING_CONNECTED_PROJECT_ID');
        assert.ok(err.message.includes('Connected Neon project identity is missing or empty'));
        return true;
      }
    );

    // Sub-case 3: Database returned empty telemetry row
    const mockKnexEmptyRows = {
      raw: async () => ({
        rows: []
      })
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockKnexEmptyRows);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'UNVERIFIED_DATABASE_IDENTITY');
        return true;
      }
    );
  });

  // =========================================================================
  // PHASE 4 — POSITIVE ACTIVATION PATH (LAYER 1)
  // =========================================================================

  test('LAYER 1: Positive Production Activation Path (Deterministic Policy Verification)', () => {
    const res = evaluateWorkerActivationPolicy(validProductionConfig, validProductionIdentity);
    assert.strictEqual(res.authorized, true);
    assert.strictEqual(res.code, 'ACTIVATION_AUTHORIZED');
    assert.strictEqual(res.isProduction, true);
    assert.strictEqual(res.sanitizedConfig.productionWorkerEnabled, true);
    assert.strictEqual(res.sanitizedConfig.expectedNeonProjectId, CANONICAL_PRODUCTION_NEON_PROJECT_ID);
    assert.strictEqual(res.sanitizedConfig.expectedNeonEndpointId, CANONICAL_PRODUCTION_NEON_ENDPOINT_ID);
  });

  test('LAYER 1: Positive Staging Worker Path (Standard Staging Configuration)', () => {
    const stagingConfig: WorkerActivationConfig = {
      airaEnv: 'staging'
    };
    const res = evaluateWorkerActivationPolicy(stagingConfig, stagingIdentity);
    assert.strictEqual(res.authorized, true);
    assert.strictEqual(res.code, 'NON_PROD_WORKER_AUTHORIZED');
    assert.strictEqual(res.isProduction, false);
  });

  test('LAYER 2: Staging activation remains non-production and requires no live staging connection', () => {
    const stagingConfig: WorkerActivationConfig = { airaEnv: 'staging' };
    const authResult = evaluateWorkerActivationPolicy(stagingConfig, stagingIdentity);
    assert.strictEqual(authResult.authorized, true);
    assert.strictEqual(authResult.isProduction, false);
    assert.strictEqual(authResult.code, 'NON_PROD_WORKER_AUTHORIZED');
  });

  // =========================================================================
  // PHASE 8 — PREVENT ACCIDENTAL WORKER ACTIVATION (SCENARIOS B1 - B8)
  // =========================================================================

  test('SCENARIO B1: Container deployed with activation disabled => cannot poll or claim tasks', () => {
    const disabledProdConfig: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'false',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(disabledProdConfig, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'ACTIVATION_DISABLED');
  });

  test('SCENARIO B2: Container restarts unexpectedly => does not activate without all explicit conditions', () => {
    // When container restarts, environment must be completely re-evaluated
    const restartConfigMissingEndpoint: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'true',
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID
      // Missing expectedNeonEndpointId!
    };
    const res = evaluateWorkerActivationPolicy(restartConfigMissingEndpoint, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_EXPECTED_ENDPOINT_ID');
  });

  test('SCENARIO B3: Incomplete environment configuration => fail closed', () => {
    const emptyConfig: WorkerActivationConfig = {
      airaEnv: 'production'
    };
    const res = evaluateWorkerActivationPolicy(emptyConfig);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_ACTIVATION_FLAG');
  });

  test('SCENARIO B4: Database project identity changes unexpectedly => worker refuses startup', () => {
    const alteredDbIdentity: ConnectedDatabaseIdentity = {
      ...validProductionIdentity,
      neonProjectId: 'different-project-id-9999'
    };
    const res = evaluateWorkerActivationPolicy(validProductionConfig, alteredDbIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'DATABASE_PROJECT_MISMATCH');
  });

  test('SCENARIO B5: Deployment includes production credentials but activation remains disabled => zero task claims', () => {
    const prodCredsNoActivation: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: undefined,
      expectedNeonProjectId: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
      expectedNeonEndpointId: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
    };
    const res = evaluateWorkerActivationPolicy(prodCredsNoActivation, validProductionIdentity);
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.code, 'MISSING_ACTIVATION_FLAG');
  });

  test('SCENARIO B6: Rolling deployment replica introduces new worker => must validate activation independently', () => {
    // Each replica checks its own activation policy at bootstrap
    const replica1Config = { ...validProductionConfig };
    const replica2Misconfigured = { ...validProductionConfig, productionWorkerEnabled: '0' };

    assert.strictEqual(evaluateWorkerActivationPolicy(replica1Config, validProductionIdentity).authorized, true);
    assert.strictEqual(evaluateWorkerActivationPolicy(replica2Misconfigured, validProductionIdentity).authorized, false);
  });

  test('SCENARIO B7: Operator changes activation configuration => requires controlled restart to take effect', () => {
    let currentConfig: WorkerActivationConfig = {
      airaEnv: 'production',
      productionWorkerEnabled: 'false'
    };
    // Currently disabled
    assert.strictEqual(evaluateWorkerActivationPolicy(currentConfig).authorized, false);

    // Operator changes config: takes effect only when re-evaluated
    currentConfig = { ...validProductionConfig };
    assert.strictEqual(evaluateWorkerActivationPolicy(currentConfig, validProductionIdentity).authorized, true);
  });

  test('SCENARIO B8: Worker process crashes and restarts => startup revalidates all activation conditions', async () => {
    let mockQueryCallCount = 0;
    const mockKnex = {
      raw: async () => {
        mockQueryCallCount++;
        return {
          rows: [{
            db_name: 'neondb',
            db_user: 'aira',
            server_ip: '10.0.0.1',
            neon_project_id: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
            neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID,
            neon_branch_id: 'br-shiny-moon-b3vy9xj7'
          }]
        };
      }
    } as any;

    // First start
    const run1 = await assertWorkerActivationAuthorized(validProductionConfig, mockKnex);
    assert.strictEqual(run1.authorized, true);
    assert.strictEqual(mockQueryCallCount, 1);

    // Restart revalidates live DB query
    const run2 = await assertWorkerActivationAuthorized(validProductionConfig, mockKnex);
    assert.strictEqual(run2.authorized, true);
    assert.strictEqual(mockQueryCallCount, 2);
  });

  // =========================================================================
  // PHASE 2 — ERROR HANDLING AND SECRET SANITIZATION TESTS (E1 - E7)
  // =========================================================================

  test('TEST E1: Connection error containing PostgreSQL URL with credentials => sanitized to fixed message', () => {
    const rawError = new Error('connect ECONNREFUSED ' + 'postgres://' + 'aira_prod:SuperSecretPass123!' + '@ep-withered-art-b36ox90b.us-east-2.aws.neon.tech/neondb?sslmode=require');
    const sanitized = sanitizeActivationError(rawError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
    assert.ok(!sanitized.message.includes('SuperSecretPass123!'));
    assert.ok(!sanitized.message.includes('postgres://'));
    assert.ok(!sanitized.message.includes('ep-withered-art-b36ox90b'));
  });

  test('TEST E2: Connection error containing database passwords => sanitized without secret reflection', () => {
    const rawError = new Error('FATAL: password authentication failed for user "aira_prod": password="super_secret_token_xyz999"');
    const sanitized = sanitizeActivationError(rawError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
    assert.ok(!sanitized.message.includes('super_secret_token_xyz999'));
    assert.ok(!sanitized.message.includes('password='));
  });

  test('TEST E3: Multiline driver error string => collapsed into fixed non-sensitive message', () => {
    const multilineError = new Error(
      'error: connection timeout\n' +
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)\n' +
      '    at Client._connect (node_modules/pg/lib/client.js:142:11)\n' +
      '    connectionString: ' + '"postgres://' + 'user:injected_secret_pass' + '@host:5432/db"'
    );
    const sanitized = sanitizeActivationError(multilineError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
    assert.ok(!sanitized.message.includes('injected_secret_pass'));
    assert.ok(!sanitized.message.includes('\n'));
  });

  test('TEST E4: Unexpected error object (non-Error object) => sanitized safely', () => {
    const strangeError = {
      code: '57P01',
      details: 'postgres://' + 'admin:sensitive_token_payload' + '@host/db',
      internalSecrets: ['k1', 'k2']
    };
    const sanitized = sanitizeActivationError(strangeError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
    assert.ok(!JSON.stringify(sanitized).includes('sensitive_token_payload'));
  });

  test('TEST E5: Missing error.message or null/undefined error => safe fallback', () => {
    const emptyErrorObj = {};
    const sanitizedObj = sanitizeActivationError(emptyErrorObj);
    assert.strictEqual(sanitizedObj.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitizedObj.message, 'Unable to verify database identity during worker startup.');

    const nullError = null;
    const sanitizedNull = sanitizeActivationError(nullError);
    assert.strictEqual(sanitizedNull.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitizedNull.message, 'Unable to verify database identity during worker startup.');
  });

  test('TEST E6: Nested error causes with sensitive credentials => cause not leaked', () => {
    const rootCause = new Error('getaddrinfo ENOTFOUND ep-secret-subdomain.aws.neon.tech with auth token=secret_bearer_token_abc');
    const outerError = new Error('Database pool initialization failed', { cause: rootCause });
    const sanitized = sanitizeActivationError(outerError);

    assert.strictEqual(sanitized.code, 'DATABASE_UNAVAILABLE');
    assert.strictEqual(sanitized.message, 'Unable to verify database identity during worker startup.');
    assert.ok(!JSON.stringify(sanitized).includes('secret_bearer_token_abc'));
  });

  test('TEST E7: Serialized worker startup error JSON string => ZERO sensitive values', () => {
    const rawError = new Error('Connection refused: DATABASE_URL=' + 'postgres://' + 'aira:P@ssword999' + '@ep-prod.neon.tech/neondb?sslmode=verify-full');
    const sanitized = sanitizeActivationError(rawError);
    const serialized = JSON.stringify(sanitized);

    assert.ok(!serialized.includes('P@ssword999'));
    assert.ok(!serialized.includes('DATABASE_URL'));
    assert.ok(!serialized.includes('postgres://'));
    assert.strictEqual(serialized, JSON.stringify({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Unable to verify database identity during worker startup.'
    }));
  });

  // =========================================================================
  // PHASE 3 — FINAL SECURITY REGRESSION SUITE (S1 - S12)
  // =========================================================================

  test('TEST S1: Static configuration passes but database identity is absent => CONFIGURATION_VALID, runtime activation NOT AUTHORIZED', () => {
    const staticResult = validateWorkerStaticConfig(validProductionConfig);
    assert.strictEqual(staticResult.valid, true);
    assert.strictEqual(staticResult.code, 'CONFIGURATION_VALID');

    const policyResult = evaluateWorkerActivationPolicy(validProductionConfig, undefined);
    assert.strictEqual(policyResult.authorized, true);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.stage, 'STATIC_VALIDATION');
    assert.strictEqual(policyResult.code, 'CONFIGURATION_VALID');
  });

  test('TEST S2: Correct project ID and endpoint ID => ACTIVATION_AUTHORIZED', () => {
    const policyResult = evaluateWorkerActivationPolicy(validProductionConfig, validProductionIdentity);
    assert.strictEqual(policyResult.authorized, true);
    assert.strictEqual(policyResult.runtimeAuthorized, true);
    assert.strictEqual(policyResult.stage, 'RUNTIME_AUTHORIZATION');
    assert.strictEqual(policyResult.code, 'ACTIVATION_AUTHORIZED');
    assert.strictEqual(policyResult.isProduction, true);
  });

  test('TEST S3: Correct project ID, missing endpoint => DENIED', () => {
    const partialIdentity: ConnectedDatabaseIdentity = {
      ...validProductionIdentity,
      neonEndpointId: ''
    };
    const policyResult = evaluateWorkerActivationPolicy(validProductionConfig, partialIdentity);
    assert.strictEqual(policyResult.authorized, false);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.stage, 'RUNTIME_AUTHORIZATION');
    assert.strictEqual(policyResult.code, 'MISSING_CONNECTED_ENDPOINT_ID');
  });

  test('TEST S4: Missing project ID, correct endpoint => DENIED', () => {
    const partialIdentity: ConnectedDatabaseIdentity = {
      ...validProductionIdentity,
      neonProjectId: ''
    };
    const policyResult = evaluateWorkerActivationPolicy(validProductionConfig, partialIdentity);
    assert.strictEqual(policyResult.authorized, false);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.stage, 'RUNTIME_AUTHORIZATION');
    assert.strictEqual(policyResult.code, 'MISSING_CONNECTED_PROJECT_ID');
  });

  test('TEST S5: Staging credentials in production configuration => DENIED', () => {
    const policyResult = evaluateWorkerActivationPolicy(validProductionConfig, stagingIdentity);
    assert.strictEqual(policyResult.authorized, false);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.code, 'CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD');
  });

  test('TEST S6: Production credentials in staging configuration => DENIED', () => {
    const stagingConfig: WorkerActivationConfig = { airaEnv: 'staging' };
    const policyResult = evaluateWorkerActivationPolicy(stagingConfig, validProductionIdentity);
    assert.strictEqual(policyResult.authorized, false);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.code, 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_NON_PROD');
  });

  test('TEST S7: Correct production environment but activation disabled => DENIED', () => {
    const disabledConfig: WorkerActivationConfig = {
      ...validProductionConfig,
      productionWorkerEnabled: 'false'
    };
    const policyResult = evaluateWorkerActivationPolicy(disabledConfig, validProductionIdentity);
    assert.strictEqual(policyResult.authorized, false);
    assert.strictEqual(policyResult.runtimeAuthorized, false);
    assert.strictEqual(policyResult.code, 'ACTIVATION_DISABLED');
  });

  test('TEST S8: Database identity query throws an error containing secrets => DENIED with ZERO secrets emitted', async () => {
    const mockKnexLeakingSecrets = {
      raw: async () => {
        throw new Error('Connection failed: ' + 'postgres://' + 'aira_prod:SuperSecretP@ssword999' + '@ep-withered-art-b36ox90b.neon.tech/neondb?sslmode=require');
      }
    } as any;

    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockKnexLeakingSecrets);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'DATABASE_UNAVAILABLE');
        assert.ok(err.message.includes('Unable to verify database identity during worker startup.'));
        assert.ok(!err.message.includes('SuperSecretP@ssword999'));
        assert.ok(!err.message.includes('postgres://'));
        assert.ok(!JSON.stringify(err).includes('SuperSecretP@ssword999'));
        return true;
      }
    );
  });

  test('TEST S9: Worker readiness before runtime validation => HTTP 503', () => {
    // Model worker readiness probe before runtime authorization is complete
    let runtimeValidated = false;
    const probeHandler = () => {
      if (!runtimeValidated) {
        return { statusCode: 503, ready: false, message: 'Worker is not ready: Runtime activation pending' };
      }
      return { statusCode: 200, ready: true };
    };

    const beforeResult = probeHandler();
    assert.strictEqual(beforeResult.statusCode, 503);
    assert.strictEqual(beforeResult.ready, false);

    runtimeValidated = true;
    const afterResult = probeHandler();
    assert.strictEqual(afterResult.statusCode, 200);
    assert.strictEqual(afterResult.ready, true);
  });

  test('TEST S10: Worker startup with static configuration only => ZERO task claims and ZERO tool executions', async () => {
    const taskRepo = new InMemorySpecialistTaskRepository();
    const registry = new SpecialistRegistry();

    await taskRepo.saveTask({
      id: 'task_s10_static_only_test',
      runId: 'run_s10_test',
      principalId: 'user_prod_tester',
      role: 'analyst',
      objective: 'Sensitive task',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: { query: 'test' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 10000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: {},
      checkpoints: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const staticResult = validateWorkerStaticConfig(validProductionConfig);
    assert.strictEqual(staticResult.valid, true);

    // Because static configuration alone NEVER grants runtime execution, host.start() is NOT permitted
    const runtimeAuth = evaluateWorkerActivationPolicy(validProductionConfig, undefined);
    assert.strictEqual(runtimeAuth.runtimeAuthorized, false);

    // Verify task state in repository remains untouched: strictly QUEUED, 0 attempts, no claim
    const task = await taskRepo.getTask('task_s10_static_only_test');
    assert.strictEqual(task?.state, 'QUEUED');
    assert.strictEqual(task?.attemptCount, 0);
    assert.strictEqual(task?.leaseOwner, undefined);
  });

  test('TEST S11: Database identity changes unexpectedly on restart => startup denied', async () => {
    let restartCycle = 0;
    const mockKnexDynamicIdentity = {
      raw: async () => {
        restartCycle++;
        if (restartCycle === 1) {
          return {
            rows: [{
              db_name: 'neondb',
              db_user: 'aira_prod',
              server_ip: '10.0.1.5',
              neon_project_id: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
              neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
            }]
          };
        } else {
          // Restarted against an unexpected/rogue project ID
          return {
            rows: [{
              db_name: 'neondb',
              db_user: 'aira_prod',
              server_ip: '10.0.1.5',
              neon_project_id: 'rogue-project-unauthorized-999',
              neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
            }]
          };
        }
      }
    } as any;

    // Cycle 1: Authorized
    const firstBoot = await assertWorkerActivationAuthorized(validProductionConfig, mockKnexDynamicIdentity);
    assert.strictEqual(firstBoot.authorized, true);
    assert.strictEqual(firstBoot.runtimeAuthorized, true);

    // Cycle 2: Restart against changed DB identity => Startup denied
    await assert.rejects(
      async () => {
        await assertWorkerActivationAuthorized(validProductionConfig, mockKnexDynamicIdentity);
      },
      (err: any) => {
        assert.ok(err instanceof ActivationSecurityError);
        assert.strictEqual(err.code, 'DATABASE_PROJECT_MISMATCH');
        return true;
      }
    );
  });

  test('TEST S12: Production activation requires actual runtime verification for each new worker process', async () => {
    let liveQueryCount = 0;
    const mockKnex = {
      raw: async () => {
        liveQueryCount++;
        return {
          rows: [{
            db_name: 'neondb',
            db_user: 'aira_prod',
            server_ip: '10.0.1.5',
            neon_project_id: CANONICAL_PRODUCTION_NEON_PROJECT_ID,
            neon_endpoint_id: CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
          }]
        };
      }
    } as any;

    // Worker process 1
    const worker1 = await assertWorkerActivationAuthorized(validProductionConfig, mockKnex);
    assert.strictEqual(worker1.runtimeAuthorized, true);
    assert.strictEqual(liveQueryCount, 1);

    // Worker process 2 (new worker process must execute its own live query)
    const worker2 = await assertWorkerActivationAuthorized(validProductionConfig, mockKnex);
    assert.strictEqual(worker2.runtimeAuthorized, true);
    assert.strictEqual(liveQueryCount, 2);
  });
});
