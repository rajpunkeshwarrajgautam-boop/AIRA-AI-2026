import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, DeterministicMockAdapter } from '../../packages/model-router/src/index.js';
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
});
