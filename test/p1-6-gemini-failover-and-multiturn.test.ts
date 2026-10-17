import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ResilientModelAdapter,
  ProviderHealthTracker,
  LatencyAwareRoutingPolicy,
  ModelAdapter,
  ChatMessageInput,
  ModelCompletionResult,
  SupportedProvider
} from '../packages/model-router/src/index.js';
import { ModelPolicy } from '../packages/contracts/src/index.js';

class MockStreamingAdapter implements ModelAdapter {
  readonly provider: SupportedProvider;
  readonly modelName: string;
  private delayMs: number;
  private chunks: string[];
  private shouldFailWithStatus?: number;

  constructor(
    provider: SupportedProvider,
    modelName: string,
    chunks: string[],
    delayMs = 10,
    shouldFailWithStatus?: number
  ) {
    this.provider = provider;
    this.modelName = modelName;
    this.chunks = chunks;
    this.delayMs = delayMs;
    this.shouldFailWithStatus = shouldFailWithStatus;
  }

  async complete(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    signal?: AbortSignal
  ): Promise<ModelCompletionResult> {
    if (this.shouldFailWithStatus) {
      const err = new Error(`Upstream error ${this.shouldFailWithStatus}`);
      (err as any).status = this.shouldFailWithStatus;
      throw err;
    }
    return {
      text: this.chunks.join(''),
      model: this.modelName,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    };
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: {
      firstTokenTimeoutMs?: number;
      signal?: AbortSignal;
      onProvenance?: (p: any) => void;
    }
  ): Promise<ModelCompletionResult> {
    if (this.shouldFailWithStatus) {
      const err = new Error(`Upstream error ${this.shouldFailWithStatus}`);
      (err as any).status = this.shouldFailWithStatus;
      throw err;
    }

    if (this.delayMs > 0) {
      await new Promise(r => setTimeout(r, this.delayMs));
    }

    options?.signal?.throwIfAborted();

    for (const chunk of this.chunks) {
      options?.signal?.throwIfAborted();
      onChunk({ text: chunk });
    }

    return {
      text: this.chunks.join(''),
      model: this.modelName,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    };
  }
}

test('Gemini Fallover & Multi-Turn Suite: Turn 1 (Groq) -> Turn 2 (Groq 429 -> Gemini) -> Turn 3 (Gemini follow-up)', async () => {
  const tracker = new ProviderHealthTracker();
  const policy: ModelPolicy = { model: 'openai/gpt-oss-120b', temperature: 0.7 };

  // TURN 1: Groq succeeds
  const groqTurn1 = new MockStreamingAdapter('groq', 'openai/gpt-oss-120b', ['Project ', 'Codename: ', 'Titan.']);
  const geminiTurn1 = new MockStreamingAdapter('gemini', 'gemini-3.5-flash-lite', ['Project Titan']);
  let provenanceTurn1: any = null;

  const adapter1 = new ResilientModelAdapter(groqTurn1, geminiTurn1, tracker);
  const receivedText1: string[] = [];
  await adapter1.stream(
    [{ role: 'user', content: 'What is our project codename?' }],
    policy,
    c => { if (c.text) receivedText1.push(c.text); },
    { onProvenance: p => { provenanceTurn1 = p; } }
  );

  assert.equal(receivedText1.join(''), 'Project Codename: Titan.');
  assert.equal(provenanceTurn1.executedProvider, 'groq');
  assert.equal(provenanceTurn1.fallbackOccurred, false);

  // TURN 2: Groq encounters 429 rate limit -> Seamlessly fails over to Gemini
  const groqTurn2 = new MockStreamingAdapter('groq', 'openai/gpt-oss-120b', [], 5, 429); // 429 error
  const geminiTurn2 = new MockStreamingAdapter('gemini', 'gemini-3.5-flash-lite', ['Project ', 'Titan ', 'builds ', 'transceivers.']);
  let provenanceTurn2: any = null;

  const historyTurn2: ChatMessageInput[] = [
    { role: 'user', content: 'What is our project codename?' },
    { role: 'assistant', content: 'Project Codename: Titan.' },
    { role: 'user', content: 'What does Titan build?' }
  ];

  const adapter2 = new ResilientModelAdapter(groqTurn2, geminiTurn2, tracker);
  const receivedText2: string[] = [];
  await adapter2.stream(
    historyTurn2,
    policy,
    c => { if (c.text) receivedText2.push(c.text); },
    { onProvenance: p => { provenanceTurn2 = p; } }
  );

  assert.equal(receivedText2.join(''), 'Project Titan builds transceivers.');
  assert.equal(provenanceTurn2.requestedProvider, 'groq');
  assert.equal(provenanceTurn2.executedProvider, 'gemini', 'Must execute on Gemini');
  assert.equal(provenanceTurn2.fallbackOccurred, true);
  assert.ok(provenanceTurn2.fallbackReason?.includes('429'));

  // TURN 3: Follow-up query with full history across provider switch
  const historyTurn3: ChatMessageInput[] = [
    ...historyTurn2,
    { role: 'assistant', content: 'Project Titan builds transceivers.' },
    { role: 'user', content: 'Give me 3 specs for these transceivers.' }
  ];

  const geminiTurn3 = new MockStreamingAdapter('gemini', 'gemini-3.5-flash-lite', ['1. 800Gbps, 2. Low power, 3. QSFP-DD']);
  let provenanceTurn3: any = null;
  const adapter3 = new ResilientModelAdapter(geminiTurn3, null, tracker);
  const receivedText3: string[] = [];
  await adapter3.stream(
    historyTurn3,
    policy,
    c => { if (c.text) receivedText3.push(c.text); },
    { onProvenance: p => { provenanceTurn3 = p; } }
  );

  assert.equal(receivedText3.join(''), '1. 800Gbps, 2. Low power, 3. QSFP-DD');
  assert.equal(historyTurn3.length, 5, 'Full multi-turn history preserved across failovers');
});

test('Groq Failure Simulation: First-token timeout aborts Groq and executes Gemini', async () => {
  const tracker = new ProviderHealthTracker();
  const policy: ModelPolicy = { model: 'openai/gpt-oss-120b' };

  // Groq stalls for 5000ms
  const slowGroq = new MockStreamingAdapter('groq', 'openai/gpt-oss-120b', ['Slow token'], 5000);
  const fastGemini = new MockStreamingAdapter('gemini', 'gemini-3.5-flash-lite', ['Immediate ', 'Gemini ', 'answer.']);

  let prov: any = null;
  const adapter = new ResilientModelAdapter(slowGroq, fastGemini, tracker, { firstTokenTimeoutMs: 100 });
  const text: string[] = [];

  await adapter.stream(
    [{ role: 'user', content: 'Latency test' }],
    policy,
    c => { if (c.text) text.push(c.text); },
    { onProvenance: p => { prov = p; } }
  );

  assert.equal(text.join(''), 'Immediate Gemini answer.');
  assert.equal(prov.executedProvider, 'gemini');
  assert.equal(prov.fallbackOccurred, true);
  assert.ok(prov.fallbackReason?.includes('deadline') || prov.fallbackReason?.includes('timeout'));
});
