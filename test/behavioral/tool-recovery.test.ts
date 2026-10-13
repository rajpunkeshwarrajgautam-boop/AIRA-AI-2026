import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ToolRecoveryEngine } from '../../packages/agent-runtime/src/behavioral/tool-recovery-engine.js';
import { ToolResult } from '../../packages/contracts/src/index.js';

describe('AIRA Behavioral Intelligence — Tool Intelligence & Execution Recovery', () => {
  const engine = new ToolRecoveryEngine();

  it('triggers bounded retry for transient network errors on idempotent operations', () => {
    const decision = engine.evaluateFailure(
      {
        toolName: 'web_search',
        arguments: { query: 'quantum computing records' },
        isIdempotent: true,
        requiresApproval: false
      },
      0, // Initial attempt failed
      'ETIMEDOUT: Connection to search provider timed out after 5000ms'
    );

    assert.strictEqual(decision.action, 'RETRY');
    assert.strictEqual(decision.attempt, 1);
    assert.strictEqual(decision.isIdempotent, true);
  });

  it('strictly forbids retrying non-idempotent operations blindly', () => {
    const decision = engine.evaluateFailure(
      {
        toolName: 'browser_submit_form',
        arguments: { selector: '#payment-form', submit: true },
        isIdempotent: false, // Non-idempotent!
        requiresApproval: true
      },
      0,
      'ECONNRESET: Connection dropped during form submit'
    );

    assert.notStrictEqual(decision.action, 'RETRY', 'Must never blindly retry non-idempotent mutation');
    assert.strictEqual(decision.action, 'ABORT_PERMANENT_ERROR');
    assert.ok(decision.explanation.includes('Non-idempotent'));
  });

  it('switches to alternative fallback tool when primary tool retries are exhausted', () => {
    const decision = engine.evaluateFailure(
      {
        toolName: 'tavily_search',
        arguments: { query: 'battery density records' },
        isIdempotent: true,
        requiresApproval: false,
        alternativeTools: ['exa_search']
      },
      2, // Max retries exhausted
      'HTTP 503: Service Unavailable'
    );

    assert.strictEqual(decision.action, 'FALLBACK_TOOL');
    assert.strictEqual(decision.alternativeTool, 'exa_search');
  });

  it('halts immediately on permanent authorization or permission errors', () => {
    const decision = engine.evaluateFailure(
      {
        toolName: 'system_shell',
        arguments: { command: 'rm -rf /tmp/build' },
        isIdempotent: false,
        requiresApproval: true
      },
      0,
      'Permission denied: execution requires elevated root approval'
    );

    assert.strictEqual(decision.action, 'ASK_APPROVAL');
    assert.ok(decision.explanation.includes('authorization'));
  });

  it('enforces zero fabricated success when tool produces error or no output', () => {
    // 1. Missing result
    const verifyMissing = engine.verifyCompletion('browser_navigate', undefined);
    assert.strictEqual(verifyMissing.state, 'FAILED');
    assert.strictEqual(verifyMissing.verified, false);

    // 2. Errored result
    const failedResult: ToolResult = {
      callId: 'call_1',
      output: null,
      error: 'Navigation failed: net::ERR_NAME_NOT_RESOLVED',
      durationMs: 150
    };
    const verifyFailed = engine.verifyCompletion('browser_navigate', failedResult);
    assert.strictEqual(verifyFailed.state, 'FAILED');
    assert.strictEqual(verifyFailed.verified, false);

    // 3. Genuine successful result
    const successResult: ToolResult = {
      callId: 'call_2',
      output: { url: 'https://example.com', title: 'Example Domain', screenshot: 'base64_data' },
      durationMs: 400
    };
    const verifySuccess = engine.verifyCompletion('browser_navigate', successResult);
    assert.strictEqual(verifySuccess.state, 'COMPLETED');
    assert.strictEqual(verifySuccess.verified, true);
  });
});
