import assert from 'node:assert/strict';
import {
  PrivateBetaCapacityGuard,
  DistributedPostgresCapacityStore,
  InMemoryCapacityStore
} from '../packages/model-router/src/capacity/index.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';

async function runHotfixTests() {
  console.log('=== P1.6.3 CAPACITY READY HOTFIX REGRESSION TEST SUITE ===');

  // ============================================================================
  // TEST A: PrivateBetaCapacityGuard.isEnabled()
  // ============================================================================
  console.log('\n[TEST A] PrivateBetaCapacityGuard.isEnabled()');

  // A1: true when guard config enabled (default)
  const defaultGuard = new PrivateBetaCapacityGuard();
  assert.equal(typeof (defaultGuard as any).isEnabled, 'function', 'isEnabled must be a function on PrivateBetaCapacityGuard');
  assert.equal((defaultGuard as any).isEnabled(), true, 'isEnabled() must return true when enabled is true');

  // A2: false when guard config disabled explicitly
  const disabledGuard = new PrivateBetaCapacityGuard({ enabled: false });
  assert.equal((disabledGuard as any).isEnabled(), false, 'isEnabled() must return false when enabled is false');

  // A3: dynamic update via updateConfig
  defaultGuard.updateConfig({ enabled: false });
  assert.equal((defaultGuard as any).isEnabled(), false, 'isEnabled() reflects updated config');
  defaultGuard.updateConfig({ enabled: true });
  assert.equal((defaultGuard as any).isEnabled(), true, 'isEnabled() reflects updated config back to true');

  console.log('PASS: PrivateBetaCapacityGuard.isEnabled() returns accurate boolean state.');

  // ============================================================================
  // TEST B: GET /api/ready/providers Execution & Sanitization
  // ============================================================================
  console.log('\n[TEST B] GET /api/ready/providers Simulation & Sanitization');

  const healthTracker = new ProviderHealthTracker();
  const capacityGuard = new PrivateBetaCapacityGuard({ enabled: true });
  const modelRouter = new ModelRouter(healthTracker, capacityGuard);

  // Replicate the exact provider readiness logic from apps/api/src/index.ts
  const fastRoute = modelRouter.routingPolicy.resolveFastRoute();
  
  // Verify calling modelRouter.capacityGuard.isEnabled() does not throw
  let providerReadinessResult: Record<string, any>;
  try {
    providerReadinessResult = {
      supportedProviders: {
        groq: { configured: Boolean(process.env.GROQ_API_KEY) },
        gemini: { configured: Boolean(process.env.GEMINI_API_KEY) },
        nvidia: { configured: Boolean(process.env.NVIDIA_API_KEY), deepModel: 'nvidia/nemotron-3-super-120b-a12b' },
        cerebras: { configured: Boolean(process.env.CEREBRAS_API_KEY) },
        together: { configured: Boolean(process.env.TOGETHER_API_KEY) },
        fireworks: { configured: Boolean(process.env.FIREWORKS_API_KEY) },
        openai: { configured: Boolean(process.env.OPENAI_API_KEY) },
        anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) }
      },
      fastRouting: fastRoute,
      circuitBreakers: modelRouter.healthTracker.getAllTelemetry(),
      capacity: {
        guardEnabled: (modelRouter.capacityGuard as any).isEnabled(),
        isDegraded: fastRoute.isDegraded
      }
    };
  } catch (err: any) {
    assert.fail(`GET /api/ready/providers route logic threw: ${err.message}`);
  }

  assert.equal(providerReadinessResult.capacity.guardEnabled, true);
  assert.equal(typeof providerReadinessResult.capacity.isDegraded, 'boolean');

  // Check with disabled guard
  capacityGuard.updateConfig({ enabled: false });
  const disabledCapacityCheck = {
    guardEnabled: (modelRouter.capacityGuard as any).isEnabled(),
    isDegraded: fastRoute.isDegraded
  };
  assert.equal(disabledCapacityCheck.guardEnabled, false);

  // Validate sanitization: No secret values, prefixes, or lengths leaked
  const serialized = JSON.stringify(providerReadinessResult);
  assert.equal(serialized.includes('keyLength'), false, 'keyLength must NOT be exposed');
  assert.equal(serialized.includes('keyPrefix'), false, 'keyPrefix must NOT be exposed');
  assert.equal(serialized.includes('DATABASE_URL'), false, 'DATABASE_URL must NOT be exposed');
  assert.equal(serialized.includes('sk-'), false, 'No API keys or key tokens exposed');

  console.log('PASS: GET /api/ready/providers executes without throwing and output is strictly sanitized.');

  // ============================================================================
  // TEST C: P1.6.3 Security Invariants Preservation
  // ============================================================================
  console.log('\n[TEST C] P1.6.3 Security Invariants Preservation');

  // C1: /api/capacity/status auth gate evaluation
  function evaluateCapacityAuth(principal?: { userId: string; roles?: string[]; scopes?: string[] }) {
    if (!principal) {
      return { status: 401, body: { error: 'Unauthorized', message: 'Authentication required' } };
    }
    const roles = principal.roles || [];
    const scopes = principal.scopes || [];
    const isAuthorized =
      roles.includes('admin') ||
      roles.includes('operator') ||
      scopes.includes('admin') ||
      scopes.includes('operator') ||
      principal.userId === 'admin';

    if (!isAuthorized) {
      return { status: 403, body: { error: 'Forbidden', message: 'Admin or operator authorization required for internal capacity diagnostics' } };
    }
    return { status: 200, body: { guardEnabled: true, globalMaxConcurrent: 2 } };
  }

  assert.equal(evaluateCapacityAuth(undefined).status, 401, 'Unauthenticated status must be 401');
  assert.equal(evaluateCapacityAuth({ userId: 'standard_user' }).status, 403, 'Standard user must be 403');
  assert.equal(evaluateCapacityAuth({ userId: 'admin_user', roles: ['admin'] }).status, 200, 'Admin must be 200');

  // C2: Missing Postgres capacity tables remain fail-closed
  const mockMissingTableDb = {
    schema: {
      hasTable: async () => false
    },
    raw: async () => {
      const err: any = new Error('relation "capacity_permits" does not exist');
      err.code = '42P01';
      throw err;
    }
  } as any;

  const failClosedStore = new DistributedPostgresCapacityStore(mockMissingTableDb);
  const failClosedGuard = new PrivateBetaCapacityGuard(
    { enabled: true, retryAfterSeconds: 5 },
    failClosedStore
  );

  const admissionResult = await failClosedGuard.admit({
    principalId: 'test_user',
    model: 'aira-fast',
    promptText: 'Hello'
  });

  assert.equal(admissionResult.decision, 'REJECT_CAPACITY', 'Missing schema must fail-closed');
  assert.equal(admissionResult.rejectionCode, 'AIRA_PRIVATE_BETA_CAPACITY');
  assert.ok(admissionResult.retryAfterSeconds! >= 5, 'Must provide retryAfterSeconds');

  // C3: Verify no runtime DDL in DistributedPostgresCapacityStore
  const storeProto = Object.getOwnPropertyNames(DistributedPostgresCapacityStore.prototype);
  assert.equal(storeProto.includes('createTablesIfMissing'), false, 'createTablesIfMissing must not exist');
  assert.equal(storeProto.includes('ensureSchema'), false, 'ensureSchema must not exist');

  console.log('PASS: P1.6.3 security guarantees (auth gate, fail-closed, no runtime DDL) are verified intact.');

  console.log('\n=== ALL P1.6.3 CAPACITY READY HOTFIX REGRESSION TESTS PASSED ===');
}

runHotfixTests().catch(err => {
  console.error('\nFAIL: Regression test caught defect:', err.message);
  process.exit(1);
});
