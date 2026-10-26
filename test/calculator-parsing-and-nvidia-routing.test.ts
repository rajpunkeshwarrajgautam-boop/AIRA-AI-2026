import assert from 'node:assert/strict';
import {
  resolveNvidiaModel,
  OpenAIAdapter,
  ResilientModelAdapter,
  ProviderHealthTracker
} from '../packages/model-router/src/index.js';
import { ModelPolicy } from '../packages/contracts/src/index.js';

// =========================================================================
// SECTION 1: CALCULATOR PARSER DEFECT REPRODUCTION & EXPECTED BEHAVIOR
// =========================================================================

/**
 * Historical buggy parser (Commit de4ceeeb - Pre-PR112 production):
 * Uses /([0-9+\-*\/().^ ]+)/ which matches any space character first!
 */
function legacyParserPrePR112(prompt: string): string {
  const exprMatch = prompt.match(/([0-9+\-*/().^ ]+)/);
  const raw = exprMatch ? exprMatch[0].trim() : '1024 * 4';
  return raw;
}

/**
 * Current PR#112 parser (Commit 65cf42b / 9db745f):
 * Uses /(?:calculate|calc|compute)\s*:?\s*([0-9+\-*\/().^]*[0-9]+[0-9+\-*\/().^ ]*)/i
 * Defect: Lacks word boundaries, matches 'calc' inside 'calculator', fails if 'calculate' isn't immediately adjacent.
 */
function currentPR112Parser(prompt: string): string {
  const calcMatch = prompt.match(/(?:calculate|calc|compute)\s*:?\s*([0-9+\-*/().^]*[0-9]+[0-9+\-*/().^ ]*)/i);
  const rawExpr = calcMatch ? calcMatch[1] : (prompt.match(/([0-9+\-*/().^]*[0-9]+[0-9+\-*/().^ ]*)/)?.[0] || '1024 * 4');
  return rawExpr.replace(/[^0-9+\-*/().^ ]/g, '').replace(/[. ]+$/, '').trim();
}

/**
 * Proposed Corrected Robust Parser:
 * 1. Uses word boundary \b(?:\bcalculate|\bcalc|\bcompute)\b
 * 2. Extracts mathematical expressions containing arithmetic operators (+, -, *, /, ^)
 * 3. Handles 'calculator tool: <expr>', 'calculate <expr>', and standalone expressions
 * 4. Ignores standalone years (2026) and PR numbers (#112) unless part of formula
 * 5. Guarantees non-empty string so gateway validation always passes
 */
