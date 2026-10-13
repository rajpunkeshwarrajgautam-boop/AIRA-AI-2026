import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerIntentRouter } from '../../packages/agent-runtime/src/router.js';
import { CapabilityRegistry } from '../../packages/agent-runtime/src/registry.js';

const router = new ServerIntentRouter(new CapabilityRegistry());
const principal = {
  userId: 'booking-clarification-test-user',
  sessionId: 'booking-clarification-test-session',
  roles: ['member']
};

test('context-free booking pronoun asks for target rather than invoking a tool', async () => {
  for (const prompt of [
    'Please book it for tomorrow. Ask a clarifying question if essential details are missing.',
    'Could you reserve that for 7 PM?',
    'Book this on Friday.'
  ]) {
    const decision = await router.route({ prompt, principal });
    assert.equal(decision.intent, 'ANSWER', prompt);
    assert.equal(decision.executionTarget, 'CHAT_STREAM', prompt);
    assert.equal(decision.metadata?.reasoningStrategy, 'CLARIFY_AMBIGUOUS', prompt);
    assert.match(String(decision.metadata?.clarificationPrompt || ''), /what would you like me to book or reserve/i);
    assert.equal(decision.approvalRequired, false);
  }
});

test('booking clarification guard does not suppress context-aware follow-up routing', async () => {
  const decision = await router.route({
    prompt: 'Please book it for tomorrow.',
    principal,
    conversationHistory: [
      { role: 'user', content: 'I want a reservation at Noma.' },
      { role: 'assistant', content: 'You are considering a reservation at Noma.' }
    ]
  });
  assert.notEqual(decision.metadata?.reasoningStrategy, 'CLARIFY_AMBIGUOUS');
});

test('negated booking instruction is not reinterpreted as a booking request', async () => {
  const decision = await router.route({ prompt: "Don't book it for tomorrow.", principal });
  assert.notEqual(decision.metadata?.reasoningStrategy, 'CLARIFY_AMBIGUOUS');
});
