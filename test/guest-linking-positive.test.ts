import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { NeonAuthClient } from '../src/lib/neonAuth.js';

const STAGING_AUTH_BASE = process.env.NEON_AUTH_BASE_URL || 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const STAGING_JWKS_URL = process.env.NEON_AUTH_JWKS_URL || 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';
const TEST_PORT = 3097;
const TEST_API_URL = `http://127.0.0.1:${TEST_PORT}`;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port: number) {
  if (process.platform === 'win32') {
    try {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' });
    } catch {}
  }
}

function killProcessTree(proc: ChildProcess) {
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true, stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
}

async function waitForServer(url: string, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/ready`);
      if (res.status === 200) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${url} failed to become READY within ${timeoutMs}ms`);
}

async function main() {
  console.log('\n=============================================================');
  console.log('  AIRA AI 2026 — POSITIVE GUEST LINKING ACCEPTANCE SUITE     ');
  console.log('=============================================================\n');

  killPort(TEST_PORT);

  const stagingDbUrl = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
  if (!stagingDbUrl) {
    console.error('\n❌ ERROR: Staging database credentials not provided.');
    console.error('Set STAGING_DATABASE_URL or DATABASE_URL before running positive guest linking tests.');
    console.error('Refusing to run with fallback or production database.\n');
    process.exit(1);
  }
  if (stagingDbUrl.includes('prod') || stagingDbUrl.includes('production')) {
    console.error('\n❌ SECURITY GUARD: Staging tests cannot run against production database.\n');
    process.exit(1);
  }

  process.env.DATABASE_URL = stagingDbUrl;
  const { db } = await import('../packages/db/src/index.js');

  // 1. Spawn test server
  console.log('[1/10] Starting test API server on port 3097...');
  const serverProc: ChildProcess = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      AIRA_API_URL: TEST_API_URL,
      DATABASE_URL: stagingDbUrl,
      AIRA_EXTERNAL_AUTH_ENABLED: 'true',
      NEON_AUTH_BASE_URL: STAGING_AUTH_BASE,
      NEON_AUTH_JWKS_URL: STAGING_JWKS_URL,
      NODE_ENV: 'test'
    },
    shell: true,
    stdio: 'pipe'
  });

  serverProc.stderr?.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('ExperimentalWarning')) {
      process.stderr.write(`[TEST_SERVER_STDERR] ${msg}`);
    }
  });

  try {
    await waitForServer(TEST_API_URL);
    console.log('  ✓ Test API server is ready and listening');

    const ts = Date.now();
    const guestChatId = `guest-chat-transfer-${ts}`;
    const guestSecretContent = `Confidential guest payload token: ${ts}`;

    // -------------------------------------------------------------
    // STEP 2: Create a genuine signed guest session
    // -------------------------------------------------------------
    console.log('[2/10] Creating genuine signed guest session...');
    const sessionRes = await fetch(`${TEST_API_URL}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      }
    });
    assert.equal(sessionRes.status, 200, 'Session bootstrap must succeed');
    const cookieHeader = sessionRes.headers.get('set-cookie');
    assert.ok(cookieHeader, 'Session bootstrap must return signed cookie');
    const guestCookie = cookieHeader.split(';')[0]; // aira_guest_session=...
    console.log('  ✓ Signed guest cookie received');

    // -------------------------------------------------------------
    // STEP 3: Persist genuine guest conversation under verified guest principal
    // -------------------------------------------------------------
    console.log('[3/10] Persisting guest conversation to PostgreSQL...');
    const syncRes = await fetch(`${TEST_API_URL}/api/conversations/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': guestCookie,
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({
        id: guestChatId,
        title: 'Important Guest Research',
        createdAt: ts,
        updatedAt: ts,
        messages: [
          { id: `msg-user-${ts}`, role: 'user', content: guestSecretContent, createdAt: ts }
        ]
      })
    });
    assert.equal(syncRes.status, 200, 'Guest conversation sync must succeed');
    console.log('  ✓ Conversation successfully stored under guest session');

    // -------------------------------------------------------------
    // STEP 4: Verify conversation exists under guest principal in PostgreSQL
    // -------------------------------------------------------------
    console.log('[4/10] Verifying database record under guest principal...');
    const dbGuestConv = await db('conversations').where({ client_id: guestChatId }).first();
    assert.ok(dbGuestConv, 'Conversation record must exist in PostgreSQL');
    assert.ok(dbGuestConv.principal_id.startsWith('user_'), 'Principal ID must be guest UUID format');
    const guestPrincipalId = dbGuestConv.principal_id;
    console.log(`  ✓ Confirmed PostgreSQL ownership: principal_id=${guestPrincipalId}`);

    // -------------------------------------------------------------
    // STEP 5: Register genuine Account 1 on Staging Neon Better Auth
    // -------------------------------------------------------------
    console.log('[5/10] Registering real Account 1 on Staging Neon...');
    const email1 = `guest_link_u1_${ts}@example.com`;
    const password = `LinkSecure!2026_${ts}`;

    const client1 = new NeonAuthClient();
    const { user: user1 } = await client1.signUp({
      email: email1,
      password,
      name: `Link User 1 ${ts}`,
      preserveGuestData: false
    });
    const jwt1 = await client1.getValidJwt();
    assert.ok(jwt1, 'Account 1 must receive valid EdDSA JWT');
    const expectedUser1Principal = `neon_user_${user1.id}`;
    console.log(`  ✓ Account 1 registered: target principal=${expectedUser1Principal}`);

    // -------------------------------------------------------------
    // STEP 6: Execute POST /api/auth/link-guest
    // -------------------------------------------------------------
    console.log('[6/10] Invoking POST /api/auth/link-guest with signed guest cookie & verified JWT...');
    const linkRes = await fetch(`${TEST_API_URL}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt1}`,
        'Cookie': guestCookie,
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({})
    });
    assert.equal(linkRes.status, 200, 'Guest linking must return HTTP 200');
    const linkData = await linkRes.json();
    assert.equal(linkData.success, true, 'Link response must indicate success');
    assert.ok(linkData.transferredConversations >= 1, 'At least 1 conversation must be transferred');
    console.log(`  ✓ Link endpoint succeeded: transferred ${linkData.transferredConversations} conversation(s)`);

    // -------------------------------------------------------------
    // STEP 7: Verify ownership transfer inside PostgreSQL
    // -------------------------------------------------------------
    console.log('[7/10] Verifying database ownership transferred to Account 1...');
    const dbTransferredConv = await db('conversations').where({ client_id: guestChatId }).first();
    assert.ok(dbTransferredConv, 'Transferred conversation must exist in PostgreSQL');
    assert.equal(dbTransferredConv.principal_id, expectedUser1Principal,
      `Conversation principal_id must now equal Account 1 principal (${expectedUser1Principal})`);

    const dbTransferredMsgs = await db('conversation_messages')
      .where({ conversation_id: dbTransferredConv.id });
    assert.ok(dbTransferredMsgs.length >= 1, 'Messages must exist in database');
    for (const msg of dbTransferredMsgs) {
      assert.equal(msg.principal_id, expectedUser1Principal,
        `Message principal_id must now equal Account 1 principal (${expectedUser1Principal})`);
    }
    console.log('  ✓ PostgreSQL records confirmed: conversations & messages reassigned to Account 1');

    // -------------------------------------------------------------
    // STEP 8: Verify Account 1 retrieves the migrated conversation via GET /api/conversations
    // -------------------------------------------------------------
    console.log('[8/10] Verifying Account 1 retrieves migrated conversation via authenticated API...');
    const listRes1 = await fetch(`${TEST_API_URL}/api/conversations`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${jwt1}` }
    });
    assert.equal(listRes1.status, 200, 'Account 1 list conversations must return HTTP 200');
    const listData1 = await listRes1.json();
    const foundInAccount1 = listData1.conversations.find((c: any) => c.id === guestChatId);
    assert.ok(foundInAccount1, 'Account 1 must see the migrated conversation in their conversation list');
    assert.equal(foundInAccount1.messages[0].content, guestSecretContent, 'Message content must match exactly');
    console.log('  ✓ Account 1 API retrieval verified with full message fidelity');

    // -------------------------------------------------------------
    // STEP 9: Verify old guest identity & Account 2 CANNOT access records
    // -------------------------------------------------------------
    console.log('[9/10] Verifying old guest identity and Account 2 cannot access transferred records...');
    // Old guest cookie request
    const oldGuestListRes = await fetch(`${TEST_API_URL}/api/conversations`, {
      method: 'GET',
      headers: { 'Cookie': guestCookie }
    });
    assert.equal(oldGuestListRes.status, 200);
    const oldGuestListData = await oldGuestListRes.json();
    const guestStillSees = oldGuestListData.conversations?.find((c: any) => c.id === guestChatId);
    assert.equal(guestStillSees, undefined, 'Old guest identity must NO LONGER see transferred conversation');

    // Register Account 2
    const email2 = `guest_link_u2_${ts}@example.com`;
    const client2 = new NeonAuthClient();
    const { user: user2 } = await client2.signUp({
      email: email2,
      password,
      name: `Link User 2 ${ts}`,
      preserveGuestData: false
    });
    const jwt2 = await client2.getValidJwt();
    assert.ok(jwt2, 'Account 2 must receive valid EdDSA JWT');

    const listRes2 = await fetch(`${TEST_API_URL}/api/conversations`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${jwt2}` }
    });
    const listData2 = await listRes2.json();
    const account2Sees = listData2.conversations?.find((c: any) => c.id === guestChatId);
    assert.equal(account2Sees, undefined, 'Account 2 must NEVER see Account 1 transferred conversation');
    console.log('  ✓ Strict boundary verified: Neither old guest nor third-party accounts can access records');

    // -------------------------------------------------------------
    // STEP 10: Idempotency, duplicate requests, and failure rejection
    // -------------------------------------------------------------
    console.log('[10/10] Testing idempotency and failure rejections...');
    // Duplicate link with same guest cookie
    const dupRes = await fetch(`${TEST_API_URL}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt1}`,
        'Cookie': guestCookie,
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({})
    });
    // Should be either idempotent success (0 transferred) or safe rejection
    assert.ok(dupRes.status === 200 || dupRes.status === 400, 'Duplicate link must be handled safely');

    // Missing JWT must fail closed
    const unauthLinkRes = await fetch(`${TEST_API_URL}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': guestCookie,
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({})
    });
    assert.equal(unauthLinkRes.status, 401, 'Unauthenticated link request must return HTTP 401');

    // Missing guest cookie must fail closed
    const noCookieLinkRes = await fetch(`${TEST_API_URL}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt1}`,
        'Origin': TEST_API_URL,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({})
    });
    assert.equal(noCookieLinkRes.status, 400, 'Missing guest cookie link request must return HTTP 400');
    console.log('  ✓ Idempotency, fail-closed auth, and cookie requirement verified');

    console.log('\n=============================================================');
    console.log('ALL POSITIVE GUEST LINKING ACCEPTANCE CHECKS PASSED [10/10]  ');
    console.log('=============================================================\n');

    killProcessTree(serverProc);
    killPort(TEST_PORT);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error('\nPositive guest linking test failed:', err);
    killProcessTree(serverProc);
    killPort(TEST_PORT);
    try { await db.destroy(); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  killPort(TEST_PORT);
  process.exit(1);
});
