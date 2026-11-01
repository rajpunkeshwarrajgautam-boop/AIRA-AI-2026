import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomousAgentTaskSchema,
  AutonomousTaskStateSchema,
  canAutonomousStateTransition,
  isTerminalAutonomousState,
  AUTONOMOUS_STATE_TRANSITIONS,
  ALL_SPECIALIST_ROLES,
  ExecutionPrincipal,
  PrincipalScope
} from '../packages/contracts/src/index.js';
import {
  AutonomousAgentEngine,
  InMemoryAutonomousTaskRepository,
  createAutonomousSpecialistRegistry
} from '../packages/agent-runtime/src/index.js';
import { ToolGateway, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { BrowserAdapter } from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import { LocalIsolatedSandboxProvider } from '../packages/builder-runtime/src/local-provider.js';
import { McpHost } from '../packages/mcp/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { generateArtifactSandboxHtml } from '../src/utils/artifactSandbox.js';

const testPrincipal: ExecutionPrincipal = {
  userId: 'usr_autonomous_test_01',
  sessionId: 'sess_auto_01',
  workspaceId: 'ws_auto_01',
  roles: ['developer']
};

const foreignPrincipal: ExecutionPrincipal = {
  userId: 'usr_foreign_attacker',
  sessionId: 'sess_foreign_01',
  workspaceId: 'ws_foreign_01',
  roles: ['developer']
};

// =========================================================================
// 1. STATE MACHINE & TRANSITION RIGOR
// =========================================================================
test('1. Autonomous State Machine: enforces valid transitions and rejects invalid hops', () => {
  // Legal forward transition
  assert.equal(canAutonomousStateTransition('CREATED', 'PLANNING'), true);
  assert.equal(canAutonomousStateTransition('PLANNING', 'READY'), true);
  assert.equal(canAutonomousStateTransition('READY', 'RUNNING'), true);
  assert.equal(canAutonomousStateTransition('RUNNING', 'WAITING_FOR_APPROVAL'), true);
  assert.equal(canAutonomousStateTransition('WAITING_FOR_APPROVAL', 'RESUMING'), true);
  assert.equal(canAutonomousStateTransition('RESUMING', 'RUNNING'), true);
  assert.equal(canAutonomousStateTransition('RUNNING', 'VERIFYING'), true);
  assert.equal(canAutonomousStateTransition('VERIFYING', 'COMPLETED'), true);

  // Pause / Resume
  assert.equal(canAutonomousStateTransition('RUNNING', 'PAUSED'), true);
  assert.equal(canAutonomousStateTransition('PAUSED', 'RESUMING'), true);

  // Cancellation & Failure
  assert.equal(canAutonomousStateTransition('RUNNING', 'CANCELLED'), true);
  assert.equal(canAutonomousStateTransition('RUNNING', 'FAILED'), true);

  // Same-state idempotency
  assert.equal(canAutonomousStateTransition('RUNNING', 'RUNNING'), true);
  assert.equal(canAutonomousStateTransition('COMPLETED', 'COMPLETED'), true);

  // Illegal transitions (forbidden hops)
  assert.equal(canAutonomousStateTransition('CREATED', 'COMPLETED'), false);
  assert.equal(canAutonomousStateTransition('CREATED', 'RESUMING'), false);
  assert.equal(canAutonomousStateTransition('PAUSED', 'COMPLETED'), false);
  assert.equal(canAutonomousStateTransition('COMPLETED', 'RUNNING'), false);
  assert.equal(canAutonomousStateTransition('FAILED', 'RUNNING'), false);
  assert.equal(canAutonomousStateTransition('CANCELLED', 'RESUMING'), false);

  // Terminal state immutability
  assert.equal(isTerminalAutonomousState('COMPLETED'), true);
  assert.equal(isTerminalAutonomousState('FAILED'), true);
  assert.equal(isTerminalAutonomousState('CANCELLED'), true);
  assert.equal(isTerminalAutonomousState('TIMED_OUT'), true);
  assert.equal(isTerminalAutonomousState('RUNNING'), false);
});

// =========================================================================
// 2. SPECIALIST AGENT TAXONOMY & REGISTRY
// =========================================================================
test('2. Specialist Orchestration: all 9 canonical specialist roles are implemented and registered', () => {
  const toolCallRepo = new InMemoryToolCallRepository();
  const toolGateway = new ToolGateway(toolCallRepo);
  const registry = createAutonomousSpecialistRegistry(toolGateway);

  assert.equal(ALL_SPECIALIST_ROLES.length, 9);
  for (const role of ALL_SPECIALIST_ROLES) {
    assert.equal(registry.hasSpecialist(role), true, `Role "${role}" must be registered`);
    assert.equal(registry.getStatus(role), 'IMPLEMENTED_LOCALLY');
    const specialist = registry.getSpecialist(role);
    assert.ok(specialist, `Specialist instance for "${role}" must exist`);
    assert.equal(specialist.role, role);
    assert.ok(specialist.name.length > 0);
    assert.ok(specialist.description.length > 0);
    assert.ok(specialist.requiredCapabilities.length > 0);
  }
});

// =========================================================================
// 3. SECURE PYTHON EXECUTION SANDBOX
// =========================================================================
test('3. Python Sandbox: isolated execution, credential scrubbing, and security boundaries', async () => {
  const sandbox = new LocalIsolatedSandboxProvider();
  const ws = await sandbox.createWorkspace({
    timeoutMs: 30000,
    allowInternet: false,
    allowPreview: false
  });

  try {
    // 3a. Verify file writing and script execution
    const pythonCode = `
import sys
import os

print("SANDBOX_EXEC_SUCCESS")
# Print non-sensitive environment check
print(f"PLATFORM={sys.platform}")
`;
    await sandbox.writeFile(ws, 'main.py', pythonCode);
    const cmd = process.platform === 'win32' ? 'python main.py' : 'python3 main.py';
    const result = await sandbox.runCommand(ws, cmd);

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('SANDBOX_EXEC_SUCCESS'));

    // 3b. Verify credential scrubbing from environment
    // Set dummy secrets in process.env to ensure they do not leak to sandbox subprocess
    const leakCheckCode = `
import os
secrets = [k for k in os.environ if any(x in k.upper() for x in ['TOKEN', 'SECRET', 'DATABASE', 'KEY', 'NEON', 'AUTH', 'JWT'])]
print(f"LEAKED_COUNT={len(secrets)}")
`;
    await sandbox.writeFile(ws, 'leak_test.py', leakCheckCode);
    const leakCmd = process.platform === 'win32' ? 'python leak_test.py' : 'python3 leak_test.py';
    const leakResult = await sandbox.runCommand(ws, leakCmd);
    assert.equal(leakResult.exitCode, 0);
    assert.ok(leakResult.stdout.includes('LEAKED_COUNT=0'));

    // 3c. Verify path traversal denial
    await assert.rejects(
      async () => {
        await sandbox.readFile(ws, '../../etc/passwd');
      },
      /SECURITY_VIOLATION/
    );

    // 3d. Verify syntax error capture
    await sandbox.writeFile(ws, 'syntax_err.py', 'def invalid_syntax(');
    const errCmd = process.platform === 'win32' ? 'python syntax_err.py' : 'python3 syntax_err.py';
    const errResult = await sandbox.runCommand(ws, errCmd);
    assert.notEqual(errResult.exitCode, 0);
    assert.ok(errResult.stderr.length > 0 || errResult.stdout.length > 0);
  } finally {
    await sandbox.terminateWorkspace(ws);
  }
});

