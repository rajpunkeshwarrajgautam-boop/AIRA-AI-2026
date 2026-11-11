import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS, DEFAULT_SETTINGS } from '../src/utils/constants.js';
import {
  VERIFIED_MODEL_REGISTRY,
  VERIFIED_PLAN_MODEL_ALLOWLIST
} from '../packages/contracts/src/model-registry.js';
import { normalizeModelIdentifier } from '../packages/contracts/src/index.js';
import { normalizeStoredModelId } from '../src/utils/storage.js';
import { composeSystemPrompt } from '../src/utils/aiEngine.js';
import { FEATURE_GUIDANCE_CATALOG } from '../src/utils/featureDiscovery.js';

test('Truthful Capabilities & Model Architecture Suite', async (t) => {
  await t.test('1. Model Registry Truthfulness & Active Models in Contracts', () => {
    // Ensure VERIFIED_MODEL_REGISTRY contains canonical models
    const registryKeys = Object.keys(VERIFIED_MODEL_REGISTRY);
    assert.ok(registryKeys.includes('aira-auto'));
    assert.ok(registryKeys.includes('aira-fast'));
    assert.ok(registryKeys.includes('aira-pro'));
    assert.ok(registryKeys.includes('aira-deep'));
    assert.ok(registryKeys.includes('nvidia/llama-3.1-nemotron-70b-instruct'));

    // Check upstream models and providers
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-auto'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-auto'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-fast'].provider, 'groq');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-fast'].upstreamModelId, 'openai/gpt-oss-120b');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-pro'].provider, 'nvidia');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-pro'].upstreamModelId, 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-deep'].provider, 'nvidia');
    assert.equal(VERIFIED_MODEL_REGISTRY['aira-deep'].upstreamModelId, 'nvidia/llama-3.1-nemotron-70b-instruct');

    // Ensure no model in VERIFIED_MODEL_REGISTRY claims Anthropic as provider
    for (const [id, def] of Object.entries(VERIFIED_MODEL_REGISTRY)) {
      assert.notEqual(def.provider, 'anthropic', `Model ${id} must not use unconfigured provider anthropic`);
      assert.equal(def.contextWindow, '128K tokens', `Context window for ${id} must be truthful 128K tokens`);
    }

    // Verify Plan allowlists contain truthful models
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.guest.includes('aira-fast'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.free.includes('aira-auto'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.plus.includes('aira-pro'));
    assert.ok(VERIFIED_PLAN_MODEL_ALLOWLIST.pro.includes('aira-deep'));
  });

  await t.test('2. AVAILABLE_MODELS Interface Catalog Truthfulness', () => {
    // Default active model must be aira-auto
    assert.equal(DEFAULT_SETTINGS.activeModel, 'aira-auto');

    // Check each UI model option
    for (const model of AVAILABLE_MODELS) {
      // Must not make false claims about Claude, Sonnet, Haiku, GPT-4o, or DeepSeek
      const forbiddenTerms = [/claude/i, /sonnet/i, /haiku/i, /gpt-4o/i, /deepseek/i];
      for (const term of forbiddenTerms) {
        assert.doesNotMatch(model.name, term, `Model name "${model.name}" contains unsupported reference`);
        assert.doesNotMatch(model.description, term, `Model description "${model.description}" contains unsupported reference`);
      }

      // Max context window must be truthful 128K tokens
      assert.equal(model.contextWindow, '128K tokens', `Model ${model.id} contextWindow must be "128K tokens"`);
    }
  });

  await t.test('3. Contracts normalizeModelIdentifier Behavior', () => {
    // Legacy Anthropic / Claude aliases must map to supported canonical options
    assert.equal(normalizeModelIdentifier('claude-3-7-sonnet'), 'aira-auto');
    assert.equal(normalizeModelIdentifier('claude-3-5-sonnet'), 'aira-pro');
    assert.equal(normalizeModelIdentifier('claude-3-5-haiku'), 'aira-fast');
    assert.equal(normalizeModelIdentifier('claude-3-opus'), 'aira-deep');

    // 405B and 120B NVIDIA aliases map to 70b nemotron
    assert.equal(normalizeModelIdentifier('meta/llama-3.1-405b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.equal(normalizeModelIdentifier('nvidia/nemotron-3-super-120b-a12b'), 'nvidia/llama-3.1-nemotron-70b-instruct');

    // Canonical IDs pass through
    assert.equal(normalizeModelIdentifier('aira-auto'), 'aira-auto');
    assert.equal(normalizeModelIdentifier('aira-fast'), 'aira-fast');
    assert.equal(normalizeModelIdentifier('aira-pro'), 'aira-pro');
    assert.equal(normalizeModelIdentifier('aira-deep'), 'aira-deep');
    assert.equal(normalizeModelIdentifier('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');
  });

  await t.test('4. Local Storage normalizeStoredModelId Migration Mapping', () => {
    // Legacy Claude IDs normalize to truthful canonical IDs
    assert.equal(normalizeStoredModelId('claude-3-7-sonnet'), 'aira-auto');
    assert.equal(normalizeStoredModelId('claude-3-5-sonnet'), 'aira-pro');
    assert.equal(normalizeStoredModelId('claude-3-5-haiku'), 'aira-fast');
    assert.equal(normalizeStoredModelId('claude-3-opus'), 'aira-deep');

    // Unsupported legacy 405B must map to Nemotron 70B
    assert.equal(normalizeStoredModelId('meta-llama/llama-3.1-405b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');

    // Canonical IDs must pass through unchanged
    assert.equal(normalizeStoredModelId('aira-auto'), 'aira-auto');
    assert.equal(normalizeStoredModelId('aira-fast'), 'aira-fast');
    assert.equal(normalizeStoredModelId('aira-pro'), 'aira-pro');
    assert.equal(normalizeStoredModelId('aira-deep'), 'aira-deep');
    assert.equal(normalizeStoredModelId('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/llama-3.1-nemotron-70b-instruct');

    // Unknown or empty ID falls back to aira-auto
    assert.equal(normalizeStoredModelId('unknown-model-xyz'), 'aira-auto');
    assert.equal(normalizeStoredModelId(null), 'aira-auto');
    assert.equal(normalizeStoredModelId(undefined), 'aira-auto');
  });

  await t.test('5. Prompt Composition: Response Style Injection', () => {
    const baseSettings: any = {
      responseStyle: 'normal',
      userBio: '',
      customInstructions: ''
    };

    // Normal style
    const promptNormal = composeSystemPrompt(baseSettings);
    assert.ok(promptNormal.includes('Response Style Directive: Adopt a balanced, clear, and adaptive tone'));

    // Concise style
    const promptConcise = composeSystemPrompt({ ...baseSettings, responseStyle: 'concise' });
    assert.ok(promptConcise.includes('Response Style Directive: Provide concise, direct answers without unnecessary preamble or filler.'));

    // Explanatory style
    const promptExplanatory = composeSystemPrompt({ ...baseSettings, responseStyle: 'explanatory' });
    assert.ok(promptExplanatory.includes('Response Style Directive: Provide detailed, pedagogical explanations breaking down concepts step-by-step.'));

    // Academic style
    const promptAcademic = composeSystemPrompt({ ...baseSettings, responseStyle: 'academic' });
    assert.ok(promptAcademic.includes('Response Style Directive: Provide rigorous, academically grounded analysis with analytical depth and formal phrasing.'));

    // Code-first style
    const promptCodeFirst = composeSystemPrompt({ ...baseSettings, responseStyle: 'code-first' });
    assert.ok(promptCodeFirst.includes('Response Style Directive: Provide dense, production-grade code-first implementations with minimal conversational overhead.'));
  });

  await t.test('6. Prompt Composition: User Bio and Custom Instructions Scoping', () => {
    const settingsWithPersonalization: any = {
      responseStyle: 'concise',
      userBio: 'Senior distributed systems engineer focusing on high-throughput streaming systems.',
      customInstructions: 'Always include execution complexity benchmarks.'
    };

    const prompt = composeSystemPrompt(settingsWithPersonalization);

    // Must include style
    assert.ok(prompt.includes('Response Style Directive: Provide concise, direct answers without unnecessary preamble or filler.'));

    // Must include user bio in bounded section
    assert.ok(prompt.includes('User Profile Context: Senior distributed systems engineer focusing on high-throughput streaming systems.'));

    // Must include custom instructions in bounded section
    assert.ok(prompt.includes('User Custom Instructions: Always include execution complexity benchmarks.'));

    // Precedence: Response Style Directive -> User Profile Context -> User Custom Instructions
    const stylePos = prompt.indexOf('Response Style Directive:');
    const bioPos = prompt.indexOf('User Profile Context:');
    const customPos = prompt.indexOf('User Custom Instructions:');

    assert.ok(stylePos < bioPos, 'Response Style must precede User Bio');
    assert.ok(bioPos < customPos, 'User Bio must precede Custom Instructions');
  });

  await t.test('7. Feature Guidance Catalog Truthfulness Verification', () => {
    // FEATURE_GUIDANCE_CATALOG must not have any unverified provider claims
    for (const card of FEATURE_GUIDANCE_CATALOG) {
      const forbiddenTerms = [/claude/i, /sonnet/i, /haiku/i, /gpt-4o/i, /deepseek/i, /64[,.]?000/i];
      for (const term of forbiddenTerms) {
        assert.doesNotMatch(card.title, term, `Card "${card.title}" contains unsupported reference`);
        assert.doesNotMatch(card.description, term, `Card "${card.title}" description contains unsupported reference`);
        if (card.subtitle) {
          assert.doesNotMatch(card.subtitle, term, `Card "${card.title}" subtitle contains unsupported reference`);
        }
        if (card.samplePrompt) {
          assert.doesNotMatch(card.samplePrompt, term, `Card "${card.title}" samplePrompt contains unsupported reference`);
        }
      }
    }
  });
});
