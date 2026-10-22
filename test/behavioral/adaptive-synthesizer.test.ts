import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AdaptiveSynthesizer } from '../../packages/agent-runtime/src/behavioral/adaptive-synthesizer.js';

describe('AIRA Behavioral Intelligence — Adaptive Writing & Communication Synthesis', () => {
  const synthesizer = new AdaptiveSynthesizer();

  it('selects CASUAL_GREETING profile for short greetings without development boilerplate', () => {
    const profile = synthesizer.deriveProfile('Hi there!');
    assert.strictEqual(profile.mode, 'CASUAL_GREETING');
    assert.strictEqual(profile.tone, 'warm_friendly');
    assert.strictEqual(profile.targetLength, 'concise_under_50_words');
    assert.strictEqual(profile.avoidBoilerplate, true);

    const directive = synthesizer.buildSystemDirective(profile);
    assert.ok(directive.includes('under 40 words'));
    assert.ok(directive.includes('Do NOT include development checklists'));
  });

  it('selects CREATIVE_WRITING profile and naturally allows emojis', () => {
    const profile = synthesizer.deriveProfile('Write a funny story about a robot learning to cook with emojis 🤖🍕');
    assert.strictEqual(profile.mode, 'CREATIVE_WRITING');
    assert.strictEqual(profile.tone, 'playful_creative');
    assert.strictEqual(profile.allowEmojis, true);

    const directive = synthesizer.buildSystemDirective(profile);
    assert.ok(directive.includes('expressive and delightful emojis'));
  });

  it('selects SCIENTIFIC_DEEP_DIVE profile with high conceptual depth for scientific questions', () => {
    const profile = synthesizer.deriveProfile('Explain quantum entanglement and Einstein-Podolsky-Rosen paradox.');
    assert.strictEqual(profile.mode, 'SCIENTIFIC_DEEP_DIVE');
    assert.strictEqual(profile.tone, 'academic_rigorous');
    assert.strictEqual(profile.technicalDepth, 4);

    const directive = synthesizer.buildSystemDirective(profile);
    assert.ok(directive.includes('factual accuracy'));
  });

  it('selects TECHNICAL_DEBUGGING profile for code error diagnostics', () => {
    const profile = synthesizer.deriveProfile('Fix this TypeScript TypeError in src/App.tsx where state is undefined.');
    assert.strictEqual(profile.mode, 'TECHNICAL_DEBUGGING');
    assert.strictEqual(profile.tone, 'objective_technical');
    assert.strictEqual(profile.formattingPreference, 'markdown_code_and_diffs');

    const directive = synthesizer.buildSystemDirective(profile);
    assert.ok(directive.includes('isolated root cause'));
  });

  it('selects STRUCTURED_COMPARISON profile for comparative analysis', () => {
    const profile = synthesizer.deriveProfile('Compare PostgreSQL and MongoDB: trade-offs and performance.');
    assert.strictEqual(profile.mode, 'STRUCTURED_COMPARISON');
    assert.strictEqual(profile.formattingPreference, 'markdown_tables_and_rubrics');

    const directive = synthesizer.buildSystemDirective(profile);
    assert.ok(directive.includes('tradeoffs'));
  });

  it('respects explicit request for no emojis in business communication', () => {
    const profile = synthesizer.deriveProfile('Draft an executive summary email for the board. Do not use emojis.');
    assert.strictEqual(profile.mode, 'BUSINESS_COMMUNICATION');
    assert.strictEqual(profile.allowEmojis, false);
  });
});
