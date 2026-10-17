import assert from 'node:assert/strict';
import { ModelRouter, OpenAIAdapter } from '../packages/model-router/src/index.js';
import { ModelIdSchema, ModelProvenanceSchema } from '../packages/contracts/src/index.js';

async function run() {
  console.log('=== P1.3 MULTI-PROVIDER ROUTING & FIRST-TOKEN DEADLINE TEST SUITE ===');

  const originalEnv = { ...process.env };

  function cleanEnv() {
    delete process.env.GROQ_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AIRA_FAST_PROVIDER;
    delete process.env.AIRA_FAST_MODEL;
    delete process.env.NVIDIA_FAST_MODEL;
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Schema validation of new provider IDs & fast models
    // -------------------------------------------------------------
    console.log('\n[TEST 1] Contracts: ModelIdSchema and ModelProvenanceSchema validation');
    const validModels = [
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'llama3.1-8b',
      'llama3.1-70b',
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
      'nvidia/nemotron-3-super-120b-a12b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'allam-2-7b'
    ];
    for (const m of validModels) {
      assert.doesNotThrow(() => ModelIdSchema.parse(m), `Model ID ${m} should be valid`);
    }

    const validProvenance = {
      requestedModel: 'aira-fast',
      resolvedPolicyModel: 'aira-fast',
      provider: 'groq' as const,
      requestedProvider: 'groq',
      executedProvider: 'groq',
      executedModel: 'llama-3.1-8b-instant',
      fallbackOccurred: false,
      verified: true,
      executionStatus: 'SUCCESS' as const,
      timestamp: Date.now()
    };
    assert.doesNotThrow(() => ModelProvenanceSchema.parse(validProvenance), 'Groq provenance should parse');
    console.log('PASS: Contracts accept new low-latency provider and model schemas.');

    // -------------------------------------------------------------
    // TEST 2: Truthful fallback when only NVIDIA is configured
    // -------------------------------------------------------------
    console.log('\n[TEST 2] NVIDIA-only environment: truthful fallback on aira-fast');
    cleanEnv();
    process.env.NVIDIA_API_KEY = 'nv-mock-key';

    const nvidiaOnlyRouter = new ModelRouter();
    const fastExec = nvidiaOnlyRouter.resolveExecution('aira-fast', 'ANSWER');

    assert.equal(fastExec.provider, 'nvidia');
    assert.equal(fastExec.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(fastExec.fallbackOccurred, true, 'Fallback must be reported truthfully');
    assert.ok(fastExec.fallbackReason?.includes('NVIDIA Nemotron 120B reasoning model'), 'Fallback reason must identify 120B model');
    console.log('PASS: aira-fast truthfully reports fallback to Nemotron 120B when no fast provider is configured.');

    // -------------------------------------------------------------
    // TEST 3: AIRA Deep route preservation
    // -------------------------------------------------------------
    console.log('\n[TEST 3] AIRA Deep route preservation: never routed to fast provider');
    cleanEnv();
    process.env.GROQ_API_KEY = 'groq-mock-key';
    process.env.NVIDIA_API_KEY = 'nv-mock-key';

    const multiRouter = new ModelRouter();
    const deepExec = multiRouter.resolveExecution('aira-deep', 'ANSWER');

    assert.equal(deepExec.provider, 'nvidia', 'Deep mode must use NVIDIA Nemotron 120B, not Groq');
    assert.equal(deepExec.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(deepExec.fallbackOccurred, true, 'Falls back from Anthropic to NVIDIA when only NVIDIA is configured');
    console.log('PASS: aira-deep strictly preserved on NVIDIA Nemotron 120B.');

    // -------------------------------------------------------------
    // TEST 4: Auto-prioritization when Groq is available
    // -------------------------------------------------------------
    console.log('\n[TEST 4] Fast route auto-prioritization: Groq chosen when available');
    cleanEnv();
    process.env.GROQ_API_KEY = 'groq-mock-key';
    process.env.NVIDIA_API_KEY = 'nv-mock-key';

    const groqRouter = new ModelRouter();
    const groqFastExec = groqRouter.resolveExecution('aira-fast', 'ANSWER');

    assert.equal(groqFastExec.provider, 'groq');
    assert.equal(groqFastExec.executedModel, 'llama-3.1-8b-instant');
    assert.equal(groqFastExec.fallbackOccurred, false);
    console.log('PASS: Groq auto-selected as default fast provider with llama-3.1-8b-instant.');

    // -------------------------------------------------------------
    // TEST 5: Explicit AIRA_FAST_PROVIDER configuration
    // -------------------------------------------------------------
    console.log('\n[TEST 5] Explicit AIRA_FAST_PROVIDER configuration');
    cleanEnv();
    process.env.GROQ_API_KEY = 'groq-mock-key';
    process.env.CEREBRAS_API_KEY = 'cerebras-mock-key';
    process.env.AIRA_FAST_PROVIDER = 'cerebras';
    process.env.AIRA_FAST_MODEL = 'llama3.1-70b';

    const cerebrasRouter = new ModelRouter();
    const cerebrasFastExec = cerebrasRouter.resolveExecution('aira-fast', 'ANSWER');

    assert.equal(cerebrasFastExec.provider, 'cerebras');
    assert.equal(cerebrasFastExec.executedModel, 'llama3.1-70b');
    assert.equal(cerebrasFastExec.fallbackOccurred, false);
    console.log('PASS: AIRA_FAST_PROVIDER=cerebras and AIRA_FAST_MODEL=llama3.1-70b respected.');

    // -------------------------------------------------------------
    // TEST 6: First-token deadline timeout behavior
    // -------------------------------------------------------------
    console.log('\n[TEST 6] First-token deadline timeout in OpenAIAdapter.stream');
    cleanEnv();

    // Mock an adapter with a hanging stream
    const adapter = new OpenAIAdapter('test-key', 'https://api.groq.com/openai/v1', 'groq', 'llama-3.1-8b-instant');

    const originalFetch = globalThis.fetch;
    try {
      // Mock fetch returning a stream that never yields any content
      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start() {
            // Keep stream open, never emit anything
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }) as typeof fetch;

      const policy = { model: 'aira-fast', maxTokens: 100 };
      const receivedChunks: string[] = [];

      let errorCaught: any = null;
      try {
        await adapter.stream(
          [{ role: 'user', content: 'hello' }],
          policy,
          (delta) => { if (delta.text) receivedChunks.push(delta.text); },
          { firstTokenTimeoutMs: 50 } // 50ms test deadline
        );
      } catch (err: any) {
        errorCaught = err;
      }

      assert.ok(errorCaught, 'Expected first-token timeout error');
      assert.ok(
        errorCaught.message.includes('FIRST_TOKEN_TIMEOUT') || errorCaught.name === 'AbortError',
        `Error message was: ${errorCaught.message}`
      );
      assert.equal(receivedChunks.length, 0, 'No chunks should have been emitted');
      console.log('PASS: First-token deadline timer aborted request when provider hung.');

      // Now test fast arrival clears timer
      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }) as typeof fetch;

      const happyChunks: string[] = [];
      const result = await adapter.stream(
        [{ role: 'user', content: 'hello' }],
        policy,
        (delta) => { if (delta.text) happyChunks.push(delta.text); },
        { firstTokenTimeoutMs: 500 }
      );
      assert.equal(happyChunks.join(''), 'Hi');
      assert.equal(result.text, 'Hi');
      console.log('PASS: Normal stream receives first token before deadline without abort.');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('\n=== ALL P1.3 MULTI-PROVIDER ROUTING TESTS PASSED ===');
  } finally {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

run().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
