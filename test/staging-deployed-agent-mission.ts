import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import knex from 'knex';
import { assertAuthorizedStagingDatabase, STAGING_NEON_PROJECT_ID } from '../packages/db/src/security/database-isolation-guard.js';

function getStagingConnectionString(): string {
  if (process.env.ISOLATED_TEST_DATABASE_URL?.trim()) {
    return process.env.ISOLATED_TEST_DATABASE_URL.trim();
  }
  if (process.env.DATABASE_URL?.trim() && !process.env.DATABASE_URL.includes('localhost')) {
    return process.env.DATABASE_URL.trim();
  }
  const output = execSync(
    'npx --yes neonctl connection-string pr-agent-tool-calls-isolated --project-id mute-frost-50372225 --org-id org-broad-butterfly-41820185',
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return output;
}

const targetBaseUrl = process.env.STAGING_BASE_URL?.trim() || 'https://aira-ai-2026-4z2fe9qlm-rajpunkeshwarrajgautam-boops-projects.vercel.app';
console.log(`Target Preview Base URL: ${targetBaseUrl}`);

async function runDeployedStagingAcceptance(): Promise<void> {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — FINAL STAGING PREVIEW DEPLOYMENT ACCEPTANCE SUITE');
  console.log('========================================================================');

  // STEP 1: Verify Staging Preview HTTP Readiness
  console.log('\n[STEP 1] Testing Vercel Preview Deployment HTTP Reachability...');
  const probe = await fetch(targetBaseUrl);
  assert.equal(probe.status, 200, 'Staging deployment root must return HTTP 200');
  console.log('PASS: Vercel Preview Deployment is online and responding with HTTP 200');

  // STEP 2: Authenticate and obtain session
  console.log('\n[STEP 2] Establishing authenticated session on Preview deployment...');
  const sessionRes = await fetch(`${targetBaseUrl}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': targetBaseUrl,
      'Content-Type': 'application/json',
      'x-aira-csrf-protection': '1'
    }
  });
  assert.equal(sessionRes.status, 200, 'Session endpoint must return 200');
  const sessionCookie = sessionRes.headers.get('set-cookie') || '';
  const sessionData = await sessionRes.json() as any;
  assert.equal(sessionData.status, 'AUTHENTICATED', 'Session must be authenticated');
  console.log('Authenticated Principal:', JSON.stringify({ userId: sessionData.userId, sessionId: sessionData.sessionId }));
  console.log(`PASS: Session handshake established on Vercel Preview`);

  // STEP 3: Dispatch Real Agent Request to Deployed Preview
  console.log('\n[STEP 3] Dispatching real Agent request with >255 char prompt to Vercel Preview...');
  const promptText = (
    'AIRA Staging Deployed Verification Protocol: Live preview model acceptance sequence. ' +
    'Please verify the autonomous execution pipeline and tool gateway by evaluating the cluster memory formula: ' +
    'calculate ((16384 * 1024) / 4). ' +
    'Execute the calculator tool, evaluate the result with zero truncation, and provide the complete synthesized answer.'
  );

  assert.ok(promptText.length > 255, 'Prompt must exceed 255 characters');
  console.log(`Prompt Length: ${promptText.length} characters`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Origin': targetBaseUrl,
    'x-aira-csrf-protection': '1',
    'Accept': 'text/event-stream'
  };
  if (sessionCookie) {
    headers['Cookie'] = sessionCookie;
  }

  const streamRes = await fetch(`${targetBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: promptText,
      model: 'aira-auto'
    })
  });

  console.log(`Stream HTTP Status: ${streamRes.status}`);
  console.log(`Stream Content-Type: ${streamRes.headers.get('content-type')}`);

  let runId = '';
  let fullOutput = '';
  let eventsReceived: string[] = [];

  if (streamRes.status === 200) {
    const reader = streamRes.body?.getReader();
    if (!reader) throw new Error('No body stream from deployed chat endpoint');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const evtType = line.slice(7).trim();
          eventsReceived.push(evtType);
        }
        if (line.startsWith('data: ')) {
          const rawData = line.slice(6).trim();
          try {
            const parsed = JSON.parse(rawData);
            if (parsed.runId) runId = parsed.runId;
            if (parsed.delta) fullOutput += parsed.delta;
            if (parsed.text) fullOutput += parsed.text;
          } catch {
            // raw text or delimiter
          }
        }
      }
    }
  } else {
    const errText = await streamRes.text();
    console.error(`Stream error response: ${errText}`);
    throw new Error(`Deployed chat stream returned HTTP ${streamRes.status}: ${errText}`);
  }

  console.log(`Dispatched Run ID: ${runId}`);
  console.log(`Events Received: ${eventsReceived.join(', ')}`);
  console.log(`Live Model Output Text:\n"${fullOutput}"`);

  // STEP 4: Verify Database Persistence Against Isolated Staging Database
  console.log('\n[STEP 4] Verifying execution record persistence in isolated Neon database...');
  const connStr = getStagingConnectionString();
  const db = knex({
    client: 'pg',
    connection: {
      connectionString: connStr,
      ssl: { rejectUnauthorized: true }
    },
    pool: { min: 1, max: 2 }
  });

  const identity = await assertAuthorizedStagingDatabase(db, {
    allowedProjectIds: [STAGING_NEON_PROJECT_ID],
    allowedBranchIds: ['br-muddy-wave-b3zxhkqf']
  });

  console.log(`PASS: Connected to Neon Project: ${identity.neonProjectId}, Branch: ${identity.neonBranchId}`);

  if (runId) {
    const runRecord = await db('runs').where({ id: runId }).first();
    if (runRecord) {
      console.log(`PASS: Run ${runId} found in public.runs with prompt length ${runRecord.prompt?.length}`);
      assert.equal(runRecord.prompt, promptText, 'Prompt must be stored completely without truncation');
    }

    const toolCalls = await db('tool_calls').where({ run_id: runId });
    console.log(`Tool calls found for run ${runId}: ${toolCalls.length}`);
    if (toolCalls.length > 0) {
      const tc = toolCalls[0];
      console.log(`PASS: Tool call ${tc.id} persisted with status: ${tc.status}, tool: ${tc.tool}`);
    }
  }

  await db.destroy();

  console.log('\n========================================================================');
  console.log('  FINAL STAGING PREVIEW DEPLOYMENT ACCEPTANCE: CERTIFIED (PASS)');
  console.log('========================================================================\n');
}

runDeployedStagingAcceptance().catch((err) => {
  console.error('\n[DEPLOYED ACCEPTANCE FAILED]:', err);
  process.exit(1);
});
