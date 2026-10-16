import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRecoveryEngine } from '../../packages/agent-runtime/src/behavioral/tool-recovery-engine.js';
import type { ToolResult } from '../../packages/contracts/src/index.js';

const recovery = new ToolRecoveryEngine();
const receipt = (output: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({
  toolCallId: 'call-1',
  output,
  durationMs: 5,
  timestamp: Date.now(),
  isError: false,
  ...extra
});

describe('Tool completion evidence checks', () => {
  it('rejects error flags without descriptive messages', () => {
    assert.equal(recovery.verifyCompletion('calculator', receipt({ answer: 1 }, { isError: true })).verified, false);
  });

  it('rejects absent result evidence', () => {
    assert.equal(recovery.verifyCompletion('calculator', receipt(null)).verified, false);
    assert.equal(recovery.verifyCompletion('calculator', receipt(undefined)).verified, false);
  });

  it('accepts concrete successful results', () => {
    assert.equal(recovery.verifyCompletion('calculator', receipt({ answer: 1 })).verified, true);
  });

  it('requires browser navigation receipts', () => {
    assert.equal(recovery.verifyCompletion('browser_navigate', receipt({})).verified, false);
    assert.equal(recovery.verifyCompletion('browser_navigate', receipt({ url: 'https://example.org' })).verified, true);
  });
});
