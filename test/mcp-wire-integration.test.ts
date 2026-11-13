import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHost, validateMcpUrl, McpSecurityError } from '../packages/mcp/src/index.js';
import { createTestMcpServer } from '../packages/mcp/src/test-server.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

test('Mission D — Real Wire MCP Server Integration, Tool Discovery, and Security Bounds', async (t) => {
  const principal: ExecutionPrincipal = {
    userId: 'user_mcp_wire_test',
    sessionId: 'sess_mcp_wire',
    workspaceId: 'ws_mcp',
    scopes: ['*']
  };

  const toolGateway = new ToolGateway(new InMemoryToolCallRepository());
  const mcpHost = new McpHost(toolGateway);

  const testServer = createTestMcpServer(0);
  let port: number;

  await t.test('1. Start Live MCP Server and Establish Streamable HTTP Connection', async () => {
    port = await testServer.start();
    assert.ok(port > 0, 'Test MCP server must bind to ephemeral port');

    mcpHost.registerServer({
      id: 'srv_calc_real',
      name: 'Calculator & Echo MCP Server',
      url: `http://127.0.0.1:${port}/mcp`,
      transport: 'streamable_http'
    });

    const connected = await mcpHost.connectServer('srv_calc_real');
    assert.equal(connected, true, 'McpHost must connect over Streamable HTTP');

    const status = mcpHost.getServerStatus('srv_calc_real');
    assert.ok(status);
    assert.equal(status.connected, true);
    assert.equal(status.transport, 'streamable_http');
    assert.ok(status.toolCount >= 2);
    assert.ok(status.tools.includes('mcp_srv_calc_real_echo'));
    assert.ok(status.tools.includes('mcp_srv_calc_real_add'));
  });

  await t.test('2. Execute Real Discovered Tools on Live Server with Untrusted Data Tagging', async () => {
    // 1. Execute 'add' tool through ToolGateway
    const addResult = await toolGateway.executeTool(
      'mcp_srv_calc_real_add',
      { a: 19, b: 23 },
      { runId: 'run_mcp_01', taskId: 'task_mcp_01', principal }
    );

    assert.equal(addResult.isError, false);
    assert.equal(addResult.untrustedExternalData, true, 'External MCP output must be tagged untrusted');
    assert.ok(Array.isArray(addResult.output));
    assert.equal(addResult.output[0].text, '42', 'Live wire execution of add(19, 23) must return 42');

    // 2. Execute 'echo' tool through ToolGateway
    const echoResult = await toolGateway.executeTool(
      'mcp_srv_calc_real_echo',
      { message: 'AIRA Live MCP Integration 2026' },
      { runId: 'run_mcp_02', taskId: 'task_mcp_02', principal }
    );

    assert.equal(echoResult.isError, false);
    assert.equal(echoResult.untrustedExternalData, true);
    assert.equal(echoResult.output[0].text, 'AIRA Live MCP Integration 2026');
  });

  await t.test('3. Security Protocol Gate: SSRF and Forbidden Protocols Rejection', async () => {
    mcpHost.registerServer({
      id: 'srv_malicious_proto',
      name: 'Malicious Protocol Endpoint',
      url: 'file:///etc/passwd',
      transport: 'streamable_http'
    });

    const connectResult = await mcpHost.connectServer('srv_malicious_proto');
    assert.equal(connectResult, false, 'Connection to non-HTTP/HTTPS protocol must fail');

    const status = mcpHost.getServerStatus('srv_malicious_proto');
    assert.equal(status?.lastError, 'MCP_CONNECTION_FAILED', 'Public status must never expose raw transport error details');
    await assert.rejects(() => validateMcpUrl('file:///tmp/forbidden'),
      (err: any) => err instanceof McpSecurityError && err.code === 'FORBIDDEN_PROTOCOL');
  });

  await t.test('4. Clean Disconnection, Tool Unregistration, and Teardown', async () => {
    assert.ok(toolGateway.hasTool('mcp_srv_calc_real_add'));
    assert.ok(toolGateway.hasTool('mcp_srv_calc_real_echo'));

    // Disconnect server
    const disconnected = await mcpHost.disconnectServer('srv_calc_real');
    assert.equal(disconnected, true);

    // Verify tools were removed from tool gateway
    assert.equal(toolGateway.hasTool('mcp_srv_calc_real_add'), false);
    assert.equal(toolGateway.hasTool('mcp_srv_calc_real_echo'), false);

    // Shut down HTTP server
    await testServer.close();
  });
});
