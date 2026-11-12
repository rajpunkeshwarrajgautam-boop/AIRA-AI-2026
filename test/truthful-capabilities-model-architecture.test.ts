import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { AVAILABLE_MODELS, DEFAULT_SETTINGS } from '../src/utils/constants.js';
import {
  VERIFIED_MODEL_REGISTRY,
  VERIFIED_PLAN_MODEL_ALLOWLIST,
  COMMERCIAL_PLANS,
  isModelAllowedForTier
} from '../packages/contracts/src/commercial.js';
import { normalizeModelIdentifier, type ExecutionPrincipal } from '../packages/contracts/src/index.js';
import {
  STORAGE_KEYS,
  DEVICE_PREFERENCE_KEYS,
  ACCOUNT_SETTING_KEYS,
  getAccountSettingsStorageKey,
  normalizeStoredModelId,
  loadSettings,
  saveSettings,
  clearAccountSettings,
  exportAllStorageData,
  resetSettingsCacheForTesting
} from '../src/utils/storage.js';
import { composeSystemPrompt, PERSONALIZATION_BOUNDS } from '../src/utils/aiEngine.js';
import { FEATURE_GUIDANCE_CATALOG } from '../src/utils/featureDiscovery.js';
import {
  syncOnboardingActionToServer,
  fetchOnboardingFromServer,
  getOnboardingState
} from '../src/utils/onboarding.js';
import { neonAuth } from '../src/lib/neonAuth.js';
import {
  ModelRouter,
  OpenAIAdapter,
  GeminiAdapter,
  PlanRestrictionError,
  withInferencePrincipal
} from '../packages/model-router/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { InMemoryWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import type { ApprovalRepository, SessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { InMemoryKnowledgeRepository } from '../packages/knowledge/src/repositories.js';
import { createAccountRoutes, resetOnboardingStoreForTesting } from '../apps/api/src/account-routes.js';

class MockLocalStorage {
  public store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  get length(): number { return this.store.size; }
}

