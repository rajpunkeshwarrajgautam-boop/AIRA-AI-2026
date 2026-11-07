import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import knex from 'knex';
import { NeonAuthClient } from '../src/lib/neonAuth.js';
import {
  assertAuthorizedStagingDatabase,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import {
  assertCertificationFixtureWriteOptIn,
  assertIsolatedAuthEndpoint
} from './staging-certification-safety.js';

const STAGING_AUTH_BASE = process.env.NEON_AUTH_BASE_URL?.replace(/\/$/, '') || '';
const STAGING_JWKS_URL = process.env.NEON_AUTH_JWKS_URL || '';
const ISOLATED_BRANCH_ID = 'br-muddy-wave-b3zxhkqf';
const TEST_PORT = 3098;
const TEST_API_URL = `http://127.0.0.1:${TEST_PORT}`;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${url} failed to start within ${timeoutMs}ms`);
}

async function main() {
  console.log('\n=== AIRA AI 2026 — AUTH & AUTHORIZATION NEGATIVE SECURITY SUITE ===\n');

  const stagingDbUrl = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
  if (!stagingDbUrl) {
    console.error('\n❌ ERROR: Staging database credentials not provided.');
    console.error('Set STAGING_DATABASE_URL or DATABASE_URL before running auth security tests.');
    console.error('Refusing to run with fallback or production database.\n');
    process.exit(1);
  }
  if (stagingDbUrl.includes('prod') || stagingDbUrl.includes('production')) {
    console.error('\n❌ SECURITY GUARD: Staging tests cannot run against production database.\n');
    process.exit(1);
  }

  // No fallback to a different staging branch's Better Auth integration.
  // This check precedes account registration or any other fixture writes.
  if (!STAGING_AUTH_BASE || !STAGING_JWKS_URL) {
    throw new Error('Branch-specific NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL must be set explicitly');
  }

  const identityDb = knex({
    client: 'pg',
    connection: { connectionString: stagingDbUrl, ssl: { rejectUnauthorized: true } },
    pool: { min: 0, max: 1 }
  });
  try {
    const identity = await assertAuthorizedStagingDatabase(identityDb, {
      allowedProjectIds: [STAGING_NEON_PROJECT_ID],
      allowedBranchIds: [ISOLATED_BRANCH_ID]
    });
    assertIsolatedAuthEndpoint(STAGING_AUTH_BASE, STAGING_JWKS_URL, identity.neonEndpointId);
  } finally {
    await identityDb.destroy();
  }
  assertCertificationFixtureWriteOptIn(process.env.AIRA_AUTH_TEST_FIXTURE_WRITES_ENABLED);

  const testEmail1 = process.env.STAGING_AUTH_TEST_USER_A_EMAIL;
  const testEmail2 = process.env.STAGING_AUTH_TEST_USER_B_EMAIL;
  const testPassword1 = process.env.STAGING_AUTH_TEST_USER_A_PASSWORD;
  const testPassword2 = process.env.STAGING_AUTH_TEST_USER_B_PASSWORD;
  if (!testEmail1 || !testEmail2 || !testPassword1 || !testPassword2 || testEmail1 === testEmail2) {
    throw new Error('Two distinct, pre-existing isolated Auth test accounts must be configured; this suite never signs up new users');
  }

  // Import the real Express app in serverless mode, then bind it to a local
  // test-only listener. The normal API entrypoint recovers ALL interrupted runs
  // on startup; doing that against a reused staging branch would mutate other
  // principals' historical runs during an unrelated auth certification.
  const env = {
    ...process.env,
    PORT: String(TEST_PORT),
    AIRA_API_URL: TEST_API_URL,
    DATABASE_URL: stagingDbUrl,
    AIRA_EXTERNAL_AUTH_ENABLED: 'true',
    NEON_AUTH_BASE_URL: STAGING_AUTH_BASE,
    NEON_AUTH_JWKS_URL: STAGING_JWKS_URL,
    NODE_ENV: 'test',
    VERCEL: '1'
  };

  const serverProc: ChildProcess = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    `import app from './apps/api/src/index.ts'; const server = app.listen(${TEST_PORT}, '127.0.0.1'); process.on('SIGTERM', () => server.close(() => process.exit(0)));`
  ], {
    env,
    shell: false,
    stdio: 'pipe'
  });

  serverProc.stderr?.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('ExperimentalWarning')) {
      process.stderr.write(`[API_SERVER_STDERR] ${msg}`);
    }
  });

  let cleanupJwt: string | null = null;
  let cleanupPrincipalId: string | null = null;
  let cleanupAutomationId: string | null = null;
  let cleanupConversationId: string | null = null;
  let testSucceeded = false;
  try {
    console.log(`[1/12] Waiting for test API server on port ${TEST_PORT}...`);
    await waitForServer(TEST_API_URL);
    console.log('  ✓ Test API server is HEALTHY and listening on ' + TEST_API_URL);

    // Sign into two pre-provisioned isolated accounts. Never create durable
    // Auth users from an unattended certification run.
    const ts = Date.now();

    console.log('[2/12] Signing into two existing accounts on isolated staging Neon Auth...');
    const client1 = new NeonAuthClient();
    const client2 = new NeonAuthClient();

    const { user: user1 } = await client1.signIn({ email: testEmail1, password: testPassword1, preserveGuestData: false });
    const jwt1 = await client1.getValidJwt();
    assert.ok(jwt1, 'Account 1 must receive valid EdDSA JWT');
    cleanupJwt = jwt1;

    const { user: user2 } = await client2.signIn({ email: testEmail2, password: testPassword2, preserveGuestData: false });
    const jwt2 = await client2.getValidJwt();
    assert.ok(jwt2, 'Account 2 must receive valid EdDSA JWT');

    const principalId1 = `neon_user_${user1.id}`;
    const principalId2 = `neon_user_${user2.id}`;
    cleanupPrincipalId = principalId1;
    assert.notEqual(principalId1, principalId2, 'Principals must be distinct');
    console.log(`  ✓ Account 1: ${principalId1}`);
    console.log(`  ✓ Account 2: ${principalId2}`);

    // TEST 3: Verify /api/auth/identity binds to verified cryptographic subject
    console.log('[3/12] Verifying server-side identity endpoint binding...');
    const idRes1 = await fetch(`${TEST_API_URL}/api/auth/identity`, {
      headers: { Authorization: `Bearer ${jwt1}` }
    });
    assert.equal(idRes1.status, 200);
    const idData1 = await idRes1.json();
    assert.equal(idData1.userId, principalId1);
    assert.equal(idData1.provider, 'neon_auth');

    const idRes2 = await fetch(`${TEST_API_URL}/api/auth/identity`, {
      headers: { Authorization: `Bearer ${jwt2}` }
    });
    assert.equal(idRes2.status, 200);
    const idData2 = await idRes2.json();
    assert.equal(idData2.userId, principalId2);
    console.log('  ✓ Server-side identity verified for both accounts');

    // TEST 4: Negative - Unauthenticated / Tampered JWT on protected endpoints
    console.log('[4/12] Testing unauthenticated and tampered JWT rejection...');
    const noAuthRes = await fetch(`${TEST_API_URL}/api/auth/identity`);
    assert.equal(noAuthRes.status, 401, 'Request without token must be rejected 401');

    const tamperedJwt = jwt1.slice(0, -6) + 'XXXXXX';
    const badAuthRes = await fetch(`${TEST_API_URL}/api/auth/identity`, {
      headers: { Authorization: `Bearer ${tamperedJwt}` }
    });
    assert.equal(badAuthRes.status, 401, 'Tampered JWT signature must be rejected 401');
    console.log('  ✓ Unauthenticated and tampered requests fail closed with 401');

    // TEST 5: Negative - Forged principalId on POST /api/automations
    console.log('[5/12] Testing forged principalId on automation creation...');
    const forgedAutoRes = await fetch(`${TEST_API_URL}/api/automations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        name: 'Forged Automation Attempt',
        principalId: principalId2, // Maliciously forging ownership to Account 2
        trigger: 'MANUAL',
        agentId: 'agent_test_sec',
        objective: 'Attempt privilege escalation'
      })
    });
    const forgedAutoErr = await forgedAutoRes.json();
    assert.equal(forgedAutoRes.status, 400,
      `Forged principalId must be rejected with HTTP 400; received ${forgedAutoRes.status}: ${JSON.stringify(forgedAutoErr)}`);
    assert.match(forgedAutoErr.error, /Forbidden: caller may not specify or forge principalId ownership/i);
    console.log('  ✓ Forged principalId on POST /api/automations rejected securely');

    // TEST 6: Legitimate automation creation by Account 1
    console.log('[6/12] Creating legitimate automation under Account 1...');
    const validAutoRes = await fetch(`${TEST_API_URL}/api/automations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        name: 'Account 1 Legitimate Automation',
        trigger: 'MANUAL',
        agentId: 'agent_test_sec',
        objective: 'Verify ownership derivation'
      })
    });
    assert.equal(validAutoRes.status, 201);
    const validAuto = await validAutoRes.json();
    cleanupAutomationId = validAuto.id;
    assert.equal(validAuto.principalId, principalId1, 'Automation ownership must strictly equal caller principal');
    console.log(`  ✓ Automation created with server-verified principal: ${validAuto.id}`);

    // TEST 7: Negative - Forged principalId on PATCH /api/automations/:id
    console.log('[7/12] Testing forged principalId on automation update...');
    const forgedPatchRes = await fetch(`${TEST_API_URL}/api/automations/${validAuto.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        principalId: principalId2 // Maliciously attempting to reassign ownership
      })
    });
    assert.equal(forgedPatchRes.status, 400, 'Forged principalId on PATCH must be rejected with HTTP 400');
    console.log('  ✓ Forged principalId on PATCH /api/automations/:id rejected securely');

    // TEST 8: IDOR Check - Account 2 cannot read or modify Account 1 automation
    console.log('[8/12] Testing cross-account IDOR isolation on automations...');
    const idorGetRes = await fetch(`${TEST_API_URL}/api/automations/${validAuto.id}`, {
      headers: { Authorization: `Bearer ${jwt2}` } // Account 2 attempting to view Account 1 automation
    });
    assert.equal(idorGetRes.status, 404, 'Account 2 must receive 404 for Account 1 automation');

    const idorPatchRes = await fetch(`${TEST_API_URL}/api/automations/${validAuto.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt2}`
      },
      body: JSON.stringify({ name: 'Hacked by Account 2' })
    });
    assert.equal(idorPatchRes.status, 400, 'Account 2 must be blocked from modifying Account 1 automation');
    console.log('  ✓ IDOR isolation verified: Account 2 blocked from reading or patching Account 1 automation');

    // TEST 9: Conversation Sync & Cross-Account Read Isolation
    console.log('[9/12] Testing durable conversation persistence and cross-account isolation...');
    const convId = `conv_sec_${randomUUID()}`;

    // Negative: Forged principalId on sync
    const forgedSyncRes = await fetch(`${TEST_API_URL}/api/conversations/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        id: convId,
        title: 'Account 1 Secret Discussion',
        principalId: principalId2, // Forged
        createdAt: ts,
        updatedAt: ts,
        messages: [{ id: 'm1', role: 'user', content: 'Secret confidential data', createdAt: ts }]
      })
    });
    assert.equal(forgedSyncRes.status, 400, 'Forged principalId on conversation sync must be rejected');

    // Legitimate sync by Account 1
    const validSyncRes = await fetch(`${TEST_API_URL}/api/conversations/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        id: convId,
        title: 'Account 1 Secret Discussion',
        createdAt: ts,
        updatedAt: ts,
        messages: [{ id: 'm1', role: 'user', content: 'Secret confidential data', createdAt: ts }]
      })
    });
    assert.equal(validSyncRes.status, 200, 'Legitimate sync must succeed');
    cleanupConversationId = convId;

    // Cross-Account Isolation on GET /api/conversations/:id
    const idorConvGet = await fetch(`${TEST_API_URL}/api/conversations/${convId}`, {
      headers: { Authorization: `Bearer ${jwt2}` } // Account 2 trying to read Account 1 conversation
    });
    assert.equal(idorConvGet.status, 404, 'Account 2 must receive 404 for Account 1 conversation');

    // Cross-Device List Hydration on GET /api/conversations
    const listRes1 = await fetch(`${TEST_API_URL}/api/conversations`, {
      headers: { Authorization: `Bearer ${jwt1}` }
    });
    assert.equal(listRes1.status, 200);
    const listData1 = await listRes1.json();
    assert.ok(listData1.conversations.some((c: any) => c.id === convId), 'Account 1 must retrieve its synced conversation');

    const listRes2 = await fetch(`${TEST_API_URL}/api/conversations`, {
      headers: { Authorization: `Bearer ${jwt2}` }
    });
    assert.equal(listRes2.status, 200);
    const listData2 = await listRes2.json();
    assert.ok(!listData2.conversations.some((c: any) => c.id === convId), 'Account 2 must NEVER see Account 1 conversation in list');
    console.log('  ✓ Cross-device conversation persistence & account isolation verified in PostgreSQL');

    // TEST 10: Negative - Forged ownership on Knowledge and Memories
    console.log('[10/12] Testing forged principalId on knowledge and memory endpoints...');
    const forgedIngest = await fetch(`${TEST_API_URL}/api/knowledge/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        title: 'Doc 1',
        content: 'Sensitive Document Content',
        principalId: principalId2
      })
    });
    assert.equal(forgedIngest.status, 400, 'Forged principalId on knowledge ingest must be rejected');

    const forgedMemory = await fetch(`${TEST_API_URL}/api/knowledge/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        key: 'secret_key',
        value: 'secret_value',
        principalId: principalId2
      })
    });
    assert.equal(forgedMemory.status, 400, 'Forged principalId on memory creation must be rejected');
    console.log('  ✓ Knowledge & Memory forged principalId rejections verified');

    // TEST 11: Negative - Forged ownership on Workflow Runs
    console.log('[11/12] Testing forged principalId on workflow runs...');
    const forgedWf = await fetch(`${TEST_API_URL}/api/workflows/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        prompt: 'Execute automated workflow',
        principalId: principalId2
      })
    });
    assert.equal(forgedWf.status, 400, 'Forged principalId on workflow runs must be rejected');
    console.log('  ✓ Workflow run forged principalId rejection verified');

    // TEST 12: Secure Guest Account Linking
    console.log('[12/12] Testing secure guest account linking boundary...');
    // Attempt 1: Forged client guestUserId without valid server-signed cookie
    const forgedLinkRes = await fetch(`${TEST_API_URL}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt1}`
      },
      body: JSON.stringify({
        guestUserId: 'usr_stolen_guest_identity_123'
      })
    });
    assert.equal(forgedLinkRes.status, 400, 'Unverified forged guestUserId must be rejected with HTTP 400');
    console.log('  ✓ Server-side guest linking rejects unverified client-provided guestUserId');

    console.log('\n=============================================================');
    console.log('ALL AUTH & AUTHORIZATION NEGATIVE SECURITY CHECKS PASSED [12/12]');
    console.log('=============================================================\n');
    testSucceeded = true;
  } finally {
    // The only persistent application fixtures created by this suite are a
    // single automation and conversation, both owned by Account 1.
    if (cleanupJwt) {
      for (const [name, endpoint] of [
        ['automation', cleanupAutomationId && `/api/automations/${cleanupAutomationId}`],
        ['conversation', cleanupConversationId && `/api/conversations/${cleanupConversationId}`]
      ] as const) {
        if (!endpoint) continue;
        try {
          const response = await fetch(`${TEST_API_URL}${endpoint}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${cleanupJwt}` }
          });
          if (!response.ok) {
            testSucceeded = false;
            process.exitCode = 1;
            console.error(`[FIXTURE CLEANUP FAILED] ${name}: HTTP ${response.status}`);
          }
        } catch (error) {
          testSucceeded = false;
          console.error(`[FIXTURE CLEANUP FAILED] ${name}:`, error);
          process.exitCode = 1;
        }
      }
    }
    // The public conversation DELETE endpoint intentionally soft-deletes to
    // preserve normal user recovery semantics. Certification fixtures must not
    // remain as tombstones on a shared staging branch. Remove ONLY the exact
    // soft-deleted, principal-owned fixture after rechecking live DB identity.
    if (cleanupConversationId && cleanupPrincipalId) {
      const cleanupDb = knex({
        client: 'pg',
        connection: { connectionString: stagingDbUrl, ssl: { rejectUnauthorized: true } },
        pool: { min: 0, max: 1 }
      });
      try {
        await assertAuthorizedStagingDatabase(cleanupDb, {
          allowedProjectIds: [STAGING_NEON_PROJECT_ID],
          allowedBranchIds: [ISOLATED_BRANCH_ID]
        });
        const conversation = await cleanupDb('conversations')
          .where({ client_id: cleanupConversationId, principal_id: cleanupPrincipalId })
          .first('id', 'deleted_at');
        assert.ok(conversation?.id && conversation.deleted_at != null,
          'Disposable conversation was not soft-deleted by the authenticated API');
        const removed = await cleanupDb('conversations')
          .where({
            id: conversation.id,
            client_id: cleanupConversationId,
            principal_id: cleanupPrincipalId
          })
          .whereNotNull('deleted_at')
          .del();
        assert.equal(removed, 1, `Disposable conversation hard-delete affected ${removed} rows`);
        console.log('  ✓ Removed the exact soft-deleted certification conversation tombstone');
      } catch (error) {
        testSucceeded = false;
        process.exitCode = 1;
        console.error('[FIXTURE HARD CLEANUP FAILED]', error);
      } finally {
        await cleanupDb.destroy();
      }
    }
    serverProc.kill();
    if (!testSucceeded) process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('\nSecurity authorization suite failed:', err);
  process.exit(1);
});
