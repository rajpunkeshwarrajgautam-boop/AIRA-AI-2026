import { Knex } from 'knex';

/**
 * P0 Security Remediation: Principal-scoped Knowledge and Memory Isolation.
 *
 * Adds server-authoritative ownership and access control boundaries:
 * - knowledge_sources: principal_id, workspace_id, is_system, visibility
 * - knowledge_chunks: principal_id, is_system
 * - knowledge_entities: principal_id, workspace_id, is_system
 * - knowledge_edges: principal_id, is_system
 * - memory_records: principal_id, workspace_id, is_system
 *
 * Ensures system seed knowledge is explicitly marked is_system = true,
 * while all customer/user knowledge is private and isolated to the authenticated principal.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. knowledge_sources
  if (await knex.schema.hasTable('knowledge_sources')) {
    const hasPrincipal = await knex.schema.hasColumn('knowledge_sources', 'principal_id');
    if (!hasPrincipal) {
      await knex.schema.alterTable('knowledge_sources', (table) => {
        table.string('principal_id');
        table.string('workspace_id');
        table.boolean('is_system').notNullable().defaultTo(false);
        table.string('visibility').notNullable().defaultTo('private');

        table.index(['principal_id', 'created_at'], 'idx_knowledge_sources_principal_created');
        table.index(['is_system'], 'idx_knowledge_sources_system');
        table.index(['workspace_id'], 'idx_knowledge_sources_workspace');
      });

      // Mark system seed documents
      await knex.raw(`
        UPDATE knowledge_sources
        SET is_system = true, visibility = 'system', principal_id = 'system'
        WHERE uri LIKE 'aira://system/%' OR uri = 'aira://system/docs/architecture'
      `);

      // Legacy unassigned rows remain private to prevent leakage
      await knex.raw(`
        UPDATE knowledge_sources
        SET principal_id = 'legacy_unassigned', visibility = 'private', is_system = false
        WHERE principal_id IS NULL AND is_system = false
      `);
    }
  }

  // 2. knowledge_chunks
  if (await knex.schema.hasTable('knowledge_chunks')) {
    const hasPrincipal = await knex.schema.hasColumn('knowledge_chunks', 'principal_id');
    if (!hasPrincipal) {
      await knex.schema.alterTable('knowledge_chunks', (table) => {
        table.string('principal_id');
        table.boolean('is_system').notNullable().defaultTo(false);

        table.index(['principal_id'], 'idx_knowledge_chunks_principal');
        table.index(['is_system'], 'idx_knowledge_chunks_system');
      });

      // Backfill from knowledge_sources
      await knex.raw(`
        UPDATE knowledge_chunks kc
        SET principal_id = ks.principal_id, is_system = ks.is_system
        FROM knowledge_sources ks
        WHERE kc.source_id = ks.id
      `);
    }
  }

  // 3. knowledge_entities
  if (await knex.schema.hasTable('knowledge_entities')) {
    const hasPrincipal = await knex.schema.hasColumn('knowledge_entities', 'principal_id');
    if (!hasPrincipal) {
      await knex.schema.alterTable('knowledge_entities', (table) => {
        table.string('principal_id');
        table.string('workspace_id');
        table.boolean('is_system').notNullable().defaultTo(false);

        table.index(['principal_id'], 'idx_knowledge_entities_principal');
        table.index(['is_system'], 'idx_knowledge_entities_system');
      });

      // Mark existing seed entities as system
      await knex.raw(`
        UPDATE knowledge_entities
        SET is_system = true, principal_id = 'system'
        WHERE principal_id IS NULL
      `);
    }
  }

  // 4. knowledge_edges
  if (await knex.schema.hasTable('knowledge_edges')) {
    const hasPrincipal = await knex.schema.hasColumn('knowledge_edges', 'principal_id');
    if (!hasPrincipal) {
      await knex.schema.alterTable('knowledge_edges', (table) => {
        table.string('principal_id');
        table.boolean('is_system').notNullable().defaultTo(false);

        table.index(['principal_id'], 'idx_knowledge_edges_principal');
        table.index(['is_system'], 'idx_knowledge_edges_system');
      });

      // Mark existing seed edges as system
      await knex.raw(`
        UPDATE knowledge_edges
        SET is_system = true, principal_id = 'system'
        WHERE principal_id IS NULL
      `);
    }
  }

  // 5. memory_records
  if (await knex.schema.hasTable('memory_records')) {
    const hasPrincipal = await knex.schema.hasColumn('memory_records', 'principal_id');
    if (!hasPrincipal) {
      await knex.schema.alterTable('memory_records', (table) => {
        table.string('principal_id');
        table.string('workspace_id');
        table.boolean('is_system').notNullable().defaultTo(false);

        table.index(['principal_id', 'created_at'], 'idx_memory_records_principal_created');
        table.index(['is_system'], 'idx_memory_records_system');
      });

      // Seed records (workspace_identity, execution_boundary) are system records
      await knex.raw(`
        UPDATE memory_records
        SET is_system = true, principal_id = 'system'
        WHERE agent_id IN ('workspace_identity', 'execution_boundary')
      `);

      // Any other legacy rows
      await knex.raw(`
        UPDATE memory_records
        SET principal_id = 'legacy_unassigned', is_system = false
        WHERE principal_id IS NULL AND is_system = false
      `);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('memory_records')) {
    if (await knex.schema.hasColumn('memory_records', 'principal_id')) {
      await knex.schema.alterTable('memory_records', (table) => {
        table.dropIndex(['principal_id', 'created_at'], 'idx_memory_records_principal_created');
        table.dropIndex(['is_system'], 'idx_memory_records_system');
        table.dropColumns('principal_id', 'workspace_id', 'is_system');
      });
    }
  }

  if (await knex.schema.hasTable('knowledge_edges')) {
    if (await knex.schema.hasColumn('knowledge_edges', 'principal_id')) {
      await knex.schema.alterTable('knowledge_edges', (table) => {
        table.dropIndex(['principal_id'], 'idx_knowledge_edges_principal');
        table.dropIndex(['is_system'], 'idx_knowledge_edges_system');
        table.dropColumns('principal_id', 'is_system');
      });
    }
  }

  if (await knex.schema.hasTable('knowledge_entities')) {
    if (await knex.schema.hasColumn('knowledge_entities', 'principal_id')) {
      await knex.schema.alterTable('knowledge_entities', (table) => {
        table.dropIndex(['principal_id'], 'idx_knowledge_entities_principal');
        table.dropIndex(['is_system'], 'idx_knowledge_entities_system');
        table.dropColumns('principal_id', 'workspace_id', 'is_system');
      });
    }
  }

  if (await knex.schema.hasTable('knowledge_chunks')) {
    if (await knex.schema.hasColumn('knowledge_chunks', 'principal_id')) {
      await knex.schema.alterTable('knowledge_chunks', (table) => {
        table.dropIndex(['principal_id'], 'idx_knowledge_chunks_principal');
        table.dropIndex(['is_system'], 'idx_knowledge_chunks_system');
        table.dropColumns('principal_id', 'is_system');
      });
    }
  }

  if (await knex.schema.hasTable('knowledge_sources')) {
    if (await knex.schema.hasColumn('knowledge_sources', 'principal_id')) {
      await knex.schema.alterTable('knowledge_sources', (table) => {
        table.dropIndex(['principal_id', 'created_at'], 'idx_knowledge_sources_principal_created');
        table.dropIndex(['is_system'], 'idx_knowledge_sources_system');
        table.dropIndex(['workspace_id'], 'idx_knowledge_sources_workspace');
        table.dropColumns('principal_id', 'workspace_id', 'is_system', 'visibility');
      });
    }
  }
}
