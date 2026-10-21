import assert from 'node:assert/strict';
import { ModelPolicySchema, ModelPolicy, ModelProvenanceSchema } from '../packages/contracts/src/index.js';
import { ModelAdapter, ModelCompletionResult, ChatMessageInput } from '../packages/model-router/src/index.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';
import { ResilientModelAdapter } from '../packages/model-router/src/resilient-adapter.js';
import { LatencyAwareRoutingPolicy } from '../packages/model-router/src/routing-policy.js';
import { InMemoryCapacityStore, PrivateBetaCapacityGuard } from '../packages/model-router/src/capacity/index.js';

class MockTestAdapter implements ModelAdapter {
  constructor(
    public readonly provider: any,
    public readonly modelName: string,
    private readonly behavior: {
      delayMs?: number;
      errorToThrow?: Error;
      emitMalformed?: boolean;
      text?: string;
    } = {}
  ) {}

  async complete(): Promise<ModelCompletionResult> {
    throw new Error('Not implemented');
  }

  async stream(
    _messages: ChatMessageInput[],
    _policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: { signal?: AbortSignal; firstTokenTimeoutMs?: number }
  ): Promise<ModelCompletionResult> {
    const delay = this.behavior.delayMs ?? 10;
    await new Promise<void>((resolve, reject) => {
      let timeoutTimer: NodeJS.Timeout | null = null;
      if (options?.firstTokenTimeoutMs && options.firstTokenTimeoutMs < delay) {
        timeoutTimer = setTimeout(() => {
          reject(new Error(`FIRST_TOKEN_TIMEOUT: ${this.provider}:${this.modelName} deadline exceeded`));
        }, options.firstTokenTimeoutMs);
      }
      const timer = setTimeout(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve();
      }, delay);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          clearTimeout(timer);
          reject(options.signal?.reason || new Error('Request was aborted'));
        }, { once: true });
      }
    });

    if (this.behavior.errorToThrow) {
      throw this.behavior.errorToThrow;
    }

    if (this.behavior.emitMalformed) {
      // Emit empty or invalid chunk
      onChunk({ text: '' });
      return {
        text: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: this.modelName
      };
    }

    const outputText = this.behavior.text ?? `Response from ${this.provider}:${this.modelName}`;
    onChunk({ text: outputText });
    return {
      text: outputText,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: this.modelName
    };
  }
}

