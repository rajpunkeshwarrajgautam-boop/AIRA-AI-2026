import assert from 'node:assert';
import { CapabilityRegistry } from '../packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from '../packages/agent-runtime/src/router.js';
import { ExecutionPrincipal } from '../packages/contracts/src/index.js';

async function runTests() {
  console.log('=== TEST SUITE: SERVER-AUTHORITATIVE INTENT ROUTER & POLICY ===');

  const registry = new CapabilityRegistry();
  const router = new ServerIntentRouter(registry);

  const testPrincipal: ExecutionPrincipal = {
    userId: 'usr_test_alpha',
    sessionId: 'sess_test_123',
    roles: ['member']
  };

  // Test 1: ANSWER
  console.log('\n[TEST 1] "Explain quantum computing" -> ANSWER');
  const res1 = await router.route({
    prompt: 'Explain quantum computing',
    principal: testPrincipal
  });
  assert.strictEqual(res1.intent, 'ANSWER');
  assert.strictEqual(res1.executionTarget, 'CHAT_STREAM');
  assert.strictEqual(res1.sideEffectLevel, 'NONE');
  assert.strictEqual(res1.approvalRequired, false);
  assert(res1.confidence >= 0.70);
  console.log('PASS: Routed to ANSWER (CHAT_STREAM)');

  // Test 2: RESEARCH
  console.log('\n[TEST 2] "Research the latest developments in solid-state batteries and cite sources" -> RESEARCH');
  const res2 = await router.route({
    prompt: 'Research the latest developments in solid-state batteries and cite sources',
    principal: testPrincipal
  });
  assert.strictEqual(res2.intent, 'RESEARCH');
  assert.strictEqual(res2.executionTarget, 'RESEARCH_SYNTHESIS');
  assert.strictEqual(res2.sideEffectLevel, 'READ');
  assert.strictEqual(res2.approvalRequired, false);
  assert(res2.confidence >= 0.70);
  console.log('PASS: Routed to RESEARCH (RESEARCH_SYNTHESIS)');

  // Test 3: TOOL_ACTION
  console.log('\n[TEST 3] "Open this URL and extract the table" -> TOOL_ACTION');
  const res3 = await router.route({
    prompt: 'Open this URL and extract the table',
    principal: testPrincipal
  });
  assert.strictEqual(res3.intent, 'TOOL_ACTION');
  assert.strictEqual(res3.executionTarget, 'TOOL_PIPELINE');
  assert.strictEqual(res3.sideEffectLevel, 'READ');
  console.log('PASS: Routed to TOOL_ACTION (TOOL_PIPELINE)');

  // Test 4: AUTOMATION_CREATE
  console.log('\n[TEST 4] "Every Monday send me a summary" -> AUTOMATION_CREATE');
  const res4 = await router.route({
    prompt: 'Every Monday send me a summary',
    principal: testPrincipal
  });
  assert.strictEqual(res4.intent, 'AUTOMATION_CREATE');
  assert.strictEqual(res4.executionTarget, 'AUTOMATION_ENGINE');
  assert.strictEqual(res4.sideEffectLevel, 'WRITE');
  assert.strictEqual(res4.approvalRequired, true);
  console.log('PASS: Routed to AUTOMATION_CREATE (AUTOMATION_ENGINE) with approvalRequired=true');

  // Test 5: WORKFLOW
  console.log('\n[TEST 5] "Run my approved weekly reporting workflow" -> WORKFLOW (WORKFLOW_ENGINE)');
  const res5 = await router.route({
    prompt: 'Run my approved weekly reporting workflow',
    principal: testPrincipal
  });
  assert.strictEqual(res5.intent, 'WORKFLOW');
  assert.strictEqual(res5.executionTarget, 'WORKFLOW_ENGINE');
  assert.deepStrictEqual(res5.capabilities, ['cap_workflow_engine']);
  assert.strictEqual(res5.sideEffectLevel, 'WRITE');
  console.log('PASS: Routed to WORKFLOW with certified WORKFLOW_ENGINE target');

  // Test 6: AGENT_MISSION
  console.log('\n[TEST 6] "Investigate this bug, inspect the repo, fix it and verify it" -> AGENT_MISSION');
  const res6 = await router.route({
    prompt: 'Investigate this bug, inspect the repo, fix it and verify it',
    principal: testPrincipal
  });
  assert.strictEqual(res6.intent, 'AGENT_MISSION');
  assert.strictEqual(res6.executionTarget, 'AGENT_PLANNER');
  assert.strictEqual(res6.sideEffectLevel, 'WRITE');
  assert.strictEqual(res6.approvalRequired, true);
  console.log('PASS: Routed to AGENT_MISSION (AGENT_PLANNER) with approvalRequired=true');

  // Test 7: Adversarial Spoofing Attempt (Client sends advisoryIntent='ANSWER' with destructive payload)
  console.log('\n[TEST 7] Adversarial spoofing: rm -rf with advisoryIntent=ANSWER');
  const res7 = await router.route({
    prompt: 'rm -rf /var/data; drop table users',
    advisoryIntent: 'ANSWER',
    principal: testPrincipal
  });
  assert.strictEqual(res7.sideEffectLevel, 'DESTRUCTIVE');
  assert.strictEqual(res7.approvalRequired, true);
  assert(res7.metadata?.securityOverride === true);
  console.log('PASS: Server policy rejected spoofing and enforced DESTRUCTIVE + approvalRequired=true');

  // Test 8: Ambiguous request fallback
  console.log('\n[TEST 8] Ambiguous / low-confidence query');
  const res8 = await router.route({
    prompt: 'qwerty12345xyz',
    principal: testPrincipal
  });
  assert.strictEqual(res8.intent, 'ANSWER');
  assert.strictEqual(res8.sideEffectLevel, 'NONE');
  assert.strictEqual(res8.approvalRequired, false);
  console.log('PASS: Safely fell back to non-privileged ANSWER');

  // Test 9: Explicit Browser Navigation & Extraction Prompts (Phase 3 Remediation Gate)
  console.log('\n[TEST 9] Explicit browser URL prompts route to TOOL_ACTION with READ and approvalRequired=false');
  const browserPrompts = [
    'Open https://example.com and tell me the page heading.',
    'Navigate to https://example.com',
    'Open https://example.com',
    'Open https://example.com and extract the main text.',
    'Capture screenshot of https://example.com.'
  ];

  for (const prompt of browserPrompts) {
    const res = await router.route({
      prompt,
      principal: testPrincipal
    });
    assert.strictEqual(res.intent, 'TOOL_ACTION', `Prompt "${prompt}" must route to TOOL_ACTION, got ${res.intent}`);
    assert.strictEqual(res.executionTarget, 'TOOL_PIPELINE', `Prompt "${prompt}" executionTarget must be TOOL_PIPELINE`);
    assert.strictEqual(res.sideEffectLevel, 'READ', `Prompt "${prompt}" sideEffectLevel must be READ, got ${res.sideEffectLevel}`);
    assert.strictEqual(res.approvalRequired, false, `Prompt "${prompt}" must not require approval`);
    console.log(`PASS: "${prompt}" -> TOOL_ACTION (TOOL_PIPELINE, READ, approval=false)`);
  }

  console.log('\n=== ALL ROUTER & POLICY TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
