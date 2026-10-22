/**
 * AIRA AI 2026 — Permanent Staging Maintenance Barrier Comprehensive Test Suite
 * 
 * Validates the dual-layer maintenance barrier covering:
 * 1. Database-Level Barrier (PostgreSQL/Neon):
 *    - Sentinel state management and cryptographic token verification.
 *    - Unprivileged write interception (simulating older immutable Vercel deployments).
 *    - Privileged elevation for Knex migrations and historical identity imports.
 *    - Reversibility: clean deactivation and write restoration.
 *    - Strict fail-closed isolation preventing activation on Production.
 * 2. Application-Level Middleware:
 *    - Mutating HTTP methods (POST, PUT, PATCH, DELETE) blocked with HTTP 503.
 *    - Mutating GET endpoints (OAuth callbacks, OAuth start, account linking) blocked.
 *    - Public health probes (/api/health, /api/ready/*) and CORS OPTIONS allowed.
 *    - Read-only GET paths allowed.
 *    - Privileged header bypass with timing-safe token validation.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import {
  activateStagingMaintenance,
  deactivateStagingMaintenance,
  getStagingMaintenanceStatus,
  verifyStagingWriteRestriction,
  hashBypassToken,
  generateBypassToken,
  assertNonProductionTarget,
  STAGING_MAINTENANCE_TABLE,
  STAGING_PROBE_TABLE
} from '../packages/db/src/security/staging-maintenance-barrier.js';
import {
  createStagingMaintenanceMiddleware,
  setStagingMaintenanceState,
  isStagingMaintenanceActive,
  MUTATING_GET_PATHS
} from '../apps/api/src/middleware/staging-maintenance.js';
import {
  verifyStagingWriteIsolation
} from '../scripts/verify-staging-write-isolation.js';

console.log('\n================================================================================');
console.log('   AIRA AI 2026 — PR #96 STAGING MAINTENANCE BARRIER TEST SUITE                 ');
console.log('================================================================================\n');

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(err);
        process.exit(1);
      });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runAll() {
  // ── GROUP 1: Cryptographic Token & Safety Guards ───────────────────────────
  console.log('--- Test Group 1: Cryptographic Tokens & Production Protection ---');

  await test('Generates 64-char hex cryptographically secure token', () => {
    const token = generateBypassToken();
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  await test('Computes deterministic SHA-256 hash of bypass token', () => {
    const token = 'test-token-12345';
    const hash = hashBypassToken(token);
    const expected = crypto.createHash('sha256').update(token).digest('hex');
    assert.equal(hash, expected);
  });

  await test('Strict production check throws [SECURITY FATAL] on production Neon project', async () => {
    const mockProdClient: any = {
      raw: async () => ({
        rows: [{
          db_name: 'neondb',
          neon_project_id: PRODUCTION_NEON_PROJECT_ID,
          neon_branch_id: 'br-shiny-moon-b3vy9xj7'
        }]
      })
    };
    await assert.rejects(
      async () => assertNonProductionTarget(mockProdClient),
      /\[SECURITY FATAL\].*Target database is PRODUCTION/
    );
  });

  await test('Staging maintenance activation aborted if target is Production', async () => {
    const mockProdClient: any = {
      raw: async () => ({
        rows: [{
          db_name: 'neondb',
          neon_project_id: PRODUCTION_NEON_PROJECT_ID
        }]
      })
    };
    await assert.rejects(
      async () => activateStagingMaintenance(mockProdClient, { operator: 'test', reason: 'cutover' }),
      /\[SECURITY FATAL\]/
    );
  });

  // ── GROUP 2: Database Maintenance Barrier Lifecycle ────────────────────────
  console.log('\n--- Test Group 2: Database Maintenance Barrier Lifecycle ---');

  let memoryDbState = {
    sentinelActive: false,
    tokenHash: '',
    defaultReadOnly: false,
    triggers: new Set<string>()
  };

  const createMockDbClient = () => {
    const rawHandler = async (sql: string, params?: any) => {
      const s = sql.trim();

      if (s.includes('neon.project_id')) {
        return {
          rows: [{
            db_name: 'neondb',
            default_ro: memoryDbState.defaultReadOnly ? 'on' : 'off',
            neon_project_id: STAGING_NEON_PROJECT_ID,
            neon_branch_id: STAGING_NEON_BRANCH_ID
          }]
        };
      }

      if (s.includes('current_database()')) {
        return { rows: [{ db_name: 'neondb' }] };
      }

      if (s.includes(`CREATE TABLE IF NOT EXISTS ${STAGING_MAINTENANCE_TABLE}`)) {
        return { rows: [] };
      }

      if (s.includes(`INSERT INTO ${STAGING_MAINTENANCE_TABLE}`)) {
        memoryDbState.sentinelActive = true;
        memoryDbState.tokenHash = params?.tokenHash || 'dummy_hash';
        return { rows: [] };
      }

      if (/SELECT\s+tablename\s+FROM\s+pg_tables/i.test(s)) {
        return {
          rows: [
            { tablename: 'conversations' },
            { tablename: 'conversation_messages' },
            { tablename: 'runs' },
            { tablename: 'agents' }
          ]
        };
      }

      if (s.includes('CREATE TRIGGER')) {
        const match = s.match(/ON "([^"]+)"|ON ([_a-zA-Z0-9]+)/);
        const tbl = match ? (match[1] || match[2]) : 'unknown';
        memoryDbState.triggers.add(tbl);
        return { rows: [] };
      }

      if (s.includes('ALTER DATABASE') && s.includes('default_transaction_read_only = on')) {
        memoryDbState.defaultReadOnly = true;
        return { rows: [] };
      }

      if (s.includes('ALTER DATABASE') && s.includes('default_transaction_read_only = off')) {
        memoryDbState.defaultReadOnly = false;
        return { rows: [] };
      }

      if (s.includes(`UPDATE ${STAGING_MAINTENANCE_TABLE}`) && s.includes('is_active = false')) {
        memoryDbState.sentinelActive = false;
        return { rows: [] };
      }

      if (s.includes('DROP TRIGGER')) {
        return { rows: [] };
      }

      if (s.includes(STAGING_MAINTENANCE_TABLE) && /SELECT.*is_active/is.test(s)) {
        if (!memoryDbState.sentinelActive) return { rows: [] };
        return {
          rows: [{
            is_active: memoryDbState.sentinelActive,
            activated_at: '2026-10-22T00:00:00Z',
            activated_by: 'rajpunkeshwarrajgautam-boop',
            reason: 'PR #96 staging release cutover',
            bypass_token_hash: memoryDbState.tokenHash
          }]
        };
      }

      if (s.includes('default_transaction_read_only')) {
        return {
          rows: [{
            db_name: 'neondb',
            default_ro: memoryDbState.defaultReadOnly ? 'on' : 'off',
            project_id: STAGING_NEON_PROJECT_ID,
            branch_id: STAGING_NEON_BRANCH_ID
          }]
        };
      }

      if (s.includes('FROM information_schema.triggers')) {
        return {
          rows: Array.from(memoryDbState.triggers).map(t => ({ tablename: t }))
        };
      }

      if (memoryDbState.sentinelActive && (s.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`) || s.includes(`TRUNCATE TABLE ${STAGING_PROBE_TABLE}`))) {
        const err: any = new Error('[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode. Write path is locked.');
        err.code = '55P03';
        throw err;
      }

      return { rows: [] };
    };

    return {
      raw: rawHandler,
      transaction: async (cb: any) => {
        let elevated = false;
        return cb({
          raw: async (txSql: string, params?: any) => {
            if (txSql.includes('SET LOCAL aira.privileged_token')) {
              elevated = true;
              return { rows: [] };
            }
            if (txSql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`) && elevated) {
              return { rows: [] };
            }
            return rawHandler(txSql, params);
          }
        });
      }
    };
  };

  await test('Activate staging maintenance initializes sentinel and attaches triggers to tables', async () => {
    const mockClient: any = createMockDbClient();
    const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const res = await activateStagingMaintenance(mockClient, {
      operator: 'rajpunkeshwarrajgautam-boop',
      reason: 'PR #96 staging cutover',
      bypassToken: token
    });

    assert.equal(res.active, true);
    assert.equal(res.operator, 'rajpunkeshwarrajgautam-boop');
    assert.equal(res.bypassToken, token);
    assert.equal(memoryDbState.sentinelActive, true);
    assert.equal(memoryDbState.defaultReadOnly, true);
    assert.ok(memoryDbState.triggers.has('conversations'));
    assert.ok(memoryDbState.triggers.has('conversation_messages'));
    assert.ok(memoryDbState.triggers.has('runs'));
  });

  await test('Status reports active barrier with guarded tables count', async () => {
    const mockClient: any = createMockDbClient();
    const status = await getStagingMaintenanceStatus(mockClient);
    assert.equal(status.isActive, true);
    assert.equal(status.defaultReadOnly, true);
    assert.ok(status.tablesGuarded.length >= 3);
  });

  await test('Deactivate staging maintenance cleanly clears sentinel, read-only setting and triggers', async () => {
    const mockClient: any = createMockDbClient();
    const res = await deactivateStagingMaintenance(mockClient, {
      operator: 'rajpunkeshwarrajgautam-boop'
    });

    assert.equal(res.active, false);
    assert.equal(res.readOnlyReset, true);
    assert.equal(res.triggersRemoved, true);
    assert.equal(memoryDbState.sentinelActive, false);
    assert.equal(memoryDbState.defaultReadOnly, false);
  });

  // ── GROUP 3: Write Restriction Verification & Bypass Rejection ─────────────
  console.log('\n--- Test Group 3: Write Restriction Verification & Bypass Rejection ---');

  await test('Unprivileged write is rejected when maintenance is active (older deployment simulation)', async () => {
    const mockActiveClient: any = {
      raw: async (sql: string) => {
        if (sql.includes(STAGING_MAINTENANCE_TABLE)) {
          return { rows: [{ is_active: true, activated_at: '2026-10-22', bypass_token_hash: 'hash' }] };
        }
        if (sql.includes('default_transaction_read_only')) {
          return { rows: [{ db_name: 'neondb', default_ro: 'on' }] };
        }
        if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`)) {
          // Throws standard Postgres trigger exception
          const err: any = new Error('[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode.');
          err.code = '55P03';
          throw err;
        }
        return { rows: [] };
      },
      transaction: async (cb: any) => {
        return cb({
          raw: async (sql: string) => {
            if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`)) return { rows: [] };
            return { rows: [] };
          }
        });
      }
    };

    const res = await verifyStagingWriteRestriction(mockActiveClient, { bypassToken: 'valid_token' });
    assert.equal(res.writesBlocked, true);
    assert.equal(res.privilegedPathOperational, true);
  });

  await test('Write restriction check fails if unprivileged insert unexpectedly succeeds', async () => {
    const mockLeakyClient: any = {
      raw: async (sql: string) => {
        if (sql.includes(STAGING_MAINTENANCE_TABLE)) {
          return { rows: [{ is_active: true, activated_at: '2026-10-22', bypass_token_hash: 'hash' }] };
        }
        if (sql.includes('default_transaction_read_only')) {
          return { rows: [{ db_name: 'neondb', default_ro: 'off' }] };
        }
        if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`)) {
          // Leaky write succeeds!
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const res = await verifyStagingWriteRestriction(mockLeakyClient);
    assert.equal(res.writesBlocked, false);
    assert.match(res.details, /writesBlocked=false/);
  });

  await test('Zero false-positive certification: verifyStagingWriteRestriction returns privilegedPathOperational=false when no token provided', async () => {
    const mockClientNoToken: any = {
      raw: async (sql: string) => {
        if (sql.includes(STAGING_MAINTENANCE_TABLE)) {
          return { rows: [{ is_active: true, bypass_token_hash: 'hash' }] };
        }
        if (sql.includes('default_transaction_read_only')) {
          return { rows: [{ default_ro: 'on' }] };
        }
        if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`) || sql.includes(`TRUNCATE TABLE ${STAGING_PROBE_TABLE}`)) {
          const err: any = new Error('[STAGING_MAINTENANCE_BLOCKED]');
          err.code = '55P03';
          throw err;
        }
        return { rows: [] };
      }
    };

    const res = await verifyStagingWriteRestriction(mockClientNoToken);
    assert.equal(res.writesBlocked, true);
    assert.equal(res.truncateBlocked, true);
    assert.equal(res.privilegedPathOperational, false); // Must be FALSE when no token provided
  });

  await test('auditConnectedRolePrivileges detects table-owner vs least-privilege runtime role', async () => {
    const mockOwnerClient: any = {
      raw: async (sql: string) => {
        if (sql.includes('current_user as current_role')) {
          return { rows: [{ current_role: 'neondb_owner', session_role: 'neondb_owner', db_name: 'neondb' }] };
        }
        if (sql.includes('FROM pg_tables')) {
          return { rows: [{ tableowner: 'neondb_owner', count: 23 }] };
        }
        return { rows: [] };
      }
    };

    const { auditConnectedRolePrivileges } = await import('../packages/db/src/security/staging-role-separation.js');
    const ownerAudit = await auditConnectedRolePrivileges(mockOwnerClient);
    assert.equal(ownerAudit.isTableOwner, true);
    assert.equal(ownerAudit.canDisableTriggers, true);
    assert.equal(ownerAudit.isRuntimeRoleSeparated, false);

    const mockRuntimeClient: any = {
      raw: async (sql: string) => {
        if (sql.includes('current_user as current_role')) {
          return { rows: [{ current_role: 'aira_staging_runtime', session_role: 'aira_staging_runtime', db_name: 'neondb' }] };
        }
        if (sql.includes('FROM pg_tables')) {
          return { rows: [{ tableowner: 'neondb_owner', count: 23 }] };
        }
        return { rows: [] };
      }
    };

    const runtimeAudit = await auditConnectedRolePrivileges(mockRuntimeClient);
    assert.equal(runtimeAudit.isTableOwner, false);
    assert.equal(runtimeAudit.canDisableTriggers, false);
    assert.equal(runtimeAudit.isRuntimeRoleSeparated, true);
  });

  // ── GROUP 4: 5-Gate Write Isolation Evaluation ─────────────────────────────
  console.log('\n--- Test Group 4: 5-Gate Write Isolation Evaluation ---');

  await test('verifyStagingWriteIsolation passes all 5 gates when barrier active and writes drained', async () => {
    const mockPassingClient: any = {
      raw: async (sql: string) => {
        if (sql.includes('neon.project_id')) {
          return {
            rows: [{
              db_name: 'neondb',
              neon_project_id: STAGING_NEON_PROJECT_ID,
              neon_branch_id: STAGING_NEON_BRANCH_ID
            }]
          };
        }
        if (sql.includes(STAGING_MAINTENANCE_TABLE)) {
          return { rows: [{ is_active: true, activated_at: '2026-10-22', bypass_token_hash: 'hash' }] };
        }
        if (sql.includes('default_transaction_read_only')) {
          return { rows: [{ db_name: 'neondb', default_ro: 'on' }] };
        }
        if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`) || sql.includes(`TRUNCATE TABLE ${STAGING_PROBE_TABLE}`)) {
          const err: any = new Error('[STAGING_MAINTENANCE_BLOCKED] Write path locked');
          err.code = '55P03';
          throw err;
        }
        return { rows: [] };
      },
      transaction: async (cb: any) => cb({ raw: async () => ({ rows: [] }) })
    };

    const res = await verifyStagingWriteIsolation(mockPassingClient, { bypassToken: 'token' });
    assert.equal(res.isolated, true);
    assert.equal(res.stagingDatabaseIdentity.status, 'PASS');
    assert.equal(res.maintenanceBarrierActive.status, 'PASS');
    assert.equal(res.runtimeWriteRestriction.status, 'PASS');
    assert.equal(res.inFlightWritesDrained.status, 'PASS');
    assert.equal(res.privilegedMigrationPath.status, 'PASS');
  });

  await test('verifyStagingWriteIsolation fails if in-flight active writers detected', async () => {
    const mockWritingClient: any = {
      raw: async (sql: string) => {
        if (sql.includes('pg_stat_activity')) {
          return {
            rows: [{
              pid: 1234,
              usename: 'active_writer',
              application_name: 'vercel_worker',
              client_addr: '10.0.0.1',
              state: 'active',
              query: 'INSERT INTO conversations ...',
              xact_start: '2026-10-22T00:00:00Z'
            }]
          };
        }
        if (sql.includes(STAGING_MAINTENANCE_TABLE)) {
          return { rows: [{ is_active: true }] };
        }
        if (sql.includes('default_transaction_read_only')) {
          return { rows: [{ default_ro: 'on' }] };
        }
        if (sql.includes(`INSERT INTO ${STAGING_PROBE_TABLE}`)) {
          throw new Error('[STAGING_MAINTENANCE_BLOCKED]');
        }
        return { rows: [] };
      },
      transaction: async (cb: any) => cb({ raw: async () => ({ rows: [] }) })
    };

    const res = await verifyStagingWriteIsolation(mockWritingClient);
    assert.equal(res.isolated, false);
    assert.equal(res.inFlightWritesDrained.status, 'FAIL');
    assert.match(res.details, /active write transaction/);
  });

  // ── GROUP 5: Express Maintenance Middleware HTTP Interception ──────────────
  console.log('\n--- Test Group 5: Express Maintenance Middleware HTTP Interception ---');

  const bypassSecret = 'super-secret-maintenance-token-2026';
  const bypassSecretHash = crypto.createHash('sha256').update(bypassSecret).digest('hex');

  const middleware = createStagingMaintenanceMiddleware({
    enabled: true,
    bypassToken: bypassSecret,
    bypassTokenHash: bypassSecretHash
  });

  function createMockHttpReq(method: string, path: string, headers: Record<string, string> = {}) {
    return {
      method,
      path,
      url: path,
      originalUrl: path,
      headers
    } as any;
  }

  function createMockHttpRes() {
    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    let responseBody: any = null;

    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      setHeader: (name: string, value: string) => {
        responseHeaders[name.toLowerCase()] = value;
      },
      json: (body: any) => {
        responseBody = body;
        return res;
      },
      getStatusCode: () => statusCode,
      getHeaders: () => responseHeaders,
      getBody: () => responseBody
    };
    return res;
  }

  await test('Health check /api/health passes through unconditionally (HTTP 200/next)', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/health');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.getStatusCode(), 200);
  });

  await test('Readiness probe /api/ready/benchmark passes through unconditionally', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/ready/benchmark-groq');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  await test('CORS OPTIONS preflight passes through unconditionally', () => {
    let nextCalled = false;
    const req = createMockHttpReq('OPTIONS', '/api/chat/stream');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  await test('Read-only GET /api/billing/plans passes through to next()', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/billing/plans');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  await test('POST /api/chat/stream blocked with HTTP 503 and Retry-After: 60', () => {
    let nextCalled = false;
    const req = createMockHttpReq('POST', '/api/chat/stream');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
    assert.equal(res.getHeaders()['retry-after'], '60');
    assert.equal(res.getHeaders()['x-aira-maintenance'], 'active');
    assert.equal(res.getBody().code, 'STAGING_MAINTENANCE_ACTIVE');
  });

  await test('POST /api/runs blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('POST', '/api/runs');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('PUT /api/account/profile blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('PUT', '/api/account/profile');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('DELETE /api/conversations/123 blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('DELETE', '/api/conversations/conv_123');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('Mutating GET: /api/auth/oauth/google/callback blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/auth/oauth/google/callback?code=test');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('Mutating GET: /api/auth/oauth/github/callback blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/auth/oauth/github/callback?code=test');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('Mutating GET: /api/auth/oauth/google/start blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/auth/oauth/google/start');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('Mutating GET: /api/auth/oauth/google/link blocked with HTTP 503', () => {
    let nextCalled = false;
    const req = createMockHttpReq('GET', '/api/auth/oauth/google/link');
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
  });

  await test('Security check: Request with X-Aira-Maintenance-Token is STILL denied with HTTP 503 (no HTTP bypass allowed)', () => {
    let nextCalled = false;
    const req = createMockHttpReq('POST', '/api/chat/stream', {
      'x-aira-maintenance-token': bypassSecret
    });
    const res = createMockHttpRes();
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.getStatusCode(), 503);
    assert.equal(res.getBody().code, 'STAGING_MAINTENANCE_ACTIVE');
  });

  await test('Disabled middleware permits all mutating requests through', () => {
    const disabledMiddleware = createStagingMaintenanceMiddleware({ enabled: false });
    let nextCalled = false;
    const req = createMockHttpReq('POST', '/api/chat/stream');
    const res = createMockHttpRes();
    disabledMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  console.log(`\n================================================================================`);
  console.log(`  ✓ ALL ${passed} STAGING MAINTENANCE BARRIER TESTS PASSED SUCCESSFULLY!       `);
  console.log(`================================================================================\n`);
}

runAll().catch(err => {
  console.error('[FATAL_TEST_ERROR]', err);
  process.exit(1);
});
