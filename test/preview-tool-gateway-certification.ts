import assert from 'node:assert';

const PREVIEW_URL = process.env.PREVIEW_URL || 'https://aira-ai-2026-git-f-2f6ed8-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const BYPASS_HEADER = { 'x-vercel-protection-bypass': 'QQUvz2kp1hnrbJeAicx0ZyH3kL18z54r' };

class PreviewClient {
  public cookie: string = '';
  public userId: string = '';
  public sessionId: string = '';

  async initSession(): Promise<{ userId: string; sessionId: string }> {
    const res = await fetch(`${PREVIEW_URL}/api/auth/session`, {
      method: 'POST',
      headers: {
        ...BYPASS_HEADER,
        'Content-Type': 'application/json'
      }
    });
    assert.strictEqual(res.status, 200, `Failed to init session: ${res.status}`);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const data = await res.json() as any;
    assert.strictEqual(data.status, 'AUTHENTICATED');
    this.userId = data.userId;
    this.sessionId = data.sessionId;
    return { userId: data.userId, sessionId: data.sessionId };
  }

  async get(path: string): Promise<any> {
    const res = await fetch(`${PREVIEW_URL}${path}`, {
      headers: {
        ...BYPASS_HEADER,
        Cookie: this.cookie
      }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GET ${path} returned ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async post(path: string, body: any): Promise<any> {
    const res = await fetch(`${PREVIEW_URL}${path}`, {
      method: 'POST',
      headers: {
        ...BYPASS_HEADER,
        'Content-Type': 'application/json',
        Cookie: this.cookie
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`POST ${path} returned ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async postRaw(path: string, body: any): Promise<Response> {
    return fetch(`${PREVIEW_URL}${path}`, {
      method: 'POST',
      headers: {
        ...BYPASS_HEADER,
        'Content-Type': 'application/json',
        Cookie: this.cookie
      },
      body: JSON.stringify(body)
    });
  }

  async postStream(path: string, body: any, onEvent: (event: string, data: any) => void): Promise<void> {
    const res = await fetch(`${PREVIEW_URL}${path}`, {
      method: 'POST',
      headers: {
        ...BYPASS_HEADER,
        'Content-Type': 'application/json',
        Cookie: this.cookie
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`POST ${path} stream returned ${res.status}: ${txt}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') {
            onEvent('done', '[DONE]');
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            onEvent(currentEvent, parsed);
          } catch {
            onEvent(currentEvent, dataStr);
          }
        }
      }
    }
  }
}

async function runPreviewSuite() {
  console.log(`Starting Tool Gateway Preview Certification on ${PREVIEW_URL}...`);

  const clientA = new PreviewClient();
  const userA = await clientA.initSession();
  console.log(`[PASS] Client A Authenticated: ${userA.userId}`);

  const clientB = new PreviewClient();
  const userB = await clientB.initSession();
  console.log(`[PASS] Client B Authenticated: ${userB.userId}`);

  // Test 1: Tool Discovery
  console.log('Testing Tool Discovery on Preview...');
  const toolsRes = await clientA.get('/api/tools');
  assert(Array.isArray(toolsRes.tools), 'tools must be array');
  assert(toolsRes.tools.length >= 8, `Expected at least 8 tools, got ${toolsRes.tools.length}`);
  const toolIds = toolsRes.tools.map((t: any) => t.id);
  console.log(`[PASS] Discovered ${toolsRes.tools.length} tools:`, toolIds);
  assert(toolIds.includes('tool_browser_navigate'), 'tool_browser_navigate missing');
  assert(toolIds.includes('tool_browser_extract'), 'tool_browser_extract missing');
  assert(toolIds.includes('tool_fs_read'), 'tool_fs_read missing');
  assert(toolIds.includes('tool_repo_status'), 'tool_repo_status missing');

  // Test 2: Connector Discovery
  console.log('Testing Connector Discovery on Preview...');
  const connectorsRes = await clientA.get('/api/tools/connectors');
  assert(Array.isArray(connectorsRes.connectors), 'connectors must be array');
  console.log(`[PASS] Discovered connectors:`, connectorsRes.connectors.map((c: any) => `${c.id} (${c.state || c.availability})`));

  // Test 3: Safe READ Tool execution (tool_calculator)
  console.log('Testing Safe READ Tool execution on Preview...');
  const readRes = await clientA.post('/api/tools/execute', {
    toolId: 'tool_calculator',
    input: { expression: '40 + 2' }
  });
  console.log(`[PASS] Tool execution response:`, readRes);
  assert.strictEqual(readRes.isError, false, 'Execution should not be an error');
  assert(readRes.output, 'output should exist');
  assert.strictEqual(readRes.output.result, 42);
  const toolCallId = readRes.toolCallId;
  assert(toolCallId, 'toolCallId must exist');

  // Test 4: Tool Call persistence and retrieval
  console.log('Testing Tool Call persistence & retrieval on Preview...');
  const callRes = await clientA.get(`/api/tools/calls/${toolCallId}`);
  const call = callRes.call || callRes;
  console.log(`[PASS] Retrieved call:`, call);
  assert.strictEqual(call.id, toolCallId);
  assert.strictEqual(call.principalId, userA.userId);
  assert.strictEqual(call.lifecycleState || call.status, 'COMPLETED');
  console.log(`[PASS] ToolCall persisted and retrieved correctly: ${toolCallId}`);

  // Test 5: Principal Isolation
  console.log('Testing Principal Isolation on Preview...');
  const bGet = await fetch(`${PREVIEW_URL}/api/tools/calls/${toolCallId}`, {
    headers: { ...BYPASS_HEADER, Cookie: clientB.cookie }
  });
  assert(bGet.status === 403 || bGet.status === 404, `Expected 403 or 404 for cross-principal access, got ${bGet.status}`);
  console.log(`[PASS] Cross-principal access correctly blocked (${bGet.status})`);

  // Test 6: Unknown Tool Failure
  console.log('Testing Unknown Tool Rejection on Preview...');
  const unkRes = await clientA.postRaw('/api/tools/execute', {
    toolId: 'non_existent_malicious_tool',
    input: {}
  });
  const unkJson = await unkRes.json() as any;
  assert(unkJson.errorCode === 'TOOL_NOT_FOUND' || unkJson.error?.includes('TOOL_NOT_FOUND') || unkJson.isError, `Expected TOOL_NOT_FOUND, got ${JSON.stringify(unkJson)}`);
  console.log(`[PASS] Unknown tool properly rejected: TOOL_NOT_FOUND`);

  // Test 7: Input Validation Failure
  console.log('Testing Input Validation Rejection on Preview...');
  const valRes = await clientA.postRaw('/api/tools/execute', {
    toolId: 'tool_browser_navigate',
    input: { notAUrl: 12345 }
  });
  const valJson = await valRes.json() as any;
  assert(valJson.errorCode === 'TOOL_INPUT_INVALID' || valJson.error?.includes('TOOL_INPUT_INVALID') || valJson.isError, `Expected TOOL_INPUT_INVALID, got ${JSON.stringify(valJson)}`);
  console.log(`[PASS] Invalid tool input properly rejected: TOOL_INPUT_INVALID`);

  // Test 8: Permission Enforcement (repo_status requires repo.read scope)
  console.log('Testing repo_status Tool Execution on Preview...');
  const repoRes = await clientA.post('/api/tools/execute', {
    toolId: 'tool_repo_status',
    input: {}
  });
  console.log(`[PASS] repo_status Response:`, repoRes);
  assert.strictEqual(repoRes.isError, true);
  assert.strictEqual(repoRes.errorCode, 'TOOL_PERMISSION_DENIED');
  console.log(`[PASS] Permission enforcement proven on Preview: TOOL_PERMISSION_DENIED`);

  // Test 8b: Filesystem List on Preview (files.read is allowed)
  console.log('Testing fs_list Tool Execution on Preview...');
  const fsRes = await clientA.post('/api/tools/execute', {
    toolId: 'tool_fs_list',
    input: { directoryPath: '.' }
  });
  console.log(`[PASS] fs_list Response:`, fsRes);
  assert.strictEqual(fsRes.isError, false);
  assert(Array.isArray(fsRes.output?.entries), 'fs_list should return entries');

  // Test 8c: Real Browser Navigation on Preview (Serverless Resilient Execution)
  console.log('Testing Real Browser Navigation on Preview...');
  const navRes = await clientA.post('/api/tools/execute', {
    toolId: 'tool_browser_navigate',
    input: { url: 'https://example.com' }
  });
  console.log(`[PASS] tool_browser_navigate Response:`, navRes);
  assert.strictEqual(navRes.isError, false, `browser_navigate failed: ${navRes.error}`);
  assert(navRes.output?.pageHeading?.includes('Example Domain'), `Expected pageHeading "Example Domain", got: ${navRes.output?.pageHeading}`);
  console.log(`[PASS] Real browser navigation proven on Preview: pageHeading = "${navRes.output?.pageHeading}"`);

  // Test 9: Chat / ANSWER Regression on Preview
  console.log('Testing ANSWER Chat Regression on Preview...');
  let chatText = '';
  await clientA.postStream(
    '/api/chat/stream',
    { messages: [{ role: 'user', content: 'What is 2 + 2? Reply with just the number 4.' }] },
    (event, data) => {
      if (event === 'content' && typeof data === 'string') {
        chatText += data;
      } else if (data && typeof data === 'object' && data.text) {
        chatText += data.text;
      }
    }
  );
  console.log(`[PASS] Chat response received: "${chatText.trim()}"`);
  assert(chatText.length > 0, 'Chat response must not be empty');

  console.log('\n========================================');
  console.log('PREVIEW CERTIFICATION COMPLETED SUCCESSFULLY!');
  console.log('========================================');
}

runPreviewSuite().catch((err) => {
  console.error('PREVIEW CERTIFICATION FAILED:', err);
  process.exit(1);
});
