import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, closeDb } from '../packages/db/src/index.js';
import { up as quarantineLegacyGraph } from '../packages/db/src/migrations/017_quarantine_legacy_graph_provenance.js';

const id = randomUUID().slice(0, 8);
const legacySource = 'src_legacy_' + id;
const publicSource = 'src_public_' + id;
const oldSourceNode = 'ent_old_source_' + id;
const oldConcept = 'ent_old_concept_' + id;
const approvedSystemNode = 'ent_approved_system_' + id;
const oldEdge = 'edge_legacy_' + id;
const approvedEdge = 'edge_approved_' + id;

async function run(): Promise<void> {
  // Use a transaction deliberately rolled back after the test: no persistent
  // fixture rows are added to staging, CI or production databases.
  let rolledBack = false;
  const rollbackMarker = 'TEST_FIXTURE_TRANSACTION_ROLLBACK';
  try {
    await db.transaction(async trx => {
      const now = Date.now();
      await trx('knowledge_sources').insert([
        { id: legacySource, type: 'text/plain', uri: 'aira://knowledge/sources/' + legacySource,
          hash: 'test-private-' + id, metadata: '{}', created_at: now,
          principal_id: 'legacy_unassigned', is_system: false, visibility: 'private' },
        { id: publicSource, type: 'text/plain', uri: 'aira://system/' + publicSource,
          hash: 'test-system-' + id, metadata: '{}', created_at: now,
          principal_id: 'system', is_system: true, visibility: 'system' }
      ]);
      await trx('knowledge_entities').insert([
        { id: oldSourceNode, name: 'src_' + legacySource, type: 'source',
          description: JSON.stringify({ sourceIds: [legacySource] }),
          principal_id: 'system', is_system: true },
        { id: oldConcept, name: 'AIConcept', type: 'concept',
          description: JSON.stringify({ sourceIds: [legacySource, publicSource] }),
          principal_id: 'system', is_system: true },
        { id: approvedSystemNode, name: 'ApprovedSystemConcept', type: 'concept',
          description: JSON.stringify({ sourceIds: [publicSource] }),
          principal_id: 'system', is_system: true }
      ]);
      await trx('knowledge_edges').insert([
        { id: oldEdge, source_entity_id: oldSourceNode, target_entity_id: oldConcept,
          relation: 'REFERENCES',
          provenance: JSON.stringify({ provenanceSourceId: legacySource }),
          principal_id: 'system', is_system: true },
        { id: approvedEdge, source_entity_id: approvedSystemNode, target_entity_id: approvedSystemNode,
          relation: 'REFERENCES',
          provenance: JSON.stringify({ provenanceSourceId: publicSource }),
          principal_id: 'system', is_system: true }
      ]);

      await quarantineLegacyGraph(trx as unknown as import('knex').Knex);
      await quarantineLegacyGraph(trx as unknown as import('knex').Knex); // Idempotent

      const entities = await trx('knowledge_entities').whereIn('id', [
        oldSourceNode, oldConcept, approvedSystemNode
      ]).orderBy('id');
      const findEnt = (name: string) => entities.find(e => e.id === name);
      for (const name of [oldSourceNode, oldConcept]) {
        assert.equal(findEnt(name)?.principal_id, 'legacy_unassigned');
        assert.equal(findEnt(name)?.is_system, false);
      }
      assert.equal(findEnt(approvedSystemNode)?.is_system, true);
      assert.equal(findEnt(approvedSystemNode)?.principal_id, 'system');

      const edges = await trx('knowledge_edges').whereIn('id', [oldEdge, approvedEdge]);
      const findEdge = (name: string) => edges.find(e => e.id === name);
      assert.equal(findEdge(oldEdge)?.principal_id, 'legacy_unassigned');
      assert.equal(findEdge(oldEdge)?.is_system, false);
      assert.equal(findEdge(approvedEdge)?.principal_id, 'system');
      assert.equal(findEdge(approvedEdge)?.is_system, true);

      // The same principal-scoping query used for standard record visibility
      // must not expose either quarantined legacy entity or edge.
      const visibleEntityIds = (await trx('knowledge_entities')
        .where(q => q.where('principal_id', 'user_test_alice').orWhere('is_system', true))
        .whereIn('id', [oldSourceNode, oldConcept, approvedSystemNode]))
        .map(row => row.id);
      assert.deepEqual(visibleEntityIds, [approvedSystemNode]);

      const visibleEdgeIds = (await trx('knowledge_edges')
        .where(q => q.where('principal_id', 'user_test_alice').orWhere('is_system', true))
        .whereIn('id', [oldEdge, approvedEdge]))
        .map(row => row.id);
      assert.deepEqual(visibleEdgeIds, [approvedEdge]);

      throw new Error(rollbackMarker);
    });
  } catch (error) {
    if (error instanceof Error && error.message === rollbackMarker) {
      rolledBack = true;
    } else {
      throw error;
    }
  }
  assert.ok(rolledBack, 'test fixtures must be rolled back');
  const leaked = await db('knowledge_entities').whereIn('id', [oldConcept, approvedSystemNode]);
  assert.equal(leaked.length, 0, 'test transaction must not persist fixtures');
  console.log('Legacy graph quarantine migration: PASS (private provenance quarantined; genuine system data retained)');
}

run().catch(error => {
  console.error('Legacy graph quarantine: FAILED', error);
  process.exitCode = 1;
}).finally(async () => {
  await closeDb();
});
