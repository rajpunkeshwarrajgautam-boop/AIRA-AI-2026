/**
 * Local MCP Server Test Fixture for Phase 4A MCP Apps
 * Simulates a local MCP server that provides tools and exports an MCP Application descriptor.
 */
import {
  AIRA_MCP_APP_CONTRACT_VERSION,
  type McpAppDescriptor,
} from '../../packages/contracts/src/mcp-apps.js';

export interface LocalPortfolioState {
  holdings: Array<{ symbol: string; allocation: number; target: number }>;
  totalValue: number;
}

export const LOCAL_MOCK_MCP_SERVER_ID = 'srv_local_portfolio_mgr';

export const LOCAL_MOCK_MCP_TOOLS = [
  {
    name: 'query_portfolio_data',
    description: 'Retrieve real-time portfolio holdings and asset allocations (read-only).',
    parameters: { type: 'object', properties: {} },
    permissionLevel: 'READ',
    sideEffectLevel: 'NONE',
  },
  {
    name: 'update_asset_target',
    description: 'Update the target allocation percentage for an asset symbol (side-effecting).',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        newTarget: { type: 'number' },
      },
      required: ['symbol', 'newTarget'],
    },
    permissionLevel: 'WRITE',
    sideEffectLevel: 'MUTATION',
  },
];

export const LOCAL_MOCK_MCP_APP_DESCRIPTOR: McpAppDescriptor = {
  schemaVersion: AIRA_MCP_APP_CONTRACT_VERSION,
  appId: 'app_mcp_portfolio_rebalancer',
  serverId: LOCAL_MOCK_MCP_SERVER_ID,
  title: 'Portfolio Rebalancer MCP App',
  description: 'Interactive visual allocation dashboard with live rebalance tools.',
  entrypointHtml: `
    <div id="mcp-app-root">
      <h2>Portfolio Rebalancer</h2>
      <div id="holdings-list">Loading holdings...</div>
      <button id="btn-rebalance">Execute Rebalance</button>
    </div>
    <script>
      document.addEventListener('DOMContentLoaded', function() {
        if (window.airaMcpBridge) {
          window.airaMcpBridge.callTool('query_portfolio_data', {})
            .then(function(res) {
              const root = document.getElementById('holdings-list');
              if (root) root.innerHTML = '<pre>' + JSON.stringify(res, null, 2) + '</pre>';
            })
            .catch(function(err) {
              const root = document.getElementById('holdings-list');
              if (root) root.innerText = 'Error: ' + err.message;
            });
        }
      });
    </script>
  `,
  supportedTools: ['query_portfolio_data', 'update_asset_target'],
  displayMode: 'inline',
  capabilities: {
    requiresToolExecution: true,
    requiresStateSync: true,
    readOnly: false,
    maxHeightPx: 650,
  },
  initialState: {
    portfolioId: 'port_123',
    selectedSymbol: 'AAPL',
  },
  textFallback: 'Portfolio Rebalancer MCP App providing interactive asset management tools.',
};
