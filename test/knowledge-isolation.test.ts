import assert from 'node:assert/strict';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository, isRecordAccessible } from '../packages/knowledge/src/index.js';
import type { PrincipalScope } from '../packages/contracts/src/index.js';

console.log('--- RUNNING P0 KNOWLEDGE & MEMORY ISOLATION REGRESSION SUITE ---');

async function runIsolationTests() {
  const repo = new InMemoryKnowledgeRepository();
  const engine = new BrainV2KnowledgeEngine(repo);

  const principalA: PrincipalScope = {
    principalId: 'usr_alice_001',
    workspaceId: 'ws_alice_corp',
    isSystem: false
  };

  const principalB: PrincipalScope = {
    principalId: 'usr_bob_002',
    workspaceId: 'ws_bob_ltd',
    isSystem: false
  };

  const systemScope: PrincipalScope = {
    principalId: 'system',
    isSystem: true
  };

  const unauthenticatedScope: PrincipalScope = {
    isSystem: false
  };

  // -------------------------------------------------------------------------
  // 1. Ingest System Seed Knowledge
  // -------------------------------------------------------------------------
  console.log('[1/8] Ingesting system seed knowledge...');
  const systemDoc = await engine.ingestDocument(
    'AIRA Architecture Guide',
    'Aira AI is an autonomous operating workspace uniting intelligence, deterministic run execution, and human oversight.',
    'text/markdown',
    'aira://system/docs/architecture',
    undefined,
    systemScope
  );
  await engine.saveMemory('workspace_identity', 'Aira AI — One workspace. Every intelligence.', 'pattern', 'system', systemScope);

  assert.equal(systemDoc.source.isSystem, true, 'System doc must be marked isSystem=true');
  assert.equal(systemDoc.source.principalId, 'system', 'System doc principal must be system');

  // -------------------------------------------------------------------------
  // 2. Ingest Alice's Private Knowledge and Memory
  // -------------------------------------------------------------------------
  console.log("[2/8] Ingesting Alice's private knowledge & memory...");
  const aliceDoc = await engine.ingestDocument(
    "Alice Q3 Financial Audit",
    "Alice internal confidential revenue projections for Q3 total forty-two million dollars. Classified.",
    'text/markdown',
    'aira://knowledge/sources/alice_confidential',
    'proj_alice',
    principalA
  );
  const aliceMem = await engine.saveMemory(
    'alice_secret_token',
    'SUPER_SECRET_ALICE_KEY_9999',
    'fact',
    'user',
    principalA
  );

  assert.equal(aliceDoc.source.principalId, 'usr_alice_001');
  assert.equal(aliceDoc.source.isSystem, false);
  assert.equal(aliceMem.principalId, 'usr_alice_001');
  assert.equal(aliceMem.isSystem, false);

  // -------------------------------------------------------------------------
  // 3. Ingest Bob's Private Knowledge and Memory
  // -------------------------------------------------------------------------
  console.log("[3/8] Ingesting Bob's private knowledge & memory...");
  const bobDoc = await engine.ingestDocument(
    "Bob Patent Application",
    "Bob secret quantum encryption algorithm blueprint. Never share with external parties.",
    'text/markdown',
    'aira://knowledge/sources/bob_secret',
    'proj_bob',
    principalB
  );
  const bobMem = await engine.saveMemory(
    'bob_secret_key',
    'BOB_PRIVATE_VAULT_7777',
    'fact',
    'user',
    principalB
  );

  assert.equal(bobDoc.source.principalId, 'usr_bob_002');
  assert.equal(bobDoc.source.isSystem, false);
  assert.equal(bobMem.principalId, 'usr_bob_002');
  assert.equal(bobMem.isSystem, false);

  // -------------------------------------------------------------------------
  // 4. Same-Owner Access (Alice accessing Alice's data + system data)
  // -------------------------------------------------------------------------
  console.log("[4/8] Testing same-owner authorized access for Alice...");
  const aliceSources = await engine.getSources(principalA);
  const aliceSourceIds = aliceSources.map(s => s.id);
  assert.ok(aliceSourceIds.includes(aliceDoc.source.id), "Alice must see her own document");
  assert.ok(aliceSourceIds.includes(systemDoc.source.id), "Alice must see system documents");
  assert.ok(!aliceSourceIds.includes(bobDoc.source.id), "Alice MUST NOT see Bob's document in source listing");

  const aliceMemories = await engine.getMemories(principalA);
  const aliceMemoryKeys = aliceMemories.map(m => m.key);
  assert.ok(aliceMemoryKeys.includes('alice_secret_token'), "Alice must see her own memory");
  assert.ok(aliceMemoryKeys.includes('workspace_identity'), "Alice must see system memory");
  assert.ok(!aliceMemoryKeys.includes('bob_secret_key'), "Alice MUST NOT see Bob's memory");

  // Alice searching Alice's data
  const aliceSearchOwn = await engine.search('confidential revenue projections', 5, principalA);
  assert.ok(aliceSearchOwn.length > 0, "Alice must find her own chunks");
  assert.equal(aliceSearchOwn[0].chunk.sourceId, aliceDoc.source.id);

  // -------------------------------------------------------------------------
  // 5. Cross-Principal Isolation Denial (CRITICAL SECURITY)
  // -------------------------------------------------------------------------
  console.log("[5/8] Testing cross-principal denial (Alice cannot access Bob's data)...");

  // Direct fetch by ID (forged or guessed ID)
  const directGetBobSource = await engine.getSource(bobDoc.source.id, principalA);
  assert.equal(directGetBobSource, undefined, "Alice attempting getSource on Bob's ID MUST return undefined");

  // Direct search for Bob's secret content
  const aliceSearchBob = await engine.search('quantum encryption algorithm', 5, principalA);
  assert.equal(aliceSearchBob.length, 0, "Alice search query matching Bob's content MUST return 0 results");

  // Bob searching for Alice's secret content
  const bobSearchAlice = await engine.search('confidential revenue projections', 5, principalB);
  assert.equal(bobSearchAlice.length, 0, "Bob search query matching Alice's content MUST return 0 results");

  // Bob viewing source listing
  const bobSources = await engine.getSources(principalB);
  const bobSourceIds = bobSources.map(s => s.id);
  assert.ok(bobSourceIds.includes(bobDoc.source.id), "Bob must see his own document");
  assert.ok(bobSourceIds.includes(systemDoc.source.id), "Bob must see system documents");
  assert.ok(!bobSourceIds.includes(aliceDoc.source.id), "Bob MUST NOT see Alice's document in source listing");

  // Bob viewing memories
  const bobMemories = await engine.getMemories(principalB);
  const bobMemoryKeys = bobMemories.map(m => m.key);
  assert.ok(bobMemoryKeys.includes('bob_secret_key'), "Bob must see his own memory");
  assert.ok(!bobMemoryKeys.includes('alice_secret_token'), "Bob MUST NOT see Alice's memory");

  // -------------------------------------------------------------------------
  // 6. Knowledge Graph Isolation
  // -------------------------------------------------------------------------
  console.log("[6/8] Testing knowledge graph cross-principal isolation...");
  const aliceGraph = await engine.getKnowledgeGraph(principalA);
  const bobGraph = await engine.getKnowledgeGraph(principalB);

  // Verify Alice's graph does not leak Bob's entities or edges
  for (const ent of aliceGraph.entities) {
    if (!ent.isSystem) {
      assert.equal(ent.principalId, 'usr_alice_001', "All non-system entities in Alice's graph must belong to Alice");
    }
  }
  for (const edge of aliceGraph.edges) {
    if (!edge.isSystem) {
      assert.equal(edge.principalId, 'usr_alice_001', "All non-system edges in Alice's graph must belong to Alice");
    }
  }

  for (const ent of bobGraph.entities) {
    if (!ent.isSystem) {
      assert.equal(ent.principalId, 'usr_bob_002', "All non-system entities in Bob's graph must belong to Bob");
    }
  }

  // -------------------------------------------------------------------------
  // 7. Unauthenticated / Public Fail-Closed Behavior
  // -------------------------------------------------------------------------
  console.log("[7/8] Testing unauthenticated fail-closed access...");
  const publicSources = await engine.getSources(unauthenticatedScope);
  const publicSourceIds = publicSources.map(s => s.id);
  assert.ok(publicSourceIds.includes(systemDoc.source.id), "Public request can see system docs");
  assert.ok(!publicSourceIds.includes(aliceDoc.source.id), "Public request MUST NOT see Alice's docs");
  assert.ok(!publicSourceIds.includes(bobDoc.source.id), "Public request MUST NOT see Bob's docs");

  const publicSearch = await engine.search('confidential revenue projections', 5, unauthenticatedScope);
  assert.equal(publicSearch.length, 0, "Public search MUST NOT return private chunks");

  const publicMemories = await engine.getMemories(unauthenticatedScope);
  const publicMemKeys = publicMemories.map(m => m.key);
  assert.ok(publicMemKeys.includes('workspace_identity'), "Public request can see system pattern");
  assert.ok(!publicMemKeys.includes('alice_secret_token'), "Public request MUST NOT see Alice's memory");
  assert.ok(!publicMemKeys.includes('bob_secret_key'), "Public request MUST NOT see Bob's memory");

  // -------------------------------------------------------------------------
  // 8. Deletion & Tamper Resistance
  // -------------------------------------------------------------------------
  console.log("[8/8] Testing unauthorized deletion rejection...");
  // Alice tries to delete Bob's document
  const aliceDeleteBob = await engine.deleteSource(bobDoc.source.id, principalA);
  assert.equal(aliceDeleteBob, false, "Alice MUST NOT be able to delete Bob's document");

  // Verify Bob's document still exists
  const bobDocStillExists = await engine.getSource(bobDoc.source.id, principalB);
  assert.ok(bobDocStillExists !== undefined, "Bob's document must still exist after unauthorized delete attempt");

  // Alice tries to delete system document
  const aliceDeleteSystem = await engine.deleteSource(systemDoc.source.id, principalA);
  assert.equal(aliceDeleteSystem, false, "Standard principal MUST NOT be able to delete system knowledge");

  // Alice deletes Alice's document
  const aliceDeleteOwn = await engine.deleteSource(aliceDoc.source.id, principalA);
  assert.equal(aliceDeleteOwn, true, "Alice MUST be able to delete her own document");

  // Verify Alice's document is gone
  const aliceDocAfterDelete = await engine.getSource(aliceDoc.source.id, principalA);
  assert.equal(aliceDocAfterDelete, undefined, "Deleted document must return undefined");

  console.log('\n===========================================================');
  console.log(' P0 KNOWLEDGE & MEMORY ISOLATION CERTIFICATION: 100% PASS');
  console.log(' - Same-owner access: VERIFIED');
  console.log(' - Cross-principal access denial: VERIFIED');
  console.log(' - Forged ID rejection: VERIFIED');
  console.log(' - Knowledge graph isolation: VERIFIED');
  console.log(' - Unauthenticated fail-closed: VERIFIED');
  console.log(' - Unauthorized deletion denial: VERIFIED');
  console.log('===========================================================\n');
}

runIsolationTests().catch((err) => {
  console.error('FATAL ISOLATION TEST FAILURE:', err);
  process.exit(1);
});
