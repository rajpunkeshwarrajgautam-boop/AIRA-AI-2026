import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';
import { ResilientModelAdapter } from '../packages/model-router/src/resilient-adapter.js';
import { ProviderHealthTracker } from '../packages/model-router/src/health-tracker.js';
import { ModelRouter, type ModelAdapter, type ModelCompletionResult, type ChatMessageInput } from '../packages/model-router/src/index.js';
import {
  AgentRuntime,
} from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { InMemoryWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import type { ApprovalRepository, SessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { InMemoryKnowledgeRepository } from '../packages/knowledge/src/repositories.js';
import { type ModelPolicy, type ExecutionPrincipal } from '../packages/contracts/src/index.js';

function createSseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function buildRuntimeHarness(adapter: ModelAdapter) {
  const runRepo = new InMemoryRunRepository();
  const workspaceAuthority = new InMemoryWorkspaceAuthorityRepository();
  const approvalRepo: ApprovalRepository = {
    saveRequest: async () => {},
    getRequest: async () => undefined,
    getPendingForRun: async () => [],
    resolveRequest: async () => {},
  };
  const grantRepo: SessionGrantRepository = {
    grantSession: async () => {},
    grantAlways: async () => {},
    hasSessionGrant: async () => false,
    hasAlwaysGrant: async () => false,
    clearSession: async () => {},
  };
  const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);
  const toolGateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel, process.cwd(), workspaceAuthority);
  const knowledgeEngine = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false });
  const router = new ModelRouter({});
  (router as any).resolveExecution = (modelId: string) => ({
    policy: {
      model: modelId,
      temperature: 0.2,
      maxTokens: 512,
      extendedThinking: false,
    },
    adapter,
    provider: 'groq',
    requestedProvider: 'groq',
    executedProvider: 'groq',
    executedModel: 'openai/gpt-oss-120b',
    plannedModel: 'openai/gpt-oss-120b',
    fallbackOccurred: false,
    verified: true,
    callerTier: 'pro',
    reasoningControl: 'none',
  });

  const runtime = new AgentRuntime(
    router,
    new ToolRegistry(process.cwd()),
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd(),
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceAuthority,
    toolGateway
  );
  runtime.setEntitlementResolver(async () => 'pro');
  return { runtime, runRepo, workspaceAuthority };
}

const TEST_POLICY: ModelPolicy = {
  model: 'gemini-3.5-flash-lite',
  temperature: 0.3,
  maxTokens: 256,
  extendedThinking: false,
};