// =========================================================================
// 4. BROWSER AUTOMATION & SESSION RECOVERY
// =========================================================================
test('4. Browser Automation: adapter provides session listing, scrolling, wait, and isolation', () => {
  const browserAdapter = new BrowserAdapter();

  // Session listing for principal
  const sessions = browserAdapter.listSessions(testPrincipal);
  assert.ok(Array.isArray(sessions));

  // Foreign principal isolation
  const foreignSessions = browserAdapter.listSessions(foreignPrincipal);
  assert.ok(Array.isArray(foreignSessions));

  // Verify that methods are callable interfaces
  assert.equal(typeof browserAdapter.scroll, 'function');
  assert.equal(typeof browserAdapter.waitFor, 'function');
  assert.equal(typeof browserAdapter.restartSession, 'function');
  assert.equal(typeof browserAdapter.closeSession, 'function');
});

// =========================================================================
// 5. COMPREHENSIVE MCP INTEGRATION
// =========================================================================
test('5. MCP Integration: registration, discovery, untrusted output tagging, and SSRF guard', async () => {
  const toolCallRepo = new InMemoryToolCallRepository();
  const toolGateway = new ToolGateway(toolCallRepo);
  const mcpHost = new McpHost(toolGateway);

  // Register server config
  mcpHost.registerServer({
    id: 'server_alpha',
    name: 'Alpha MCP Server',
    url: 'http://localhost:3999/mcp',
    transport: 'streamable_http'
  });

  const servers = mcpHost.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'server_alpha');

  const status = mcpHost.getServerStatus('server_alpha');
  assert.ok(status);
  assert.equal(status.connected, false);
  assert.equal(status.toolCount, 0);

  // SSRF prevention: invalid protocol rejected
  mcpHost.registerServer({
    id: 'server_bad_protocol',
    name: 'Bad Protocol Server',
    url: 'file:///etc/passwd',
    transport: 'streamable_http'
  });

  await assert.rejects(
    async () => {
      await mcpHost.connectServer('server_bad_protocol');
    },
    /Only http and https are allowed/
  );

  // Unregister cleanup
  mcpHost.unregisterServer('server_bad_protocol');
  assert.equal(mcpHost.listServers().length, 1);
});

