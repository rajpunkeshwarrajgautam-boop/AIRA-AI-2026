import assert from 'assert';
import { McpHost } from '../packages/mcp/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';

async function runTest() {
  const registry = new ToolRegistry();
  const host = new McpHost(registry);

  host.registerServer({
    id: 'test-mcp',
    name: 'test-mcp',
    url: 'http://127.0.0.1:3002/mcp'
  });

  console.log('Connecting to MCP Server...');
  const success = await host.connectServer('test-mcp');
  assert.ok(success, 'Should connect successfully');

  const tools = registry.listDefinitions();
  console.log('Discovered Tools:', tools.map(t => t.name));
  
  assert.ok(tools.some(t => t.name === 'echo'), 'Should register echo tool');
  assert.ok(tools.some(t => t.name === 'add'), 'Should register add tool');

  const addToolDef = tools.find(t => t.name === 'add');
  assert.ok(addToolDef, 'Add tool must exist');

  const addTool = registry.get(addToolDef.name);
  assert.ok(addTool, 'Executable Add tool must exist');

  console.log('Executing add tool...');
  const res = await addTool.execute({ a: 10, b: 25 }, {} as any);
  
  console.log('Result:', res);
  // MCP returns array of content usually:
  // e.g. [{ type: 'text', text: '35' }]
  assert.strictEqual(res.isError, false, 'Should not error');
  assert.ok(Array.isArray(res.output), 'Output should be array');
  assert.strictEqual(res.output[0].text, '35', 'Should compute sum correctly');

  console.log('Disconnecting...');
  await host.disconnectAll();
  console.log('PASS');
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
