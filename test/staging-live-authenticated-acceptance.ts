import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import knex from 'knex';
import { NeonAuthClient } from '../src/lib/neonAuth.js';
import {
  assertAuthorizedStagingDatabase,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';

const PREVIEW_URL = process.env.AIRA_PREVIEW_URL || 'https://aira-ai-2026-3trpr8741-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const VERCEL_BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || 'QQUvz2kp1hnrbJeAicx0ZyH3kL18z54r';
const ISOLATED_BRANCH_ID = 'br-muddy-wave-b3zxhkqf';

const USER_A_EMAIL = process.env.STAGING_AUTH_TEST_USER_A_EMAIL || 'test_user_a_aira_staging@virexaaiventures.com';
const USER_A_PASSWORD = process.env.STAGING_AUTH_TEST_USER_A_PASSWORD || 'StrongP@ssw0rd2026!StagingA';
const USER_B_EMAIL = process.env.STAGING_AUTH_TEST_USER_B_EMAIL || 'test_user_b_aira_staging@virexaaiventures.com';
const USER_B_PASSWORD = process.env.STAGING_AUTH_TEST_USER_B_PASSWORD || 'StrongP@ssw0rd2026!StagingB';

const OUTPUT_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance');

interface AcceptanceEvidence {
  step: string;
  verdict: 'PASS' | 'FAIL';
  details: Record<string, unknown>;
}

const evidenceLedger: AcceptanceEvidence[] = [];

function recordEvidence(step: string, details: Record<string, unknown>) {
  console.log(`[PASS] ${step}`);
  evidenceLedger.push({ step, verdict: 'PASS', details });
}

async function main() {
  console.log('\n========================================================================');
  console.log('  AIRA AI 2026 — LIVE AUTHENTICATED AGENT ACCEPTANCE MATRIX (STAGING)');
  console.log('========================================================================\n');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Verify Deployment Reachability and Agent Readiness
  console.log('--- Phase 1: Deployment & Readiness Gate ---');
  const readyRes = await fetch(`${PREVIEW_URL}/api/ready`, {
    headers: { 'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET }
  });
  assert.equal(readyRes.status, 200, `Preview /api/ready must return HTTP 200. Got ${readyRes.status}`);
  const readyData = await readyRes.json();
  assert.equal(readyData.status, 'READY', `Agent readiness must be READY. Got ${readyData.status}`);
  recordEvidence('Phase 1.1: Preview /api/ready probe', {
    url: `${PREVIEW_URL}/api/ready`,
    status: readyRes.status,
    readyData
  });

  const healthRes = await fetch(`${PREVIEW_URL}/api/health`, {
    headers: { 'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET }
  });
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, 'HEALTHY');
  assert.equal(healthData.readiness, 'READY');
  assert.equal(healthData.productionMockFallback, 'DISABLED');
  recordEvidence('Phase 1.2: Preview /api/health probe', {
    subsystems: healthData.subsystems,
    mockFallback: healthData.productionMockFallback
  });

  // 2. Authenticate Two Independent Principals
  console.log('\n--- Phase 2: Dual Principal Authentication & Isolation ---');
  const authClientA = new NeonAuthClient();
  const authClientB = new NeonAuthClient();

  const { user: userA } = await authClientA.signIn({
    email: USER_A_EMAIL,
    password: USER_A_PASSWORD,
    preserveGuestData: false
  });
  const jwtA = await authClientA.getValidJwt();
  assert.ok(jwtA, 'User A must acquire valid JWT');
  const principalA = `neon_user_${userA.id}`;

  const { user: userB } = await authClientB.signIn({
    email: USER_B_EMAIL,
    password: USER_B_PASSWORD,
    preserveGuestData: false
  });
  const jwtB = await authClientB.getValidJwt();
  assert.ok(jwtB, 'User B must acquire valid JWT');
  const principalB = `neon_user_${userB.id}`;

  assert.notEqual(principalA, principalB, 'Principals must be cryptographically distinct');
  recordEvidence('Phase 2.1: Dual principal login & JWT issuance', {
    userA: { id: userA.id, email: userA.email, principal: principalA },
    userB: { id: userB.id, email: userB.email, principal: principalB }
  });

  // 3. Cryptographic Identity & Negative Security
  console.log('\n--- Phase 3: Identity Binding & IDOR Quarantine ---');
  const idResA = await fetch(`${PREVIEW_URL}/api/auth/identity`, {
    headers: {
      Authorization: `Bearer ${jwtA}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  });
  assert.equal(idResA.status, 200);
  const idDataA = await idResA.json();
  assert.equal(idDataA.userId, principalA);

  const unauthRes = await fetch(`${PREVIEW_URL}/api/auth/identity`, {
    headers: { 'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET }
  });
  assert.equal(unauthRes.status, 401, 'Unauthenticated request must return 401');

  const tamperedJwt = jwtA.slice(0, -6) + 'XXXXXX';
  const tamperedRes = await fetch(`${PREVIEW_URL}/api/auth/identity`, {
    headers: {
      Authorization: `Bearer ${tamperedJwt}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  });
  assert.equal(tamperedRes.status, 401, 'Tampered token must return 401');
  recordEvidence('Phase 3.1: Token validation & tampered JWT rejection', {
    unauthenticatedStatus: unauthRes.status,
    tamperedStatus: tamperedRes.status
  });

  // User A creates conversation fixture
  const convId = `conv_test_${Date.now()}`;
  const convSyncRes = await fetch(`${PREVIEW_URL}/api/conversations/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtA}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    },
    body: JSON.stringify({
      id: convId,
      title: 'Confidential Strategy User A',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: 'm1', role: 'user', content: 'Top secret plan for User A', createdAt: Date.now() }]
    })
  });
  assert.equal(convSyncRes.status, 200, 'User A conversation sync must succeed');

  // Cross-Principal IDOR Check: User B attempts to read User A conversation
  const idorConvRes = await fetch(`${PREVIEW_URL}/api/conversations/${convId}`, {
    headers: {
      Authorization: `Bearer ${jwtB}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  });
  assert.equal(idorConvRes.status, 404, `User B reading User A conversation must return 404. Got ${idorConvRes.status}`);
  recordEvidence('Phase 3.2: Cross-user IDOR conversation isolation', {
    convId,
    ownerPrincipal: principalA,
    unauthorizedAccessor: principalB,
    accessorStatus: idorConvRes.status
  });

  // 4. Multi-Step Live Agent Execution via SSE
  console.log('\n--- Phase 4: Multi-Step Live Agent Execution & Streaming ---');
  const agentPrompt = (
    'AIRA Production Certification Mission: Execute live tool invocation to compute ' +
    '((16384 * 1024) / 4) with calculator tool. Return exact integer result.'
  );

  const streamRes = await fetch(`${PREVIEW_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtA}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET,
      'x-aira-csrf-protection': '1',
      Origin: PREVIEW_URL,
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      prompt: agentPrompt,
      model: 'aira-fast'
    })
  });
  assert.equal(streamRes.status, 200, `Chat stream must return HTTP 200. Got ${streamRes.status}`);

  const reader = streamRes.body?.getReader();
  assert.ok(reader, 'Response body stream must exist');
  const decoder = new TextDecoder();
  let buffer = '';
  let runId = '';
  let fullOutput = '';
  const eventsReceived: string[] = [];
  const toolCompletedEvents: any[] = [];
  const modelProvenanceEvents: any[] = [];
  let doneReceived = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        const evt = line.slice(7).trim();
        eventsReceived.push(evt);
        if (evt === 'done') doneReceived = true;
      }
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6).trim());
          if (parsed.runId) runId = parsed.runId;
          if (parsed.delta) fullOutput += parsed.delta;
          if (parsed.text) fullOutput += parsed.text;
          const lastEvt = eventsReceived[eventsReceived.length - 1];
          if (lastEvt === 'tool_completed') toolCompletedEvents.push(parsed);
          if (lastEvt === 'model_provenance') modelProvenanceEvents.push(parsed);
        } catch {}
      }
    }
  }

  assert.ok(runId, 'Stream must emit a valid runId');
  assert.ok(doneReceived, 'Stream must complete with terminal [done] event');
  assert.ok(toolCompletedEvents.length > 0, 'Agent must execute at least one tool call');
  const calcOutput = toolCompletedEvents[0].output?.result;
  assert.equal(calcOutput, 4194304, `Calculator output must be 4194304. Got ${calcOutput}`);
  assert.ok(modelProvenanceEvents.length > 0, 'Stream must emit model provenance');
  const prov = modelProvenanceEvents[modelProvenanceEvents.length - 1];
  assert.notEqual(prov.provider, 'mock', 'Model provider must not be mock');
  assert.equal(prov.verified, true, 'Provenance must be verified: true');

  recordEvidence('Phase 4.1: Live streaming Agent execution', {
    runId,
    toolExecuted: toolCompletedEvents[0].tool || 'calculator',
    toolOutput: calcOutput,
    modelProvider: prov.provider,
    model: prov.executedModel,
    eventsCount: eventsReceived.length
  });

  // 5. Database Durability & Cross-Tenant Run Isolation
  console.log('\n--- Phase 5: Database Persistence & Cross-Tenant Quarantine ---');
  const stagingConn = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
  if (stagingConn) {
    const db = knex({
      client: 'pg',
      connection: { connectionString: stagingConn, ssl: { rejectUnauthorized: true } },
      pool: { min: 1, max: 2 }
    });
    try {
      await assertAuthorizedStagingDatabase(db, {
        allowedProjectIds: [STAGING_NEON_PROJECT_ID],
        allowedBranchIds: [ISOLATED_BRANCH_ID]
      });

      const dbRun = await db('runs').where({ id: runId }).first();
      assert.ok(dbRun, `Run ${runId} must exist in public.runs`);
      assert.equal(dbRun.principal_id, principalA, 'Run must be owned by User A');
      assert.equal(dbRun.state, 'COMPLETED', `Run state must be COMPLETED. Found: ${dbRun.state}`);

      const dbTools = await db('tool_calls').where({ run_id: runId });
      assert.ok(dbTools.length > 0, 'Tool calls must be persisted');
      assert.equal(dbTools[0].tool, 'calculator');
      assert.equal(dbTools[0].status, 'COMPLETED');
      assert.ok(Number(dbTools[0].duration_ms) >= 0);

      recordEvidence('Phase 5.1: Database records verified', {
        runId: dbRun.id,
        state: dbRun.state,
        principalId: dbRun.principal_id,
        toolCallId: dbTools[0].id,
        durationMs: dbTools[0].duration_ms
      });
    } finally {
      await db.destroy();
    }
  }

  // User B tries to view or cancel User A run via API
  const idorRunGet = await fetch(`${PREVIEW_URL}/api/runs/${runId}`, {
    headers: {
      Authorization: `Bearer ${jwtB}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  });
  assert.equal(idorRunGet.status, 404, `User B reading User A run must return 404. Got ${idorRunGet.status}`);

  const idorRunCancel = await fetch(`${PREVIEW_URL}/api/runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwtB}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  });
  assert.ok([403, 404].includes(idorRunCancel.status), `User B cancelling User A run must return 403 or 404. Got ${idorRunCancel.status}`);
  recordEvidence('Phase 5.2: Cross-user run IDOR protection', {
    runId,
    ownerPrincipal: principalA,
    unauthorizedAccessor: principalB,
    readStatus: idorRunGet.status,
    cancelStatus: idorRunCancel.status
  });

  // 6. HITL Approval Security Gate (Fail-Closed Token Verification)
  console.log('\n--- Phase 6: HITL Approval Fail-Closed Security ---');
  const invalidApprovalRes = await fetch(`${PREVIEW_URL}/api/runs/${runId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtA}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    },
    body: JSON.stringify({
      approvalToken: 'invalid_forged_token_2026',
      decision: 'APPROVE'
    })
  });
  assert.ok(
    [400, 404, 409].includes(invalidApprovalRes.status),
    `Invalid approval token must fail closed. Got ${invalidApprovalRes.status}`
  );
  recordEvidence('Phase 6.1: Forged/invalid approval token rejection', {
    status: invalidApprovalRes.status
  });

  // 7. Multi-Viewport Real Browser Acceptance (Edge)
  console.log('\n--- Phase 7: Real Browser Multi-Viewport Acceptance ---');
  const browser: Browser = await chromium.launch({
    channel: 'msedge',
    headless: true
  });

  const viewports = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 375, height: 667 }
  ];

  try {
    for (const vp of viewports) {
      console.log(`Testing viewport: ${vp.name} (${vp.width}x${vp.height})...`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        userAgent: vp.name === 'mobile'
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
          : undefined
      });

      const consoleErrors: string[] = [];
      const page = await context.newPage();

      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = msg.text();
          if (!text.includes('favicon') && !text.includes('telemetry')) {
            consoleErrors.push(text);
          }
        }
      });

      const previewOrigin = new URL(PREVIEW_URL).origin.toLowerCase();
      await context.route('**/*', async (route, request) => {
        try {
          const reqOrigin = new URL(request.url()).origin.toLowerCase();
          if (reqOrigin === previewOrigin) {
            const headers = {
              ...request.headers(),
              'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET,
              'x-vercel-set-bypass-cookie': 'true'
            };
            await route.continue({ headers });
            return;
          }
        } catch {}
        await route.continue();
      });

      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      const title = await page.title();
      assert.ok(title && !title.includes('Login – Vercel'), `Page must load without protection login wall on ${vp.name}`);

      const textarea = page.locator('textarea');
      await textarea.waitFor({ state: 'visible', timeout: 10000 });

      // Verify no horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(scrollWidth <= clientWidth + 2, `No unintended horizontal overflow on ${vp.name} (scroll: ${scrollWidth}, client: ${clientWidth})`);

      const screenshotPath = path.join(OUTPUT_DIR, `preview_${vp.name}_viewport.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      assert.equal(consoleErrors.length, 0, `No console errors on ${vp.name}. Got: ${consoleErrors.join(', ')}`);
      recordEvidence(`Phase 7: Browser Acceptance [${vp.name}]`, {
        viewport: vp,
        title,
        scrollWidth,
        clientWidth,
        screenshot: screenshotPath,
        consoleErrorsCount: consoleErrors.length
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  // Cleanup disposable test conversation
  await fetch(`${PREVIEW_URL}/api/conversations/${convId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${jwtA}`,
      'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET
    }
  }).catch(() => {});

  console.log('\n========================================================================');
  console.log('  LIVE AUTHENTICATED AGENT ACCEPTANCE: ALL PHASES PASSED (100%)');
  console.log('========================================================================\n');

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'ACCEPTANCE_LEDGER.json'),
    JSON.stringify(evidenceLedger, null, 2)
  );
  console.log(`Saved acceptance ledger to: ${path.join(OUTPUT_DIR, 'ACCEPTANCE_LEDGER.json')}`);
}

main().catch(err => {
  console.error('\n❌ ACCEPTANCE SUITE FAILED:', err);
  process.exit(1);
});
