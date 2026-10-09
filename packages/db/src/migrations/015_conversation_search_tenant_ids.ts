import { Knex } from 'knex';

/**
 * Tenant-safe client identifiers for durable conversation search.
 *
 * Existing rows are preserved by backfilling the current primary key values
 * into client-facing identifier columns. New writes may then use storage IDs
 * that are unique per principal while the UI continues to use its original
 * local conversation/message IDs.
 */
export async function up(knex: Knex): Promise<void> {
  const hasClientId = await knex.schema.hasColumn('conversations', 'client_id');
  if (!hasClientId) {
    await knex.schema.alterTable('conversations', table => {
      table.string('client_id');
    });
  }

  const hasClientMessageId = await knex.schema.hasColumn('conversation_messages', 'client_message_id');
  if (!hasClientMessageId) {
    await knex.schema.alterTable('conversation_messages', table => {
      table.string('client_message_id');
    });
  }

  await knex.raw(`
    UPDATE conversations
    SET client_id = id
    WHERE client_id IS NULL
  `);

  await knex.raw(`
    UPDATE conversation_messages
    SET client_message_id = id
    WHERE client_message_id IS NULL
  `);

  await knex.raw(`
    ALTER TABLE conversations
    ALTER COLUMN client_id SET NOT NULL
  `);

  await knex.raw(`
    ALTER TABLE conversation_messages
    ALTER COLUMN client_message_id SET NOT NULL
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_principal_client
    ON conversations (principal_id, client_id)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_messages_principal_conversation_client
    ON conversation_messages (principal_id, conversation_id, client_message_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS uq_conv_messages_principal_conversation_client');
  await knex.raw('DROP INDEX IF EXISTS uq_conversations_principal_client');

  if (await knex.schema.hasColumn('conversation_messages', 'client_message_id')) {
    await knex.schema.alterTable('conversation_messages', table => {
      table.dropColumn('client_message_id');
    });
  }

  if (await knex.schema.hasColumn('conversations', 'client_id')) {
    await knex.schema.alterTable('conversations', table => {
      table.dropColumn('client_id');
    });
  }
}
