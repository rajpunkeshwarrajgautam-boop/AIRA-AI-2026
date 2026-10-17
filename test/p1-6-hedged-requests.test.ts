import assert from 'node:assert/strict';
import { ModelPolicySchema, ModelPolicy } from '../packages/contracts/src/index.js';
import { ModelAdapter, ModelCompletionResult, ChatMessageInput } from '../packages/model-router/src/index.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';
import { ResilientModelAdapter } from '../packages/model-router/src/resilient-adapter.js';

class MockDelayedAdapter implements ModelAdapter {
  public wasCancelled: boolean = false;
  public completedNormally: boolean = false;

  constructor(
    public readonly provider: any,
    public readonly modelName: string,
    private readonly delayMs: number
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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completedNormally = true;
        resolve(true);
      }, this.delayMs);

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          this.wasCancelled = true;
          reject(new Error('AbortError: Request was aborted'));
        }, { once: true });
      }
    });

    onChunk({ text: `Content from ${this.modelName}` });
    return {
      text: `Content from ${this.modelName}`,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: this.modelName
    };
  }
}

async function runTests() {
  console.log('=== P1.6 HEDGED REQUEST EXPERIMENT TEST SUITE ===');

  const tracker = new ProviderHealthTracker({ cooldownMs: 1000 });
  const policy: ModelPolicy = ModelPolicySchema.parse({
    model: 'aira-fast',
    maxTokens: 500,
    temperature: 0.7,
    timeoutMs: 10000
  });

  // TEST 1: Fast primary finishes before hedge delay -> Secondary is NEVER launched
  console.log('\n[TEST 1] Fast primary finishes before hedge delay -> Secondary never launched');
  const fastPrimary = new MockDelayedAdapter('groq', 'openai/gpt-oss-120b', 80);
  const standbySecondary = new MockDelayedAdapter('groq', 'allam-2-7b', 150);

  const resilient1 = new ResilientModelAdapter(
    fastPrimary,
    standbySecondary,
    tracker,
    {
      firstTokenTimeoutMs: 1000,
      enableHedging: true,
      hedgeDelayMs: 200 // Hedge kicks in only after 200ms
    }
  );

  const chunks1: string[] = [];
  let prov1: any = null;
  const res1 = await resilient1.stream(
    [{ role: 'user', content: 'test' }],
    policy,
    d => { if (d.text) chunks1.push(d.text); },
    { onProvenance: p => { prov1 = p; } }
  );

  assert.equal(res1.text, 'Content from openai/gpt-oss-120b');
  assert.equal(prov1?.executedModel, 'openai/gpt-oss-120b');
  assert.equal(prov1?.hedgedRequestUsed, false);
  assert.equal(standbySecondary.wasCancelled, false);
  assert.equal(standbySecondary.completedNormally, false, 'Secondary must not have executed');
  console.log('PASS: Primary finished before hedge delay; secondary was never dispatched.');

  // TEST 2: Primary is delayed beyond hedge delay -> Secondary launches and wins race
  console.log('\n[TEST 2] Primary delayed beyond hedge delay -> Secondary launches and wins');
  // Primary takes 500ms. Hedge delay is 100ms. Secondary takes 80ms.
  // Timeline:
  // 0ms: Primary starts
  // 100ms: Hedge delay fires -> Secondary starts
  // 180ms: Secondary finishes (100 + 80) -> Secondary wins!
  // 180ms: Primary is cancelled immediately!
  const slowPrimary = new MockDelayedAdapter('groq', 'openai/gpt-oss-120b', 500);
  const fastSecondary = new MockDelayedAdapter('groq', 'allam-2-7b', 80);

  const resilient2 = new ResilientModelAdapter(
    slowPrimary,
    fastSecondary,
    tracker,
    {
      firstTokenTimeoutMs: 1000,
      enableHedging: true,
      hedgeDelayMs: 100
    }
  );

  const chunks2: string[] = [];
  let prov2: any = null;
  const res2 = await resilient2.stream(
    [{ role: 'user', content: 'test' }],
    policy,
    d => { if (d.text) chunks2.push(d.text); },
    { onProvenance: p => { prov2 = p; } }
  );

  assert.equal(res2.text, 'Content from allam-2-7b');
  assert.equal(chunks2.join(''), 'Content from allam-2-7b');
  assert.equal(prov2?.executedModel, 'allam-2-7b');
  assert.equal(prov2?.requestedModel, 'openai/gpt-oss-120b');
  assert.equal(prov2?.fallbackOccurred, true);
  assert.equal(prov2?.hedgedRequestUsed, true);
  assert.equal(slowPrimary.wasCancelled, true, 'Losing primary must be cancelled via AbortController');
  console.log('PASS: Secondary hedged request won the race; slow primary was cleanly aborted.');

  console.log('\n=== ALL P1.6 HEDGED REQUEST TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
