import { Knex } from 'knex';

/**
 * Optional pgvector layer for conversation search.
 *
 * The migration is intentionally capability-aware:
 * - Neon / pgvector-enabled Postgres gets a real vector column
 * - plain PostgreSQL (including the existing broad CI matrix) keeps working
 * - lexical search remains the graceful fallback
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  const availability = await knex.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available"
  );
  const available = Boolean(availability.rows?.[0]?.available);
  if (!available) return;

  try {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {
    // Extension installation may be restricted by the database provider.
    // Do not break the rest of Aira; runtime capability detection will keep
    // semantic retrieval disabled while lexical search remains available.
    return;
  }

  const extension = await knex.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled"
  );
  if (!Boolean(extension.rows?.[0]?.enabled)) return;

  const column = await knex.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'conversation_search_documents'
        AND column_name = 'embedding_vector'
    ) AS present
  `);

  if (!Boolean(column.rows?.[0]?.present)) {
    // Deliberately unbounded vector dimensions: the embedding provider is
    // versioned in-row and retrieval filters on the exact dimension/model.
    // A dimension-specific ANN index can be added once the production
    // embedding model is locked and benchmarked.
    await knex.raw(
      'ALTER TABLE conversation_search_documents ADD COLUMN embedding_vector vector'
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  const column = await knex.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'conversation_search_documents'
        AND column_name = 'embedding_vector'
    ) AS present
  `);

  if (Boolean(column.rows?.[0]?.present)) {
    await knex.raw(
      'ALTER TABLE conversation_search_documents DROP COLUMN embedding_vector'
    );
  }

  // Do not DROP EXTENSION vector: it may be shared by other Aira features.
}
