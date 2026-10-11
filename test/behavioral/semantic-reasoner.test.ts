import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SemanticReasoner } from '../../packages/agent-runtime/src/behavioral/semantic-reasoner.js';

describe('AIRA Behavioral Intelligence — Semantic Reasoning & Intent Routing', () => {
  const reasoner = new SemanticReasoner();

  it('differentiates explanation vs execution intent', () => {
    // 1. Explanation only
    const explanation = reasoner.analyze({
      prompt: 'Explain how an application is built and deployed.'
    });
    assert.strictEqual(explanation.primaryIntent, 'ANSWER');
    assert.strictEqual(explanation.isExplanationOnly, true);
    assert.strictEqual(explanation.isExecutionRequested, false);

    // 2. Execution requested (Agent Mission for building full app)
    const execution = reasoner.analyze({
      prompt: 'Build an application and show me the result.'
    });
    assert.strictEqual(execution.primaryIntent, 'AGENT_MISSION');
    assert.strictEqual(execution.isExplanationOnly, false);
    assert.strictEqual(execution.isExecutionRequested, true);
  });

  it('resolves contextual referents in follow-up conversations without losing context', () => {
    const history = [
      { role: 'user', content: 'Write a python implementation of bubble sort.' },
      { role: 'assistant', content: 'def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n...' }
    ];

    const followUp = reasoner.analyze({
      prompt: 'Now make it faster.',
      conversationHistory: history
    });

    assert.strictEqual(followUp.primaryIntent, 'ANSWER');
    assert.ok(followUp.contextualReferents['it'], 'Must resolve pronoun "it"');
    assert.ok(
      followUp.contextualReferents['it'].includes('algorithm') ||
      followUp.contextualReferents['it'].includes('code'),
      'Referent must resolve to the prior algorithm'
    );
  });

  it('decomposes multi-part requests into discrete subtasks', () => {
    const multiPart = reasoner.analyze({
      prompt: 'Calculate 1024 * 16 and also research the latest quantum computing benchmarks'
    });

    assert.strictEqual(multiPart.isMultiPart, true);
    assert.strictEqual(multiPart.subTasks.length, 2);
    assert.ok(multiPart.subTasks[0].includes('Calculate'));
    assert.ok(multiPart.subTasks[1].includes('research'));
  });

  it('executes zero-cost fast paths on trivial greetings with high confidence', () => {
    const greeting = reasoner.analyze({
      prompt: 'Hi!'
    });

    assert.strictEqual(greeting.primaryIntent, 'ANSWER');
    assert.strictEqual(greeting.fastPathUsed, true);
    assert.strictEqual(greeting.reasoningStrategy, 'FAST_DIRECT');
    assert.ok(greeting.confidence >= 0.95);
  });

  it('correctly classifies research vs agent mission intents', () => {
    const research = reasoner.analyze({
      prompt: 'Research recent breakthroughs in solid-state battery chemistry and cite sources'
    });
    assert.strictEqual(research.primaryIntent, 'RESEARCH');

    const mission = reasoner.analyze({
      prompt: 'Investigate the bug in the auth module, inspect the repo, fix it and verify it'
    });
    assert.strictEqual(mission.primaryIntent, 'AGENT_MISSION');
  });

  it('correctly classifies automation creation requests', () => {
    const automation = reasoner.analyze({
      prompt: 'Schedule an automated check every Monday at 9am.'
    });
    assert.strictEqual(automation.primaryIntent, 'AUTOMATION_CREATE');
  });
});