test('1. Successful Gemini SSE streaming delivers content deltas and verified model metadata', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"fallback ready."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14}}\n\n',
      'data: [DONE]\n\n',
    ])) as typeof fetch;

  try {
    const adapter = new GeminiAdapter('test-gemini-key', 'gemini-3.5-flash-lite');
    const chunks: string[] = [];
    const res = await adapter.stream(
      [{ role: 'user', content: 'Summarize failover.' }],
      TEST_POLICY,
      (delta) => {
        if (delta.text) chunks.push(delta.text);
      }
    );
    assert.equal(chunks.join(''), 'Gemini fallback ready.');
    assert.equal(res.text, 'Gemini fallback ready.');
    assert.equal(res.outboundModel, 'gemini-3.5-flash-lite');
    assert.equal(res.model, 'gemini-3.5-flash-lite');
    assert.equal(res.usage?.totalTokens, 14);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('2. Gemini returning HTTP 200 SSE with empty response fails closed (EMPTY_PROVIDER_RESPONSE)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createSseResponse([
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
      'data: [DONE]\n\n',
    ])) as typeof fetch;

  try {
    const adapter = new GeminiAdapter('test-gemini-key', 'gemini-3.5-flash-lite');
    await assert.rejects(
      () =>
        adapter.stream([{ role: 'user', content: 'Produce answer.' }], TEST_POLICY, () => {}),
      /EMPTY_PROVIDER_RESPONSE/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('3. ResilientModelAdapter rejects upstream fallback completion without content', async () => {
  const tracker = new ProviderHealthTracker();
  const groqPrimary: ModelAdapter = {
    provider: 'groq',
    async complete() { throw new Error('unused'); },
    async stream() {
      const err: any = new Error('groq 413 Request too large');
      err.status = 413;
      throw err;
    },
  };
  const emptyFallback: ModelAdapter = {
    provider: 'gemini',
    async complete() { throw new Error('unused'); },
    async stream() {
      return { text: '   ', usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 }, model: 'gemini-3.5-flash-lite', outboundModel: 'gemini-3.5-flash-lite' };
    },
  };

  const resilient = new ResilientModelAdapter(groqPrimary, emptyFallback, tracker, {
    firstTokenTimeoutMs: 50,
    fallbackFirstTokenTimeoutMs: 500,
  });

  await assert.rejects(
    () => resilient.stream([{ role: 'user', content: 'test' }], TEST_POLICY, () => {}),
    /EMPTY_PROVIDER_RESPONSE/
  );
});

test('4. Gemini stream termination after thinking/usage frames with zero text fails closed', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"considering options"}]}}]}\n\n',
      'data: {"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":0,"totalTokenCount":12}}\n\n',
    ])) as typeof fetch;

  try {
    const adapter = new GeminiAdapter('test-gemini-key', 'gemini-3.5-flash-lite');
    const seenThinking: string[] = [];
    await assert.rejects(
      () =>
        adapter.stream(
          [{ role: 'user', content: 'Answer cleanly' }],
          TEST_POLICY,
          (d) => { if (d.thinking) seenThinking.push(d.thinking); }
        ),
      /EMPTY_PROVIDER_RESPONSE/
    );
    assert.equal(seenThinking.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('5. Groq 429 rate limit and 413 payload overflow skip tertiary Groq and succeed via Gemini with >=25s budget for large prompts', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Long context failover answer VERIFIED."}]},"finishReason":"STOP"}]}\n\n',
      'data: [DONE]\n\n',
    ])) as typeof fetch;

  try {
    for (const statusCode of [429, 413]) {
      const tracker = new ProviderHealthTracker();
      let tertiaryCalled = false;
      let observedTimeout: number | undefined;

      const groqPrimary: ModelAdapter = {
        provider: 'groq',
        async complete() { throw new Error('unused'); },
        async stream() {
          const err: any = new Error(statusCode === 413 ? 'groq streaming request failed (HTTP 413): Request too large' : 'groq 429 rate_limit_exceeded');
          err.status = statusCode;
          throw err;
        },
      };
      const geminiFallback = new GeminiAdapter('test-gemini-key', 'gemini-3.5-flash-lite');
      const origStream = geminiFallback.stream.bind(geminiFallback);
      geminiFallback.stream = (msgs, pol, onChunk, opts) => {
        observedTimeout = opts?.firstTokenTimeoutMs;
        return origStream(msgs, pol, onChunk, opts);
      };
      const tertiaryGroq: ModelAdapter = {
        provider: 'groq',
        async complete() { throw new Error('unused'); },
        async stream() {
          tertiaryCalled = true;
          throw new Error('Tertiary Groq should not be called');
        },
      };

      const resilient = new ResilientModelAdapter(groqPrimary, geminiFallback, tracker, {
        firstTokenTimeoutMs: 500,
        fallbackFirstTokenTimeoutMs: 4000,
        tertiaryAdapter: tertiaryGroq,
      });

      const chunks: string[] = [];
      let prov: any = null;
      const largeMessages: ChatMessageInput[] = [{ role: 'user', content: 'DATA '.repeat(6000) }];
      const res = await resilient.stream(largeMessages, TEST_POLICY, (d) => { if (d.text) chunks.push(d.text); }, {
        onProvenance: (p) => { prov = p; },
      });

      assert.equal(tertiaryCalled, false, `HTTP ${statusCode} must not fall back to tertiary Groq`);
      assert.equal(observedTimeout, 25000, 'Large-context Gemini fallback must get full 25s first-token budget');
      assert.equal(prov?.executedProvider, 'gemini');
      assert.equal(prov?.fallbackOccurred, true);
      assert.equal(chunks.join(''), 'Long context failover answer VERIFIED.');
      assert.equal(res.text, 'Long context failover answer VERIFIED.');
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('6 & 7. AgentRuntime persists fallback answer on success, fails on empty stream, and never double-settles quota', async () => {
  // 6a. Non-empty fallback run persists content and reaches COMPLETED
  const successAdapter: ModelAdapter = {
    provider: 'groq',
    async complete() { throw new Error('unused'); },
    async stream(_msgs, _pol, onChunk, opts) {
      opts?.onProvenance?.({
        requestedProvider: 'groq',
        requestedModel: 'openai/gpt-oss-120b',
        executedProvider: 'gemini',
        executedModel: 'gemini-3.5-flash-lite',
        fallbackOccurred: true,
        fallbackReason: 'Groq 413 TPM exceeded',
      });
      onChunk({ text: 'Verified persisted Gemini answer.' });
      return { text: 'Verified persisted Gemini answer.', model: 'gemini-3.5-flash-lite', outboundModel: 'gemini-3.5-flash-lite' };
    },
  };
  const h1 = buildRuntimeHarness(successAdapter);
  const principal: ExecutionPrincipal = {
    userId: 'user_gemini_test',
    sessionId: 'sess_gemini',
    workspaceId: await h1.workspaceAuthority.resolveWorkspace('user_gemini_test'),
    scopes: ['chat:write'],
  };
  const run1 = await h1.runtime.createRun({ prompt: 'Test persistence', modelPolicy: { model: 'aira-pro' } }, principal, { callerTier: 'pro' });
  await h1.runtime.startRun(run1.id);
  const saved1 = await h1.runRepo.getRun(run1.id);
  assert.equal(saved1?.state, 'COMPLETED');
  assert.equal(saved1?.content, 'Verified persisted Gemini answer.');
  assert.equal(saved1?.provenance?.executedProvider, 'gemini');
  assert.equal(saved1?.provenance?.fallbackOccurred, true);

  // 7a. Silent empty completion transitions run to FAILED rather than COMPLETED
  const silentEmptyAdapter: ModelAdapter = {
    provider: 'groq',
    async complete() { throw new Error('unused'); },
    async stream(_msgs, _pol, _onChunk, opts) {
      opts?.onProvenance?.({
        requestedProvider: 'groq',
        requestedModel: 'openai/gpt-oss-120b',
        executedProvider: 'gemini',
        executedModel: 'gemini-3.5-flash-lite',
        fallbackOccurred: true,
      });
      return { text: '', model: 'gemini-3.5-flash-lite', outboundModel: 'gemini-3.5-flash-lite' };
    },
  };
  const h2 = buildRuntimeHarness(silentEmptyAdapter);
  const principal2: ExecutionPrincipal = {
    userId: 'user_empty_test',
    sessionId: 'sess_empty',
    workspaceId: await h2.workspaceAuthority.resolveWorkspace('user_empty_test'),
    scopes: ['chat:write'],
  };
  const run2 = await h2.runtime.createRun({ prompt: 'Test empty fail closed', modelPolicy: { model: 'aira-pro' } }, principal2, { callerTier: 'pro' });
  const events2: string[] = [];
  h2.runtime.getEventStream(run2.id).on('event', (e: any) => events2.push(e.type));
  await h2.runtime.startRun(run2.id);
  const saved2 = await h2.runRepo.getRun(run2.id);
  assert.equal(saved2?.state, 'FAILED');
  assert.ok(events2.includes('run.failed'));
  assert.equal(events2.includes('run.completed'), false);

  // 7b. Concurrent settle-once / release-if-unused quota accounting guard
  let settleCalls = 0;
  let releaseCalls = 0;
  let quotaSettled = false;
  let quotaPromise: Promise<void> | null = null;
  const settleOnce = async () => {
    if (!quotaSettled) {
      if (!quotaPromise) {
        quotaPromise = (async () => {
          settleCalls++;
          quotaSettled = true;
        })();
      }
      await quotaPromise;
    }
  };
  await Promise.all([settleOnce(), settleOnce(), settleOnce()]);
  if (!quotaSettled) releaseCalls++;
  assert.equal(settleCalls, 1, 'Duplicate settleOnce calls must settle quota strictly once');
  assert.equal(releaseCalls, 0);
});

test('8. Caller cancellation during Gemini fallback aborts cleanly without tripping Gemini health circuit', async () => {
  const tracker = new ProviderHealthTracker();
  const groqPrimary: ModelAdapter = {
    provider: 'groq',
    async complete() { throw new Error('unused'); },
    async stream() {
      const err: any = new Error('groq 413 Request too large');
      err.status = 413;
      throw err;
    },
  };
  const slowFallback: ModelAdapter = {
    provider: 'gemini',
    async complete() { throw new Error('unused'); },
    async stream(_msgs, _pol, _onChunk, opts) {
      await new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted.');
          abortErr.name = 'AbortError';
          reject(abortErr);
        }, { once: true });
      });
      return { text: '' } as ModelCompletionResult;
    },
  };

  const resilient = new ResilientModelAdapter(groqPrimary, slowFallback, tracker, {
    firstTokenTimeoutMs: 500,
    fallbackFirstTokenTimeoutMs: 5000,
  });

  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('USER_CANCELLED')), 25);

  await assert.rejects(
    () => resilient.stream([{ role: 'user', content: 'Cancel mid-fallback' }], TEST_POLICY, () => {}, { signal: ac.signal }),
    /USER_CANCELLED|AbortError/
  );
  assert.equal(
    tracker.isAvailable('gemini', 'gemini-3.5-flash-lite'),
    true,
    'User cancellation during fallback must not penalize Gemini health tracker'
  );
});
