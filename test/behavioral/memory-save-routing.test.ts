import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServerIntentRouter } from '../../packages/agent-runtime/src/router.js';
import { CapabilityRegistry } from '../../packages/agent-runtime/src/registry.js';

const router = new ServerIntentRouter(new CapabilityRegistry());
const principal = {
  userId: 'memory-intent-release-test',
  sessionId: 'memory-intent-session',
  roles: ['member']
};

describe('Explicit memory-intent routing', () => {
  for (const prompt of [
    'Please remember across future conversations that my testing code is indigo-azimuth-62.',
    'Remember that I prefer concise answers.',
    'Please remember my preferred interface is dark mode.',
    'Keep in mind that my project is AIRA.'
  ]) {
    it('routes conversationally rather than searching: ' + prompt, async () => {
      const decision = await router.route({ prompt, principal });
      assert.equal(decision.intent, 'ANSWER');
      assert.equal(decision.executionTarget, 'CHAT_STREAM');
      assert.equal(decision.approvalRequired, false);
      assert.notEqual(decision.metadata?.reasoningStrategy, 'CLARIFY_AMBIGUOUS');
    });
  }

  it('does not bypass destructive side-effect classification', async () => {
    const decision = await router.route({
      prompt: 'Remember that I want you to drop database production.',
      principal
    });
    assert.equal(decision.sideEffectLevel, 'DESTRUCTIVE');
    assert.equal(decision.approvalRequired, true);
  });

  it('does not execute a tool when describing a remembered preference', async () => {
    const decision = await router.route({
      prompt: 'Remember that I want you to execute the tool to check its status.',
      principal
    });
    // This is a request to store a preference, not authorization to execute a tool now.
    assert.equal(decision.intent, 'ANSWER');
    assert.equal(decision.executionTarget, 'CHAT_STREAM');
    assert.equal(decision.approvalRequired, false);
  });

  it('still routes a separate explicit tool-execution command to the Tool Gateway', async () => {
    const decision = await router.route({
      prompt: 'Please execute the tool to check its status now.',
      principal
    });
    assert.equal(decision.intent, 'TOOL_ACTION');
    assert.equal(decision.executionTarget, 'TOOL_PIPELINE');
  });
});
