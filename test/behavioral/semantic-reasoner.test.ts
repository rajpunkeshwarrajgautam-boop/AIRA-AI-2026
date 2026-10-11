import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SemanticReasoner } from '../../packages/agent-runtime/src/behavioral/semantic-reasoner.js';

describe('AIRA Behavioral Intelligence — Semantic Reasoning & Intent Routing', () => {
  const reasoner = new SemanticReasoner();

  it('differentiates explanation vs execution intent', async () => {
    // 1. Explanation only: "Explain how an application is built and deployed."
    const explanation = await reasoner.analyze({
      prompt: 'Explain how an application is built and deployed.'
    });
    assert.strictEqual(explanation.primaryIntent, 'ANSWER');
    assert.strictEqual(explanation.isExplanationOnly, true);
    assert.strictEqual(explanation.isExecutionRequested, false);

    // 2. Execution requested: "Build an application and show me the result."
    const execution = await reasoner.analyze({
      prompt: 'Build an application and show me the result.'
    });
    assert.strictEqual(execution.primaryIntent, 'AGENT_MISSION');
    assert.strictEqual(explanation.isExplanationOnly, true);
    assert.strictEqual(execution.isExecutionRequested, true);
  });

  it('correctly handles mandatory nuance edge cases', async () => {
    // "Explain how a website is built." -> ANSWER (explanation)
    const edge1 = await reasoner.analyze({ prompt: 'Explain how a website is built.' });
    assert.strictEqual(edge1.primaryIntent, 'ANSWER');
    assert.strictEqual(edge1.isExplanationOnly, true);

    // "Build a website and preview it." -> AGENT_MISSION (action)
    const edge2 = await reasoner.analyze({ prompt: 'Build a website and preview it.' });
    assert.strictEqual(edge2.primaryIntent, 'AGENT_MISSION');
    assert.strictEqual(edge2.isExecutionRequested, true);

    // "What if we built a website?" -> ANSWER (hypothetical inquiry)
    const edge3 = await reasoner.analyze({ prompt: 'What if we built a website?' });
    assert.strictEqual(edge3.primaryIntent, 'ANSWER');
    assert.strictEqual(edge3.isExplanationOnly, true);

    // "Could you describe how you would deploy this?" -> ANSWER (explanation)
    const edge4 = await reasoner.analyze({ prompt: 'Could you describe how you would deploy this?' });
    assert.strictEqual(edge4.primaryIntent, 'ANSWER');
    assert.strictEqual(edge4.isExplanationOnly, true);

    // "Deploy this now." -> TOOL_ACTION (execution)
    const edge5 = await reasoner.analyze({ prompt: 'Deploy this now.' });
    assert.strictEqual(edge5.primaryIntent, 'TOOL_ACTION');
    assert.strictEqual(edge5.isExecutionRequested, true);

    // "Research this and write a report." -> WORKFLOW / RESEARCH
    const edge6 = await reasoner.analyze({ prompt: 'Research this and write a report.' });
    assert.ok(edge6.primaryIntent === 'WORKFLOW' || edge6.primaryIntent === 'RESEARCH');
  });

  it('resolves contextual referents in follow-up conversations without losing context', async () => {
    const codeHistory = [
      { role: 'user', content: 'Write a python implementation of bubble sort.' },
      { role: 'assistant', content: 'def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n...' }
    ];

    const followUp1 = await reasoner.analyze({
      prompt: 'Now make it faster.',
      conversationHistory: codeHistory
    });

    assert.strictEqual(followUp1.primaryIntent, 'ANSWER');
    assert.ok(followUp1.contextualReferents['it'], 'Must resolve pronoun "it"');
    assert.ok(
      followUp1.contextualReferents['it'].includes('algorithm') ||
      followUp1.contextualReferents['it'].includes('code'),
      'Referent must resolve to the prior algorithm'
    );

    const docHistory = [
      { role: 'user', content: 'Draft a project status report for Q3.' },
      { role: 'assistant', content: '# Q3 Project Status Report\n\nAll key deliverables completed on time...' }
    ];

    const followUp2 = await reasoner.analyze({
      prompt: 'Make it shorter.',
      conversationHistory: docHistory
    });
    assert.strictEqual(followUp2.primaryIntent, 'ANSWER');
    assert.ok(followUp2.contextualReferents['it'].includes('document'), 'Must resolve to document');
  });

  it('decomposes multi-part requests into discrete subtasks', async () => {
    const multiPart = await reasoner.analyze({
      prompt: 'Calculate 1024 * 16 and also research the latest quantum computing benchmarks'
    });

    assert.strictEqual(multiPart.isMultiPart, true);
    assert.strictEqual(multiPart.subTasks.length, 2);
    assert.ok(multiPart.subTasks[0].includes('Calculate'));
    assert.ok(multiPart.subTasks[1].includes('research'));
  });

  it('executes zero-cost fast paths on trivial greetings with high confidence', async () => {
    const greeting = await reasoner.analyze({
      prompt: 'Hi!'
    });

    assert.strictEqual(greeting.primaryIntent, 'ANSWER');
    assert.strictEqual(greeting.fastPathUsed, true);
    assert.strictEqual(greeting.reasoningStrategy, 'FAST_DIRECT');
    assert.ok(greeting.confidence >= 0.95);
  });

  it('correctly classifies research vs agent mission intents', async () => {
    const research = await reasoner.analyze({
      prompt: 'Research recent breakthroughs in solid-state battery chemistry and cite sources'
    });
    assert.strictEqual(research.primaryIntent, 'RESEARCH');

    const mission = await reasoner.analyze({
      prompt: 'Investigate the bug in the auth module, inspect the repo, fix it and verify it'
    });
    assert.strictEqual(mission.primaryIntent, 'AGENT_MISSION');
  });

  it('correctly classifies automation creation requests', async () => {
    const automation = await reasoner.analyze({
      prompt: 'Schedule an automated check every Monday at 9am.'
    });
    assert.strictEqual(automation.primaryIntent, 'AUTOMATION_CREATE');
  });

  it('preserves advisory AGENT_MISSION intent, decomposes multi-step mission clauses, and avoids single-step tool hijacking', async () => {
    const analysis = await reasoner.analyze({
      prompt: 'Inspect workspace files, check git status, and summarize repo history.',
      advisoryIntent: 'AGENT_MISSION'
    });

    assert.strictEqual(analysis.primaryIntent, 'AGENT_MISSION');
    assert.strictEqual(analysis.fastPathUsed, true);
    assert.strictEqual(analysis.isMultiPart, true);
    assert.ok(analysis.subTasks.length >= 3, `Expected at least 3 subtasks, got ${analysis.subTasks.length}`);
    assert.ok(analysis.confidence >= 0.85);
  });
});
