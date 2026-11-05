import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrainV2KnowledgeEngine,
  InMemoryKnowledgeRepository
} from '../packages/knowledge/src/index.js';
import type { PrincipalScope } from '../packages/contracts/src/index.js';

test('Mission F — BrainV2 Durable Memory, Search, Compaction, Export, and Privacy Center Purge', async (t) => {
  const sharedRepo = new InMemoryKnowledgeRepository();

  const userAlice: PrincipalScope = {
    principalId: 'usr_alice_privacy',
    workspaceId: 'ws_alice_corp',
    isSystem: false
  };

  const userBob: PrincipalScope = {
    principalId: 'usr_bob_privacy',
    workspaceId: 'ws_bob_corp',
    isSystem: false
  };

  const systemScope: PrincipalScope = {
    principalId: 'system',
    isSystem: true
  };

  await t.test('1. Persistence Across Engine Re-instantiation', async () => {
    // Engine Instance 1 writes
    const engine1 = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });
    await engine1.saveMemory('deploy_region', 'ap-south-1', 'preference', 'user', userAlice);
    await engine1.ingestDocument(
      'Alice Operational Plan',
      'Deploying AIRA microservices in ap-south-1 with Kubernetes multi-cluster routing.',
      'text/markdown',
      'aira://docs/ops_alice',
      undefined,
      userAlice
    );

    // Engine Instance 2 reads from the underlying shared repository (simulating process restart)
    const engine2 = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });
    const aliceMemories = await engine2.getMemories(userAlice);
    assert.equal(aliceMemories.length, 1);
    assert.equal(aliceMemories[0].key, 'deploy_region');
    assert.equal(aliceMemories[0].value, 'ap-south-1');

    const aliceSources = await engine2.getSources(userAlice);
    assert.equal(aliceSources.length, 1);
    assert.equal(aliceSources[0].title, 'Alice Operational Plan');
  });

  await t.test('2. Hybrid Search and Citation Generation', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });
    const results = await engine.search('Kubernetes routing', 5, userAlice);
    assert.ok(results.length >= 1, 'Search must return matching chunks');
    assert.ok(results[0].score > 0);
    assert.ok(results[0].citation);
    assert.equal(results[0].citation.sourceTitle, 'Alice Operational Plan');
    assert.ok(results[0].chunk.text.includes('Kubernetes'));
  });

  await t.test('3. Contradiction Handling and Memory Supercedence', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });

    // Alice updates her preferred deployment region from ap-south-1 to eu-central-1
    const contradictionResult = await engine.handleContradiction(
      'deploy_region',
      'eu-central-1',
      'preference',
      'user_settings',
      userAlice
    );

    assert.equal(contradictionResult.priorStaleCount, 1, 'Prior conflicting record must be marked stale');
    assert.equal(contradictionResult.activeMemory.value, 'eu-central-1');

    const allMemories = await engine.getMemories(userAlice);
    const staleMem = allMemories.find(m => m.value === 'ap-south-1');
    const activeMem = allMemories.find(m => m.value === 'eu-central-1');

    assert.ok(staleMem);
    assert.equal(staleMem.stale, true);
    assert.equal(staleMem.confidence, 0.1);

    assert.ok(activeMem);
    assert.equal(activeMem.stale, false);
    assert.equal(activeMem.confidence, 1.0);
  });

  await t.test('4. Memory Compaction (Pruning Stale Knowledge)', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });
    const beforeCompaction = await engine.getMemories(userAlice);
    assert.equal(beforeCompaction.length, 2); // 1 active, 1 stale

    const compaction = await engine.compactMemories(userAlice);
    assert.equal(compaction.removedCount, 1);

    const afterCompaction = await engine.getMemories(userAlice);
    assert.equal(afterCompaction.length, 1);
    assert.equal(afterCompaction[0].value, 'eu-central-1');
    assert.equal(afterCompaction[0].stale, false);
  });

  await t.test('5. Tenant Isolation (Alice vs Bob Separation)', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });

    // Bob creates his private memory and document
    await engine.saveMemory('stripe_secret_key', 'sk_live_bob_secret', 'constraint', 'api', userBob);
    await engine.ingestDocument(
      'Bob Private Ledger',
      'Confidential accounting records for Bob Corp.',
      'text/markdown',
      'aira://docs/ledger_bob',
      undefined,
      userBob
    );

    // Alice searches for Bob's data — must return 0 results (strict isolation)
    const aliceSearchForBob = await engine.search('Confidential accounting', 5, userAlice);
    assert.equal(aliceSearchForBob.length, 0, "Alice must never find Bob's confidential documents");

    const aliceMemories = await engine.getMemories(userAlice);
    assert.ok(!aliceMemories.some(m => m.value.includes('sk_live_bob_secret')));

    const aliceSources = await engine.getSources(userAlice);
    assert.ok(!aliceSources.some(s => s.title.includes('Bob Private Ledger')));
  });

  await t.test('6. Privacy Center Export (GDPR Portability Bundle)', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });
    const bundle = await engine.exportUserKnowledge(userAlice);

    assert.equal(bundle.principalId, 'usr_alice_privacy');
    assert.equal(bundle.sources.length, 1);
    assert.equal(bundle.sources[0].title, 'Alice Operational Plan');
    assert.equal(bundle.memories.length, 1);
    assert.equal(bundle.memories[0].value, 'eu-central-1');
    assert.ok(bundle.exportedAt > 0);
  });

  await t.test('7. Privacy Center Purge (Right-to-be-Forgotten Zero Leakage)', async () => {
    const engine = new BrainV2KnowledgeEngine(sharedRepo, { seedDefaults: false });

    // Also seed system memory to verify system data is protected
    await engine.saveMemory('platform_name', 'AIRA AI 2026', 'fact', 'system', systemScope);

    // Alice executes full Privacy Center purge
    const purgeResult = await engine.purgeAllUserData(userAlice);
    assert.ok(purgeResult.purgedMemories >= 1);
    assert.ok(purgeResult.purgedSources >= 1);

    // Verify Alice has 0 private memories and 0 private sources
    const aliceRemainingMemories = await engine.getMemories(userAlice);
    assert.equal(aliceRemainingMemories.filter(m => !m.isSystem).length, 0);

    const aliceRemainingSources = await engine.getSources(userAlice);
    assert.equal(aliceRemainingSources.filter(s => !s.isSystem).length, 0);

    // Verify Bob's data was NOT touched
    const bobMemories = await engine.getMemories(userBob);
    assert.equal(bobMemories.filter(m => !m.isSystem).length, 1);
    assert.equal(bobMemories.find(m => !m.isSystem)?.value, 'sk_live_bob_secret');

    // Verify System data was NOT purged
    const systemMemories = await engine.getMemories(systemScope);
    assert.ok(systemMemories.some(m => m.value === 'AIRA AI 2026'));
  });
});
