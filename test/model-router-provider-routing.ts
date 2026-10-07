import assert from 'node:assert/strict';
import { ModelRouter, OpenAIAdapter } from '../packages/model-router/src/index.js';

async function run() {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  process.env.NODE_ENV = 'production';
  process.env.NVIDIA_API_KEY = 'test-nvidia-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const router = new ModelRouter();

    const legacyAuto = router.resolvePolicy('claude-3-7-sonnet', 'ANSWER');
    assert.equal(legacyAuto.model, 'aira-fast', 'legacy Aira Auto must resolve to the product router');
    assert.ok(router.getAdapter(legacyAuto) instanceof OpenAIAdapter, 'Aira Auto must use configured NVIDIA OpenAI-compatible adapter');

    const research = router.resolvePolicy('aira-auto', 'RESEARCH');
    assert.equal(research.model, 'aira-deep', 'research should resolve Aira Auto to Aira Deep');
    assert.equal(research.extendedThinking, true, 'Aira Deep should enable reasoning');
    assert.ok(router.getAdapter(research) instanceof OpenAIAdapter, 'Aira Deep must fall back to NVIDIA when it is the configured production provider');

    const directNvidia = router.resolvePolicy('nvidia/nemotron-3-super-120b-a12b', 'ANSWER');
    assert.equal(directNvidia.model, 'nvidia/nemotron-3-super-120b-a12b');
    assert.ok(router.getAdapter(directNvidia) instanceof OpenAIAdapter);

    console.log('MODEL ROUTER PROVIDER ROUTING PASS');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

run().catch(error => {
  console.error('MODEL ROUTER PROVIDER ROUTING FAILED:', error);
  process.exit(1);
});
