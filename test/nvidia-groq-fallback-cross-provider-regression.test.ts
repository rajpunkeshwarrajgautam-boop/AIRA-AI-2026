import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIAdapter,
  ResilientModelAdapter,
  ProviderHealthTracker,
  ModelRouter,
  resolveNvidiaModel
} from '../packages/model-router/src/index.js';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';
import { ModelPolicy, ModelPolicySchema } from '../packages/contracts/src/index.js';

describe('NVIDIA -> Groq -> Gemini Cross-Provider Fallback & Model Isolation Suite', () => {
  const originalFetch = globalThis.fetch;

  it('TEST 1: When NVIDIA returns HTTP 404, Groq receives openai/gpt-oss-120b and NEVER receives NVIDIA model', async () => {
    const healthTracker = new ProviderHealthTracker({ cooldownMs: 1000 });
    const primaryNvidia = new OpenAIAdapter(
      'nvapi-test-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia'
    );
    const fallbackGroq = new OpenAIAdapter(
      'gsk-test-key',
      'https://api.groq.com/openai/v1',
      'openai/gpt-oss-120b',
      'groq'
    );

    const interceptedRequests: Array<{ url: string; body: any }> = [];
    let provenanceReported: any = null;

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      interceptedRequests.push({ url: urlStr, body: parsedBody });

      if (urlStr.includes('integrate.api.nvidia.com')) {
        return new Response(JSON.stringify({
          status: 404,
          title: 'Not Found',
          detail: "Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'IWp0S44IxqoKxlASDHiRhMsA1f2Cif8UgbEq19XdhYQ'"
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      if (urlStr.includes('api.groq.com')) {
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Groq synthesized answer."}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    try {
      const resilientAdapter = new ResilientModelAdapter(primaryNvidia, fallbackGroq, healthTracker, {
        firstTokenTimeoutMs: 3000,
        onProvenance: (p) => {
          provenanceReported = p;
        }
      });

      const policy: ModelPolicy = ModelPolicySchema.parse({
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        temperature: 0.7,
        maxTokens: 512
      });

      let streamedText = '';
      const result = await resilientAdapter.stream(
        [{ role: 'user', content: 'Explain quantum computing in one sentence.' }],
        policy,
        (chunk) => {
          if (chunk.text) streamedText += chunk.text;
        }
      );

      // Verify requests
      assert.equal(interceptedRequests.length, 2, 'Must make exactly 2 requests: 1 to NVIDIA, then 1 to Groq');
      
      const nvidiaReq = interceptedRequests.find(r => r.url.includes('integrate.api.nvidia.com'));
      assert.ok(nvidiaReq, 'NVIDIA endpoint must have been called');
      assert.equal(nvidiaReq.body.model, 'nvidia/llama-3.1-nemotron-70b-instruct');

      const groqReq = interceptedRequests.find(r => r.url.includes('api.groq.com'));
      assert.ok(groqReq, 'Groq endpoint must have been called');
      assert.equal(groqReq.body.model, 'openai/gpt-oss-120b', 'Groq must receive its own model identifier');
      assert.notEqual(
        groqReq.body.model,
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'CRITICAL DEFECT PREVENTION: Groq must NEVER receive the raw NVIDIA model identifier'
      );

      // Verify completion output
      assert.equal(streamedText, 'Groq synthesized answer.');
      assert.equal(provenanceReported.fallbackOccurred, true);
      assert.equal(provenanceReported.executedProvider, 'groq');
      assert.equal(provenanceReported.executedModel, 'openai/gpt-oss-120b');
      assert.ok(provenanceReported.fallbackReason.includes('HTTP 404'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('TEST 2: When NVIDIA returns HTTP 500, Groq receives openai/gpt-oss-120b and streams cleanly', async () => {
    const healthTracker = new ProviderHealthTracker({ cooldownMs: 1000 });
    const primaryNvidia = new OpenAIAdapter(
      'nvapi-test-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia'
    );
    const fallbackGroq = new OpenAIAdapter(
      'gsk-test-key',
      'https://api.groq.com/openai/v1',
      'openai/gpt-oss-120b',
      'groq'
    );

    const interceptedRequests: Array<{ url: string; body: any }> = [];
    let provenanceReported: any = null;

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      interceptedRequests.push({ url: urlStr, body: parsedBody });

      if (urlStr.includes('integrate.api.nvidia.com')) {
        return new Response(JSON.stringify({ error: { message: 'Internal Server Error', code: 500 } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (urlStr.includes('api.groq.com')) {
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Groq recovered output."}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    try {
      const resilientAdapter = new ResilientModelAdapter(primaryNvidia, fallbackGroq, healthTracker, {
        firstTokenTimeoutMs: 3000,
        onProvenance: (p) => {
          provenanceReported = p;
        }
      });

      const policy: ModelPolicy = ModelPolicySchema.parse({
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        temperature: 0.5,
        maxTokens: 256
      });

      let streamedText = '';
      await resilientAdapter.stream(
        [{ role: 'user', content: 'What is 2+2?' }],
        policy,
        (chunk) => {
          if (chunk.text) streamedText += chunk.text;
        }
      );

      const groqReq = interceptedRequests.find(r => r.url.includes('api.groq.com'));
      assert.ok(groqReq);
      assert.equal(groqReq.body.model, 'openai/gpt-oss-120b');
      assert.equal(streamedText, 'Groq recovered output.');
      assert.equal(provenanceReported.fallbackOccurred, true);
      assert.equal(provenanceReported.executedProvider, 'groq');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('TEST 3: Triple cascade: NVIDIA 404 -> Groq 429 -> Gemini completes with gemini-3.5-flash-lite', async () => {
    const healthTracker = new ProviderHealthTracker({ cooldownMs: 1000 });
    const primaryNvidia = new OpenAIAdapter(
      'nvapi-test-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia'
    );
    const fallbackGroq = new OpenAIAdapter(
      'gsk-test-key',
      'https://api.groq.com/openai/v1',
      'openai/gpt-oss-120b',
      'groq'
    );
    const tertiaryGemini = new GeminiAdapter(
      'gemini-test-key',
      'gemini-3.5-flash-lite'
    );

    const interceptedRequests: Array<{ url: string; body: any }> = [];
    let provenanceReported: any = null;

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      interceptedRequests.push({ url: urlStr, body: parsedBody });

      if (urlStr.includes('integrate.api.nvidia.com')) {
        return new Response(JSON.stringify({ status: 404, title: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (urlStr.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          error: { message: 'Rate limit exceeded: 429', type: 'tokens_per_minute' }
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (urlStr.includes('generativelanguage.googleapis.com')) {
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Gemini tertiary answer."}]}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    try {
      const resilientAdapter = new ResilientModelAdapter(primaryNvidia, fallbackGroq, healthTracker, {
        firstTokenTimeoutMs: 3000,
        tertiaryAdapter: tertiaryGemini,
        onProvenance: (p) => {
          provenanceReported = p;
        }
      });

      const policy: ModelPolicy = ModelPolicySchema.parse({
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        temperature: 0.7,
        maxTokens: 512
      });

      let streamedText = '';
      await resilientAdapter.stream(
        [{ role: 'user', content: 'Explain relativity.' }],
        policy,
        (chunk) => {
          if (chunk.text) streamedText += chunk.text;
        }
      );

      assert.equal(interceptedRequests.length, 3, 'Must attempt all 3 providers');
      assert.ok(interceptedRequests[0].url.includes('integrate.api.nvidia.com'));
      assert.ok(interceptedRequests[1].url.includes('api.groq.com'));
      assert.ok(interceptedRequests[2].url.includes('generativelanguage.googleapis.com'));

      assert.ok(interceptedRequests[2].url.includes('models/gemini-3.5-flash-lite'));
      assert.equal(streamedText, 'Gemini tertiary answer.');
      assert.equal(provenanceReported.fallbackOccurred, true);
      assert.equal(provenanceReported.executedProvider, 'gemini');
      assert.equal(provenanceReported.executedModel, 'gemini-3.5-flash-lite');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('TEST 4: Reverse cross-provider protection: NVIDIA adapter refuses to leak Groq or foreign model IDs', async () => {
    const nvidiaAdapter = new OpenAIAdapter(
      'nvapi-test-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia'
    );

    const interceptedRequests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      interceptedRequests.push({ url: urlStr, body: parsedBody });

      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    try {
      // Simulate an erroneous foreign model passed in policy to NVIDIA adapter
      const foreignPolicy: ModelPolicy = {
        model: 'openai/gpt-oss-120b',
        temperature: 0.5,
        maxTokens: 256
      };

      await nvidiaAdapter.stream(
        [{ role: 'user', content: 'test' }],
        foreignPolicy,
        () => {}
      );

      assert.equal(interceptedRequests.length, 1);
      assert.equal(
        interceptedRequests[0].body.model,
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'NVIDIA adapter must sanitize foreign model and use its own canonical model'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('TEST 5: ModelRouter end-to-end resolution wires resilient fallback with strict model boundaries', () => {
    const savedEnv = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.NVIDIA_API_KEY = 'nvapi-mock-test';
      process.env.GROQ_API_KEY = 'gsk-mock-test';
      process.env.GEMINI_API_KEY = 'gemini-mock-test';
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const router = new ModelRouter();

      // Explicit NVIDIA model
      const exec = router.resolveExecution('nvidia/llama-3.1-nemotron-70b-instruct', 'ANSWER');
      assert.equal(exec.provider, 'nvidia');
      assert.equal(exec.executedModel, 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.ok(exec.adapter instanceof ResilientModelAdapter, 'Should wire ResilientModelAdapter when fallback providers exist');

      // Legacy retired model mapping
      const legacyExec = router.resolveExecution('nvidia/nemotron-3-super-120b-a12b', 'ANSWER');
      assert.equal(legacyExec.provider, 'nvidia');
      assert.equal(legacyExec.executedModel, 'nvidia/llama-3.1-nemotron-70b-instruct', 'Legacy 120B must route to active 70B');
      assert.equal(legacyExec.fallbackOccurred, true);
      assert.ok(legacyExec.fallbackReason?.includes('migrated to NVIDIA Nemotron 70B'));
    } finally {
      process.env = savedEnv;
    }
  });

  it('TEST 6: resolveNvidiaModel preserves explicitly selected supported models, migrates legacy models, and respects environment defaults', () => {
    const savedEnv = { ...process.env };
    try {
      // 1. Explicit model selection MUST be preserved even when NVIDIA_DEFAULT_MODEL is configured
      process.env.NVIDIA_DEFAULT_MODEL = 'nv-mistralai/mistral-nemo-12b-instruct';
      
      const explicitNemotron = resolveNvidiaModel('nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(
        explicitNemotron,
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'Explicitly selected supported model MUST NOT be overridden by NVIDIA_DEFAULT_MODEL'
      );

      const explicitCandidate = resolveNvidiaModel('nvidia/mistral-nemo-minitron-8b-8k-instruct');
      assert.equal(
        explicitCandidate,
        'nvidia/mistral-nemo-minitron-8b-8k-instruct',
        'Other explicit candidate NVIDIA models must be preserved without override'
      );

      // 2. Legacy model migration
      // When NVIDIA_DEFAULT_MODEL is set, legacy retired models migrate to NVIDIA_DEFAULT_MODEL
      assert.equal(
        resolveNvidiaModel('meta/llama-3.1-405b-instruct'),
        'nv-mistralai/mistral-nemo-12b-instruct',
        'Legacy Llama 405B migrates to NVIDIA_DEFAULT_MODEL when configured'
      );
      assert.equal(
        resolveNvidiaModel('nvidia/nemotron-3-super-120b-a12b'),
        'nv-mistralai/mistral-nemo-12b-instruct',
        'Deprecated Nemotron 120B migrates to NVIDIA_DEFAULT_MODEL when configured'
      );

      // When NVIDIA_DEFAULT_MODEL is absent, legacy retired models migrate to canonical active 70B
      delete process.env.NVIDIA_DEFAULT_MODEL;
      assert.equal(
        resolveNvidiaModel('meta/llama-3.1-405b-instruct'),
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'Legacy Llama 405B migrates to active 70B default when NVIDIA_DEFAULT_MODEL is absent'
      );
      assert.equal(
        resolveNvidiaModel('nvidia/nemotron-3-super-120b-a12b'),
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'Deprecated Nemotron 120B migrates to active 70B default when NVIDIA_DEFAULT_MODEL is absent'
      );

      // 3. Environment-default resolution for internal modes
      delete process.env.NVIDIA_FAST_MODEL;
      delete process.env.NVIDIA_DEEP_MODEL;
      delete process.env.NVIDIA_DEFAULT_MODEL;

      assert.equal(resolveNvidiaModel('aira-auto'), 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(resolveNvidiaModel('aira-pro'), 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(resolveNvidiaModel('aira-fast'), 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(resolveNvidiaModel('aira-deep'), 'nvidia/llama-3.1-nemotron-70b-instruct');

      // Environment overrides for dedicated fast / deep modes
      process.env.NVIDIA_FAST_MODEL = 'nvidia/llama-3.1-nemotron-51b-instruct';
      process.env.NVIDIA_DEEP_MODEL = 'nvidia/nemotron-nano-3-30b-a3b';
      assert.equal(resolveNvidiaModel('aira-fast'), 'nvidia/llama-3.1-nemotron-51b-instruct');
      assert.equal(resolveNvidiaModel('aira-deep'), 'nvidia/nemotron-nano-3-30b-a3b');

      // Unmapped / unrecognized string falls back to default
      delete process.env.NVIDIA_DEFAULT_MODEL;
      assert.equal(resolveNvidiaModel('unknown-model-xyz'), 'nvidia/llama-3.1-nemotron-70b-instruct');
      process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/custom-fleet-model';
      assert.equal(resolveNvidiaModel('unknown-model-xyz'), 'nvidia/custom-fleet-model');
    } finally {
      process.env = savedEnv;
    }
  });
});
