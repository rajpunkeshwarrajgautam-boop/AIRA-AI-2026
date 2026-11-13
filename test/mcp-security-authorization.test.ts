import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHost, McpSecurityError, validateMcpUrl, isMcpToolInvocationAuthorized, assertApprovedPublicMcpDestination } from '../packages/mcp/src/index.js';
import { ToolGateway, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';

test('SEC-01 & SEC-02: MCP Management Authorization and Tenant Isolation', async (t) => {
  const toolGateway = new ToolGateway(new InMemoryToolCallRepository());
  const mcpHost = new McpHost(toolGateway);

  await t.test('SEC-01: Non-operator (Free, Plus, Pro) cannot register stdio transport', () => {
    // Attempt by Free user
    assert.throws(
      () => {
        mcpHost.registerServer(
          {
            id: 'malicious_stdio',
            name: 'Malicious stdio',
            transport: 'stdio',
            command: 'node',
            args: ['-e', 'console.log("pwned")']
          },
          { ownerId: 'user_free_123', isOperator: false }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'STDIO_TRANSPORT_RESTRICTED');
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );

    // Attempt by Pro user without operator role
    assert.throws(
      () => {
        mcpHost.registerServer(
          {
            id: 'malicious_stdio_pro',
            name: 'Pro Stdio Attempt',
            transport: 'stdio',
            command: 'calc.exe'
          },
          { ownerId: 'user_pro_999', isOperator: false }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'STDIO_TRANSPORT_RESTRICTED');
        return true;
      }
    );
  });

  await t.test('SEC-01: Operator can register approved stdio command, but unapproved command is rejected', () => {
    // Unapproved command attempt
    assert.throws(
      () => {
        mcpHost.registerServer(
          {
            id: 'unapproved_cmd',
            name: 'Bash Script',
            transport: 'stdio',
            command: 'bash'
          },
          { ownerId: 'operator_1', isOperator: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'UNAPPROVED_COMMAND');
        return true;
      }
    );

    // Command with shell metacharacters is rejected
    assert.throws(
      () => {
        mcpHost.registerServer(
          {
            id: 'shell_injection',
            name: 'Injection Attempt',
            transport: 'stdio',
            command: 'node; rm -rf /'
          },
          { ownerId: 'operator_1', isOperator: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'DANGEROUS_COMMAND');
        return true;
      }
    );

    // Approved command succeeds
    mcpHost.registerServer(
      {
        id: 'approved_operator_mcp',
        name: 'Approved Operator Node Service',
        transport: 'stdio',
        command: 'node',
        args: ['--version']
      },
      { ownerId: 'operator_1', isOperator: true }
    );

    const status = mcpHost.getServerStatus('approved_operator_mcp', { isOperator: true });
    assert.ok(status);
    assert.strictEqual(status.serverId, 'approved_operator_mcp');
  });

  await t.test('SEC-02: Tenant Isolation — Account A cannot view, update, connect, or delete Account B server', async () => {
    // User A registers a legitimate HTTP server
    mcpHost.registerServer(
      {
        id: 'user_a_server',
        name: 'User A Tools',
        transport: 'streamable_http',
        url: 'https://api.external-service.com/mcp',
        headers: {
          authorization: 'Bearer user_a_super_secret_token_12345'
        },
        env: {
          API_KEY: 'secret_key_abc'
        }
      },
      { ownerId: 'user_a', isOperator: false }
    );

    // 1. User B lists servers: must NOT see User A server
    const userBServers = mcpHost.listServers('user_b', false);
    assert.strictEqual(userBServers.some(s => s.id === 'user_a_server'), false);

    // 2. User A lists servers: sees User A server, but SECRETS ARE SCRUBBED
    const userAServers = mcpHost.listServers('user_a', false);
    const serverA = userAServers.find(s => s.id === 'user_a_server');
    assert.ok(serverA);
    assert.strictEqual(serverA.id, 'user_a_server');
    assert.strictEqual(serverA.hasHeaders, true);
    assert.deepStrictEqual(serverA.headerNames, ['authorization']);
    // Secrets must NOT be present on summary
    assert.strictEqual((serverA as any).headers, undefined);
    assert.strictEqual((serverA as any).env, undefined);

    // 3. User B attempts to read configuration of User A server -> DENIED
    assert.throws(
      () => {
        mcpHost.getServerConfig('user_a_server', { ownerId: 'user_b', isOperator: false });
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );

    // 4. User B attempts to delete User A server -> DENIED
    assert.throws(
      () => {
        mcpHost.unregisterServer('user_a_server', { ownerId: 'user_b', isOperator: false });
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'FORBIDDEN');
        return true;
      }
    );

    // 5. User B attempts to overwrite User A server ID -> DENIED
    assert.throws(
      () => {
        mcpHost.registerServer(
          {
            id: 'user_a_server',
            name: 'Hijacked Server',
            transport: 'streamable_http',
            url: 'https://evil.com/mcp'
          },
          { ownerId: 'user_b', isOperator: false }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'TENANT_ISOLATION_VIOLATION');
        return true;
      }
    );

    // 6. User B attempts to disconnect User A server -> DENIED
    await assert.rejects(
      async () => {
        await mcpHost.disconnectServer('user_a_server', { ownerId: 'user_b', isOperator: false });
      },
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'FORBIDDEN');
        return true;
      }
    );

    // 7. User A can unregister their own server
    const deleted = mcpHost.unregisterServer('user_a_server', { ownerId: 'user_a', isOperator: false });
    assert.strictEqual(deleted, true);
  });
});

test('SEC-03: MCP Network Access and SSRF Protection', async (t) => {
  await t.test('Rejects cloud provider metadata addresses', async () => {
    // AWS/GCP/Azure link-local metadata
    await assert.rejects(
      () => validateMcpUrl('http://169.254.169.254/latest/meta-data/'),
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );

    // Google Cloud metadata hostname
    await assert.rejects(
      () => validateMcpUrl('http://metadata.google.internal/computeMetadata/v1/'),
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        assert.strictEqual(err.code, 'SSRF_METADATA_PROHIBITED');
        return true;
      }
    );

    // Alibaba cloud metadata
    await assert.rejects(
      () => validateMcpUrl('http://100.100.100.200/latest/meta-data/'),
      (err: any) => {
        assert.ok(err instanceof McpSecurityError);
        return true;
      }
    );
  });

  await t.test('Rejects loopback addresses and alternate numeric encodings', async () => {
    const loopbacks = [
      'http://127.0.0.1:8080/mcp',
      'http://localhost:3000/mcp',
      'http://2130706433:8080/mcp',      // Dword format for 127.0.0.1
      'http://0177.0.0.1:8080/mcp',       // Octal format for 127.0.0.1
      'http://0x7f000001:8080/mcp',      // Hex format for 127.0.0.1
      'http://0x7f.0.0.1:8080/mcp',      // Dotted hex format
      'http://[::1]:8080/mcp',           // IPv6 loopback
      'http://[::ffff:127.0.0.1]:8080/mcp' // IPv4-mapped IPv6 loopback
    ];

    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllowLocal = process.env.AIRA_ALLOW_LOCAL_MCP;
    process.env.NODE_ENV = 'production';
    process.env.AIRA_ALLOW_LOCAL_MCP = 'true'; // Must not override production safety.
    try {
      for (const url of loopbacks) {
        await assert.rejects(
          () => validateMcpUrl(url),
          (err: any) => {
            assert.ok(err instanceof McpSecurityError, `Failed for ${url}`);
            assert.strictEqual(err.statusCode, 403, `Wrong status for ${url}`);
            return true;
          }
        );
      }
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevAllowLocal === undefined) delete process.env.AIRA_ALLOW_LOCAL_MCP;
      else process.env.AIRA_ALLOW_LOCAL_MCP = prevAllowLocal;
    }
  });

  await t.test('Rejects RFC 1918 private IPv4 networks in production', async () => {
    const privates = [
      'http://10.0.0.1/mcp',
      'http://10.254.1.5:8000/mcp',
      'http://172.16.0.1/mcp',
      'http://172.31.255.254/mcp',
      'http://192.168.0.1/mcp',
      'http://192.168.1.100:9000/mcp',
      'http://100.64.0.1/mcp' // CGNAT
    ];

    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const url of privates) {
        await assert.rejects(
          () => validateMcpUrl(url),
          (err: any) => {
            assert.ok(err instanceof McpSecurityError, `Failed for ${url}`);
            assert.strictEqual(err.code, 'SSRF_PRIVATE_IP_PROHIBITED');
            return true;
          }
        );
      }
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  await t.test('Rejects dangerous and unsupported URL schemes', async () => {
    const dangerous = [
      'file:///etc/passwd',
      'gopher://127.0.0.1:11211/',
      'ftp://example.com/file',
      'dict://127.0.0.1:2628/',
      'javascript:alert(1)'
    ];

    for (const url of dangerous) {
      await assert.rejects(
        () => validateMcpUrl(url),
        (err: any) => {
          assert.ok(err instanceof McpSecurityError);
          return true;
        }
      );
    }
  });

  await t.test('Accepts valid public HTTPS MCP endpoint', async () => {
    // Valid public URL with public DNS record
    const result = await validateMcpUrl('https://api.github.com/mcp');
    assert.ok(result.safeUrl);
    assert.strictEqual(result.safeUrl.hostname, 'api.github.com');
    assert.ok(result.resolvedIps.length > 0);
  });
});


test('SEC-01/02 follow-up: platform MCP resources are operator-only from user-owned management routes', async () => {
  const host = new McpHost(new ToolGateway(new InMemoryToolCallRepository()));
  host.registerServer({
    id: 'platform_managed', name: 'Platform MCP', transport: 'stdio',
    command: 'node', args: ['--version']
  }, { ownerId: 'platform', isOperator: true });

  assert.equal(host.listServers('ordinary_user', false).length, 0);
  assert.equal(host.getServerStatus('platform_managed', { ownerId: 'ordinary_user' }), undefined);
  assert.throws(() => host.unregisterServer('platform_managed', { ownerId: 'ordinary_user' }),
    (e: any) => e instanceof McpSecurityError && e.code === 'FORBIDDEN');
  await assert.rejects(() => host.connectServer('platform_managed', { ownerId: 'ordinary_user' }),
    (e: any) => e instanceof McpSecurityError && e.code === 'FORBIDDEN');
  assert.throws(() => host.getServerConfig('platform_managed', { ownerId: 'ordinary_user' }),
    (e: any) => e instanceof McpSecurityError && e.code === 'FORBIDDEN');
  assert.throws(() => host.registerServer({
    id: 'platform_managed', name: 'Replacement', transport: 'streamable_http',
    url: 'https://public.example/mcp'
  }, { ownerId: 'ordinary_user', isOperator: false }),
    (e: any) => e instanceof McpSecurityError && e.code === 'TENANT_ISOLATION_VIOLATION');
});

test('SEC-02 follow-up: MCP summaries never expose URL userinfo, query secrets or raw paths', () => {
  const host = new McpHost(new ToolGateway(new InMemoryToolCallRepository()));
  host.registerServer({
    id: 'private_url', name: 'Remote', transport: 'streamable_http',
    url: 'https://username:password@service.example/secret/endpoint?api_key=sensitive#fragment',
    headers: { Authorization: 'Bearer secret' }
  }, { ownerId: 'owner_a' });
  const summary = host.listServers('owner_a')[0];
  assert.equal(summary.url, 'https://service.example');
  assert.equal(JSON.stringify(summary).includes('sensitive'), false);
  assert.equal(JSON.stringify(summary).includes('password'), false);
  assert.equal(JSON.stringify(summary).includes('Bearer secret'), false);
  assert.equal(host.listServers('owner_b').length, 0);
});

test('SEC-02 follow-up: execution-time MCP tool ownership applies even to globally registered names', () => {
  const tenant = { id: 's', name: 'S', transport: 'streamable_http' as const, ownerId: 'owner_a' };
  assert.equal(isMcpToolInvocationAuthorized(tenant, { userId: 'owner_a' }), true);
  assert.equal(isMcpToolInvocationAuthorized(tenant, { userId: 'owner_b' }), false);
  assert.equal(isMcpToolInvocationAuthorized(tenant), false);
  const platform = { ...tenant, ownerId: 'platform', isPlatform: true, transport: 'stdio' as const };
  assert.equal(isMcpToolInvocationAuthorized(platform, { userId: 'customer' }), false);
  assert.equal(isMcpToolInvocationAuthorized(platform, { userId: 'admin', roles: ['operator'] }), true);
});

test('SEC-03 follow-up: production egress stays blocked even with an approved hostname', () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorVercel = process.env.VERCEL;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL;
    const hosts = ['service.example', 'service.example,other.example'];
    for (const approvedHosts of hosts) {
      for (const address of [
        'https://service.example/mcp',
        'https://service.example/redirect',
        'http://service.example/mcp'
      ]) {
        assert.throws(
          () => assertApprovedPublicMcpDestination(new URL(address), approvedHosts),
          (e: any) => e instanceof McpSecurityError &&
            e.code === 'MCP_EGRESS_ENFORCEMENT_REQUIRED' &&
            e.statusCode === 503
        );
      }
    }

    // Vercel public runtime is production even when NODE_ENV is overridden.
    process.env.NODE_ENV = 'test';
    process.env.VERCEL = '1';
    assert.throws(
      () => assertApprovedPublicMcpDestination(new URL('https://service.example/mcp'), 'service.example'),
      (e: any) => e instanceof McpSecurityError && e.code === 'MCP_EGRESS_ENFORCEMENT_REQUIRED'
    );
    delete process.env.VERCEL;
    assert.doesNotThrow(() => assertApprovedPublicMcpDestination(new URL('https://service.example/mcp'), ''));
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = priorVercel;
  }
});
