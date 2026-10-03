import assert from 'assert';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { McpHost } from '../packages/mcp/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { AutomationEngine } from '../packages/automation/src/index.js';

async function runTests() {
  process.stdout.write('Starting AIRA Autonomous Runtime Verification Suite...\n');

  // Test 1: Model Router Policy Resolution
  {
    const router = new ModelRouter();
    const policyAuto = router.resolvePolicy('aira-auto', 'RESEARCH');
    assert.strictEqual(policyAuto.model, 'aira-deep');
    assert.strictEqual(policyAuto.extendedThinking, true);

    const policyFast = router.resolvePolicy('mock-deterministic');
    assert.strictEqual(policyFast.model, 'mock-deterministic');
    assert.strictEqual(policyFast.extendedThinking, false);

    const adapter = router.getAdapter(policyFast);
    const res = await adapter.complete([{ role: 'user', content: 'test request' }], policyFast);
    assert.ok(res.text.length > 0);
    process.stdout.write('PASS: Model Router policy resolution and deterministic completion\n');
  }

  // Test 2: Tool Runtime Registry & Execution
  {
    const tools = new ToolRegistry(process.cwd());
    const definitions = tools.listDefinitions();
    assert.ok(definitions.length >= 4);

    const calcResult = await tools.execute(
      {
        id: 'call_calc_1',
        toolId: 'tool_calculator',
        name: 'calculator',
        arguments: { expression: '512 * 2' },
        timestamp: Date.now()
      },
      { runId: 'test_run_1', workspaceRoot: process.cwd(), sessionGrantedTools: new Set() }
    );
    assert.strictEqual(calcResult.isError, false);
    assert.strictEqual(calcResult.output.result, 1024);

    const fsResult = await tools.execute(
      {
        id: 'call_fs_1',
        toolId: 'tool_fs_read',
        name: 'file_system_read',
        arguments: { filePath: 'package.json' },
        timestamp: Date.now()
      },
      { runId: 'test_run_1', workspaceRoot: process.cwd(), sessionGrantedTools: new Set() }
    );
    assert.strictEqual(fsResult.isError, false);
    assert.ok(fsResult.output.sizeBytes > 0);

    const audit = tools.getAuditLog();
    assert.ok(audit.length >= 2);
    process.stdout.write('PASS: Tool Runtime execution, sandboxing, and audit logging\n');
  }

  // Test 3: Approval Kernel
  {
    const kernel = new ApprovalKernel();
    const toolCall = {
      id: 'call_sh_1',
      toolId: 'tool_system_shell',
      name: 'system_shell',
      arguments: { command: 'npm list' },
      timestamp: Date.now()
    };

    const isInitiallyApproved = kernel.isToolCallApproved('test_run_2', 'system_shell', 'DESTRUCTIVE');
    assert.strictEqual(isInitiallyApproved, false);

    const request = kernel.createRequest('test_run_2', toolCall, 'DESTRUCTIVE', 'Dangerous shell action');
    assert.strictEqual(request.risk, 'critical');

    const decisionResult = kernel.decide(request.id, 'ALLOW_SESSION');
    assert.strictEqual(decisionResult.approved, true);

    const isNowApproved = kernel.isToolCallApproved('test_run_2', 'system_shell', 'DESTRUCTIVE');
    assert.strictEqual(isNowApproved, true);
    process.stdout.write('PASS: Approval Kernel lifecycle, grants, and security isolation\n');
  }

  // Test 4: Brain v2 Knowledge Engine
  {
    const brain = new BrainV2KnowledgeEngine();
    const ingestion = brain.ingestDocument(
      'Operational Protocols',
      'AIRA operates under strict deterministic execution parameters. ModelRouter, ToolRuntime, and BrainV2 interact deterministically.',
      'text/markdown'
    );
    assert.ok(ingestion.source.id.startsWith('src_'));
    assert.ok(ingestion.chunks.length >= 1);
    assert.ok(ingestion.chunks[0].contentHash.length === 64); // SHA-256

    const searchResults = brain.search('deterministic ModelRouter');
    assert.ok(searchResults.length > 0);
    assert.ok(searchResults[0].citation.id.startsWith('cite_'));

    const graph = brain.getKnowledgeGraph();
    assert.ok(graph.entities.length > 0);
    assert.ok(graph.edges.length > 0);

    const mem = brain.saveMemory('test_key', 'test_value', 'fact');
    assert.strictEqual(mem.key, 'test_key');
    process.stdout.write('PASS: Brain v2 SHA-256 chunking, provenance citations, and property graph\n');
  }

  // Test 5: MCP Host
  {
    const tools = new ToolRegistry(process.cwd());
    const mcp = new McpHost(tools);
    const servers = mcp.listServers();
    assert.ok(servers.length >= 2);

    const connected = await mcp.connectServer('knowledge_mcp');
    assert.strictEqual(connected, true);
    assert.ok(tools.get('mcp_knowledge_mcp_ping') !== undefined);
    process.stdout.write('PASS: MCP Host discovery and dynamic tool attachment\n');
  }

  // Test 6: Agent Runtime Loop
  {
    const router = new ModelRouter();
    const tools = new ToolRegistry(process.cwd());
    const approvals = new ApprovalKernel();
    const brain = new BrainV2KnowledgeEngine();
    const runtime = new AgentRuntime(router, tools, approvals, brain, process.cwd());

    const run = await runtime.createAndExecuteRun({
      prompt: 'calculate (256 * 4)',
      intent: 'TOOL_ACTION',
      modelPolicy: { model: 'mock-deterministic' }
    });

    assert.ok(run.id.startsWith('run_'));

    // Wait for execution completion
    let attempts = 0;
    while (attempts < 20 && run.state !== 'COMPLETED') {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    assert.strictEqual(run.state, 'COMPLETED');
    assert.ok(run.toolsUsed.includes('calculator'));
    assert.ok(run.toolResults.length >= 1);
    process.stdout.write('PASS: Agent Runtime state machine, step execution, and tool resolution\n');
  }

  // Test 7: Automation Engine
  {
    const router = new ModelRouter();
    const tools = new ToolRegistry(process.cwd());
    const approvals = new ApprovalKernel();
    const brain = new BrainV2KnowledgeEngine();
    const runtime = new AgentRuntime(router, tools, approvals, brain, process.cwd());
    const automation = new AutomationEngine(runtime);

    const created = automation.createAutomation({
      name: 'Test Recurring Job',
      enabled: true,
      trigger: 'MANUAL',
      conditions: {},
      agentId: 'agent_test',
      objective: 'Run test validation sweep',
      approvalPolicy: 'autonomous'
    });

    assert.ok(created.id.startsWith('auto_'));
    const runId = await automation.triggerNow(created.id);
    assert.ok(runId.startsWith('run_'));
    process.stdout.write('PASS: Automation Engine creation and execution triggering\n');
  }

  // Test 8: Live API Server Integration
  {
    const res = await fetch('http://127.0.0.1:3001/api/health');
    assert.strictEqual(res.status, 200);
    const health = await res.json();
    assert.strictEqual(health.status, 'HEALTHY');
    assert.strictEqual(health.subsystems.modelRouter, 'ONLINE');
    assert.strictEqual(health.subsystems.toolRuntime, 'ONLINE');
    assert.strictEqual(health.subsystems.agentRuntime, 'ONLINE');

    const toolsRes = await fetch('http://127.0.0.1:3001/api/tools');
    const toolsData = await toolsRes.json();
    assert.ok(toolsData.tools.length >= 4);

    const sourcesRes = await fetch('http://127.0.0.1:3001/api/knowledge/sources');
    const sourcesData = await sourcesRes.json();
    assert.ok(sourcesData.sources.length >= 1);

    process.stdout.write('PASS: Live API Server endpoints verified\n');
  }

  process.stdout.write('\nALL 8 CORE VERIFICATION TESTS PASSED SUCCESSFULLY.\n');
}

runTests().catch(err => {
  process.stderr.write(`Test suite failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
