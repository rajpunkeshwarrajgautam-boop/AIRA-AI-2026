import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { NeonAuthClient } from '../src/lib/neonAuth.js';

const STAGING_AUTH_BASE = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const STAGING_JWKS_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';
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

  const stagingDbUrl = process.env.DATABASE_URL ||
    'postgresql://neondb_owner:npg_iYU0dXlB9rms@ep-empty-field-b36mqqq6.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

  // Spawn API server on dedicated test port with external auth enabled
  const env = {
    ...process.env,
    PORT: String(TEST_PORT),
    AIRA_API_URL: TEST_API_URL,
    DATABASE_URL: stagingDbUrl,
    AIRA_EXTERNAL_AUTH_ENABLED: 'true',
    NEON_AUTH_BASE_URL: STAGING_AUTH_BASE,
    NEON_AUTH_JWKS_URL: STAGING_JWKS_URL,
    NODE_ENV: 'test'
  };

  const serverProc: ChildProcess = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    env,
    shell: true,
    stdio: 'pipe'
  });

  serverProc.stderr?.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('ExperimentalWarning')) {
      process.stderr.write(`[API_SERVER_STDERR] ${msg}`);
    }
  });

  try {
    console.log(`[1/12] Waiting for test API server on port ${TEST_PORT}...`);
    await waitForServer(TEST_API_URL);
    console.log('  ✓ Test API server is HEALTHY and listening on ' + TEST_API_URL);

    // Register two distinct real accounts on staging Neon Auth
    const ts = Date.now();
    const email1 = `sec_test_user1_${ts}@example.com`;
    const email2 = `sec_test_user2_${ts}@example.com`;
    const password = `SecurePass!${ts}_2026`;

    console.log('[2/12] Registering real Account 1 and Account 2 on Staging Neon...');
    const client1 = new NeonAuthClient();
    const client2 = new NeonAuthClient();

    const { user: user1 } = await client1.signUp({
      email: email1,
      password,
      name: 'Security Test Account 1',
      preserveGuestData: false
    });
    const jwt1 = await client1.getValidJwt();
    assert.ok(jwt1, 'Account 1 must receive valid EdDSA JWT');

    const { user: user2 } = await client2.signUp({
      email: email2,
      password,
      name: 'Security Test Account 2',
      preserveGuestData: false
    });
    const jwt2 = await client2.getValidJwt();
    assert.ok(jwt2, 'Account 2 must receive valid EdDSA JWT');

    const principalId1 = `neon_user_${user1.id}`;
    const principalId2 = `neon_user_${user2.id}`;
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
    assert.equal(forgedAutoRes.status, 400, 'Forged principalId must be rejected with HTTP 400');
    const forgedAutoErr = await forgedAutoRes.json();
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
    const convId = `conv_sec_${ts}`;

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
    serverProc.kill();
    process.exit(0);
  } finally {
    serverProc.kill();
  }
}

main().catch(err => {
  console.error('\nSecurity authorization suite failed:', err);
  process.exit(1);
});
