import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  migrateAgentMemoryVault,
  CURRENT_MIGRATION_VERSION
} from '../../src/utils/agentMemoryMigration.js';
import { agentMemory } from '../../src/utils/agentMemoryEngine.js';
import type { MemoryItem } from '../../src/types/index.js';

describe('AIRA Behavioral Intelligence — Memory Migration & Relevance Isolation', () => {
  it('cleanses defective seed-sem-pref-1 "zero emojis" and unpins it', () => {
    const rawFixture: MemoryItem[] = [
      {
        id: 'seed-sem-pref-1',
        tier: 'semantic',
        category: 'preference',
        title: 'Brand Aesthetic & Iconography Guidelines',
        content: 'All UI elements adhere to premium agency aesthetics: rich dark/light themes, warm terracotta accents (#D97757), zero emojis, and the 6-fold celestial neural knot logo. Star icons are replaced with Zap, Cpu, or Bookmark.',
        tags: ['aesthetic', 'theme', 'terracotta', 'logo', 'design'],
        createdAt: 1000,
        updatedAt: 1000,
        accessCount: 5,
        isPinned: true
      }
    ];

    const { migratedItems, report } = migrateAgentMemoryVault(rawFixture);

    assert.strictEqual(report.changesMade, true);
    assert.strictEqual(report.defectiveSeedsCleaned, 1);
    assert.strictEqual(report.version, CURRENT_MIGRATION_VERSION);

    const cleaned = migratedItems.find(m => m.id === 'seed-sem-pref-1');
    assert.ok(cleaned, 'seed-sem-pref-1 must exist');
    assert.strictEqual(cleaned.isPinned, false, 'Must be unpinned to prevent universal contamination');
    assert.ok(!cleaned.content.includes('zero emojis'), 'Must not contain "zero emojis" restriction');
    assert.ok(cleaned.content.includes('terracotta accents'), 'Must preserve branding colors');
    assert.ok(cleaned.content.includes('6-fold celestial neural knot'), 'Must preserve brand logo details');
  });

  it('unpins seed-proc-flow-1 so development verification rules only activate when relevant', () => {
    const rawFixture: MemoryItem[] = [
      {
        id: 'seed-proc-flow-1',
        tier: 'procedural',
        category: 'workflow',
        title: 'Code Verification & Delivery Protocol',
        content: 'Before completing development tasks, verify with `npm run lint` (oxlint) and `npm run build` (tsc -b && vite build). Ensure zero warnings and zero TypeScript errors.',
        tags: ['lint', 'build', 'verification'],
        createdAt: 1000,
        updatedAt: 1000,
        accessCount: 10,
        isPinned: true
      }
    ];

    const { migratedItems, report } = migrateAgentMemoryVault(rawFixture);

    assert.strictEqual(report.changesMade, true);
    assert.strictEqual(report.unpinnedProcedureSeeds, 1);

    const unpinned = migratedItems.find(m => m.id === 'seed-proc-flow-1');
    assert.ok(unpinned);
    assert.strictEqual(unpinned.isPinned, false);
    assert.ok(unpinned.content.includes('oxlint'));
  });

  it('preserves 100% of user-authored memories, custom tags, and preferences', () => {
    const userMemory1: MemoryItem = {
      id: 'usr_pref_user_1',
      tier: 'semantic',
      category: 'preference',
      title: 'User Tone Preference',
      content: 'I prefer concise, direct explanations without excessive disclaimers.',
      tags: ['user', 'tone', 'custom'],
      createdAt: 5000,
      updatedAt: 6000,
      accessCount: 20,
      isPinned: true,
      userId: 'user-vip-1'
    };

    const userMemory2: MemoryItem = {
      id: 'usr_proj_notes_42',
      tier: 'episodic',
      category: 'decision',
      title: 'Selected DB schema for Project Apollo',
      content: 'Decided on PostgreSQL with pgvector for hybrid retrieval.',
      tags: ['database', 'postgres', 'apollo'],
      createdAt: 7000,
      updatedAt: 7500,
      accessCount: 15,
      isPinned: false,
      projectId: 'proj-apollo'
    };

    const rawFixture = [userMemory1, userMemory2];
    const { migratedItems, report } = migrateAgentMemoryVault(rawFixture);

    assert.strictEqual(report.changesMade, false, 'No changes should be made to user memories');
    assert.strictEqual(report.userAuthoredPreserved, 2);
    assert.strictEqual(migratedItems.length, 2);

    const preserved1 = migratedItems.find(m => m.id === 'usr_pref_user_1');
    assert.deepStrictEqual(preserved1, userMemory1, 'User memory 1 must be preserved byte-for-byte');

    const preserved2 = migratedItems.find(m => m.id === 'usr_proj_notes_42');
    assert.deepStrictEqual(preserved2, userMemory2, 'User memory 2 must be preserved byte-for-byte');
  });

  it('is completely idempotent on repeated runs', () => {
    const mixedFixture: MemoryItem[] = [
      {
        id: 'seed-sem-pref-1',
        tier: 'semantic',
        category: 'preference',
        title: 'Brand Aesthetic & Iconography Guidelines',
        content: 'All UI elements adhere to premium agency aesthetics: rich dark/light themes, warm terracotta accents (#D97757), zero emojis, and the 6-fold celestial neural knot logo.',
        tags: ['aesthetic'],
        createdAt: 1000,
        updatedAt: 1000,
        accessCount: 2,
        isPinned: true
      },
      {
        id: 'seed-proc-flow-1',
        tier: 'procedural',
        category: 'workflow',
        title: 'Code Verification & Delivery Protocol',
        content: 'Verify with npm run lint.',
        tags: ['lint'],
        createdAt: 1000,
        updatedAt: 1000,
        accessCount: 2,
        isPinned: true
      },
      {
        id: 'usr_mem_custom',
        tier: 'semantic',
        category: 'general',
        title: 'My Custom Note',
        content: 'Remember to deploy to staging on Fridays.',
        tags: ['custom'],
        createdAt: 2000,
        updatedAt: 2000,
        accessCount: 1,
        isPinned: true
      }
    ];

    // Pass 1: Should migrate defective seeds
    const pass1 = migrateAgentMemoryVault(mixedFixture);
    assert.strictEqual(pass1.report.changesMade, true);

    // Pass 2: Running against pass 1 output should make 0 changes
    const pass2 = migrateAgentMemoryVault(pass1.migratedItems);
    assert.strictEqual(pass2.report.changesMade, false);
    assert.strictEqual(pass2.report.defectiveSeedsCleaned, 0);
    assert.strictEqual(pass2.report.unpinnedProcedureSeeds, 0);
    assert.deepStrictEqual(pass2.migratedItems, pass1.migratedItems);
  });

  it('safely handles null, malformed, or empty storage records without error', () => {
    const nullRun = migrateAgentMemoryVault(null);
    assert.strictEqual(nullRun.report.changesMade, false);
    assert.strictEqual(nullRun.migratedItems.length, 0);

    const undefinedRun = migrateAgentMemoryVault(undefined);
    assert.strictEqual(undefinedRun.migratedItems.length, 0);

    const corruptedRun = migrateAgentMemoryVault([null, 42, 'corrupted string', { missingId: true }]);
    assert.ok(Array.isArray(corruptedRun.migratedItems));
  });

  it('enforces relevance-first retrieval and returns empty array on unrelated queries', () => {
    // "Create some emojis" should NOT return the branding or lint seeds
    const recalledForEmojis = agentMemory.recall({
      query: 'Create some emojis for a summer party! ☀️🎉',
      limit: 5,
      minScore: 0.18
    });
    assert.strictEqual(recalledForEmojis.length, 0, 'Must return empty array when no memory matches');

    // Context assembled for emojis should be empty string
    const assembled = agentMemory.assembleMemoryContext('Create some emojis for a party!');
    assert.strictEqual(assembled, '', 'Assembled context must be empty when no relevant memory found');
  });

  it('enforces tenant and project isolation boundaries', () => {
    // Save items with specific project and user tags into memory engine
    const testEngine = agentMemory;
    testEngine.remember('Confidential strategic initiatives for Tenant Alpha only.', {
      tier: 'semantic',
      category: 'general',
      title: 'Tenant Alpha Secret Strategy',
      tags: ['alpha', 'tenant'],
      userId: 'user-tenant-alpha',
      projectId: 'proj-alpha'
    });

    testEngine.remember('Public docs for Tenant Beta.', {
      tier: 'semantic',
      category: 'general',
      title: 'Tenant Beta Public Documentation',
      tags: ['beta', 'tenant'],
      userId: 'user-tenant-beta',
      projectId: 'proj-beta'
    });

    // Query from tenant Beta should NEVER receive Tenant Alpha's memory
    const betaQuery = testEngine.recall({
      query: 'Confidential strategic initiatives',
      activeUserId: 'user-tenant-beta',
      activeProjectId: 'proj-beta'
    });

    const leakedAlpha = betaQuery.some(m => m.title.includes('Tenant Alpha'));
    assert.strictEqual(leakedAlpha, false, 'Tenant Alpha memory must not leak to Tenant Beta');
  });

  it('strictly preserves user-authored memory even if title matches "Brand Aesthetic" or "Code Verification"', () => {
    const userBrandingMemory: MemoryItem = {
      id: 'usr_brand_guidelines_99',
      tier: 'semantic',
      category: 'preference',
      title: 'Brand Aesthetic Guidelines for Client Project',
      content: 'Client Brand Aesthetic: Use primary navy #001F3F, gold accents #FFD700, zero emojis.',
      tags: ['client', 'brand', 'navy'],
      createdAt: 5000,
      updatedAt: 5000,
      accessCount: 1,
      isPinned: true
    };

    const userVerificationMemory: MemoryItem = {
      id: 'usr_code_verification_custom',
      tier: 'procedural',
      category: 'workflow',
      title: 'Code Verification Protocol for Microservices',
      content: 'Run pytest and black before committing.',
      tags: ['python', 'testing'],
      createdAt: 6000,
      updatedAt: 6000,
      accessCount: 3,
      isPinned: true
    };

    const { migratedItems, report } = migrateAgentMemoryVault([userBrandingMemory, userVerificationMemory]);

    assert.strictEqual(report.changesMade, false, 'User authored memories must never be migrated based on title');
    assert.strictEqual(report.userAuthoredPreserved, 2);
    assert.deepStrictEqual(migratedItems[0], userBrandingMemory, 'User branding memory must be preserved byte-for-byte');
    assert.deepStrictEqual(migratedItems[1], userVerificationMemory, 'User verification memory must be preserved byte-for-byte');
  });

  it('preserves user explicit preference for no emojis byte-for-byte', () => {
    const explicitNoEmojiPreference: MemoryItem = {
      id: 'usr_pref_strict_no_emoji',
      tier: 'semantic',
      category: 'preference',
      title: 'Strict No Emojis In Any Response',
      content: 'I have sensory sensitivities, please use zero emojis under any circumstances.',
      tags: ['accessibility', 'tone', 'preference'],
      createdAt: 3000,
      updatedAt: 3000,
      accessCount: 12,
      isPinned: true
    };

    const { migratedItems, report } = migrateAgentMemoryVault([explicitNoEmojiPreference]);
    assert.strictEqual(report.changesMade, false);
    assert.deepStrictEqual(migratedItems[0], explicitNoEmojiPreference);
  });

  it('recovers malformed record with deterministic ID without randomness', () => {
    const malformed1 = { title: 'Legacy Note Without ID', content: 'Important note content', tags: ['note'] };
    const malformed2 = { title: 'Legacy Note Without ID', content: 'Important note content', tags: ['note'] };

    const run1 = migrateAgentMemoryVault([malformed1]);
    const run2 = migrateAgentMemoryVault([malformed2]);

    assert.strictEqual(run1.migratedItems[0].id, run2.migratedItems[0].id, 'Recovery ID must be deterministic across runs');
    assert.ok(run1.migratedItems[0].id.startsWith('recovered_mem_'));
  });
});
