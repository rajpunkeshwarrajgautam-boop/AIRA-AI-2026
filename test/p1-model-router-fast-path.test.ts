import assert from 'node:assert/strict';
import { ModelRouter, OpenAIAdapter, resolveNvidiaModel } from '../packages/model-router/src/index.js';

async function testModelRouterFastPath() {
  console.log('=== P1 TDD: MODEL ROUTER FAST PATH TEST ===');

  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.NVIDIA_API_KEY = 'nvapi-mock-test-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.NVIDIA_FAST_MODEL;

  try {
    const router = new ModelRouter();

    // 1. Fast Model Resolution
    const fastPolicy = router.resolvePolicy('aira-fast', 'ANSWER');
    assert.equal(fastPolicy.model, 'aira-fast');
    assert.equal(fastPolicy.extendedThinking, false, 'Fast policy must disable extendedThinking');

    const fastExecution = router.resolveExecution('aira-fast', 'ANSWER');
    assert.equal(fastExecution.provider, 'nvidia');
    assert.equal(fastExecution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
    assert.ok(fastExecution.adapter instanceof OpenAIAdapter);

    // 2. Custom Fast Model via Env
    process.env.NVIDIA_FAST_MODEL = 'nv-mistralai/mistral-nemo-12b-instruct';
    const customFastExecution = router.resolveExecution('aira-fast', 'ANSWER');
    assert.equal(customFastExecution.executedModel, 'nv-mistralai/mistral-nemo-12b-instruct');
    delete process.env.NVIDIA_FAST_MODEL;

    // 3. Deep Model Resolution
    const deepPolicy = router.resolvePolicy('aira-deep', 'RESEARCH');
    assert.equal(deepPolicy.model, 'aira-deep');
    assert.equal(deepPolicy.extendedThinking, true, 'Deep policy must enable extendedThinking');

    const deepExecution = router.resolveExecution('aira-deep', 'RESEARCH');
    assert.equal(deepExecution.provider, 'nvidia');
    assert.equal(deepExecution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');

    // 4. Auto Model Routing: Conversational intent -> Fast, Research intent -> Deep
    const autoAnswerPolicy = router.resolvePolicy('aira-auto', 'ANSWER');
    assert.equal(autoAnswerPolicy.model, 'aira-fast');
    assert.equal(autoAnswerPolicy.extendedThinking, false);

    const autoResearchPolicy = router.resolvePolicy('aira-auto', 'RESEARCH');
    assert.equal(autoResearchPolicy.model, 'aira-deep');
    assert.equal(autoResearchPolicy.extendedThinking, true);

    console.log('ALL P1 MODEL ROUTER FAST PATH TESTS PASSED');
  } finally {
    process.env = originalEnv;
  }
}

testModelRouterFastPath().catch(err => {
  console.error('P1 MODEL ROUTER FAST PATH TEST FAILED:', err);
  process.exit(1);
});
