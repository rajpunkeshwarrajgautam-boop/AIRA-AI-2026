import assert from 'node:assert/strict';
import { ModelRouter, OpenAIAdapter } from '../packages/model-router/src/index.js';
import { AVAILABLE_MODELS } from '../src/utils/constants.js';
import { normalizeStoredModelId } from '../src/utils/storage.js';

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

    const retired = 'meta/llama-3.1-405b-instruct';
    const replacement = 'nvidia/nemotron-3-super-120b-a12b';
    assert.equal(AVAILABLE_MODELS.some(model => model.id === retired), false,
      'retired Llama 405B must not remain selectable');
    assert.equal(normalizeStoredModelId(retired), replacement,
      'retired saved selections must migrate to an actual selectable NVIDIA model');
    assert.equal(normalizeStoredModelId(replacement), replacement);
    assert.equal(normalizeStoredModelId('nonexistent-model'), 'claude-3-7-sonnet');

    const migratedPolicy = router.resolvePolicy(retired, 'ANSWER');
    assert.equal(migratedPolicy.model, replacement,
      'legacy callers must never forward retired Llama 405B to the provider');

    const originalFetch = globalThis.fetch;
    try {
      const requests: Array<{ url: string; model: string }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        requests.push({ url: String(url), model: body.model });
        return new Response(JSON.stringify({
          model: body.model,
          choices: [{ message: { content: 'working answer' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const result = await router.getAdapter(migratedPolicy).complete([
        { role: 'user', content: 'How does an induction motor start?' }
      ], migratedPolicy);
      assert.equal(result.text, 'working answer');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
      assert.equal(requests[0].model, replacement);

      globalThis.fetch = (async () =>
        new Response('404 page not found', { status: 404 })) as typeof fetch;
      await assert.rejects(
        () => router.getAdapter(directNvidia).complete([
          { role: 'user', content: 'Test unavailable provider model' }
        ], directNvidia),
        /NVIDIA NIM returned 404/,
        'unavailable NVIDIA models must produce an actionable provider-specific error'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('MODEL ROUTER PROVIDER ROUTING PASS');
    console.log('PASS: retired model hidden, old settings migrated, server requests use current NVIDIA ID');
    console.log('PASS: unavailable NVIDIA routes report an actionable provider-specific error');
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