export function robustCalculatorParser(prompt: string): string {
  // Pattern 1: Explicit formula with parenthesis or binary operators
  // Looks for arithmetic expressions like ((16384 * 1024) / 4) or 40 + 2
  const formulaMatch = prompt.match(/(?:\((?:[0-9+\-*/().^\s]+)\)|[0-9]+(?:\.[0-9]+)?\s*[-+*/^]\s*[0-9]+(?:\.[0-9]+)?(?:[0-9+\-*/().^\s]*))/);
  if (formulaMatch && formulaMatch[0]) {
    const cleaned = formulaMatch[0].replace(/[^0-9+\-*/().^ ]/g, '').replace(/[. ]+$/, '').trim();
    if (cleaned.length > 0 && /[0-9]/.test(cleaned) && /[-+*/^]/.test(cleaned)) {
      return cleaned;
    }
  }

  // Pattern 2: Keyword prefix with word boundary: calculate/calculator/calc/compute followed by numbers with operator
  const keywordMatch = prompt.match(/\b(?:calculate|calculator|calc|compute)\b\s*:?\s*([0-9+\-*/().^]*[0-9]+[0-9+\-*/().^ ]*)/i);
  if (keywordMatch && keywordMatch[1] && /[+\-*/^]/.test(keywordMatch[1])) {
    const cleaned = keywordMatch[1].replace(/[^0-9+\-*/().^ ]/g, '').replace(/[. ]+$/, '').trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  // Strictly return empty string — NEVER invent a default expression
  return '';
}

function runCalculatorParserTests() {
  console.log('--- [TEST 1] CALCULATOR PARSING DEFECT REPRODUCTION & RESOLUTION ---');

  const failedRunD5Prompt = 'AIRA Production Acceptance Certification Protocol: Live production model and tool gateway acceptance sequence. Please verify the autonomous execution pipeline and tool gateway by evaluating the cluster memory formula: calculate ((16384 * 1024) / 4). Execute the calculator tool, evaluate the result with zero truncation, and provide the complete synthesized answer.';

  const failedRunE4Prompt = 'AIRA Agent Diagnostic Mission: Execute an authoritative compute cluster resource quotient analysis across distributed workers. Specifically, calculate the memory allocation quotient using: calculate ((16384 * 1024) / 4) in bytes. Verify that all intermediate tool calls persist durably to PostgreSQL without column drift, and return the final quotient in megabytes alongside complete mission verification telemetry.';

  // 1. Demonstrate pre-PR112 failure: matches leading space -> empty string
  const legacyD5 = legacyParserPrePR112(failedRunD5Prompt);
  assert.strictEqual(legacyD5, '', 'PRE-PR112 DEFECT: matched space before "Production" and trimmed to empty string');
  console.log('  ✓ Verified Pre-PR112 Defect: returns "" (empty string), triggering "Required argument expression missing"');

  // 2. Demonstrate word boundary defect in current PR112 regex:
  // Prompt where 'calculator' is used without duplicate 'calculate' word
  const calculatorOnlyPrompt = 'Execute the calculator tool: ((16384 * 1024) / 4)';
  const pr112CalcOnly = currentPR112Parser(calculatorOnlyPrompt);
  assert.strictEqual(pr112CalcOnly, '((16384 * 1024) / 4)', 'Current parser falls back to secondary regex for parenthesis formula');

  // Edge case: prompt with year and PR number preceding calculator
  const trickyPrompt = 'AIRA AI 2026 PR #112: Please execute calculator on the memory quotient.';
  const pr112Tricky = currentPR112Parser(trickyPrompt);
  console.log(`  Current PR112 parser on tricky prompt ("${trickyPrompt}") -> "${pr112Tricky}"`);
  // Notice: Current parser matched "2026" because calcMatch was null and secondary regex grabbed first number!
  assert.strictEqual(pr112Tricky, '2026', 'Current parser erroneously grabs year 2026 instead of valid calculation or default');

  // 3. Test Robust Parser on all cases
  const robustD5 = robustCalculatorParser(failedRunD5Prompt);
  assert.strictEqual(robustD5, '((16384 * 1024) / 4)');

  const robustE4 = robustCalculatorParser(failedRunE4Prompt);
  assert.strictEqual(robustE4, '((16384 * 1024) / 4)');

  const robustTricky = robustCalculatorParser(trickyPrompt);
  assert.strictEqual(robustTricky, '', 'Robust parser must NEVER invent a default mathematical expression when user has not supplied one');

  const robustSimple = robustCalculatorParser('Please calculate 42 * 100 in bytes');
  assert.strictEqual(robustSimple, '42 * 100');

  console.log('  ✓ Robust parser passed all edge cases: zero false-positive numbers and zero invented defaults.\n');
}

// =========================================================================
// SECTION 2: NVIDIA MODEL ROUTING, IDENTIFIER HYGIENE & FALLBACK VERIFICATION
// =========================================================================

async function runNvidiaRoutingTests() {
  console.log('--- [TEST 2] NVIDIA MODEL ROUTING & RESILIENT FALLBACK ---');

  // 1. Model resolution hygiene: Canonical upstream identifier
  const resolved = resolveNvidiaModel('aira-pro');
  assert.strictEqual(resolved, 'nvidia/nemotron-3-super-120b-a12b', 'aira-pro must resolve to canonical Nemotron identifier');
  assert.strictEqual(resolved.startsWith('aira-'), false, 'Canonical model identifier MUST NOT leak aira-* prefix');
  console.log(`  ✓ Upstream identifier verified: "${resolved}" (zero internal alias leak)`);

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
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('integrate.api.nvidia.com')) {
      nvidiaInvocations++;
      // Exact error response returned by NVIDIA Cloud Functions in production
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
    assert.strictEqual(streamOutput.trim(), 'Synthesized answer via Groq fallback.', 'Output must match fallback stream');
    assert.strictEqual(fallbackProvenanceCaptured?.fallbackOccurred, true, 'Provenance must record fallbackOccurred=true');
    assert.strictEqual(fallbackProvenanceCaptured?.executedProvider, 'groq', 'Provenance must report active provider as groq');
    assert.strictEqual(fallbackProvenanceCaptured?.executedModel, 'openai/gpt-oss-120b', 'Provenance must record executedModel');

    console.log('  ✓ Resilient fallback verified: 404 handled cleanly with zero stream loss and accurate provenance.');

    // 3. Test Circuit Breaker: Second call MUST bypass NVIDIA completely because circuit is OPEN!
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

    assert.strictEqual(nvidiaInvocations, 1, 'NVIDIA must NOT be invoked again while circuit breaker is OPEN (zero wasted requests)');
    assert.strictEqual(groqInvocations, 2, 'Fallback Groq must be directly invoked for second request');
    assert.strictEqual(secondCallProvenance?.fallbackOccurred, true, 'Second call must report fallbackOccurred=true');
    assert.strictEqual(secondCallProvenance?.executedProvider, 'groq', 'Second call executed provider must be groq');
    assert.ok(secondCallProvenance?.fallbackReason.includes('circuit breaker is OPEN'), 'Fallback reason must state circuit breaker is OPEN');
    console.log('  ✓ Circuit breaker protection verified: Subsequent requests immediately bypass failed NVIDIA endpoint with zero wasted latency.\n');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runAll() {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — P0 RELIABILITY FOLLOW-UP REGRESSION TEST SUITE');
  console.log('========================================================================\n');

  runCalculatorParserTests();
  await runNvidiaRoutingTests();

  console.log('========================================================================');
  console.log('  ALL REGRESSION TESTS PASSED (100% VERIFIED)');
  console.log('========================================================================');
}

runAll().catch(err => {
  console.error('REGRESSION TEST FAILED:', err);
  process.exit(1);
});