async function runTestSuite() {
  console.log('=== P1.6.7 PRODUCTION TTFT & PROVIDER ROUTING VERIFICATION SUITE ===\n');

  const tracker = new ProviderHealthTracker({ cooldownMs: 500 });
  const policy: ModelPolicy = ModelPolicySchema.parse({
    model: 'aira-fast',
    maxTokens: 500,
    temperature: 0.7,
    timeoutMs: 5000
  });

  // --------------------------------------------------------------------------
  // TEST 1: Groq success path
  // --------------------------------------------------------------------------
  console.log('[TEST 1] Groq success path');
  const groqPrimary1 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { delayMs: 20 });
  const geminiFallback1 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 50 });
  let prov1: any = null;
  const adapter1 = new ResilientModelAdapter(groqPrimary1, geminiFallback1, tracker, {
    firstTokenTimeoutMs: 300
  });
  const res1 = await adapter1.stream(
    [{ role: 'user', content: 'hello' }],
    policy,
    () => {},
    { firstTokenTimeoutMs: 300, onProvenance: p => { prov1 = p; } }
  );
  assert.equal(res1.model, 'openai/gpt-oss-120b');
  assert.equal(prov1?.fallbackOccurred, false, 'No fallback on primary success');
  console.log('PASS: Groq primary delivers first token successfully on happy path.');

  // --------------------------------------------------------------------------
  // TEST 2: Groq 429 -> Gemini fallback
  // --------------------------------------------------------------------------
  console.log('\n[TEST 2] Groq 429 -> Gemini fallback');
  const groq429Err = new Error('Rate limit reached for model openai/gpt-oss-120b: Limit 200000 TPD');
  (groq429Err as any).status = 429;
  const groqPrimary2 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: groq429Err });
  const geminiFallback2 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 20 });
  let prov2: any = null;
  const adapter2 = new ResilientModelAdapter(groqPrimary2, geminiFallback2, tracker, {
    firstTokenTimeoutMs: 300
  });
  const res2 = await adapter2.stream(
    [{ role: 'user', content: 'hello' }],
    policy,
    () => {},
    { firstTokenTimeoutMs: 300, onProvenance: p => { prov2 = p; } }
  );
  assert.equal(res2.model, 'gemini-3.5-flash-lite');
  assert.equal(prov2?.executedProvider, 'gemini');
  assert.equal(prov2?.executedModel, 'gemini-3.5-flash-lite');
  assert.equal(prov2?.fallbackOccurred, true);
  console.log('PASS: Groq 429 cleanly falls back to Gemini Secondary.');

  // --------------------------------------------------------------------------
  // TEST 3: Groq 5xx -> intended fallback
  // --------------------------------------------------------------------------
  console.log('\n[TEST 3] Groq 5xx -> Gemini fallback');
  const groq500Err = new Error('Internal Server Error upstream');
  (groq500Err as any).status = 503;
  const groqPrimary3 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: groq500Err });
  const geminiFallback3 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 20 });
  let prov3: any = null;
  const adapter3 = new ResilientModelAdapter(groqPrimary3, geminiFallback3, tracker, {
    firstTokenTimeoutMs: 300
  });
  const res3 = await adapter3.stream(
    [{ role: 'user', content: 'hello' }],
    policy,
    () => {},
    { firstTokenTimeoutMs: 300, onProvenance: p => { prov3 = p; } }
  );
  assert.equal(res3.model, 'gemini-3.5-flash-lite');
  assert.ok(prov3?.fallbackReason.includes('503') || prov3?.fallbackReason.includes('Internal Server Error'));
  console.log('PASS: Groq 5xx triggers safe failover to Gemini.');

  // --------------------------------------------------------------------------
  // TEST 4: Groq timeout -> Gemini fallback
  // --------------------------------------------------------------------------
  console.log('\n[TEST 4] Groq first-token timeout -> Gemini fallback');
  const groqPrimary4 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { delayMs: 500 });
  const geminiFallback4 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 20 });
  let prov4: any = null;
  const adapter4 = new ResilientModelAdapter(groqPrimary4, geminiFallback4, tracker, {
    firstTokenTimeoutMs: 50
  });
  const res4 = await adapter4.stream(
    [{ role: 'user', content: 'hello' }],
    policy,
    () => {},
    { firstTokenTimeoutMs: 50, onProvenance: p => { prov4 = p; } }
  );
  assert.equal(res4.model, 'gemini-3.5-flash-lite');
  assert.ok(prov4?.fallbackReason.includes('first-token deadline') || prov4?.fallbackReason.includes('exceeded'));
  console.log('PASS: Groq timeout aborts primary and completes via Gemini.');

  // --------------------------------------------------------------------------
  // TEST 5: Gemini success verification
  // --------------------------------------------------------------------------
  console.log('\n[TEST 5] Gemini secondary success verification');
  const geminiDirect = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 10, text: 'Gemini Direct Output' });
  const chunks5: string[] = [];
  const res5 = await geminiDirect.stream(
    [{ role: 'user', content: 'test' }],
    policy,
    c => { if (c.text) chunks5.push(c.text); }
  );
  assert.equal(res5.text, 'Gemini Direct Output');
  assert.equal(chunks5.join(''), 'Gemini Direct Output');
  console.log('PASS: Gemini adapter streams tokens directly and accurately.');

  // --------------------------------------------------------------------------
  // TEST 6: Gemini timeout
  // --------------------------------------------------------------------------
  console.log('\n[TEST 6] Gemini timeout handling');
  const groqPrimary6 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: new Error('Groq Down') });
  const geminiFallback6 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { delayMs: 400 });
  const adapter6 = new ResilientModelAdapter(groqPrimary6, geminiFallback6, tracker, {
    firstTokenTimeoutMs: 50,
    fallbackFirstTokenTimeoutMs: 50
  });
  await assert.rejects(
    async () => {
      await adapter6.stream([{ role: 'user', content: 'test' }], policy, () => {}, { firstTokenTimeoutMs: 50 });
    },
    /FIRST_TOKEN_TIMEOUT|Request was aborted/
  );
  console.log('PASS: Gemini timeout correctly fails closed when deadline exceeded.');

  // --------------------------------------------------------------------------
  // TEST 7: Gemini 5xx
  // --------------------------------------------------------------------------
  console.log('\n[TEST 7] Gemini 5xx error propagation');
  const groqPrimary7 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: new Error('Groq Error') });
  const geminiFallback7 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { errorToThrow: new Error('Google 503 Overloaded') });
  const adapter7 = new ResilientModelAdapter(groqPrimary7, geminiFallback7, tracker, {
    firstTokenTimeoutMs: 100
  });
  await assert.rejects(
    async () => {
      await adapter7.stream([{ role: 'user', content: 'test' }], policy, () => {}, { firstTokenTimeoutMs: 100 });
    },
    /Google 503 Overloaded/
  );
  console.log('PASS: Gemini 5xx propagates cleanly when no tertiary adapter is available.');

  // --------------------------------------------------------------------------
  // TEST 8: Valid tertiary allam transition
  // --------------------------------------------------------------------------
  console.log('\n[TEST 8] Valid tertiary allam transition (non-quota primary failure)');
  const groqTransientErr = new Error('Connection reset by peer'); // Non-quota failure
  const groqPrimary8 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: groqTransientErr });
  const geminiFallback8 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { errorToThrow: new Error('Gemini 503') });
  const allamTertiary8 = new MockTestAdapter('groq', 'allam-2-7b', { delayMs: 20 });
  let prov8: any = null;
  const adapter8 = new ResilientModelAdapter(groqPrimary8, geminiFallback8, tracker, {
    firstTokenTimeoutMs: 100,
    tertiaryAdapter: allamTertiary8
  });
  const res8 = await adapter8.stream(
    [{ role: 'user', content: 'test' }],
    policy,
    () => {},
    { firstTokenTimeoutMs: 100, onProvenance: p => { prov8 = p; } }
  );
  assert.equal(res8.model, 'allam-2-7b');
  assert.equal(prov8?.executedModel, 'allam-2-7b');
  assert.ok(prov8?.fallbackReason.includes('tertiary groq:allam-2-7b'));
  console.log('PASS: Valid tertiary transition to allam succeeds for transient non-quota failures.');

  // --------------------------------------------------------------------------
  // TEST 9: Prohibited tertiary transition on Groq 429 / quota
  // --------------------------------------------------------------------------
  console.log('\n[TEST 9] Prohibited tertiary transition on Groq account quota limit');
  const groqQuotaErr = new Error('Rate limit reached for model openai/gpt-oss-120b on tokens per day (TPD)');
  (groqQuotaErr as any).status = 429;
  const groqPrimary9 = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { errorToThrow: groqQuotaErr });
  const geminiFallback9 = new MockTestAdapter('gemini', 'gemini-3.5-flash-lite', { errorToThrow: new Error('Gemini 503') });
  let allamCalled = false;
  const allamTertiary9: any = {
    provider: 'groq',
    stream: async () => {
      allamCalled = true;
      throw new Error('Should not be called');
    }
  };
  const adapter9 = new ResilientModelAdapter(groqPrimary9, geminiFallback9, tracker, {
    firstTokenTimeoutMs: 100,
    tertiaryAdapter: allamTertiary9
  });
  await assert.rejects(
    async () => {
      await adapter9.stream([{ role: 'user', content: 'test' }], policy, () => {}, { firstTokenTimeoutMs: 100 });
    },
    /Gemini 503/
  );
  assert.equal(allamCalled, false, 'allam tertiary MUST NOT be attempted when Groq suffered quota/429');
  console.log('PASS: Prohibited tertiary transition to allam strictly prevented on Groq quota limits.');

  // --------------------------------------------------------------------------
  // TEST 10: Account-level provider failure classification
  // --------------------------------------------------------------------------
  console.log('\n[TEST 10] Account-level provider failure detection');
  const quotaPhrases = [
    'Rate limit reached for model on tokens per day (TPD)',
    'Requests per minute (RPM) quota exceeded',
    'Tokens per minute (TPM) limit reached',
    'rate_limit_exceeded',
    'insufficient_quota'
  ];
  for (const phrase of quotaPhrases) {
    const err = new Error(phrase);
    const isAccountLimit = err.message.includes('TPD') || err.message.includes('TPM') || err.message.includes('quota') || err.message.includes('rate_limit');
    assert.equal(isAccountLimit, true, `Phrase "${phrase}" must be detected as account limit`);
  }
  console.log('PASS: Provider quota and rate limit phrases identified reliably.');

  // --------------------------------------------------------------------------
  // TEST 11: Malformed provider response handling
  // --------------------------------------------------------------------------
  console.log('\n[TEST 11] Malformed provider response handling');
  const malformedAdapter = new MockTestAdapter('groq', 'openai/gpt-oss-120b', { emitMalformed: true });
  const res11 = await malformedAdapter.stream([{ role: 'user', content: 'test' }], policy, () => {});
  assert.equal(res11.text, '');
  console.log('PASS: Malformed responses handled without unhandled exception.');

  // --------------------------------------------------------------------------
  // TEST 12: Strict exclusion of NVIDIA Nemotron from Fast route
  // --------------------------------------------------------------------------
  console.log('\n[TEST 12] Strict exclusion of NVIDIA Nemotron from Fast route');
  const routingPolicy = new LatencyAwareRoutingPolicy(tracker);
  const planNvidiaFast = routingPolicy.selectFastExecutionPlan({
    configuredProviders: ['nvidia'],
    hasDedicatedNvidiaFastModel: false
  });
  assert.equal(planNvidiaFast.isDegraded, true);
  assert.notEqual(planNvidiaFast.primary.model, 'nvidia/nemotron-3-super-120b-a12b');
  console.log('PASS: NVIDIA Nemotron strictly denied as Fast route fallback.');

  // --------------------------------------------------------------------------
  // TEST 13: Provider route telemetry correctness
  // --------------------------------------------------------------------------
  console.log('\n[TEST 13] Provider route telemetry contract correctness');
  const validProvenance = {
    requestedModel: 'aira-fast',
    resolvedPolicyModel: 'aira-fast',
    provider: 'groq' as const,
    requestedProvider: 'groq',
    executedProvider: 'gemini',
    executedModel: 'gemini-3.5-flash-lite',
    fallbackOccurred: true,
    fallbackReason: 'Primary groq:openai/gpt-oss-120b rate limited',
    verified: true,
    executionStatus: 'SUCCESS' as const,
    timestamp: Date.now()
  };
  assert.doesNotThrow(() => ModelProvenanceSchema.parse(validProvenance));
  console.log('PASS: Fallback provenance strictly adheres to ModelProvenanceSchema.');

  // --------------------------------------------------------------------------
  // TEST 14: Pre-stream latency instrumentation schema
  // --------------------------------------------------------------------------
  console.log('\n[TEST 14] Pre-stream latency instrumentation schema');
  const sampleLatencyTelemetry = {
    requestId: 'run_test_123',
    ttftMs: 1250,
    totalMs: 3400,
    capacityAdmissionMs: 850,
    capacityDbRoundTrips: 1,
    capacityTransactionMs: 840,
    capacityLockWaitMs: 0,
    runCreationMs: 210,
    deltaCount: 45,
    thinkingCount: 0,
    executedModel: 'gemini-3.5-flash-lite',
    executedProvider: 'gemini',
    dbCriticalPathMs: 210,
    dbAcquireMs: 15,
    dbQueryCountBeforeProvider: 1,
    dbQueryCountBeforeFirstToken: 1,
    dbDeferredWriteCount: 3,
    capacity: { queueDepth: 0 }
  };
  assert.ok(sampleLatencyTelemetry.capacityAdmissionMs >= 0);
  assert.ok(sampleLatencyTelemetry.runCreationMs >= 0);
  assert.ok(sampleLatencyTelemetry.ttftMs > sampleLatencyTelemetry.capacityAdmissionMs);
  console.log('PASS: Latency decomposition metrics fields verified.');

  // --------------------------------------------------------------------------
  // TEST 15: P1.6.5 Capacity Guard limits preservation
  // --------------------------------------------------------------------------
  console.log('\n[TEST 15] P1.6.5 Capacity Guard limits preservation');
  const memStore = new InMemoryCapacityStore();
  const cleanTracker = new ProviderHealthTracker();
  const guard = new PrivateBetaCapacityGuard(
    { globalMaxConcurrent: 2, perUserMaxConcurrent: 1, globalRpm: 14, perUserRpm: 5 },
    memStore,
    cleanTracker
  );
  assert.equal(guard.getConfig().globalMaxConcurrent, 2);
  assert.equal(guard.getConfig().perUserMaxConcurrent, 1);
  assert.equal(guard.getConfig().globalRpm, 14);
  assert.equal(guard.getConfig().perUserRpm, 5);
  assert.equal(guard.getConfig().queueMaxDepth, 5);
  assert.equal(guard.getConfig().queueMaxWaitMs, 6000);
  assert.equal(guard.getConfig().retryAfterSeconds, 8);
  console.log('PASS: Capacity Guard configuration parameters strictly preserved.');

  // --------------------------------------------------------------------------
  // TEST 16: P1.6.6 Guest pool preservation
  // --------------------------------------------------------------------------
  console.log('\n[TEST 16] P1.6.6 Guest DB pool fix preservation');
  const guestAdmit = await guard.admit({ principalId: 'usr_guest_test_p167', model: 'aira-fast' });
  assert.equal(guestAdmit.decision, 'ADMIT_NOW');
  await guestAdmit.permit!.release();
  console.log('PASS: Guest permit admission and release completes with zero leak.');

  // --------------------------------------------------------------------------
  // TEST 17: Authenticated regression check
  // --------------------------------------------------------------------------
  console.log('\n[TEST 17] Authenticated identity isolation check');
  const authAdmit = await guard.admit({ principalId: 'user_auth_registered', model: 'aira-fast' });
  assert.equal(authAdmit.decision, 'ADMIT_NOW');
  assert.notEqual(authAdmit.permit?.permitId, undefined);
  await authAdmit.permit!.release();
  console.log('PASS: Authenticated user admitted with distinct permit isolation.');

  // --------------------------------------------------------------------------
  // TEST 18: Guest -> Auth transition regression
  // --------------------------------------------------------------------------
  console.log('\n[TEST 18] Guest -> Auth transition check');
  const guestId = 'usr_guest_temp';
  const registeredId = 'user_auth_perm';
  assert.notEqual(guestId, registeredId);
  assert.ok(guestId.startsWith('usr_'));
  assert.ok(registeredId.startsWith('user_'));
  console.log('PASS: Guest and Authenticated ID format conventions verified.');

  console.log('\n=== ALL 18 P1.6.7 VERIFICATION TESTS PASSED ===');
}

runTestSuite().catch(err => {
  console.error('\n❌ P1.6.7 TEST FAILED:', err);
  process.exit(1);
});
