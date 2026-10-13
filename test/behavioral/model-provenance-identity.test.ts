import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, DeterministicMockAdapter, AnthropicAdapter, isModelMatch } from '../../packages/model-router/src/index.js';
import { ModelProvenanceSchema, type ModelProvenance } from '../../packages/contracts/src/index.js';
import { AgentRuntime } from '../../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../../packages/agent-runtime/src/repositories.js';
import { ToolRegistry } from '../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../packages/knowledge/src/index.js';
import { agentMemory } from '../../src/utils/agentMemoryEngine.js';
import { migrateAgentMemoryVault } from '../../src/utils/agentMemoryMigration.js';
import { db } from '../../packages/db/src/index.js';

describe('MISSION: Model Provenance, Runtime Identity & Capability Accuracy', () => {
  after(async () => {
    try {
      await db.destroy();
    } catch {
      // Ignore if already destroyed
    }
  });

  describe('RRF Memory Isolation & Zero-Match Hardening', () => {
    it('returns ZERO memories when query matches zero lexical or vector terms (e.g. "HOW CAPABLE ARE YOU")', () => {
      // "HOW CAPABLE ARE YOU" tokenizes to ['capable']. None of the default seed memories contain 'capable'.
      const recalled = agentMemory.recall({
        query: 'HOW CAPABLE ARE YOU',
        minScore: 0.18
      });
      assert.equal(
        recalled.length,
        0,
        `Expected 0 memories for zero-match query "HOW CAPABLE ARE YOU", but got ${recalled.length}: ${recalled.map(m => m.title).join(', ')}`
      );

      const assembledContext = agentMemory.assembleMemoryContext('HOW CAPABLE ARE YOU');
      assert.equal(
        assembledContext,
        '',
        'assembleMemoryContext must return empty string for zero-match query'
      );
    });

    it('sanitizes legacy Claude 3.7 seed memory in migration', () => {
      const contaminatedSeed = [
        {
          id: 'seed-sem-dec-1',
          tier: 'semantic',
          category: 'decision',
          title: 'Hybrid Reasoning Engine Standard',
          content: 'Claude 3.7 hybrid deep reasoning supports dynamic extended thinking budgets (1024 to 64000 tokens) with collapsible Newsreader serif thought blocks and live token telemetry.',
          tags: ['claude', 'thinking', 'reasoning', 'hybrid', 'tokens'],
          createdAt: Date.now() - 100000,
          updatedAt: Date.now() - 100000,
          accessCount: 7,
          isPinned: false,
        }
      ];

      const { migratedItems, report } = migrateAgentMemoryVault(contaminatedSeed);
      assert.equal(report.changesMade, true);
      const migrated = migratedItems.find(m => m.id === 'seed-sem-dec-1');
      assert.ok(migrated, 'migrated item must exist');
      assert.equal(
        migrated.content.includes('Claude 3.7'),
        false,
        'Migrated seed must NOT contain "Claude 3.7"'
      );
      assert.equal(
        migrated.tags.includes('claude'),
        false,
        'Migrated tags must NOT contain "claude"'
      );
    });
  });

  describe('ModelRouter Provenance Tracking & Resolution', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    // Scenario 1: Explicit NVIDIA Nemotron selection
    it('Scenario 1: Explicit NVIDIA Nemotron selection produces authoritative NVIDIA provenance', () => {
      process.env.NODE_ENV = 'production';
      process.env.NVIDIA_API_KEY = 'nvapi-test-key-mock';
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const router = new ModelRouter();
      const execution = router.resolveExecution('nvidia/nemotron-3-super-120b-a12b', 'ANSWER');

      assert.equal(execution.provider, 'nvidia');
      assert.equal(execution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
      assert.equal(execution.fallbackOccurred, false);
      assert.equal(execution.verified, true);
    });

    // Scenario 2: Explicit Anthropic selection when configured
    it('Scenario 2: Explicit Anthropic selection resolves Anthropic provider', () => {
      process.env.NODE_ENV = 'production';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-mock';
      delete process.env.NVIDIA_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const router = new ModelRouter();
      const execution = router.resolveExecution('claude-3-5-sonnet', 'ANSWER');

      assert.equal(execution.provider, 'anthropic');
      assert.equal(execution.executedModel, 'claude-3-5-sonnet');
      assert.equal(execution.fallbackOccurred, false);
    });

    // Scenario 3: Explicit OpenAI selection when configured
    it('Scenario 3: Explicit OpenAI selection resolves OpenAI provider', () => {
      process.env.NODE_ENV = 'production';
      process.env.OPENAI_API_KEY = 'sk-openai-test-key-mock';
      delete process.env.NVIDIA_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const router = new ModelRouter();
      const execution = router.resolveExecution('gpt-4o', 'ANSWER');

      assert.equal(execution.provider, 'openai');
      assert.equal(execution.executedModel, 'gpt-4o');
      assert.equal(execution.fallbackOccurred, false);
    });

    // Scenario 4: AIRA Auto provider selection with NVIDIA available (Vercel Preview environment)
    it('Scenario 4: AIRA Auto provider selection on Preview resolves to NVIDIA with fallback notice', () => {
      process.env.NODE_ENV = 'production';
      process.env.NVIDIA_API_KEY = 'nvapi-test-key-mock';
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const router = new ModelRouter();
      const execution = router.resolveExecution('aira-auto', 'ANSWER');

      assert.equal(execution.provider, 'nvidia');
      assert.equal(execution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
      assert.equal(execution.fallbackOccurred, true, 'Fallback should be true because default preferred provider was unavailable');
      assert.ok(execution.fallbackReason?.includes('NVIDIA'));
    });

    // Scenario 5: Provider unavailable and fallback paths
    it('Scenario 5: Fallback path records reason when requested provider is unavailable', () => {
      process.env.NODE_ENV = 'production';
      process.env.NVIDIA_API_KEY = 'nvapi-test-key-mock';
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const router = new ModelRouter();
      // aira-deep prefers Anthropic, but only NVIDIA is configured
      const execution = router.resolveExecution('aira-deep', 'RESEARCH');

      assert.equal(execution.provider, 'nvidia');
      assert.equal(execution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
      assert.equal(execution.fallbackOccurred, true);
      assert.ok(execution.fallbackReason);
    });

    // Scenario 6: Upstream model mismatch or missing provenance handling
    it('Scenario 6: Validates ModelProvenance schema invariants and unverified handling', () => {
      const prov: ModelProvenance = {
        requestedModel: 'unknown-model-xyz',
        resolvedPolicyModel: 'aira-fast',
        provider: 'unknown',
        executedModel: 'unverified-upstream',
        fallbackOccurred: true,
        fallbackReason: 'Provider unverified',
        verified: false,
        executionStatus: 'UNKNOWN',
        timestamp: Date.now()
      };

      const parsed = ModelProvenanceSchema.safeParse(prov);
      assert.equal(parsed.success, true);
      assert.equal(parsed.data?.verified, false);
    });

    // Scenario 8: Legacy persisted Claude aliases resolution
    it('Scenario 8: Legacy Claude aliases resolve with backward compatibility and truthful provenance', () => {
      const savedEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.NVIDIA_API_KEY = 'nvapi-test-key-mock';
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const router = new ModelRouter();
        const legacyAliases = [
          'claude-3-7-sonnet',
          'claude-3-5-sonnet',
          'claude-3-5-haiku',
          'claude-3-opus'
        ] as const;

        for (const alias of legacyAliases) {
          const execution = router.resolveExecution(alias, 'ANSWER');
          assert.ok(execution.adapter);
          assert.equal(execution.provider, 'nvidia');
          assert.equal(execution.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
          // Legacy alias requested is preserved in requestedModel
          assert.equal(execution.policy.model.startsWith('aira-'), true);
        }
      } finally {
        process.env = savedEnv;
      }
    });

    // Scenario 12: No secret leakage through provenance metadata
    it('Scenario 12: Provenance metadata never exposes API keys, tokens, or credentials', () => {
      const savedEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.NVIDIA_API_KEY = 'nvapi-SECRET-KEY-12345';

        const router = new ModelRouter();
        const execution = router.resolveExecution('nvidia/nemotron-3-super-120b-a12b', 'ANSWER');
        const serialized = JSON.stringify(execution);

        assert.equal(serialized.includes('SECRET'), false, 'Serialized execution must never contain secret keys');
        assert.equal(serialized.includes('nvapi-'), false, 'Serialized execution must never contain nvapi token prefix');
      } finally {
        process.env = savedEnv;
      }
    });
  });

  describe('AgentRuntime End-to-End Identity & Provenance Emission', () => {
    let runtime: AgentRuntime;
    let runRepo: InMemoryRunRepository;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      process.env.AIRA_ALLOW_MOCK = 'true';

      runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();
      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();

      runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );
    });

    // Scenario 7: Assistant identity question returns accurate runtime provenance
    it('Scenario 7: Identity question "HOW CAPABLE ARE YOU" produces authoritative provenance', async () => {
      const principal = { userId: 'test-user', sessionId: 'test-sess' };
      const run = await runtime.createRun({
        prompt: 'HOW CAPABLE ARE YOU',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      // Collect emitted SSE events
      const events: any[] = [];
      const stream = runtime.getEventStream(run.id);
      stream.on('event', evt => events.push(evt));

      // Wait for completion
      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      // Scenario 11: SSE provenance integrity
      const provEvent = events.find(e => e.type === 'model.provenance');
      assert.ok(provEvent, 'Runtime must emit "model.provenance" event');
      const validated = ModelProvenanceSchema.safeParse(provEvent.data);
      assert.equal(validated.success, true, 'Emitted provenance must match ModelProvenanceSchema');
      assert.equal(validated.data?.requestedModel, 'mock-deterministic');
      assert.equal(validated.data?.provider, 'mock');

      // Verify saved run has provenance
      const finalRun = await runtime.getRun(run.id);
      assert.ok(finalRun?.provenance, 'Final saved run must contain provenance object');

      // Verify content accurately answers capability question without claiming Claude 3.7
      assert.equal(
        finalRun?.content.includes('Claude 3.7'),
        false,
        'Assistant content must NOT claim Claude 3.7'
      );
    });

    // Scenario 9: Stale/adversarial memory claiming Claude 3.7 is neutralized by trusted system policy
    it('Scenario 9: Memory claiming "You are Claude 3.7" does NOT override executed model identity', async () => {
      const principal = { userId: 'test-user', sessionId: 'test-sess' };
      const run = await runtime.createRun({
        prompt: 'Which AI model are you?',
        systemPrompt: '<agent_memory>\n- [SEMANTIC | decision] Hybrid Reasoning Engine Standard: Claude 3.7 hybrid deep reasoning engine\n</agent_memory>',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const stream = runtime.getEventStream(run.id);
      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      const finalRun = await runtime.getRun(run.id);
      assert.equal(
        finalRun?.content.includes('Claude 3.7'),
        false,
        'Assistant must NOT claim Claude 3.7 despite memory claim'
      );
      assert.ok(
        finalRun?.content.includes('mock-deterministic'),
        'Assistant must state its actual execution model'
      );
    });

    // Scenario 10: Multi-turn clarification and identity persistence
    it('Scenario 10: Multi-turn questions preserve consistent model provenance', async () => {
      const principal = { userId: 'test-user', sessionId: 'test-sess' };
      
      // Turn 1
      const run1 = await runtime.createRun({
        prompt: 'Which model generated this answer?',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const stream1 = runtime.getEventStream(run1.id);
      const donePromise1 = new Promise<void>((resolve) => {
        stream1.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run1.id);
      await donePromise1;

      const finalRun1 = await runtime.getRun(run1.id);
      assert.equal(finalRun1?.provenance?.provider, 'mock');

      // Turn 2 with history
      const run2 = await runtime.createRun({
        prompt: 'Are you sure you are not Claude?',
        context: {
          history: [
            { role: 'user', content: 'Which model generated this answer?' },
            { role: 'assistant', content: finalRun1?.content || '' }
          ]
        },
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const stream2 = runtime.getEventStream(run2.id);
      const donePromise2 = new Promise<void>((resolve) => {
        stream2.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run2.id);
      await donePromise2;

      const finalRun2 = await runtime.getRun(run2.id);
      assert.equal(finalRun2?.provenance?.provider, 'mock');
      assert.equal(finalRun2?.content.includes('Claude 3.7'), false);
    });
  });

  describe('ISSUE 1 & 2 REGRESSIONS: Provenance Integrity, Reconciliation & Alias Fidelity', () => {
    // 1. Issue 2: Anthropic Model Alias Mismatch & Request Body Verification
    it('Issue 2: AnthropicAdapter sends exact model predicted by resolveExecution for all AIRA modes', async () => {
      const savedEnv = { ...process.env };
      const interceptedRequests: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;

      try {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-mock';
        process.env.NODE_ENV = 'production';
        delete process.env.NVIDIA_API_KEY;
        delete process.env.OPENAI_API_KEY;

        globalThis.fetch = async (url: any, init: any) => {
          const body = JSON.parse(init?.body as string || '{}');
          interceptedRequests.push({ url: String(url), body });
          return new Response(JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'Test response from mock Anthropic' }],
            usage: { input_tokens: 10, output_tokens: 15 }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };

        const router = new ModelRouter();

        const modes = [
          { mode: 'aira-pro' as const, intent: 'TOOL_ACTION' as const, expectedPredicted: 'claude-3-5-sonnet-20241022' },
          { mode: 'aira-fast' as const, intent: 'ANSWER' as const, expectedPredicted: 'claude-3-5-haiku-20241022' },
          { mode: 'aira-deep' as const, intent: 'RESEARCH' as const, expectedPredicted: 'claude-3-opus-20240229' },
          { mode: 'aira-auto' as const, intent: 'ANSWER' as const, expectedPredicted: 'claude-3-5-haiku-20241022' },
          { mode: 'aira-auto' as const, intent: 'RESEARCH' as const, expectedPredicted: 'claude-3-opus-20240229' },
          { mode: 'aira-auto' as const, intent: 'WORKFLOW' as const, expectedPredicted: 'claude-3-5-sonnet-20241022' },
        ];

        for (const { mode, intent, expectedPredicted } of modes) {
          interceptedRequests.length = 0;
          const execution = router.resolveExecution(mode, intent);
          assert.equal(
            execution.executedModel,
            expectedPredicted,
            `Predicted executedModel for ${mode} (${intent}) must be ${expectedPredicted}`
          );

          const result = await execution.adapter.complete([{ role: 'user', content: 'hello' }], execution.policy);
          assert.equal(interceptedRequests.length, 1, `Must have sent 1 request for ${mode} (${intent})`);
          assert.equal(
            interceptedRequests[0].body.model,
            expectedPredicted,
            `Actual HTTP request payload model for ${mode} (${intent}) must equal predicted model ${expectedPredicted}`
          );
          assert.equal(
            result.model,
            expectedPredicted,
            `Returned result.model must match ${expectedPredicted}`
          );
        }

        // Direct AnthropicAdapter complete with unrouted aira-pro and aira-auto policies
        const directAdapter = new AnthropicAdapter();
        interceptedRequests.length = 0;
        await directAdapter.complete([{ role: 'user', content: 'hi' }], { model: 'aira-pro', maxTokens: 1024, temperature: 0.7 });
        assert.equal(interceptedRequests[0].body.model, 'claude-3-5-sonnet-20241022', 'Direct aira-pro policy must map to claude-3-5-sonnet-20241022');

        interceptedRequests.length = 0;
        await directAdapter.complete([{ role: 'user', content: 'hi' }], { model: 'aira-auto', maxTokens: 1024, temperature: 0.7 });
        assert.equal(interceptedRequests[0].body.model, 'claude-3-7-sonnet-20250219', 'Direct aira-auto policy must map to claude-3-7-sonnet-20250219');
      } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
      }
    });

    // 2. Issue 1: Premature verification prevention — createRun sets verified: false, PENDING
    it('Issue 1: createRun sets verified: false and executionStatus: PENDING', async () => {
      const runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();
      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();
      const runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );

      const principal = { userId: 'u1', sessionId: 's1' };
      const run = await runtime.createRun({
        prompt: 'test prompt',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      assert.ok(run.provenance);
      assert.equal(run.provenance.verified, false, 'Initial provenance MUST NOT be marked verified before execution');
      assert.equal(run.provenance.executionStatus, 'PENDING', 'Initial provenance executionStatus must be PENDING');
      assert.equal(run.provenance.plannedModel, 'mock-deterministic', 'Planned model must be recorded');
    });

    // 3. Issue 1: Post-execution reconciliation & verification with execution evidence
    it('Issue 1: Reconciles actual outbound and upstream models and verifies upon successful completion', async () => {
      const runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();
      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();
      const runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );

      const principal = { userId: 'u1', sessionId: 's1' };
      const run = await runtime.createRun({
        prompt: 'Generate an analysis',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const events: any[] = [];
      const stream = runtime.getEventStream(run.id);
      stream.on('event', evt => events.push(evt));

      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      const finalRun = await runtime.getRun(run.id);
      assert.ok(finalRun?.provenance);
      assert.equal(finalRun.provenance.verified, true, 'Provenance must be verified after successful response');
      assert.equal(finalRun.provenance.executionStatus, 'SUCCESS', 'Execution status must be SUCCESS');
      assert.ok(finalRun.provenance.outboundModel, 'Must capture outbound model');
      assert.ok(finalRun.provenance.upstreamResponseModel, 'Must capture upstream response model');

      // Verify that emitted provenance event was updated
      const provEvents = events.filter(e => e.type === 'model.provenance');
      assert.ok(provEvents.length >= 2, 'Must emit initial planned and final confirmed provenance events');
      const finalProvEvent = provEvents[provEvents.length - 1];
      assert.equal(finalProvEvent.data.verified, true);
      assert.equal(finalProvEvent.data.executionStatus, 'SUCCESS');
    });

    // 4. Issue 1: Failed execution transition preserves FAILED status and verified: false
    it('Issue 1: Failed inference updates provenance to FAILED and verified: false without retaining SUCCESS', async () => {
      const runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();
      // Inject adapter that fails
      const failingAdapter = {
        provider: 'mock' as const,
        complete: async () => { throw new Error('Upstream provider connection timeout'); },
        stream: async () => { throw new Error('Upstream provider connection timeout'); },
        toJSON: () => ({ provider: 'mock' })
      };
      (modelRouter as any).adapters.set('mock', failingAdapter);

      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();
      const runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );

      const principal = { userId: 'u1', sessionId: 's1' };
      const run = await runtime.createRun({
        prompt: 'test prompt',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const events: any[] = [];
      const stream = runtime.getEventStream(run.id);
      stream.on('event', evt => events.push(evt));

      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      const finalRun = await runtime.getRun(run.id);
      assert.ok(finalRun?.provenance);
      assert.equal(finalRun.provenance.verified, false, 'Failed execution must NOT be verified');
      assert.equal(finalRun.provenance.executionStatus, 'FAILED', 'Failed execution must have status FAILED');

      const provEvents = events.filter(e => e.type === 'model.provenance');
      const lastProv = provEvents[provEvents.length - 1];
      assert.equal(lastProv.data.executionStatus, 'FAILED');
      assert.equal(lastProv.data.verified, false);
    });

    // 5. Missing upstream model identifier: Provider executes successfully but omits model ID
    it('Discrepancy 2: Response omitting model ID retains outbound model, leaves upstreamResponseModel undefined, and sets verified: false', async () => {
      const runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();

      const missingModelAdapter = {
        provider: 'mock' as const,
        complete: async () => ({
          text: 'Successful response without model ID',
          usage: { promptTokens: 12, completionTokens: 15, totalTokens: 27 },
          outboundModel: 'mock-deterministic'
          // model is deliberately omitted
        }),
        stream: async (_messages: any, _policy: any, onChunk: any) => {
          onChunk({ text: 'Successful response without model ID' });
          return {
            text: 'Successful response without model ID',
            usage: { promptTokens: 12, completionTokens: 15, totalTokens: 27 },
            outboundModel: 'mock-deterministic'
            // model is deliberately omitted
          };
        },
        toJSON: () => ({ provider: 'mock' })
      };
      (modelRouter as any).adapters.set('mock', missingModelAdapter);

      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();
      const runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );

      const principal = { userId: 'u1', sessionId: 's1' };
      const run = await runtime.createRun({
        prompt: 'test prompt for missing model id',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const events: any[] = [];
      const stream = runtime.getEventStream(run.id);
      stream.on('event', evt => events.push(evt));

      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      const finalRun = await runtime.getRun(run.id);
      assert.ok(finalRun?.provenance);
      // Successful provider execution
      assert.equal(finalRun.provenance.executionStatus, 'SUCCESS', 'Execution status must be SUCCESS when provider succeeds');
      // Retains known outbound model
      assert.equal(finalRun.provenance.outboundModel, 'mock-deterministic', 'Must retain known outbound model');
      assert.equal(finalRun.provenance.executedModel, 'mock-deterministic', 'Executed model defaults to known outbound model');
      // Upstream response model is omitted, not fabricated
      assert.equal(finalRun.provenance.upstreamResponseModel, undefined, 'Must not manufacture upstream response model when omitted');
      // Must not misrepresent as independently verified
      assert.equal(finalRun.provenance.verified, false, 'Must NOT claim verified when upstream omits model ID');

      const provEvents = events.filter(e => e.type === 'model.provenance');
      const lastProv = provEvents[provEvents.length - 1];
      assert.equal(lastProv.data.executionStatus, 'SUCCESS');
      assert.equal(lastProv.data.verified, false);
      assert.equal(lastProv.data.outboundModel, 'mock-deterministic');
      assert.equal(lastProv.data.upstreamResponseModel, undefined);
    });

    // 6. Mismatched upstream model identifier: Provider returns different model ID than outbound
    it('Discrepancy 2: Response returning mismatched model ID records both models, marks verified: false, and reflects SUCCESS execution', async () => {
      const runRepo = new InMemoryRunRepository();
      const modelRouter = new ModelRouter();

      const mismatchedModelAdapter = {
        provider: 'mock' as const,
        complete: async () => ({
          text: 'Response from mismatched upstream model',
          usage: { promptTokens: 14, completionTokens: 18, totalTokens: 32 },
          outboundModel: 'mock-deterministic',
          model: 'unexpected-provider-model-v2'
        }),
        stream: async (_messages: any, _policy: any, onChunk: any) => {
          onChunk({ text: 'Response from mismatched upstream model' });
          return {
            text: 'Response from mismatched upstream model',
            usage: { promptTokens: 14, completionTokens: 18, totalTokens: 32 },
            outboundModel: 'mock-deterministic',
            model: 'unexpected-provider-model-v2'
          };
        },
        toJSON: () => ({ provider: 'mock' })
      };
      (modelRouter as any).adapters.set('mock', mismatchedModelAdapter);

      const toolRegistry = new ToolRegistry();
      const approvalKernel = new ApprovalKernel({} as any, {} as any);
      const knowledgeEngine = new BrainV2KnowledgeEngine();
      const runtime = new AgentRuntime(
        modelRouter,
        toolRegistry,
        approvalKernel,
        knowledgeEngine,
        runRepo,
        process.cwd()
      );

      const principal = { userId: 'u1', sessionId: 's1' };
      const run = await runtime.createRun({
        prompt: 'test prompt for mismatched model id',
        modelPolicy: { model: 'mock-deterministic' }
      }, principal);

      const events: any[] = [];
      const stream = runtime.getEventStream(run.id);
      stream.on('event', evt => events.push(evt));

      const donePromise = new Promise<void>((resolve) => {
        stream.on('event', (evt) => {
          if (evt.type === 'run.completed' || evt.type === 'run.failed') resolve();
        });
      });

      await runtime.startRun(run.id);
      await donePromise;

      const finalRun = await runtime.getRun(run.id);
      assert.ok(finalRun?.provenance);
      // Successful provider execution
      assert.equal(finalRun.provenance.executionStatus, 'SUCCESS', 'Execution status must be SUCCESS');
      // Distinguishes outbound vs actual upstream response model
      assert.equal(finalRun.provenance.outboundModel, 'mock-deterministic', 'Must retain requested outbound model');
      assert.equal(finalRun.provenance.upstreamResponseModel, 'unexpected-provider-model-v2', 'Must record upstream response model accurately');
      assert.equal(finalRun.provenance.executedModel, 'unexpected-provider-model-v2', 'Executed model reflects upstream actual model');
      // Mismatch must NOT be verified against requested outbound model
      assert.equal(finalRun.provenance.verified, false, 'Mismatched model ID must NOT be verified');

      const provEvents = events.filter(e => e.type === 'model.provenance');
      const lastProv = provEvents[provEvents.length - 1];
      assert.equal(lastProv.data.executionStatus, 'SUCCESS');
      assert.equal(lastProv.data.verified, false);
      assert.equal(lastProv.data.outboundModel, 'mock-deterministic');
      assert.equal(lastProv.data.upstreamResponseModel, 'unexpected-provider-model-v2');
    });

    // 7. Unit tests for isModelMatch model identity reconciliation helper
    it('isModelMatch: correctly validates matching, normalized, missing, and mismatched identifiers', () => {
      // Exact matches
      assert.equal(isModelMatch('mock-deterministic', 'mock-deterministic'), true);
      assert.equal(isModelMatch('nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-super-120b-a12b'), true);
      
      // Namespace normalization
      assert.equal(isModelMatch('nvidia/nemotron-3-super-120b-a12b', 'nemotron-3-super-120b-a12b'), true);
      assert.equal(isModelMatch('nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-super-120b-a12b'), true);

      // Date / snapshot suffixes
      assert.equal(isModelMatch('gpt-4o', 'gpt-4o-2024-08-06'), true);
      assert.equal(isModelMatch('claude-3-5-sonnet', 'claude-3-5-sonnet-20241022'), true);

      // Mismatches
      assert.equal(isModelMatch('nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.1-8b-instruct'), false);
      assert.equal(isModelMatch('mock-deterministic', 'unexpected-model'), false);
      assert.equal(isModelMatch('gpt-4o', 'gpt-4o-mini'), false);

      // Missing / undefined
      assert.equal(isModelMatch('mock-deterministic', undefined), false);
      assert.equal(isModelMatch(undefined, 'mock-deterministic'), false);
      assert.equal(isModelMatch('', ''), false);
    });

    // 5. Additional verification: Explicit Nemotron vs Auto Fallback distinction
    it('Additional: Explicit Nemotron has fallbackOccurred: false, whereas Auto without primary provider has fallbackOccurred: true', () => {
      const savedEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.NVIDIA_API_KEY = 'nvapi-mock-test';
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const router = new ModelRouter();

        // 1. Explicit Nemotron
        const explicitNemotron = router.resolveExecution('nvidia/nemotron-3-super-120b-a12b', 'ANSWER');
        assert.equal(explicitNemotron.provider, 'nvidia');
        assert.equal(explicitNemotron.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
        assert.equal(explicitNemotron.fallbackOccurred, false, 'Explicit Nemotron must NOT be labeled as fallback');
        assert.equal(explicitNemotron.fallbackReason, undefined, 'Explicit Nemotron has no fallback reason');

        // 2. Aira Auto
        const airaAuto = router.resolveExecution('aira-auto', 'ANSWER');
        assert.equal(airaAuto.provider, 'nvidia');
        assert.equal(airaAuto.executedModel, 'nvidia/nemotron-3-super-120b-a12b');
        assert.equal(airaAuto.fallbackOccurred, true, 'Aira Auto routing to NVIDIA due to missing OpenAI/Anthropic must be labeled as fallback');
        assert.ok(airaAuto.fallbackReason, 'Aira Auto must provide documented fallback reason');
      } finally {
        process.env = savedEnv;
      }
    });
  });
});

