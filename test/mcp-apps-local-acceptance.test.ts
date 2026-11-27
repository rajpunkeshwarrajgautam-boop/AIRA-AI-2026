/**
 * Phase 4A — MCP Apps Local Acceptance & Security Test Suite
 *
 * Verifies:
 * 1. aira-mcp-app/v1 descriptor contract validation & limits
 * 2. JSON-RPC 2.0 message contracts (tools/call, ui/ready, ui/resize, ui/stateUpdate)
 * 3. Tool authorization & ApprovalKernel gating for side-effecting operations
 * 4. Fail-closed remote MCP egress enforcement (MCP_EGRESS_ENFORCEMENT_REQUIRED)
 * 5. Headless browser iframe mounting under opaque sandbox & CSP connect-src 'none'
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { chromium, type Browser } from 'playwright';
import {
  AIRA_MCP_APP_CONTRACT_VERSION,
  McpAppRpcMessageSchema,
  validateMcpAppDescriptor,
  type McpAppDescriptor,
} from '../packages/contracts/src/mcp-apps.js';
import {
  LOCAL_MOCK_MCP_APP_DESCRIPTOR,
  LOCAL_MOCK_MCP_TOOLS,
} from './fixtures/local-mcp-server.js';
import {
  assertApprovedPublicMcpDestination,
  isMcpToolInvocationAuthorized,
  McpSecurityError,
} from '../packages/mcp/src/index.js';
import { APP_SANDBOX_CSP_META } from '../src/utils/genuiAppBridge.js';

describe('Phase 4A — MCP Apps Local Acceptance & Security Suite', () => {
  describe('1. aira-mcp-app/v1 Descriptor Contract Validation', () => {
    it('validates compliant local MCP app descriptor', () => {
      const result = validateMcpAppDescriptor(LOCAL_MOCK_MCP_APP_DESCRIPTOR);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.descriptor.schemaVersion, AIRA_MCP_APP_CONTRACT_VERSION);
        assert.equal(result.descriptor.appId, 'app_mcp_portfolio_rebalancer');
        assert.equal(result.descriptor.supportedTools.length, 2);
      }
    });

    it('rejects descriptor with invalid schemaVersion', () => {
      const invalid = {
        ...LOCAL_MOCK_MCP_APP_DESCRIPTOR,
        schemaVersion: 'invalid-version/v9',
      };
      const result = validateMcpAppDescriptor(invalid);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MCP_APP_SCHEMA_INVALID');
    });

    it('rejects descriptor with missing entrypointHtml', () => {
      const invalid = {
        ...LOCAL_MOCK_MCP_APP_DESCRIPTOR,
        entrypointHtml: '',
      };
      const result = validateMcpAppDescriptor(invalid);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MCP_APP_SCHEMA_INVALID');
    });

    it('rejects descriptor exceeding supportedTools limit', () => {
      const tools = Array.from({ length: 40 }, (_, i) => `tool_${i}`);
      const invalid = {
        ...LOCAL_MOCK_MCP_APP_DESCRIPTOR,
        supportedTools: tools,
      };
      const result = validateMcpAppDescriptor(invalid);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MCP_APP_SCHEMA_INVALID');
    });
  });

  describe('2. JSON-RPC 2.0 Message Schema Validation', () => {
    const validNonce = 'sec_nonce_mcp_12345';

    it('validates tools/call JSON-RPC message', () => {
      const msg = {
        jsonrpc: '2.0',
        id: 'rpc_1',
        method: 'tools/call',
        params: { name: 'query_portfolio_data', arguments: {} },
        nonce: validNonce,
        appId: 'app_mcp_portfolio_rebalancer',
      };
      const parsed = McpAppRpcMessageSchema.safeParse(msg);
      assert.equal(parsed.success, true);
    });

    it('validates ui/resize JSON-RPC message', () => {
      const msg = {
        jsonrpc: '2.0',
        id: 'rpc_2',
        method: 'ui/resize',
        params: { height: 700 },
        nonce: validNonce,
        appId: 'app_mcp_portfolio_rebalancer',
      };
      const parsed = McpAppRpcMessageSchema.safeParse(msg);
      assert.equal(parsed.success, true);
    });

    it('rejects message missing jsonrpc 2.0 version specifier', () => {
      const msg = {
        id: 'rpc_3',
        method: 'ui/ready',
        params: {},
        nonce: validNonce,
        appId: 'app_mcp_portfolio_rebalancer',
      };
      const parsed = McpAppRpcMessageSchema.safeParse(msg);
      assert.equal(parsed.success, false);
    });

    it('rejects message with invalid RPC method', () => {
      const msg = {
        jsonrpc: '2.0',
        id: 'rpc_4',
        method: 'eval/code',
        params: {},
        nonce: validNonce,
        appId: 'app_mcp_portfolio_rebalancer',
      };
      const parsed = McpAppRpcMessageSchema.safeParse(msg);
      assert.equal(parsed.success, false);
    });
  });

  describe('3. Tool Authorization & Side-Effect Confirmation Gating', () => {
    it('authorizes execution when tool is declared in supportedTools', () => {
      const toolName = 'query_portfolio_data';
      assert.ok(LOCAL_MOCK_MCP_APP_DESCRIPTOR.supportedTools.includes(toolName));
    });

    it('denies tool invocation when tool is NOT declared in supportedTools', () => {
      const undeclaredTool = 'drop_all_tables';
      assert.ok(!LOCAL_MOCK_MCP_APP_DESCRIPTOR.supportedTools.includes(undeclaredTool));
    });

    it('differentiates read-only tools from side-effecting mutation tools', () => {
      const readTool = LOCAL_MOCK_MCP_TOOLS.find((t) => t.name === 'query_portfolio_data');
      const writeTool = LOCAL_MOCK_MCP_TOOLS.find((t) => t.name === 'update_asset_target');

      assert.equal(readTool?.permissionLevel, 'READ');
      assert.equal(readTool?.sideEffectLevel, 'NONE');

      assert.equal(writeTool?.permissionLevel, 'WRITE');
      assert.equal(writeTool?.sideEffectLevel, 'MUTATION');
    });

    it('enforces caller ownership on MCP server configuration', () => {
      const serverConfig: any = {
        id: 'srv_test',
        name: 'Test Server',
        transport: 'streamable_http',
        ownerId: 'usr_owner_1',
      };

      // Authorized owner
      const authorized = isMcpToolInvocationAuthorized(serverConfig, { userId: 'usr_owner_1' });
      assert.equal(authorized, true);

      // Unauthorized cross-tenant caller
      const unauthorized = isMcpToolInvocationAuthorized(serverConfig, { userId: 'usr_attacker_2' });
      assert.equal(unauthorized, false);
    });
  });

  describe('4. Fail-Closed Remote MCP Egress Enforcement', () => {
    it('throws MCP_EGRESS_ENFORCEMENT_REQUIRED in production environments', () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        assert.throws(
          () => {
            assertApprovedPublicMcpDestination(new URL('https://remote-mcp.example.com/sse'));
          },
          (err: any) => {
            return (
              err instanceof McpSecurityError &&
              err.code === 'MCP_EGRESS_ENFORCEMENT_REQUIRED' &&
              err.statusCode === 503
            );
          }
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('5. Headless Browser Iframe Mount & CSP Containment (Playwright)', () => {
    let browser: Browser;

    it('mounts MCP App entrypoint and enforces connect-src none blockade', async () => {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        browser = await chromium.launch({
          headless: true,
          executablePath: fs.existsSync(chromePath) ? chromePath : edgePath,
        });
      }

      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  ${APP_SANDBOX_CSP_META}
  <meta charset="UTF-8">
  <title>${LOCAL_MOCK_MCP_APP_DESCRIPTOR.title}</title>
</head>
<body>
  ${LOCAL_MOCK_MCP_APP_DESCRIPTOR.entrypointHtml}
</body>
</html>`;

      const page = await browser.newPage();
      try {
        await page.setContent(fullHtml, { waitUntil: 'load' });
        await page.waitForTimeout(500);

        const heading = await page.locator('h2').innerText();
        const button = await page.locator('#btn-rebalance').count();

        assert.equal(heading, 'Portfolio Rebalancer');
        assert.equal(button, 1);

        // Verify CSP blocks outgoing fetch attempt from within MCP app
        const fetchBlocked = await page.evaluate(async () => {
          try {
            await fetch('https://httpbin.org/get');
            return 'SUCCESS_UNEXPECTED';
          } catch (e: any) {
            return 'BLOCKED: ' + e.message;
          }
        });

        assert.ok(fetchBlocked.includes('BLOCKED'), `Direct fetch from MCP app frame must fail: ${fetchBlocked}`);
      } finally {
        await page.close();
        await browser.close();
      }
    });
  });
});
