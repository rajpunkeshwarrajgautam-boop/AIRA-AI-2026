import { Knex } from 'knex';

/**
 * Conversation search foundation.
 *
 * This migration is intentionally additive:
 * - existing localStorage chat persistence keeps working
 * - existing runs/history tables are untouched
 * - server-side conversations/messages are introduced for durable search
 * - lexical full-text search is available without pgvector so CI/dev remain portable
 *
 * Semantic/vector retrieval is layered on top in a later migration once the
 * embedding runtime and pgvector availability are certified end-to-end.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('conversations'))) {
    await knex.schema.createTable('conversations', (table) => {
      table.string('id').primary();
      table.string('principal_id').notNullable();
      table.string('project_id');
      table.text('title').notNullable();
      table.boolean('is_pinned').notNullable().defaultTo(false);
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('deleted_at');
      table.jsonb('metadata').notNullable().defaultTo('{}');

      table.index(['principal_id', 'updated_at'], 'idx_conversations_principal_updated');
      table.index(['principal_id', 'project_id', 'updated_at'], 'idx_conversations_principal_project_updated');
    });
  }

  if (!(await knex.schema.hasTable('conversation_messages'))) {
    await knex.schema.createTable('conversation_messages', (table) => {
      table.string('id').primary();
      table.string('conversation_id').notNullable()
        .references('id').inTable('conversations').onDelete('CASCADE');
      table.string('principal_id').notNullable();
      table.string('run_id');
      table.string('role').notNullable();
      table.text('content').notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.jsonb('metadata').notNullable().defaultTo('{}');

      table.index(['principal_id', 'conversation_id', 'created_at'], 'idx_conv_messages_principal_conversation_created');
      table.index(['principal_id', 'created_at'], 'idx_conv_messages_principal_created');
      table.index(['run_id'], 'idx_conv_messages_run_id');
    });
  }

  if (!(await knex.schema.hasTable('conversation_search_documents'))) {
    await knex.schema.createTable('conversation_search_documents', (table) => {
      table.string('id').primary();
      table.string('conversation_id').notNullable()
        .references('id').inTable('conversations').onDelete('CASCADE');
      table.string('message_id').notNullable()
        .references('id').inTable('conversation_messages').onDelete('CASCADE');
      table.string('principal_id').notNullable();
      table.string('project_id');
      table.string('role').notNullable();
      table.text('content').notNullable();
      table.text('normalized_content').notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.string('embedding_model');
      table.string('embedding_version');
      table.integer('embedding_dimensions');
      table.string('embedding_status').notNullable().defaultTo('NOT_INDEXED');
      table.bigInteger('embedding_indexed_at');
      table.jsonb('metadata').notNullable().defaultTo('{}');

      table.unique(['message_id'], { indexName: 'uq_conversation_search_message' });
      table.index(['principal_id', 'updated_at'], 'idx_conv_search_principal_updated');
      table.index(['principal_id', 'project_id', 'updated_at'], 'idx_conv_search_principal_project_updated');
      table.index(['conversation_id'], 'idx_conv_search_conversation');
    });

    // Portable PostgreSQL FTS expression index. This deliberately does not
    // require pgvector or pg_trgm, keeping the first search slice safe in the
    // stock postgres:18 CI service.
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_conv_search_fts
      ON conversation_search_documents
      USING GIN (to_tsvector('simple', coalesce(content, '')))
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_search_documents');
  await knex.schema.dropTableIfExists('conversation_messages');
  await knex.schema.dropTableIfExists('conversations');
}
