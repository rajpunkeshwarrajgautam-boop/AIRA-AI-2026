import type { Knex } from 'knex';

/**
 * Migration 017: quarantine legacy graph items incorrectly marked system-wide.
 *
 * Migration 016 correctly quarantined unknown legacy knowledge sources, but
 * mistakenly published previously unowned graph entities/edges as system data.
 * Some of those graph items have provenance pointing to private sources.
 *
 * Do not delete any records or infer a customer owner. Preserve the original
 * graph and mark derived records as private/unassigned pending administrator
 * review or a later explicit ownership migration.
 */
export async function up(knex: Knex): Promise<void> {
  const required = ['knowledge_sources', 'knowledge_entities', 'knowledge_edges'];
  for (const table of required) {
    if (!(await knex.schema.hasTable(table))) {
      throw new Error('MIGRATION_017_KNOWLEDGE_TABLE_MISSING: ' + table);
    }
  }

  // A concept may aggregate several documents. If ANY contributing source
  // is private, sharing the aggregated concept can leak private provenance.
  await knex.raw(`
    UPDATE knowledge_entities AS entity
    SET principal_id = 'legacy_unassigned',
        workspace_id = NULL,
        is_system = FALSE
    WHERE entity.is_system = TRUE
      AND EXISTS (
        SELECT 1 FROM knowledge_sources AS source
        WHERE source.is_system = FALSE
          AND (
            entity.name = CONCAT('src_', source.id)
            OR POSITION(source.id IN COALESCE(entity.description, '')) > 0
          )
      )
  `);

  // Edge visibility must be no broader than the originating document or
  // either endpoint. An edge pointing to quarantined data is private too.
  await knex.raw(`
    UPDATE knowledge_edges AS edge
    SET principal_id = 'legacy_unassigned',
        is_system = FALSE
    WHERE edge.is_system = TRUE AND (
      EXISTS (
        SELECT 1 FROM knowledge_sources AS source
        WHERE source.is_system = FALSE
          AND edge.provenance->>'provenanceSourceId' = source.id
      )
      OR EXISTS (
        SELECT 1 FROM knowledge_entities AS entity
        WHERE (entity.id = edge.source_entity_id OR entity.id = edge.target_entity_id)
          AND entity.is_system = FALSE
      )
    )
  `);
}

/** Security rollback is deliberately non-republishing.
 * Restoring broad access would expose private graph provenance.
 * A reviewed corrective migration is required to reclassify any records.
 */
export async function down(_knex: Knex): Promise<void> {
  // Intentional no-op: never re-publish quarantined records on rollback.
}
