import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LightningSandboxProvider,
  E2BSandboxProvider,
  OCISandboxProvider,
  MultiProviderSandboxFactory,
  type SandboxProvider,
  type SandboxWorkspace
} from '../packages/builder-runtime/src/sandbox.js';

test('[MOCKED] LightningSandboxProvider contract: create, write, read, list, command, preview, reconnect, terminate', async () => {
  const originalFetch = globalThis.fetch;
  const mockCalls: Array<{ url: string; method?: string; body?: string }> = [];

  const sandboxId = 'sb-test-123';
  const previewEndpoint = 'https://3000-sb-test-123.cloudspaces.litng.ai/';

  // Mock Lightning API endpoints
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const body = init?.body ? String(init.body) : undefined;
    mockCalls.push({ url: urlStr, method, body });

    // Memberships resolver
    if (urlStr.includes('/v1/memberships')) {
      return new Response(JSON.stringify({
        memberships: [
          { name: 'aira-ai-2026', display_name: 'aira-ai-2026', project_id: 'proj-aira-2026' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Create sandbox
    if (urlStr.endsWith('/v1/core/sandboxes') && method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      assert.equal(parsed.runtime, 'node24');
      assert.equal(parsed.instance_type, 'cpu-2');
      assert.equal(parsed.persistent, false);
      assert.deepEqual(parsed.ports, ['3000']);
      return new Response(JSON.stringify({
        id: sandboxId,
        status: 'running',
        port_urls: { '3000': previewEndpoint },
        created_at: new Date().toISOString()
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Get / Reconnect sandbox
    if (urlStr.includes(`/v1/core/sandboxes/${sandboxId}`) && method === 'GET') {
      return new Response(JSON.stringify({
        id: sandboxId,
        status: 'running',
        port_urls: { '3000': previewEndpoint },
        created_at: new Date().toISOString(),
        timeout: '900000'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Run command
    if (urlStr.includes('/commands') && method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      const cmdStr = (parsed.command === 'sh' ? (parsed.args?.[1] || '') : parsed.command) || '';

      // If symlink check script
      if (cmdStr.includes('pathlib')) {
        const isDot = cmdStr.includes(" '.'") || cmdStr.includes(" ''") || cmdStr.endsWith(" '.'");
        return new Response(JSON.stringify({
          cmd_id: 'cmd-symlink-ok',
          exit_code: 0,
          output: isDot ? '/home/user/workspace\n' : '/home/user/workspace/test.txt\n'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // If probe script for preview
      if (cmdStr.includes('urllib.request')) {
        return new Response(JSON.stringify({
          cmd_id: 'cmd-probe',
          exit_code: 0,
          output: 'READY\n'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // If read file base64 script
      if (cmdStr.includes('base64')) {
        return new Response(JSON.stringify({
          cmd_id: 'cmd-read',
          exit_code: 0,
          output: Buffer.from('hello lightning sandbox').toString('base64')
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // If list files json script
      if (cmdStr.includes('scandir')) {
        return new Response(JSON.stringify({
          cmd_id: 'cmd-list',
          exit_code: 0,
          output: JSON.stringify([{ name: 'test.txt', type: 'file' }])
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // General command
      return new Response(JSON.stringify({
        cmd_id: 'cmd-gen',
        exit_code: 0,
        output: 'command-output-ok'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Write file
    if (urlStr.includes('/files') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Stop sandbox
    if (urlStr.includes('/stop') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Delete sandbox
    if (urlStr.includes(`/v1/core/sandboxes/${sandboxId}`) && method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  };

  try {
    const provider = new LightningSandboxProvider({
      apiKey: 'test-mock-lightning-key',
      teamspace: 'rajpunkeshwarrajgautam-org/aira-ai-2026',
      baseUrl: 'https://mock.lightning.ai'
    });

    assert.equal(provider.isConfigured(), true);

    // 1. Create
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: true,
      timeoutMs: 900000
    });
    assert.equal(ws.id, sandboxId);
    assert.equal(ws.provider, 'lightning');
    assert.equal(ws.previewUrl, previewEndpoint);

    // 2. Command
    const cmdResult = await provider.runCommand(ws, 'node --version');
    assert.equal(cmdResult.exitCode, 0);
    assert.equal(cmdResult.stdout, 'command-output-ok');
    assert.equal(cmdResult.provider, 'lightning');

    // 3. Write file
    const writeResult = await provider.writeFile(ws, 'test.txt', 'hello lightning sandbox');
    assert.equal(writeResult.path, 'test.txt');
    assert.equal(writeResult.bytesWritten, 23);

    // 4. Read file
    const readBytes = await provider.readFile(ws, 'test.txt');
    assert.equal(Buffer.from(readBytes).toString('utf8'), 'hello lightning sandbox');

    // 5. List files
    const files = await provider.listFiles(ws, '.');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'test.txt');

    // 6. Preview
    const preview = await provider.startPreview(ws, 3000);
    assert.equal(preview.port, 3000);
    assert.equal(preview.url, previewEndpoint);
    assert.equal(preview.provider, 'lightning');

    // 7. Reconnect
    const reconnected = await provider.reconnectWorkspace(sandboxId);
    assert.equal(reconnected.id, sandboxId);
    assert.equal(reconnected.status, 'running');

    // 8. Terminate
    await provider.terminateWorkspace(ws);
    assert.ok(mockCalls.some(c => c.url.includes('/stop') && c.method === 'POST'));
    assert.ok(mockCalls.some(c => c.url.includes(sandboxId) && c.method === 'DELETE'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('[MOCKED] LightningSandboxProvider: idempotent cleanup tolerates 404 on stop and delete', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || 'GET';
      if (method === 'POST' || method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'sandbox not found' }), { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const provider = new LightningSandboxProvider({
      apiKey: 'test-mock-lightning-key',
      baseUrl: 'https://mock.lightning.ai'
    });

    const dummyWorkspace: SandboxWorkspace = {
      id: 'sb-already-stopped',
      provider: 'lightning'
    };

    // Should NOT throw when stop / delete return 404
    await assert.doesNotReject(async () => {
      await provider.terminateWorkspace(dummyWorkspace);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('[MOCKED] MultiProviderSandboxFactory: primary selection, fallback gating, and OCI boundary', async () => {
  class FakeProvider implements SandboxProvider {
    constructor(readonly name: string, private configured = true, private shouldFail = false) {}
    isConfigured(): boolean { return this.configured; }
    async createWorkspace(): Promise<SandboxWorkspace> {
      if (this.shouldFail) throw new Error(`${this.name} allocation failed`);
      return { id: `ws-${this.name}`, provider: this.name, status: 'running' };
    }
    async reconnectWorkspace(id: string): Promise<SandboxWorkspace> {
      return { id, provider: this.name, status: 'running' };
    }
    async writeFile() { return { path: 'a', bytesWritten: 1 }; }
    async readFile() { return new Uint8Array([1]); }
    async listFiles() { return []; }
    async runCommand() { return { exitCode: 0, stdout: 'ok', stderr: '', provider: this.name }; }
    async startPreview() { return { url: 'https://preview.test/', port: 3000, provider: this.name }; }
    async terminateWorkspace() {}
  }

  const savedProvider = process.env.AIRA_SANDBOX_PROVIDER;
  const savedFallback = process.env.AIRA_SANDBOX_FALLBACK_PROVIDER;

  try {
    // 1. Primary provider success
    process.env.AIRA_SANDBOX_PROVIDER = 'lightning';
    delete process.env.AIRA_SANDBOX_FALLBACK_PROVIDER;

    const lightningMock = new FakeProvider('lightning', true, false);
    const e2bMock = new FakeProvider('e2b', true, false);
    const ociMock = new OCISandboxProvider();

    const factory = new MultiProviderSandboxFactory([lightningMock, e2bMock, ociMock]);
    const sb1 = await factory.create({ allowInternet: false, allowPreview: false, timeoutMs: 10000, signal: new AbortController().signal });
    assert.equal(sb1.provider, 'lightning');

    // 2. Fail closed when fallback is NOT configured
    const failingLightning = new FakeProvider('lightning', true, true);
    const factoryNoFallback = new MultiProviderSandboxFactory([failingLightning, e2bMock, ociMock]);
    await assert.rejects(
      async () => factoryNoFallback.create({ allowInternet: false, allowPreview: false, timeoutMs: 10000, signal: new AbortController().signal }),
      /lightning allocation failed/
    );

    // 3. Fallback when AIRA_SANDBOX_FALLBACK_PROVIDER=e2b is enabled
    process.env.AIRA_SANDBOX_FALLBACK_PROVIDER = 'e2b';
    const factoryWithFallback = new MultiProviderSandboxFactory([failingLightning, e2bMock, ociMock]);
    const sbFallback = await factoryWithFallback.create({ allowInternet: false, allowPreview: false, timeoutMs: 10000, signal: new AbortController().signal });
    assert.equal(sbFallback.provider, 'e2b');

    // 4. Connect routes to specified provider
    const connectedE2B = await factory.connect('ws-e2b-1', undefined, 'e2b');
    assert.equal(connectedE2B.provider, 'e2b');

    // 5. OCI provider fails deterministically
    assert.equal(ociMock.isConfigured(), false);
    await assert.rejects(async () => ociMock.createWorkspace({ allowInternet: false, allowPreview: false, timeoutMs: 10000 }), /OCI Sandbox Provider is not active/);
    await assert.rejects(async () => ociMock.reconnectWorkspace('ws-oci'), /OCI Sandbox Provider is not active/);
  } finally {
    if (savedProvider) process.env.AIRA_SANDBOX_PROVIDER = savedProvider;
    else delete process.env.AIRA_SANDBOX_PROVIDER;
    if (savedFallback) process.env.AIRA_SANDBOX_FALLBACK_PROVIDER = savedFallback;
    else delete process.env.AIRA_SANDBOX_FALLBACK_PROVIDER;
  }
});
