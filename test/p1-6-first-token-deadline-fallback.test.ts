import assert from 'node:assert/strict';
import { ModelPolicySchema, ModelPolicy } from '../packages/contracts/src/index.js';
import { ModelAdapter, ModelCompletionResult, ChatMessageInput } from '../packages/model-router/src/index.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';
import { ResilientModelAdapter } from '../packages/model-router/src/resilient-adapter.js';

class MockSlowAdapter implements ModelAdapter {
  constructor(
    public readonly provider: any,
    public readonly modelName: string,
    private readonly delayMs: number,
    private readonly emitThinkingFirst: boolean = false
  ) {}

  async complete(): Promise<ModelCompletionResult> {
    throw new Error('Not implemented');
  }

  async stream(
    _messages: ChatMessageInput[],
    _policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<ModelCompletionResult> {
    if (this.emitThinkingFirst) {
      // Emit thinking immediately
      onChunk({ thinking: 'Thinking about the answer...' });
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('AbortError: Request was aborted'));
        }, { once: true });
      }
    });

    onChunk({ text: `Response from ${this.modelName}` });
    return {
      text: `Response from ${this.modelName}`,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: this.modelName
    };
  }
}

async function runTests() {
  console.log('=== P1.6 FIRST-TOKEN DEADLINE & SAFE FALLBACK TEST SUITE ===');

  const tracker = new ProviderHealthTracker({ cooldownMs: 1000 });
  const policy: ModelPolicy = ModelPolicySchema.parse({
    model: 'aira-fast',
    maxTokens: 500,
    temperature: 0.7,
    timeoutMs: 10000
  });

  // TEST 1: Normal fast stream completes without triggering deadline or fallback
  console.log('\n[TEST 1] Normal fast stream completes without deadline or fallback');
  const primaryFast = new MockSlowAdapter('groq', 'openai/gpt-oss-120b', 100);
  const fallbackFast = new MockSlowAdapter('groq', 'allam-2-7b', 80);

  const resilient1 = new ResilientModelAdapter(
    primaryFast,
    fallbackFast,
    tracker,
    { firstTokenTimeoutMs: 300 }
  );

  const chunks1: string[] = [];
  let prov1: any = null;
  const res1 = await resilient1.stream(
    [{ role: 'user', content: 'hello' }],
    policy,
    delta => { if (delta.text) chunks1.push(delta.text); },
    { onProvenance: p => { prov1 = p; } }
  );

  assert.equal(res1.text, 'Response from openai/gpt-oss-120b');
  assert.equal(chunks1.join(''), 'Response from openai/gpt-oss-120b');
  assert.equal(prov1?.executedModel, 'openai/gpt-oss-120b');
  assert.equal(prov1?.fallbackOccurred, false);
  console.log('PASS: Primary adapter delivered first token within deadline.');

  // TEST 2: Thinking tokens DO NOT prevent first-token deadline timeout
  console.log('\n[TEST 2] Thinking tokens DO NOT count as content; deadline aborts slow primary');
  // Primary emits thinking right away, but hangs for 600ms before visible text.
  // Deadline is 200ms.
  const slowPrimaryWithThinking = new MockSlowAdapter('groq', 'openai/gpt-oss-120b', 600, true);
  const quickFallback = new MockSlowAdapter('groq', 'allam-2-7b', 50, false);

  const resilient2 = new ResilientModelAdapter(
    slowPrimaryWithThinking,
    quickFallback,
    tracker,
    { firstTokenTimeoutMs: 200 }
  );

  const chunks2: string[] = [];
  const thinking2: string[] = [];
  let prov2: any = null;

  const res2 = await resilient2.stream(
    [{ role: 'user', content: 'test prompt' }],
    policy,
    delta => {
      if (delta.text) chunks2.push(delta.text);
      if (delta.thinking) thinking2.push(delta.thinking);
    },
    { onProvenance: p => { prov2 = p; } }
  );

  assert.equal(res2.text, 'Response from allam-2-7b', 'Should successfully fall back to allam-2-7b');
  assert.equal(prov2?.executedModel, 'allam-2-7b');
  assert.equal(prov2?.requestedModel, 'openai/gpt-oss-120b');
  assert.equal(prov2?.fallbackOccurred, true);
  assert.ok(prov2?.fallbackReason?.includes('deadline') || prov2?.fallbackReason?.includes('timeout'), 'Reason must cite deadline');
  console.log('PASS: Thinking tokens did not prevent deadline abort; truthful fallback occurred.');

  // TEST 3: Request stickiness: provider locked once content token begins
  console.log('\n[TEST 3] Request stickiness: provider locked once first visible content arrives');
  assert.equal(resilient2.isStickinessLocked(), true, 'Adapter must be locked once first content emitted');
  console.log('PASS: Request stickiness guarantees no mid-answer provider switching.');

  console.log('\n=== ALL P1.6 DEADLINE & FALLBACK TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