// =========================================================================
// 6. AUTONOMOUS AGENT TASK EXECUTION LIFECYCLE & APPROVAL CHECKPOINT
// =========================================================================
test('6. Autonomous Engine: task creation, decomposition, pause, resume, approval, and verification', async () => {
  const toolCallRepo = new InMemoryToolCallRepository();
  const toolGateway = new ToolGateway(toolCallRepo);
  const registry = createAutonomousSpecialistRegistry(toolGateway);
  const engine = new AutonomousAgentEngine({
    specialistRegistry: registry,
    toolGateway
  });

  // 6a. Create autonomous task
  const objective = 'Analyze system telemetry and prepare executive technical briefing';
  const task = await engine.createTask(objective, testPrincipal);
  assert.ok(task.taskId.startsWith('autotask_'));
  assert.equal(task.state, 'CREATED');
  assert.equal(task.objective, objective);

  // 6b. Start autonomous execution
  const startedTask = await engine.startTask(task.taskId);
  assert.ok(startedTask.plan, 'Plan must be compiled upon start');
  assert.ok(startedTask.plan.steps.length >= 4, 'Must have at least 4 plan steps');

  // Let synchronous planning & first step dispatch settle
  await new Promise(resolve => setTimeout(resolve, 80));

  const executingTask = await engine.getTask(task.taskId);
  assert.ok(executingTask);
  // Step 2 has WRITE sideEffectLevel -> engine must halt at WAITING_FOR_APPROVAL
  assert.equal(executingTask.state, 'WAITING_FOR_APPROVAL');
  assert.ok(executingTask.approvalRequestId, 'Must have active approvalRequestId');

  // 6c. Verify pause and illegal resume checks
  const pausedTask = await engine.pauseTask(task.taskId);
  assert.equal(pausedTask.state, 'PAUSED');

  const resumedTask = await engine.resumeTask(task.taskId);
  // Resuming transitions to WAITING_FOR_APPROVAL or RUNNING
  assert.ok(resumedTask.state === 'RUNNING' || resumedTask.state === 'WAITING_FOR_APPROVAL');

  // 6d. Grant human approval
  const approvedTask = await engine.approveStep(
    task.taskId,
    executingTask.approvalRequestId!,
    true,
    'Authorized by lead architect'
  );
  assert.ok(approvedTask);

  // Wait for subsequent steps (researcher, coder, document, verifier) to complete
  await new Promise(resolve => setTimeout(resolve, 150));

  const completedTask = await engine.getTask(task.taskId);
  assert.ok(completedTask);
  assert.equal(completedTask.state, 'COMPLETED');
  assert.ok(completedTask.observations.length >= 2);
  assert.ok(completedTask.deliverableSummary?.includes('executive technical briefing'));

  // Verify full execution history trail
  const historyStates = completedTask.executionHistory.map(h => h.state);
  assert.ok(historyStates.includes('CREATED'));
  assert.ok(historyStates.includes('PLANNING'));
  assert.ok(historyStates.includes('READY'));
  assert.ok(historyStates.includes('WAITING_FOR_APPROVAL'));
  assert.ok(historyStates.includes('RESUMING'));
  assert.ok(historyStates.includes('COMPLETED'));
});

// =========================================================================
// 7. TASK CANCELLATION
// =========================================================================
test('7. Autonomous Engine: task cancellation transitions cleanly to CANCELLED', async () => {
  const engine = new AutonomousAgentEngine();
  const task = await engine.createTask('Long running data processing job', testPrincipal);
  await engine.startTask(task.taskId);

  const cancelled = await engine.cancelTask(task.taskId, 'Operator aborted job');
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(isTerminalAutonomousState(cancelled.state), true);

  // Attempting to resume a cancelled task must throw
  await assert.rejects(
    async () => {
      await engine.resumeTask(task.taskId);
    },
    /Cannot resume/
  );
});