test('Truthful Capabilities & Model Architecture Suite', async (t) => {
  await t.test('1. Model Registry Truthfulness & Active Models in Contracts', () => {
    const registryKeys = Object.keys(VERIFIED_MODEL_REGISTRY);
    assert.ok(registryKeys.includes('aira-auto'));
    assert.ok(registryKeys.includes('aira-fast'));
    assert.ok(registryKeys.includes('aira-pro'));
    assert.ok(registryKeys.includes('aira-deep'));
    assert.ok(registryKeys.includes('nvidia/llama-3.1-nemotron-70b-instruct'));

    assert.equal(VERIFIED_MODEL_REGISTRY['aira-auto'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-auto'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-fast'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-fast'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-pro'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-pro'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-deep'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-deep'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-deep'].reasoningControl, 'effort_mapped');

    for (const [id, def] of Object.entries(VERIFIED_MODEL_REGISTRY)) {
      assert.notEqual(def.provider, 'anthropic', `Model ${id} must not use unconfigured provider anthropic`);
      assert.equal(def.contextWindow, '128K tokens', `Context window for ${id} must be truthful 128K tokens`);
    }

    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.guest.includes('aira-fast'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.free.includes('aira-auto'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.plus.includes('aira-pro'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.pro.includes('aira-deep'));
  });

  await t.test('2. AVAILABLE_MODELS Interface Catalog & Neutral Defaults', () => {
    assert.equal(DEFAULT_SETTINGS.activeModel, 'aira-auto');
    assert.equal(DEFAULT_SETTINGS.userBio, '', 'Default userBio must be empty so unconfigured users receive no synthetic persona');
    assert.equal(DEFAULT_SETTINGS.email, '', 'Default email must be empty instead of placeholder user@aira.internal');

    for (const model of AVAILABLE_MODELS) {
      const forbiddenTerms = [/claude/i, /sonnet/i, /haiku/i, /gpt-4o/i, /deepseek/i];
      for (const term of forbiddenTerms) {
        assert.doesNotMatch(model.name, term);
        assert.doesNotMatch(model.description, term);
      }
      assert.equal(model.contextWindow, '128K tokens');
    }
  });

  await t.test('3. Contracts normalizeModelIdentifier & Storage Migration Behavior', () => {
    assert.equal(normalizeModelIdentifier('claude-3-7-sonnet'), 'aira-auto');
    assert.equal(normalizeModelIdentifier('claude-3-5-sonnet'), 'aira-pro');
    assert.equal(normalizeModelIdentifier('claude-3-5-haiku'), 'aira-fast');
    assert.equal(normalizeModelIdentifier('claude-3-opus'), 'aira-deep');
    assert.equal(normalizeModelIdentifier('meta/llama-3.1-405b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.equal(normalizeModelIdentifier('nvidia/nemotron-3-super-120b-a12b'), 'nvidia/llama-3.1-nemotron-70b-instruct');

    assert.equal(normalizeStoredModelId('claude-3-7-sonnet'), 'aira-auto');
    assert.equal(normalizeStoredModelId('claude-3-5-sonnet'), 'aira-pro');
    assert.equal(normalizeStoredModelId('claude-3-5-haiku'), 'aira-fast');
    assert.equal(normalizeStoredModelId('claude-3-opus'), 'aira-deep');
    assert.equal(normalizeStoredModelId('meta-llama/llama-3.1-405b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.equal(normalizeStoredModelId('unknown-model-xyz'), 'aira-auto');
    assert.equal(normalizeStoredModelId(null), 'aira-auto');
  });

  await t.test('4. Prompt Composition: Bounded Personalization, Non-Duplication & Precedence', () => {
    const longBio = 'B'.repeat(2000);
    const longInstructions = 'CUSTOM_RULE_ALPHA '.repeat(400);
    const promptDeduplicated = composeSystemPrompt(
      {
        ...DEFAULT_SETTINGS,
        responseStyle: 'concise',
        userBio: longBio,
        customInstructions: longInstructions,
      },
      longInstructions // identical runtime directive must be deduplicated cleanly
    );
    const promptSingle = composeSystemPrompt({
      ...DEFAULT_SETTINGS,
      responseStyle: 'concise',
      userBio: longBio,
      customInstructions: longInstructions,
    });

    assert.equal(promptDeduplicated, promptSingle, 'Passing identical runtime directive must not duplicate instructions');
    assert.ok(promptDeduplicated.includes('Response Style Directive: Provide concise, direct answers without unnecessary preamble or filler.'));

    const bioMatch = promptDeduplicated.match(/User Profile Context: ([^\n]+)/);
    assert.ok(bioMatch, 'User bio section present');
    assert.ok(bioMatch[1].length <= PERSONALIZATION_BOUNDS.MAX_BIO_CHARS + 20, 'User bio must be strictly bounded');

    const instMatch = promptDeduplicated.match(/User Custom Instructions: ([^\n]+)/);
    assert.ok(instMatch, 'Custom instructions section present');
    assert.ok(instMatch[1].length <= PERSONALIZATION_BOUNDS.MAX_CUSTOM_INSTRUCTIONS_CHARS + 20, 'Custom instructions must be strictly bounded');

    const stylePos = promptDeduplicated.indexOf('Response Style Directive:');
    const bioPos = promptDeduplicated.indexOf('User Profile Context:');
    const customPos = promptDeduplicated.indexOf('User Custom Instructions:');
    assert.ok(stylePos < bioPos && bioPos < customPos, 'Strict ordering: Style -> Bio -> Custom Instructions');
  });

  await t.test('5. Feature Guidance Catalog Truthfulness Verification', () => {
    for (const card of FEATURE_GUIDANCE_CATALOG) {
      const forbiddenTerms = [/claude/i, /sonnet/i, /haiku/i, /gpt-4o/i, /deepseek/i, /64[,.]?000/i];
      for (const term of forbiddenTerms) {
        assert.doesNotMatch(card.title, term);
        assert.doesNotMatch(card.description, term);
        if (card.subtitle) assert.doesNotMatch(card.subtitle, term);
        if (card.samplePrompt) assert.doesNotMatch(card.samplePrompt, term);
      }
    }
  });

  await t.test('6. Account Isolation: Device vs Account Keys, A -> B -> A, and Provenance Migration', () => {
    const oldLocalStorage = (globalThis as any).localStorage;
    const mockStorage = new MockLocalStorage();
    (globalThis as any).localStorage = mockStorage;
    resetSettingsCacheForTesting();

    try {
      // Seed legacy mixed global aira_settings_v1 belonging to Alice
      mockStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify({
        theme: 'dark',
        aestheticPreset: 'nordic-moss',
        userName: 'Alice',
        email: 'alice@example.com',
        userBio: 'Alice confidential engineering bio',
        customInstructions: 'Alice private instruction',
        activeModel: 'aira-pro',
        extendedThinking: true,
        thinkingBudget: 4096,
        anthropicApiKey: 'sk-ant-secret-alice',
      }));

      // Account B signs in FIRST before Alice ever visits:
      // 1) Global aira_settings_v1 must be scrubbed of Alice's account fields (retaining theme/preset only)
      // 2) Bob must receive clean neutral defaults without ANY of Alice's personalization or API keys
      const bobLoaded = loadSettings({ userId: 'usr_bob', email: 'bob@example.com' });
      assert.equal(bobLoaded.theme, 'dark', 'Device theme preference shared safely');
      assert.equal(bobLoaded.aestheticPreset, 'nordic-moss', 'Device aesthetic preset preserved');
      assert.equal(bobLoaded.userBio, '', 'Alice bio must NOT leak to Bob');
      assert.equal(bobLoaded.customInstructions, '', 'Alice custom instructions must NOT leak to Bob');
      assert.equal(bobLoaded.userName, '', 'Alice name must NOT leak to Bob');
      assert.equal(bobLoaded.email, '', 'Alice email must NOT leak to Bob');
      assert.equal(bobLoaded.anthropicApiKey, '', 'Alice API key must NOT leak to Bob');

      const scrubbedGlobal = JSON.parse(mockStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
      for (const acctKey of ACCOUNT_SETTING_KEYS) {
        assert.equal(Object.hasOwn(scrubbedGlobal, acctKey), false, `Global key must never contain account field ${acctKey}`);
      }
      for (const devKey of DEVICE_PREFERENCE_KEYS) {
        assert.ok(Object.hasOwn(scrubbedGlobal, devKey) || devKey === 'theme', `Device key ${devKey} allowed on device store`);
      }

      // Guest ALSO cannot claim Alice's quarantined archive
      const guestLoaded = loadSettings();
      assert.equal(guestLoaded.userBio, '', 'Guest must NOT inherit Alice archived bio');
      assert.equal(guestLoaded.anthropicApiKey, '', 'Guest must NOT inherit Alice API key');

      // Alice now signs in -> email provenance matches alice@example.com -> Alice reclaims legacy settings!
      const aliceMigrated = loadSettings({ userId: 'usr_alice', email: 'alice@example.com' });
      assert.equal(aliceMigrated.userBio, 'Alice confidential engineering bio');
      assert.equal(aliceMigrated.customInstructions, 'Alice private instruction');
      assert.equal(aliceMigrated.activeModel, 'aira-pro');
      assert.equal(aliceMigrated.anthropicApiKey, 'sk-ant-secret-alice');
      assert.equal(mockStorage.getItem(STORAGE_KEYS.LEGACY_SETTINGS_ARCHIVE), null, 'Archive cleaned up after verified owner claim');

      // Bob customizes Bob's own settings
      saveSettings({
        ...bobLoaded,
        userName: 'Bob',
        email: 'bob@example.com',
        userBio: 'Bob bio only',
        customInstructions: 'Bob rule only',
        activeModel: 'aira-fast',
      }, { userId: 'usr_bob', email: 'bob@example.com' });

      // Account A -> B -> A reload verification
      const aliceReloaded = loadSettings({ userId: 'usr_alice', email: 'alice@example.com' });
      const bobReloaded = loadSettings({ userId: 'usr_bob', email: 'bob@example.com' });
      assert.equal(aliceReloaded.userBio, 'Alice confidential engineering bio');
      assert.equal(aliceReloaded.customInstructions, 'Alice private instruction');
      assert.equal(bobReloaded.userBio, 'Bob bio only');
      assert.equal(bobReloaded.customInstructions, 'Bob rule only');

      // Scoped storage keys & export isolation
      assert.equal(getAccountSettingsStorageKey('usr_alice'), 'aira_account_settings_user_usr_alice');
      assert.equal(getAccountSettingsStorageKey('usr_bob'), 'aira_account_settings_user_usr_bob');
      const bobExport = exportAllStorageData({ userId: 'usr_bob', email: 'bob@example.com' });
      assert.doesNotMatch(bobExport, /Alice confidential/);
      assert.doesNotMatch(bobExport, /sk-ant-secret-alice/);

      // Clear Bob only -> Alice remains intact
      clearAccountSettings('usr_bob');
      assert.equal(loadSettings({ userId: 'usr_bob', email: 'bob@example.com' }).userBio, '');
      assert.equal(loadSettings({ userId: 'usr_alice', email: 'alice@example.com' }).userBio, 'Alice confidential engineering bio');

      // Unowned anonymous legacy fixture may ONLY be claimed by guest, NEVER by authenticated user
      mockStorage.clear();
      resetSettingsCacheForTesting();
      mockStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify({
        theme: 'light',
        userName: 'Anon Guest',
        userBio: 'Guest-only unowned note',
      }));
      assert.equal(loadSettings({ userId: 'usr_bob', email: 'bob@example.com' }).userBio, '');
      assert.equal(loadSettings().userBio, 'Guest-only unowned note');
    } finally {
      resetSettingsCacheForTesting();
      (globalThis as any).localStorage = oldLocalStorage;
    }
  });

  await t.test('7. Model Router Priority, Health-Aware Selection & Upstream Budget Payloads', async () => {
    const origEnv = {
      NODE_ENV: process.env.NODE_ENV,
      NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };

    process.env.NODE_ENV = 'production';
    process.env.NVIDIA_API_KEY = 'nv-test-key';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.GROQ_API_KEY = 'gsk-test-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const origFetch = globalThis.fetch;
    try {
      const router = new ModelRouter();

      // Even with ANTHROPIC_API_KEY set, VERIFIED_MODEL_REGISTRY declares Groq for aira-pro and aira-deep
      const proExec = router.resolveExecution('aira-pro', 'TOOL_ACTION', { callerTier: 'plus' });
      assert.equal(proExec.executedProvider, 'groq');
      assert.equal(proExec.executedModel, 'openai/gpt-oss-120b');
      assert.equal(proExec.fallbackOccurred, false);

      const deepExec = router.resolveExecution('aira-deep', 'RESEARCH', {
        callerTier: 'pro',
        extendedThinking: true,
        reasoningBudget: 3072
      });
      assert.equal(deepExec.executedProvider, 'groq');
      assert.equal(deepExec.executedModel, 'openai/gpt-oss-120b');
      assert.equal(deepExec.policy.reasoningBudget, 3072);
      assert.equal(deepExec.reasoningControl, 'effort_mapped');

      // Explicit NVIDIA model request routes to NVIDIA without fallback if NVIDIA is configured
      const explicitNv = router.resolveExecution('nvidia/llama-3.1-nemotron-70b-instruct', 'ANSWER', { callerTier: 'plus' });
      assert.equal(explicitNv.executedProvider, 'nvidia');
      assert.equal(explicitNv.executedModel, 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(explicitNv.fallbackOccurred, false);

      // When Groq circuit breaker is OPEN, router skips straight to healthy fallback
      const healthRouter = new ModelRouter();
      for (let i = 0; i < 5; i++) {
        healthRouter.healthTracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('Groq 429'), 429);
      }
      assert.equal(healthRouter.healthTracker.getCircuitState('groq', 'openai/gpt-oss-120b'), 'OPEN');
      const deepDegraded = healthRouter.resolveExecution('aira-deep', 'RESEARCH', { callerTier: 'pro' });
      assert.equal(deepDegraded.executedProvider, 'nvidia');
      assert.equal(deepDegraded.executedModel, 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(deepDegraded.fallbackOccurred, true);

      // Verify exact HTTP outbound payload for NVIDIA OpenAIAdapter:
      // 1) Never injects invalid `thinkingBudget` or `reasoning_budget` field
      // 2) Applies reasoningBudget cleanly to `max_tokens` ceiling when extendedThinking is enabled
      const capturedBodies: Array<{ url: string; body: Record<string, any> }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedBodies.push({
          url: String(url),
          body: JSON.parse(String(init?.body || '{}'))
        });
        return new Response(
          'data: {"model":"nvidia/llama-3.1-nemotron-70b-instruct","choices":[{"delta":{"content":"Verified answer"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }) as typeof fetch;

      const nvAdapter = new OpenAIAdapter('nv-key', 'https://integrate.api.nvidia.com/v1', 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia');
      await withInferencePrincipal('probe-nv', () =>
        nvAdapter.stream([{ role: 'user', content: 'Explain Raft consensus' }], deepExec.policy, () => {})
      );
      assert.equal(capturedBodies.length, 1);
      assert.equal(capturedBodies[0].body.model, 'nvidia/llama-3.1-nemotron-70b-instruct');
      assert.equal(capturedBodies[0].body.max_tokens, 3072, 'NVIDIA output cap honors calibrated reasoningBudget');
      assert.equal(Object.hasOwn(capturedBodies[0].body, 'thinkingBudget'), false, 'Must not send unsupported thinkingBudget to NIM');
      assert.equal(Object.hasOwn(capturedBodies[0].body, 'reasoning_budget'), false, 'Must not send unsupported reasoning_budget to NIM');

      // Verify Groq adapter maps extendedThinking + reasoningBudget -> reasoning_effort and captures delta.reasoning_content
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedBodies.push({
          url: String(url),
          body: JSON.parse(String(init?.body || '{}'))
        });
        return new Response(
          'data: {"model":"openai/gpt-oss-120b","choices":[{"delta":{"reasoning_content":"Thinking step..."}}]}\n\ndata: {"model":"openai/gpt-oss-120b","choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }) as typeof fetch;

      const groqAdapter = new OpenAIAdapter('gsk-key', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'groq');
      const receivedThinking: string[] = [];
      await withInferencePrincipal('probe-groq', () =>
        groqAdapter.stream(
          [{ role: 'user', content: 'Compute step by step' }],
          { ...deepExec.policy, model: 'openai/gpt-oss-120b', extendedThinking: true, reasoningBudget: 6144 },
          (chunk) => { if (chunk.thinking) receivedThinking.push(chunk.thinking); }
        )
      );
      assert.equal(capturedBodies[1].body.reasoning_effort, 'high');
      assert.deepEqual(receivedThinking, ['Thinking step...']);

      // Verify GeminiAdapter applies thinkingConfig + includeThoughts ONLY on thinking-capable Gemini 2.5 non-lite models
      const geminiAdapter = new GeminiAdapter('gm-key', 'gemini-2.5-pro');
      const geminiPayloadWithThinking = geminiAdapter.formatRequestPayload(
        [{ role: 'user', content: 'Prove P=NP?' }],
        { model: 'gemini-2.5-pro', extendedThinking: true, reasoningBudget: 4096 }
      );
      assert.equal(geminiPayloadWithThinking.generationConfig.thinkingConfig?.thinkingBudget, 4096);
      assert.equal(geminiPayloadWithThinking.generationConfig.thinkingConfig?.includeThoughts, true);

      const geminiFlashLite = new GeminiAdapter('gm-key', 'gemini-3.5-flash-lite');
      const geminiFlashPayload = geminiFlashLite.formatRequestPayload(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gemini-3.5-flash-lite', extendedThinking: true, reasoningBudget: 4096 }
      );
      assert.equal(geminiFlashPayload.generationConfig.thinkingConfig, undefined);

      // Verify GeminiAdapter.stream() returns outboundModel and thinking so fallback provenance marks verified: true
      globalThis.fetch = (async () =>
        new Response(
          'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Internal chain "}]}}]}\n' +
          'data: {"candidates":[{"content":{"parts":[{"text":"Verified Gemini output"}]}}]}\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )) as typeof fetch;
      const geminiThinkingChunks: string[] = [];
      const geminiStreamRes = await geminiAdapter.stream(
        [{ role: 'user', content: 'Explain consensus' }],
        { model: 'aira-deep', extendedThinking: true, reasoningBudget: 4096, maxTokens: 4096, temperature: 1, timeoutMs: 30000 },
        (chunk) => { if (chunk.thinking) geminiThinkingChunks.push(chunk.thinking); }
      );
      assert.equal(geminiStreamRes.outboundModel, 'gemini-2.5-pro');
      assert.equal(geminiStreamRes.model, 'gemini-2.5-pro');
      assert.equal(geminiStreamRes.thinking, 'Internal chain ');
      assert.deepEqual(geminiThinkingChunks, ['Internal chain ']);

      // Verify OpenAIAdapter also captures delta.reasoning (used by Groq gpt-oss-120b)
      globalThis.fetch = (async () =>
        new Response(
          'data: {"model":"openai/gpt-oss-120b","choices":[{"delta":{"reasoning":"Groq step..."}}]}\n\ndata: {"model":"openai/gpt-oss-120b","choices":[{"delta":{"content":"Ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )) as typeof fetch;
      const groqReasoningChunks: string[] = [];
      await withInferencePrincipal('probe-groq-reasoning', () =>
        groqAdapter.stream(
          [{ role: 'user', content: 'Check reasoning delta' }],
          { ...deepExec.policy, model: 'openai/gpt-oss-120b', extendedThinking: true, reasoningBudget: 4096 },
          (chunk) => { if (chunk.thinking) groqReasoningChunks.push(chunk.thinking); }
        )
      );
      assert.deepEqual(groqReasoningChunks, ['Groq step...']);

      // When GEMINI_API_KEY + GROQ_API_KEY are configured:
      // aira-pro and aira-deep route to Groq as primary (fallbackOccurred: false).
      // When Groq circuit opens, they route to Gemini 3.5 Flash-Lite (fallbackOccurred: true).
      process.env.GEMINI_API_KEY = 'gm-test-key';
      const dualRouter = new ModelRouter();
      const proPrimary = dualRouter.resolveExecution('aira-pro', 'ANSWER', { callerTier: 'pro' });
      assert.equal(proPrimary.executedProvider, 'groq');
      assert.equal(proPrimary.executedModel, 'openai/gpt-oss-120b');
      assert.equal(proPrimary.fallbackOccurred, false);

      for (let i = 0; i < 5; i++) {
        dualRouter.healthTracker.recordFailure('groq', 'openai/gpt-oss-120b', new Error('Groq 429'), 429);
      }
      const proFallback = dualRouter.resolveExecution('aira-pro', 'ANSWER', { callerTier: 'pro' });
      assert.equal(proFallback.executedProvider, 'gemini');
      assert.equal(proFallback.executedModel, 'gemini-3.5-flash-lite');
      assert.equal(proFallback.fallbackOccurred, true);

      const deepFallback = dualRouter.resolveExecution('aira-deep', 'RESEARCH', { callerTier: 'pro', extendedThinking: true, reasoningBudget: 4096 });
      assert.equal(deepFallback.executedProvider, 'gemini');
      assert.equal(deepFallback.executedModel, 'gemini-3.5-flash-lite');
      assert.equal(deepFallback.fallbackOccurred, true);
    } finally {
      globalThis.fetch = origFetch;
      process.env.NODE_ENV = origEnv.NODE_ENV;
      process.env.NVIDIA_API_KEY = origEnv.NVIDIA_API_KEY;
      process.env.ANTHROPIC_API_KEY = origEnv.ANTHROPIC_API_KEY;
      process.env.GROQ_API_KEY = origEnv.GROQ_API_KEY;
      process.env.GEMINI_API_KEY = origEnv.GEMINI_API_KEY;
    }
  });

  await t.test('8. Adversarial Post-Routing Entitlement Enforcement (Free User Cannot Escalate via AIRA Auto or AgentRuntime)', async () => {
    const router = new ModelRouter();

    // Free user sending RESEARCH + extendedThinking=true on aira-auto MUST be clamped to aira-fast
    const freeResearch = router.resolveExecution('aira-auto', 'RESEARCH', {
      callerTier: 'free',
      extendedThinking: true,
      reasoningBudget: 8192
    });
    assert.equal(freeResearch.policy.model, 'aira-fast');
    assert.equal(freeResearch.policy.extendedThinking, false);
    assert.equal(freeResearch.policy.reasoningBudget, undefined);
    assert.equal(freeResearch.entitlementClamped, true);
    assert.equal(freeResearch.downgradedFrom, 'aira-deep');
    assert.equal(freeResearch.reasoningControl, 'none');

    // Guest user sending WORKFLOW on aira-auto clamps to aira-fast
    const guestWorkflow = router.resolveExecution('aira-auto', 'WORKFLOW', { callerTier: 'guest' });
    assert.equal(guestWorkflow.policy.model, 'aira-fast');
    assert.equal(guestWorkflow.entitlementClamped, true);
    assert.equal(guestWorkflow.downgradedFrom, 'aira-pro');

    // Plus user sending RESEARCH clamps to aira-pro (cannot reach Pro-only aira-deep)
    const plusResearch = router.resolveExecution('aira-auto', 'RESEARCH', {
      callerTier: 'plus',
      extendedThinking: true,
      reasoningBudget: 8192
    });
    assert.equal(plusResearch.policy.model, 'aira-pro');
    assert.equal(plusResearch.policy.extendedThinking, false);
    assert.equal(plusResearch.entitlementClamped, true);
    assert.equal(plusResearch.downgradedFrom, 'aira-deep');

    // Pro user on RESEARCH receives full aira-deep with calibrated budget
    const proResearch = router.resolveExecution('aira-auto', 'RESEARCH', {
      callerTier: 'pro',
      extendedThinking: true,
      reasoningBudget: 4096
    });
    assert.equal(proResearch.policy.model, 'aira-deep');
    assert.equal(proResearch.policy.extendedThinking, true);
    assert.equal(proResearch.policy.reasoningBudget, 4096);
    assert.equal(proResearch.entitlementClamped, false);

    // Direct restricted model requests must throw PlanRestrictionError (403)
    assert.throws(
      () => router.resolveExecution('aira-deep', 'ANSWER', { callerTier: 'free' }),
      (err: any) => err instanceof PlanRestrictionError && err.code === 'PLAN_MODEL_RESTRICTED' && err.statusCode === 403
    );
    assert.throws(
      () => router.resolveExecution('aira-pro', 'ANSWER', { callerTier: 'guest' }),
      (err: any) => err instanceof PlanRestrictionError && err.code === 'PLAN_MODEL_RESTRICTED'
    );

    // Full AgentRuntime verification with server entitlementResolver
    const runRepo = new InMemoryRunRepository();
    const workspaceAuthority = new InMemoryWorkspaceAuthorityRepository();
    const approvalRepo: ApprovalRepository = {
      saveRequest: async () => {},
      getRequest: async () => undefined,
      getPendingForRun: async () => [],
      resolveRequest: async () => {}
    };
    const grantRepo: SessionGrantRepository = {
      grantSession: async () => {},
      grantAlways: async () => {},
      hasSessionGrant: async () => false,
      hasAlwaysGrant: async () => false,
      clearSession: async () => {}
    };
    const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);
    const toolGateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel, process.cwd(), workspaceAuthority);
    const knowledgeEngine = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false });
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
    runtime.setEntitlementResolver(async (principalId) => (
      principalId.includes('pro') ? 'pro' : principalId.includes('plus') ? 'plus' : 'free'
    ));

    const freePrincipal: ExecutionPrincipal = {
      userId: `usr_free_${randomUUID().slice(0, 8)}`,
      sessionId: 'sess_free',
      workspaceId: await workspaceAuthority.resolveWorkspace('usr_free_1'),
      scopes: ['chat:write']
    };

    await assert.rejects(
      () => runtime.createRun({ prompt: 'Architecture audit', modelPolicy: { model: 'aira-deep' } }, freePrincipal),
      (err: any) => err instanceof PlanRestrictionError && err.statusCode === 403
    );

    const clampedRun = await runtime.createRun({
      prompt: 'Research quantum error correction mechanisms',
      intent: 'RESEARCH',
      modelPolicy: { model: 'aira-auto', extendedThinking: true, reasoningBudget: 8192 }
    }, freePrincipal);
    assert.equal(clampedRun.modelPolicy.model, 'aira-fast', 'Free user AIRA Auto RESEARCH run must clamp to aira-fast');
    assert.equal(clampedRun.modelPolicy.extendedThinking, false);
    assert.equal(clampedRun.provenance?.entitlementClamped, true);
    assert.equal(clampedRun.provenance?.downgradedFrom, 'aira-deep');
  });

  await t.test('9. Authenticated /api/user/onboarding Server Sync & Anti-Spoofing Isolation', async () => {
    resetOnboardingStoreForTesting();
    const origDb = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    let activePrincipal: ExecutionPrincipal | undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (activePrincipal) req.principal = activePrincipal;
      next();
    });
    app.use('/api/user', createAccountRoutes());

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Unauthenticated fail-closed 401
      const anonRes = await fetch(`${baseUrl}/api/user/onboarding`);
      assert.equal(anonRes.status, 401);

      // Guest fail-closed 401
      activePrincipal = { userId: 'guest_abc', sessionId: 's_guest', scopes: [] };
      const guestPost = await fetch(`${baseUrl}/api/user/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish' })
      });
      assert.equal(guestPost.status, 401);

      // Authenticated Alice: spoofed x-user-id or body.userId -> 403 forbidden
      activePrincipal = { userId: 'usr_alice', sessionId: 's_alice', workspaceId: 'ws_alice', scopes: ['chat:write'] };
      const headerSpoof = await fetch(`${baseUrl}/api/user/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': 'usr_bob' },
        body: JSON.stringify({ action: 'finish' })
      });
      assert.equal(headerSpoof.status, 403);

      const bodySpoof = await fetch(`${baseUrl}/api/user/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish', userId: 'usr_bob' })
      });
      assert.equal(bodySpoof.status, 403);

      // Legitimate Alice onboarding completion
      const finishRes = await fetch(`${baseUrl}/api/user/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish' })
      });
      assert.equal(finishRes.status, 200);
      const finishJson = await finishRes.json();
      assert.equal(finishJson.completed, true);
      assert.equal(finishJson.currentStage, 'plans');
      assert.equal(finishJson.userId, 'usr_alice');

      // Switch principal to Bob: Bob has isolated default incomplete state
      activePrincipal = { userId: 'usr_bob', sessionId: 's_bob', workspaceId: 'ws_bob', scopes: ['chat:write'] };
      const bobGet = await fetch(`${baseUrl}/api/user/onboarding`);
      assert.equal(bobGet.status, 200);
      const bobJson = await bobGet.json();
      assert.equal(bobJson.completed, false);
      assert.equal(bobJson.currentStage, 'intro');
      assert.equal(bobJson.userId, 'usr_bob');

      // Client onboarding helper never sends spoofable x-user-id header
      const oldFetch = globalThis.fetch;
      const oldWin = (globalThis as any).window;
      const oldLS = (globalThis as any).localStorage;
      const mockLS = new MockLocalStorage();
      const origGetUser = neonAuth.getCurrentUser.bind(neonAuth);
      const origIsAuthed = neonAuth.isAuthenticated.bind(neonAuth);
      const origGetSession = neonAuth.getCurrentSession.bind(neonAuth);
      const origGetCsrf = neonAuth.getCsrfToken.bind(neonAuth);

      const seenHeaders: Array<Record<string, string>> = [];
      (globalThis as any).window = { localStorage: mockLS };
      (globalThis as any).localStorage = mockLS;
      neonAuth.getCurrentUser = (() => ({ id: 'usr_alice', email: 'alice@example.com', name: 'Alice' })) as any;
      neonAuth.isAuthenticated = (() => true) as any;
      neonAuth.getCurrentSession = (() => ({ user: { id: 'usr_alice' }, token: 'bff_session', csrfToken: 'csrf_test_123' })) as any;
      neonAuth.getCsrfToken = (() => 'csrf_test_123') as any;

      try {
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
          const h: Record<string, string> = {};
          new Headers(init?.headers || {}).forEach((v, k) => { h[k.toLowerCase()] = v; });
          seenHeaders.push(h);
          return new Response(JSON.stringify({ completed: true, currentStage: 'plans', skipped: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }) as typeof fetch;

        await syncOnboardingActionToServer('finish', undefined, 'usr_alice');
        const fetched = await fetchOnboardingFromServer('usr_alice');
        assert.equal(fetched?.completed, true);
        assert.equal(getOnboardingState('usr_alice').completed, true);
        assert.equal(seenHeaders.length, 2);
        for (const h of seenHeaders) {
          assert.equal(Object.hasOwn(h, 'x-user-id'), false, 'Client sync must NEVER send untrusted x-user-id header');
        }
      } finally {
        globalThis.fetch = oldFetch;
        neonAuth.getCurrentUser = origGetUser;
        neonAuth.isAuthenticated = origIsAuthed;
        neonAuth.getCurrentSession = origGetSession;
        neonAuth.getCsrfToken = origGetCsrf;
        (globalThis as any).window = oldWin;
        (globalThis as any).localStorage = oldLS;
      }
    } finally {
      if (origDb) process.env.DATABASE_URL = origDb;
      resetOnboardingStoreForTesting();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  await t.test('10. Commercial Contract Consistency & UI Copy Audit', () => {
    assert.equal(COMMERCIAL_PLANS.guest.dailyStandardChatLimit, 5);
    assert.equal(COMMERCIAL_PLANS.guest.monthlyStandardChatUnits, 5);
    assert.equal(COMMERCIAL_PLANS.guest.monthlyPremiumCredits, 0);
    assert.equal(COMMERCIAL_PLANS.guest.complimentaryReasoningBoosts, 0);
    assert.equal(COMMERCIAL_PLANS.guest.maxProjects, 0);

    assert.equal(COMMERCIAL_PLANS.free.dailyStandardChatLimit, 15);
    assert.equal(COMMERCIAL_PLANS.free.monthlyStandardChatUnits, 150);
    assert.equal(COMMERCIAL_PLANS.free.monthlyPremiumCredits, 100);
    assert.equal(COMMERCIAL_PLANS.free.complimentaryReasoningBoosts, 5);
    assert.equal(COMMERCIAL_PLANS.free.maxProjects, 3);
    assert.equal(COMMERCIAL_PLANS.free.maxMemoryRecords, 50);

    assert.equal(COMMERCIAL_PLANS.plus.dailyStandardChatLimit, 50);
    assert.equal(COMMERCIAL_PLANS.plus.monthlyStandardChatUnits, 700);
    assert.equal(COMMERCIAL_PLANS.plus.monthlyPremiumCredits, 3000);
    assert.equal(COMMERCIAL_PLANS.plus.complimentaryReasoningBoosts, 50);
    assert.equal(COMMERCIAL_PLANS.plus.maxProjects, 10);
    assert.equal(COMMERCIAL_PLANS.plus.maxMemoryRecords, 250);
    assert.deepEqual(COMMERCIAL_PLANS.plus.prices, []);

    assert.equal(COMMERCIAL_PLANS.pro.dailyStandardChatLimit, 150);
    assert.equal(COMMERCIAL_PLANS.pro.monthlyStandardChatUnits, 2000);
    assert.equal(COMMERCIAL_PLANS.pro.monthlyPremiumCredits, 7500);
    assert.equal(COMMERCIAL_PLANS.pro.complimentaryReasoningBoosts, 200);
    assert.equal(COMMERCIAL_PLANS.pro.maxProjects, -1);
    assert.equal(COMMERCIAL_PLANS.pro.maxMemoryRecords, -1);
    assert.deepEqual(COMMERCIAL_PLANS.pro.prices, []);

    assert.equal(isModelAllowedForTier('aira-fast', 'free'), true);
    assert.equal(isModelAllowedForTier('aira-pro', 'free'), false);
    assert.equal(isModelAllowedForTier('aira-deep', 'plus'), false);
    assert.equal(isModelAllowedForTier('aira-deep', 'pro'), true);

    const filesToAudit = [
      'src/video/types.ts',
      'src/components/LegalViewerModal.tsx',
      'src/components/ReleaseNotesModal.tsx',
      'src/components/PrivacyCenterModal.tsx',
      'src/components/SettingsModal.tsx',
      'src/components/MotionStudioModal.tsx'
    ];
    for (const relPath of filesToAudit) {
      const content = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
      assert.doesNotMatch(content, /\$20\/mo|\$50\/mo/i, `${relPath} must not show unapproved $20/$50 pricing`);
      assert.doesNotMatch(content, /unlimited chats/i, `${relPath} must not advertise unlimited chats`);
      assert.doesNotMatch(content, /4 progressive steps/i, `${relPath} must not contradict 5-stage onboarding`);
      assert.doesNotMatch(content, /Free, Pro,? (?:&|and|or) Enterprise/i, `${relPath} must not advertise non-existent Enterprise tier`);
    }
  });
});
