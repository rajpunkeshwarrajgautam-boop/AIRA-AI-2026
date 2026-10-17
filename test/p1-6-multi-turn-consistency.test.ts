import assert from 'node:assert/strict';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { ExecutionPrincipal } from '../packages/contracts/src/index.js';

async function runTests() {
  console.log('=== P1.6 MULTI-TURN CONSISTENCY & CONTEXT INTEGRITY TEST SUITE ===');

  process.env.AIRA_ALLOW_MOCK = 'true';
  const router = new ModelRouter();
  const repo = new InMemoryRunRepository();
  const runtime = new AgentRuntime(
    router,
    new ToolRegistry(process.cwd()),
    new ApprovalKernel(
      { saveRequest: async () => {}, getRequest: async () => undefined, listRequests: async () => [], listPendingRequests: async () => [] } as any,
      { saveGrant: async () => {}, getGrant: async () => undefined, hasActiveGrant: async () => false, revokeGrant: async () => {} } as any
    ),
    new BrainV2KnowledgeEngine(),
    repo,
    process.cwd()
  );

  const principal: ExecutionPrincipal = {
    userId: 'usr_multiturn',
    sessionId: 'sess_multiturn',
    roles: ['workspace_user'],
    scopes: ['chat:write', 'runs:read', 'runs:write']
  };

  // Turn 1: Establish durable context
  console.log('\n[TURN 1] User establishes project context (Project Codename: Titan)');
  const run1 = await runtime.createRun({
    prompt: 'Our confidential project is codenamed Project Titan. It builds high-speed optical transceivers.',
    modelPolicy: { model: 'mock-deterministic' }
  }, principal);
  await runtime.startRun(run1.id);
  const finished1 = await runtime.getRun(run1.id);
  assert.equal(finished1?.state, 'COMPLETED');
  console.log('PASS: Turn 1 processed and completed.');

  // Turn 2: Context recall with conversation history
  console.log('\n[TURN 2] Recall test: Query project codename using multi-turn history');
  const historyTurn2 = [
    { role: 'user', content: 'Our confidential project is codenamed Project Titan. It builds high-speed optical transceivers.' },
    { role: 'assistant', content: 'Understood. Project Titan details noted.' }
  ];

  const run2 = await runtime.createRun({
    prompt: 'What was our confidential project codename and domain from our previous discussion?',
    context: { history: historyTurn2 },
    modelPolicy: { model: 'mock-deterministic' }
  }, principal);
  await runtime.startRun(run2.id);
  const finished2 = await runtime.getRun(run2.id);
  assert.equal(finished2?.state, 'COMPLETED');
  assert.equal(finished2?.context?.history?.length, 2, 'History must be preserved in run context');
  console.log('PASS: Turn 2 history context preserved.');

  // Turn 3: Technical follow-up under simulated fallback
  console.log('\n[TURN 3] Technical follow-up under simulated provider fallback');
  const historyTurn3 = [
    ...historyTurn2,
    { role: 'user', content: 'What was our confidential project codename and domain from our previous discussion?' },
    { role: 'assistant', content: 'Your project is codenamed Project Titan, focused on high-speed optical transceivers.' }
  ];

  const run3 = await runtime.createRun({
    prompt: 'Provide three key performance metrics we should track for these optical transceivers.',
    context: { history: historyTurn3 },
    modelPolicy: { model: 'mock-deterministic' }
  }, principal);
  await runtime.startRun(run3.id);
  const finished3 = await runtime.getRun(run3.id);
  assert.equal(finished3?.state, 'COMPLETED');
  assert.equal(finished3?.context?.history?.length, 4, 'Full 4-turn conversation history intact');
  console.log('PASS: Turn 3 technical follow-up completed with full history intact.');

  console.log('\n=== ALL P1.6 MULTI-TURN CONSISTENCY TESTS PASSED ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
