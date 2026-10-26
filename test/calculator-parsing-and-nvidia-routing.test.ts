import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  resolveNvidiaModel,
  OpenAIAdapter,
  ResilientModelAdapter,
  ProviderHealthTracker
} from '../packages/model-router/src/index.js';
import { ModelPolicy } from '../packages/contracts/src/index.js';
import { extractCalculatorExpression } from '../packages/agent-runtime/src/index.js';

describe('AIRA AI 2026 — Calculator Parsing & Model Routing Suite', () => {

  // =========================================================================
  // SECTION 1: CALCULATOR PARSER DEFECT REPRODUCTION & RESOLUTION
  // =========================================================================
  test('Calculator Parser — extraction accuracy, boundary defense, and zero false-positive numbers', () => {
    // 1. Valid complex formulas
    const d5Prompt = 'AIRA Production Acceptance Certification Protocol: calculate ((16384 * 1024) / 4). Execute the calculator tool.';
    const d5Expr = extractCalculatorExpression(d5Prompt);
    assert.strictEqual(d5Expr, '((16384 * 1024) / 4)');

    // Evaluate formula mathematically to verify 4194304
    const evalResult = new Function(`return (${d5Expr})`)();
    assert.strictEqual(evalResult, 4194304, 'calculate ((16384 * 1024) / 4) must evaluate to 4194304');

    const simplePrompt = 'compute 2 + 2';
    assert.strictEqual(extractCalculatorExpression(simplePrompt), '2 + 2');
    assert.strictEqual(new Function(`return (${extractCalculatorExpression(simplePrompt)})`)(), 4);

    const arithmeticPrompt = 'Please calculate 42 * 100 in bytes';
    assert.strictEqual(extractCalculatorExpression(arithmeticPrompt), '42 * 100');

    // 2. Strict rejection of standalone keywords and non-arithmetic text
    assert.strictEqual(extractCalculatorExpression('calculator'), '', 'Bare keyword "calculator" must NOT yield expression');
    assert.strictEqual(extractCalculatorExpression('calculate'), '', 'Bare keyword "calculate" must NOT yield expression');
    assert.strictEqual(extractCalculatorExpression('AIRA AI 2026'), '', '"AIRA AI 2026" must NOT yield year "2026"');
    assert.strictEqual(extractCalculatorExpression('business calculation analysis'), '', '"business calculation analysis" must NOT trigger calculator');
    assert.strictEqual(extractCalculatorExpression('Cluster with 10 nodes, 20 workers, and port 8080'), '', 'Prompts with multiple unrelated numbers must NOT trigger calculator');
    assert.strictEqual(extractCalculatorExpression('AIRA AI 2026 PR #112: Please execute calculator on the memory quotient.'), '', 'Missing formula must NOT extract year or PR number');
  });

  // =========================================================================
  // SECTION 2: NVIDIA MODEL ROUTING, IDENTIFIER HYGIENE & FALLBACK
  // =========================================================================
  test('NVIDIA Model Routing — Canonical identifier hygiene and resilient circuit breaker', async () => {
    // 1. Canonical upstream identifier verification
    const resolved = resolveNvidiaModel('aira-pro');
    assert.strictEqual(resolved, 'nvidia/nemotron-3-super-120b-a12b', 'aira-pro must resolve to canonical Nemotron identifier');
    assert.strictEqual(resolved.startsWith('aira-'), false, 'Canonical model identifier MUST NOT leak aira-* prefix');

    // 2. Resilient fallback handling on upstream HTTP 404
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

    let nvidiaInvocations = 0;
    let groqInvocations = 0;
    let fallbackProvenanceCaptured: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('integrate.api.nvidia.com')) {
        nvidiaInvocations++;
        return new Response(JSON.stringify({
          status: 404,
          title: 'Not Found',
          detail: "Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'IWp0S44IxqoKxlASDHiRhMsA1f2Cif8UgbEq19XdhYQ'"
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      if (urlStr.includes('api.groq.com')) {
        groqInvocations++;
        const sseStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Synthesized answer via Groq fallback."}}]}\n\n'));
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
          fallbackProvenanceCaptured = p;
        }
      });

      const policy: ModelPolicy = {
        model: 'aira-pro',
        temperature: 0.7,
        maxTokens: 1024
      };

      let streamOutput = '';
      await resilientAdapter.stream(
        [{ role: 'user', content: 'Execute reasoning analysis' }],
        policy,
        (chunk) => {
          streamOutput += chunk.text || '';
        }
      );

      assert.strictEqual(nvidiaInvocations, 1, 'Primary NVIDIA must be attempted first');
      assert.strictEqual(groqInvocations, 1, 'Fallback Groq must be invoked upon NVIDIA 404');
      assert.strictEqual(streamOutput.trim(), 'Synthesized answer via Groq fallback.');
      assert.strictEqual(fallbackProvenanceCaptured?.fallbackOccurred, true);
      assert.strictEqual(fallbackProvenanceCaptured?.executedProvider, 'groq');
      assert.strictEqual(fallbackProvenanceCaptured?.executedModel, 'openai/gpt-oss-120b');

      // 3. Test Circuit Breaker: Subsequent request immediately bypasses NVIDIA
      const circuitState = healthTracker.getCircuitState('nvidia', 'nvidia/nemotron-3-super-120b-a12b');
      assert.strictEqual(circuitState, 'OPEN', 'NVIDIA circuit breaker must be OPEN after 404');

      let secondCallStreamOutput = '';
      let secondCallProvenance: any = null;
      await resilientAdapter.stream(
        [{ role: 'user', content: 'Second query while circuit breaker is open' }],
        policy,
        (chunk) => {
          secondCallStreamOutput += chunk.text || '';
        },
        {
          onProvenance: (p) => {
            secondCallProvenance = p;
          }
        }
      );

      assert.strictEqual(nvidiaInvocations, 1, 'NVIDIA must NOT be invoked again while circuit breaker is OPEN');
      assert.strictEqual(groqInvocations, 2, 'Fallback Groq must be directly invoked for second request');
      assert.strictEqual(secondCallProvenance?.fallbackOccurred, true);
      assert.strictEqual(secondCallProvenance?.executedProvider, 'groq');
      assert.ok(secondCallProvenance?.fallbackReason.includes('circuit breaker is OPEN'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
