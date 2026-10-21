import test from 'node:test';
import assert from 'node:assert/strict';
import { LightningSandboxProvider } from '../packages/builder-runtime/src/lightning-provider.js';

test('[MOCKED] LightningSandboxProvider: fails closed when API key is missing', async () => {
  const provider = new LightningSandboxProvider({ apiKey: '' });
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(
    async () => provider.createWorkspace({ allowInternet: false, allowPreview: false, timeoutMs: 1000 }),
    /LIGHTNING_SANDBOX_API_KEY/
  );
  await assert.rejects(
    async () => provider.reconnectWorkspace('sb-1'),
    /LIGHTNING_SANDBOX_API_KEY/
  );
});

test('[MOCKED] LightningSandboxProvider: project ID resolution matches teamspace name and caches result', async () => {
  const originalFetch = globalThis.fetch;
  let membershipFetchCount = 0;

  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = String(input);
    if (urlStr.includes('/v1/memberships')) {
      membershipFetchCount++;
      return new Response(JSON.stringify({
        memberships: [
          { name: 'other-team', display_name: 'Other', project_id: 'proj-other' },
          { name: 'aira-ai-2026', display_name: 'aira-ai-2026', project_id: 'proj-aira-expected' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    const provider = new LightningSandboxProvider({
      apiKey: 'test-key',
      teamspace: 'rajpunkeshwarrajgautam-org/aira-ai-2026',
      baseUrl: 'https://mock.lightning.ai'
    });

    const id1 = await provider.resolveProjectId();
    assert.equal(id1, 'proj-aira-expected');
    assert.equal(membershipFetchCount, 1);

    // Second call must use cache
    const id2 = await provider.resolveProjectId();
    assert.equal(id2, 'proj-aira-expected');
    assert.equal(membershipFetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('[MOCKED] LightningSandboxProvider: symlink escape is rejected by remote validation', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? String(init.body) : '';

    if (urlStr.includes('/commands') && method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      const cmdStr = (parsed.command === 'sh' ? (parsed.args?.[1] || '') : parsed.command) || '';
      // If symlink check script, simulate assertion failure in python
      if (cmdStr.includes('pathlib')) {
        return new Response(JSON.stringify({
          cmd_id: 'cmd-symlink-fail',
          exit_code: 1,
          output: 'AssertionError: Path escapes workspace through a symlink\n'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    const provider = new LightningSandboxProvider({
      apiKey: 'test-key',
      baseUrl: 'https://mock.lightning.ai'
    });

    const dummyWorkspace = { id: 'sb-test', provider: 'lightning' };
    await assert.rejects(
      async () => provider.writeFile(dummyWorkspace, 'symlink-target', 'payload'),
      /Workspace path validation failed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('[MOCKED] LightningSandboxProvider: command execution timeout reaches controller signal', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('AbortError: Command timeout')), { once: true });
    });
  };

  try {
    const provider = new LightningSandboxProvider({
      apiKey: 'test-key',
      baseUrl: 'https://mock.lightning.ai'
    });

    const dummyWorkspace = { id: 'sb-test', provider: 'lightning' };
    await assert.rejects(
      async () => provider.runCommand(dummyWorkspace, 'sleep 100', { timeoutMs: 50 }),
      /timeout/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
