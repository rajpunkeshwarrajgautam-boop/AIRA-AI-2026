import assert from 'node:assert/strict';
import { isRepositoryIntent } from '../packages/agent-runtime/src/index.js';
import {
  ModelRouter,
  OpenAIAdapter,
  AnthropicAdapter,
  resolveNvidiaModel,
  resolveOpenAIModel,
  resolveAnthropicModel,
  ResilientModelAdapter,
  ProviderHealthTracker
} from '../packages/model-router/src/index.js';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';
import { ModelPolicy } from '../packages/contracts/src/index.js';

async function runReleaseReadinessTestSuite(): Promise<void> {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — PR #112 FINAL RELEASE-READINESS CERTIFICATION SUITE');
  console.log('========================================================================');

  // -------------------------------------------------------------------------
  // SECTION 1: REPOSITORY-INTENT DETECTION (GENERIC WORDS vs GENUINE REPO OPS)
  // -------------------------------------------------------------------------
  console.log('\n[SECTION 1] Testing Agent Planner Repository-Intent Detection...');

  // Unrelated generic prompts that MUST NOT trigger repository operations
  const genericNegativeCases = [
    'What is the status of my flight from SFO to JFK?',
    'Check order status for order #12345',
    'Calculate the log base 10 of 1000',
    'Calculate logarithm log(x) + log(y)',
    'Where is the nearest Chase bank branch in New York?',
    'Tree branch pruning guide for maple trees',
    'Explain the diff between functional programming and OOP',
    'What is the semantic difference (diff) between let and const?',
    'I want to commit to my new fitness routine and eat healthy',
    'Show me the status of the weather in Seattle',
    'Please calculate ((16384 * 1024) / 4) and return the integer'
  ];

  for (const prompt of genericNegativeCases) {
    const isRepo = isRepositoryIntent(prompt);
    assert.equal(isRepo, false, `Generic prompt must NOT trigger repository intent: "${prompt}"`);
  }
  console.log(`PASS: All ${genericNegativeCases.length} generic prompts with 'status', 'log', 'branch', 'diff', 'commit' properly rejected from repo routing`);

  // Legitimate git/repo prompts that MUST trigger repository operations
  const legitimatePositiveCases = [
    'check git status',
    'show git log of recent changes',
    'run git diff on current branch',
    'inspect repository status',
    'display codebase git branch information',
    'git commit history for this repository',
    'inspect the git repo',
    'get the repo status'
  ];

  for (const prompt of legitimatePositiveCases) {
    const isRepo = isRepositoryIntent(prompt);
    assert.equal(isRepo, true, `Legitimate repository prompt MUST trigger repository intent: "${prompt}"`);
  }
  console.log(`PASS: All ${legitimatePositiveCases.length} authentic git/repo prompts properly identified as repository missions`);

  // -------------------------------------------------------------------------
  // SECTION 2: NVIDIA 404 RETIREMENT & RESILIENT PROVIDER FALLBACK
  // -------------------------------------------------------------------------
  console.log('\n[SECTION 2] Verifying NVIDIA 404 Failure and Provider Fallback Handling...');

  // 2.1 Retired Llama 405B normalization
  const retiredLlama = 'meta/llama-3.1-405b-instruct';
  const normalizedModel = resolveNvidiaModel(retiredLlama);
  assert.equal(normalizedModel, 'nvidia/nemotron-3-super-120b-a12b', 'Retired Llama 405B must normalize to Nemotron 120B');
  console.log('PASS: Retired NVIDIA Llama 405B normalized to supported Nemotron 120B');

  // 2.2 ResilientModelAdapter handling of upstream HTTP 404
  const originalFetch = globalThis.fetch;
  try {
    const healthTracker = new ProviderHealthTracker();
    const primaryNvidia = new OpenAIAdapter(
      'mock-nvidia-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia'
    );
    const fallbackGroq = new OpenAIAdapter(
      'mock-groq-key',
      'https://api.groq.com/openai/v1',
      'openai/gpt-oss-120b',
      'groq'
    );

    let nvidiaCalls = 0;
    let groqCalls = 0;
    let outboundModels: string[] = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body || '{}'));
      outboundModels.push(body.model);

      if (urlStr.includes('integrate.api.nvidia.com')) {
        nvidiaCalls++;
        // Simulate NVIDIA NIM returning 404 (model deprecated or unavailable)
        return new Response(JSON.stringify({
          error: { message: 'Model not found: nvidia/deprecated-model', code: 404 }
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        // Simulate Groq fallback succeeding with streaming SSE response
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Fallback success from Groq"}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    let provenanceReported: any = null;
    const resilientAdapter = new ResilientModelAdapter(primaryNvidia, fallbackGroq, healthTracker, {
      firstTokenTimeoutMs: 3000,
      onProvenance: p => {
        provenanceReported = p;
      }
    });

    let streamedText = '';
    const policy: ModelPolicy = {
      model: 'aira-fast',
      temperature: 0.3,
      maxTokens: 512
    };

    const completion = await resilientAdapter.stream(
      [{ role: 'user', content: 'Test NVIDIA 404 fallback resilience' }],
      policy,
      chunk => {
        if (chunk.text) streamedText += chunk.text;
      }
    );

    assert.equal(nvidiaCalls, 1, 'Primary NVIDIA provider must have been attempted once');
    assert.equal(groqCalls, 1, 'Fallback Groq provider must have been executed upon NVIDIA 404');
    assert.ok(streamedText.includes('Fallback success from Groq'), 'Streamed output must contain response from fallback provider');
    assert.equal(provenanceReported.fallbackOccurred, true, 'Provenance must accurately record fallbackOccurred=true');
    assert.equal(provenanceReported.executedProvider, 'groq', 'Executed provider must be groq');
    assert.equal(provenanceReported.executedModel, 'openai/gpt-oss-120b', 'Executed model must be openai/gpt-oss-120b');
    assert.ok(provenanceReported.fallbackReason.includes('HTTP 404'), 'Fallback reason must document the upstream HTTP 404');
    console.log(`PASS: Upstream NVIDIA 404 captured; fell back cleanly to ${provenanceReported.executedProvider}:${provenanceReported.executedModel}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------------------
  // SECTION 3: INTERNAL MODEL ALIAS DISPATCH DEFENSE-IN-DEPTH
  // -------------------------------------------------------------------------
  console.log('\n[SECTION 3] Verifying Internal Model Aliases Never Reach External APIs...');

  const supportedAiraModes = ['aira-auto', 'aira-fast', 'aira-pro', 'aira-deep'] as const;
  const originalFetch2 = globalThis.fetch;

  try {
    const interceptedRequests: Array<{ url: string; model: string }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      let requestModel = '';
      if (init?.body) {
        try {
          const parsed = JSON.parse(String(init.body));
          if (parsed.model) requestModel = parsed.model;
        } catch {}
      }
      if (!requestModel && urlStr.includes('/models/')) {
        const match = urlStr.match(/\/models\/([^:/?]+)/);
        if (match) requestModel = match[1];
      }

      interceptedRequests.push({ url: urlStr, model: requestModel });

      // Verify immediate invariant: request body/URL model MUST NOT be an internal aira-* alias!
      assert.ok(
        !requestModel.startsWith('aira-'),
        `CRITICAL SECURITY VIOLATION: Internal model alias "${requestModel}" was dispatched to external API: ${urlStr}`
      );

      // Return synthetic SSE response
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(sseStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    // Test 3.1: OpenAIAdapter with OpenAI baseUrl
    const openaiAdapter = new OpenAIAdapter('mock-key', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    for (const mode of supportedAiraModes) {
      await openaiAdapter.stream([{ role: 'user', content: 'hello' }], { model: mode, temperature: 0.2, maxTokens: 100 }, () => {});
    }

    // Test 3.2: OpenAIAdapter with NVIDIA baseUrl
    const nvidiaAdapter = new OpenAIAdapter('mock-key', 'https://integrate.api.nvidia.com/v1', 'nvidia/nemotron-3-super-120b-a12b', 'nvidia');
    for (const mode of supportedAiraModes) {
      await nvidiaAdapter.stream([{ role: 'user', content: 'hello' }], { model: mode, temperature: 0.2, maxTokens: 100 }, () => {});
    }

    // Test 3.3: OpenAIAdapter with Groq baseUrl
    const groqAdapter = new OpenAIAdapter('mock-key', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'groq');
    for (const mode of supportedAiraModes) {
      await groqAdapter.stream([{ role: 'user', content: 'hello' }], { model: mode, temperature: 0.2, maxTokens: 100 }, () => {});
    }

    // Test 3.4: GeminiAdapter
    const geminiAdapter = new GeminiAdapter('mock-gemini-key', 'gemini-3.5-flash-lite');
    for (const mode of supportedAiraModes) {
      await geminiAdapter.stream([{ role: 'user', content: 'hello' }], { model: mode, temperature: 0.2, maxTokens: 100 }, () => {});
    }

    console.log(`PASS: Verified ${interceptedRequests.length} external provider API requests across all 4 Aira modes`);
    for (const req of interceptedRequests) {
      assert.ok(!req.model.startsWith('aira-'), `Dispatched model must not be alias: ${req.model}`);
    }
    console.log('PASS: Zero internal model aliases (aira-auto, aira-fast, aira-pro, aira-deep) reached external APIs');

    // Test 3.5: Fail-closed assertion if an internal alias is directly forced unmapped
    const rawAdapter = new OpenAIAdapter('mock-key', 'https://api.unknown.com/v1', 'aira-unmapped-alias' as any, 'unknown');
    await assert.rejects(
      () => rawAdapter.complete([{ role: 'user', content: 'test' }], { model: 'aira-unmapped-alias', temperature: 0.2, maxTokens: 50 }),
      /INTERNAL_MODEL_ALIAS_LEAK/,
      'Unmapped internal alias must fail closed with INTERNAL_MODEL_ALIAS_LEAK'
    );
    console.log('PASS: Fail-closed defense-in-depth guard strictly rejected unmapped internal alias');
  } finally {
    globalThis.fetch = originalFetch2;
  }

  console.log('\n========================================================================');
  console.log('  ALL RELEASE-READINESS CERTIFICATION CHECKS PASSED (100%)');
  console.log('========================================================================\n');
}

runReleaseReadinessTestSuite().catch(err => {
  console.error('\n[FATAL] Release-Readiness Certification Failed:', err);
  process.exit(1);
});
