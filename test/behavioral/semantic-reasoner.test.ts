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

  it('routes time-sensitive current information requests to RESEARCH without advisoryIntent', async () => {
    const currentQueries = [
      'What is the current box office collection for latest movie?',
      'What is the current box office collection for the latest movie?',
      'What happened in AI news today?',
      'What is the current share price of NVIDIA?',
      'Who won the latest Formula 1 race?',
      'What is the latest version of Next.js?',
      'Who is the current CEO of Twitter?',
      'Compare the latest AI models with citations.',
      'Research this and summarize the findings.'
    ];

    for (const prompt of currentQueries) {
      const res = await reasoner.analyze({ prompt });
      assert.strictEqual(res.primaryIntent, 'RESEARCH', `Prompt "${prompt}" should route to RESEARCH, got ${res.primaryIntent}`);
      assert.strictEqual(res.isFreshnessRequired, true, `Prompt "${prompt}" should require freshness`);
      assert.ok(res.confidence >= 0.90, `Confidence for "${prompt}" should be >= 0.90, got ${res.confidence}`);
    }
  });

  it('routes timeless explanations, conceptual mechanics, and historical questions to ANSWER', async () => {
    const timelessQueries = [
      'What is quantum entanglement?',
      'Explain how box office revenue works.',
      'What were the highest-grossing movies of 1997?',
      'Write a fictional story about a movie premiere.',
      'What is an electric current?',
      'Explain how electric current creates a magnetic field.',
      'What is the current directory in Linux?'
    ];

    for (const prompt of timelessQueries) {
      const res = await reasoner.analyze({ prompt });
      assert.strictEqual(res.primaryIntent, 'ANSWER', `Prompt "${prompt}" should route to ANSWER, got ${res.primaryIntent}`);
      assert.strictEqual(res.isFreshnessRequired, false, `Prompt "${prompt}" should NOT require freshness`);
    }
  });

  it('demands clarification on ambiguous current-information requests when key entities are missing', async () => {
    // 1. Ambiguous share price query with no company/ticker
    const ambiguousStock = await reasoner.analyze({
      prompt: 'What is the current share price?'
    });
    assert.strictEqual(ambiguousStock.primaryIntent, 'ANSWER');
    assert.strictEqual(ambiguousStock.reasoningStrategy, 'CLARIFY_AMBIGUOUS');
    assert.strictEqual(ambiguousStock.isFreshnessRequired, true);
    assert.ok(ambiguousStock.clarificationPrompt, 'Must include clarificationPrompt');
    assert.ok(ambiguousStock.clarificationPrompt.toLowerCase().includes('company') || ambiguousStock.clarificationPrompt.toLowerCase().includes('ticker'));

    // 2. Ambiguous weather query with no city/location
    const ambiguousWeather = await reasoner.analyze({
      prompt: 'What is the weather today?'
    });
    assert.strictEqual(ambiguousWeather.primaryIntent, 'ANSWER');
    assert.strictEqual(ambiguousWeather.reasoningStrategy, 'CLARIFY_AMBIGUOUS');
    assert.strictEqual(ambiguousWeather.isFreshnessRequired, true);
    assert.ok(ambiguousWeather.clarificationPrompt, 'Must include clarificationPrompt');
    assert.ok(ambiguousWeather.clarificationPrompt.toLowerCase().includes('city') || ambiguousWeather.clarificationPrompt.toLowerCase().includes('location'));
  });

  it('resolves multi-turn freshness references using conversational context', async () => {
    // Multi-turn stock query resolving pronoun "its" to NVIDIA
    const stockHistory = [
      { role: 'user', content: 'Tell me about NVIDIA and its GPU architecture.' },
      { role: 'assistant', content: 'NVIDIA is a technology leader in high-performance computing GPUs.' }
    ];

    const followUpStock = await reasoner.analyze({
      prompt: 'What is its current share price?',
      conversationHistory: stockHistory
    });

    assert.strictEqual(followUpStock.primaryIntent, 'RESEARCH');
    assert.strictEqual(followUpStock.isFreshnessRequired, true);
    assert.ok(followUpStock.confidence >= 0.90);

    // Multi-turn weather query resolving location "there" to Tokyo
    const travelHistory = [
      { role: 'user', content: 'I am planning a trip to Tokyo next month.' },
      { role: 'assistant', content: 'Tokyo is an incredible city with wonderful culture and sights.' }
    ];

    const followUpWeather = await reasoner.analyze({
      prompt: 'What is the weather there today?',
      conversationHistory: travelHistory
    });

    assert.strictEqual(followUpWeather.primaryIntent, 'RESEARCH');
    assert.strictEqual(followUpWeather.isFreshnessRequired, true);
    assert.ok(followUpWeather.confidence >= 0.90);
  });

  it('evaluates dedicated current-information and evergreen benchmark achieving >=95% accuracy and <=5% false positive rate', async () => {
    const currentSet = [
      'What is the current box office collection for latest movie?',
      'What is the current box office collection for the latest movie?',
      'What is the box office gross of the latest Marvel release?',
      'What happened in AI news today?',
      'What is the latest breaking news regarding OpenAI?',
      'What is the current share price of NVIDIA?',
      'What is the current price of Bitcoin?',
      'What is the current market cap of Apple?',
      'Who won the latest Formula 1 race?',
      'Who won the latest Champions League match?',
      'What is the weather in Tokyo today?',
      'What is the weather forecast for Paris this weekend?',
      'What is the latest version of Next.js?',
      'What is the newest model released by Anthropic?',
      'Who is the current CEO of Twitter?',
      'Who is currently the prime minister of the UK?',
      'Compare the latest AI models with citations.',
      'Research the latest developments in nuclear fusion and summarize.',
      'What is the current inflation rate in the US?',
      'What is the current world record for the 100m sprint?'
    ];

    const evergreenSet = [
      'What is quantum entanglement?',
      'What is photosynthesis?',
      'Explain how box office revenue works.',
      'Explain how a stock exchange operates.',
      'What were the highest-grossing movies of 1997?',
      'Who won the 1994 World Cup?',
      'What happened during the 1969 moon landing?',
      'Write a fictional story about a movie premiere.',
      'Write a poem about the sunrise today.',
      'What is an electric current?',
      'Explain the relationship between voltage, current, and resistance.',
      'What is an ocean current?',
      'What is the current directory in Linux?',
      'Explain how current directory is determined in Unix.',
      'Today is a great day to learn programming, what should I start with?',
      'Why do people say live for today?',
      'Explain how the immune system defends against viruses.',
      'What is the theory of general relativity?',
      'Define object-oriented programming.',
      'Explain the difference between TCP and UDP.'
    ];

    let currentCorrect = 0;
    for (const prompt of currentSet) {
      const res = await reasoner.analyze({ prompt });
      if (res.primaryIntent === 'RESEARCH') {
        currentCorrect++;
      }
    }
    const currentAccuracy = currentCorrect / currentSet.length;

    let evergreenFalsePositives = 0;
    for (const prompt of evergreenSet) {
      const res = await reasoner.analyze({ prompt });
      if (res.primaryIntent === 'RESEARCH') {
        evergreenFalsePositives++;
      }
    }
    const falsePositiveRate = evergreenFalsePositives / evergreenSet.length;

    console.log(`\nBenchmark Results:`);
    console.log(`Current Information Accuracy: ${(currentAccuracy * 100).toFixed(1)}% (${currentCorrect}/${currentSet.length}) [Target >= 95%]`);
    console.log(`Evergreen False Positive Rate: ${(falsePositiveRate * 100).toFixed(1)}% (${evergreenFalsePositives}/${evergreenSet.length}) [Target <= 5%]`);

    assert.ok(currentAccuracy >= 0.95, `Current info accuracy must be >= 95%, got ${(currentAccuracy * 100).toFixed(1)}%`);
    assert.ok(falsePositiveRate <= 0.05, `False positive rate must be <= 5%, got ${(falsePositiveRate * 100).toFixed(1)}%`);
  });
});

