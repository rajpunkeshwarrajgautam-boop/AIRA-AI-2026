import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from '../packages/agent-runtime/src/router.js';
import { ExecutionPrincipal } from '../packages/contracts/src/index.js';

async function testFastPathRouting() {
  console.log('=== P1 TDD: FAST PATH INTENT ROUTING TEST ===');

  const registry = new CapabilityRegistry();
  const router = new ServerIntentRouter(registry);

  const principal: ExecutionPrincipal = {
    userId: 'user_p1_test',
    sessionId: 'session_p1_test',
    roles: ['member'],
    scopes: ['chat:write']
  };

  const normalChatPrompts = [
    'Say hello in one sentence.',
    'What is HTTP in one sentence?',
    'Explain REST briefly.',
    'What is 2 + 2?',
    'Define latency.',
    'What is DNS in simple terms?',
    'How does a compiler work in one sentence?',
    'Name three primary colors.',
    'What is JSON?',
    'Tell me a short one-line joke.',
    'Write a haiku about computers.',
    'Translate "Good morning" to Spanish.'
  ];

  for (const prompt of normalChatPrompts) {
    const t0 = performance.now();
    const decision = await router.route({
      prompt,
      principal
    });
    const elapsed = performance.now() - t0;

    assert.equal(decision.intent, 'ANSWER', `Prompt "${prompt}" must route to ANSWER`);
    assert.equal(decision.executionTarget, 'CHAT_STREAM', `Prompt "${prompt}" executionTarget must be CHAT_STREAM`);
    assert.equal(decision.sideEffectLevel, 'NONE', `Prompt "${prompt}" must have sideEffectLevel NONE`);
    assert.equal(decision.approvalRequired, false, `Prompt "${prompt}" must not require approval`);
    assert.ok(decision.metadata?.fastPath === true, `Prompt "${prompt}" must use fastPath (fastPath === true)`);
    assert.ok(elapsed < 20, `Prompt "${prompt}" routing took ${elapsed.toFixed(1)}ms, expected < 20ms without LLM calls`);
    console.log(`  ✓ "${prompt}": ANSWER (CHAT_STREAM) in ${elapsed.toFixed(1)}ms [fastPath: true]`);
  }

  // Regression check: Non-chat prompts must NOT be misclassified as fast-path ANSWER
  console.log('\nChecking regression gates for non-chat intents...');

  const researchDecision = await router.route({
    prompt: 'What is the current share price of NVIDIA?',
    principal
  });
  assert.equal(researchDecision.intent, 'RESEARCH', 'Live stock quote must route to RESEARCH');

  const automationDecision = await router.route({
    prompt: 'Every Monday send me a weekly report',
    principal
  });
  assert.equal(automationDecision.intent, 'AUTOMATION_CREATE', 'Recurring schedule must route to AUTOMATION_CREATE');

  const destructiveDecision = await router.route({
    prompt: 'rm -rf /var/data',
    principal
  });
  assert.equal(destructiveDecision.intent, 'TOOL_ACTION', 'Destructive command must route to TOOL_ACTION');
  assert.equal(destructiveDecision.approvalRequired, true, 'Destructive command must require approval');

  console.log('ALL P1 FAST PATH ROUTING TESTS PASSED');
}

testFastPathRouting().catch(err => {
  console.error('P1 FAST PATH ROUTING TEST FAILED:', err);
  process.exit(1);
});