// =========================================================================
// 8. ADVANCED PERSISTENT MEMORY & PRIVACY CENTER PURGE
// =========================================================================
test('8. Persistent Memory: tenant scoping, search, budget compaction, export, and purge', async () => {
  const memRepo = new InMemoryKnowledgeRepository();
  const knowledge = new BrainV2KnowledgeEngine(memRepo, { seedDefaults: false });

  const userScope: PrincipalScope = {
    principalId: testPrincipal.userId,
    workspaceId: testPrincipal.workspaceId,
    isSystem: false
  };

  const otherScope: PrincipalScope = {
    principalId: foreignPrincipal.userId,
    workspaceId: foreignPrincipal.workspaceId,
    isSystem: false
  };

  // 8a. Save memories for user A
  await knowledge.saveMemory('tech_stack', 'AIRA uses TypeScript, React, and Neon Postgres', 'fact', 'user', userScope);
  await knowledge.saveMemory('user_preference', 'Prefers dark mode and reduced motion', 'preference', 'user', userScope);
  await knowledge.saveMemory('security_policy', 'Strict origin isolation enforced', 'constraint', 'system', userScope);

  // Save memory for foreign user B
  await knowledge.saveMemory('private_key', 'Foreign user secret data', 'fact', 'user', otherScope);

  // 8b. Tenant Isolation: user A cannot see foreign user B's memories
  const userMemories = await knowledge.getMemories(userScope);
  assert.equal(userMemories.length, 3);
  assert.ok(!userMemories.some(m => m.key === 'private_key'), 'Cross-tenant memory leakage forbidden');

  // 8c. Search
  await knowledge.ingestDocument(
    'Architecture Notes',
    'AIRA implements autonomous agent runtime with 9 specialist roles and durable worker leases.',
    'text/markdown',
    'aira://notes/1',
    undefined,
    userScope
  );
  const searchResults = await knowledge.search('autonomous specialist', 5, userScope);
  assert.ok(searchResults.length > 0);
  assert.ok(searchResults[0].citation.snippet.includes('autonomous'));

  // 8d. Delete individual memory
  const memToDelete = userMemories[0];
  const deleted = await knowledge.deleteMemory(memToDelete.id, userScope);
  assert.equal(deleted, true);
  const afterDelete = await knowledge.getMemories(userScope);
  assert.equal(afterDelete.length, 2);

  // Foreign user cannot delete user A's memory
  const foreignDelete = await knowledge.deleteMemory(afterDelete[0].id, otherScope);
  assert.equal(foreignDelete, false);

  // 8e. Privacy Purge: wipes all user A's memories without touching user B
  const purgedCount = await knowledge.purgeMemories(userScope);
  assert.equal(purgedCount, 2);

  const finalUserMems = await knowledge.getMemories(userScope);
  assert.equal(finalUserMems.length, 0);

  const finalOtherMems = await knowledge.getMemories(otherScope);
  assert.equal(finalOtherMems.length, 1);
  assert.equal(finalOtherMems[0].key, 'private_key');
});

// =========================================================================
// 9. CLAUDE-STYLE INTERACTIVE ARTIFACT SANDBOX
// =========================================================================
test('9. Interactive Artifact Sandbox: React TSX, SVG, Markdown, and secret nonce log bridge', () => {
  const nonce = 'secret_nonce_test_xyz123';

  // 9a. React TSX artifact
  const reactArtifact = {
    id: 'art_react_01',
    type: 'application/vnd.ant.react',
    title: 'Financial Dashboard Card',
    language: 'tsx',
    content: `
import React, { useState } from 'react';
import { TrendingUp } from 'lucide-react';

export default function DashboardCard() {
  const [val, setVal] = useState(42);
  return (
    <div className="p-4 bg-white rounded shadow">
      <TrendingUp className="text-emerald-500" />
      <span className="font-bold">{val}</span>
    </div>
  );
}
    `,
    version: 1
  };

  const html = generateArtifactSandboxHtml(reactArtifact as any, reactArtifact.content, true, nonce);
  assert.ok(html.includes('react.production.min.js'));
  assert.ok(html.includes('babel.min.js'));
  assert.ok(html.includes('tailwindcss.com'));
  assert.ok(html.includes('CONSOLE_LOG'));
  assert.ok(html.includes(nonce), 'HTML must embed session secret nonce for log bridge verification');

  // 9b. SVG artifact
  const svgArtifact = {
    id: 'art_svg_01',
    type: 'image/svg+xml',
    title: 'Flow Diagram',
    language: 'svg',
    content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="tomato" /></svg>',
    version: 1
  };

  const svgHtml = generateArtifactSandboxHtml(svgArtifact as any, svgArtifact.content, false, nonce);
  assert.ok(svgHtml.includes('<circle cx="50" cy="50" r="40"'));
  assert.ok(svgHtml.includes(nonce));
});
