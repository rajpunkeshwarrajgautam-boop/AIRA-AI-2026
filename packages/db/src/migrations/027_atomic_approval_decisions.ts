import { Knex } from 'knex';

/**
 * Stages 1.2B/1.2C: persist approval risk ceilings, exact tool/argument policy
 * bindings, and a durable consumable ALLOW_ONCE lifecycle. Existing grants get a
 * READ ceiling so they cannot authorize mutative or financial actions.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('approvals', 'permission_level'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.string('permission_level', 32).notNullable().defaultTo('READ');
    });
  }

  if (!(await knex.schema.hasColumn('approvals', 'risk'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.string('risk', 32).notNullable().defaultTo('medium');
    });
  }

  if (!(await knex.schema.hasColumn('approvals', 'tool_definition_version'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.integer('tool_definition_version');
    });
  }

  if (!(await knex.schema.hasColumn('approvals', 'tool_policy_fingerprint'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.string('tool_policy_fingerprint', 64);
    });
  }

  if (!(await knex.schema.hasColumn('approvals', 'argument_fingerprint'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.string('argument_fingerprint', 64);
    });
  }

  if (!(await knex.schema.hasColumn('approvals', 'once_state'))) {
    await knex.schema.alterTable('approvals', (table) => {
      table.string('once_state', 16).notNullable().defaultTo('NONE');
      table.string('once_claim_id', 255);
      table.bigInteger('once_claimed_at');
      table.bigInteger('once_claim_expires_at');
      table.bigInteger('once_dispatched_at');
      table.bigInteger('once_completed_at');
    });
  }

  if (!(await knex.schema.hasColumn('session_grants', 'risk_ceiling'))) {
    await knex.schema.alterTable('session_grants', (table) => {
      table.string('risk_ceiling', 32).notNullable().defaultTo('READ');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('session_grants', 'risk_ceiling')) {
    await knex.schema.alterTable('session_grants', (table) => table.dropColumn('risk_ceiling'));
  }
  if (await knex.schema.hasColumn('approvals', 'once_state')) {
    await knex.schema.alterTable('approvals', (table) => {
      table.dropColumn('once_state');
      table.dropColumn('once_claim_id');
      table.dropColumn('once_claimed_at');
      table.dropColumn('once_claim_expires_at');
      table.dropColumn('once_dispatched_at');
      table.dropColumn('once_completed_at');
    });
  }
  if (await knex.schema.hasColumn('approvals', 'argument_fingerprint')) {
    await knex.schema.alterTable('approvals', (table) => table.dropColumn('argument_fingerprint'));
  }
  if (await knex.schema.hasColumn('approvals', 'tool_policy_fingerprint')) {
    await knex.schema.alterTable('approvals', (table) => table.dropColumn('tool_policy_fingerprint'));
  }
  if (await knex.schema.hasColumn('approvals', 'tool_definition_version')) {
    await knex.schema.alterTable('approvals', (table) => table.dropColumn('tool_definition_version'));
  }
  if (await knex.schema.hasColumn('approvals', 'risk')) {
    await knex.schema.alterTable('approvals', (table) => table.dropColumn('risk'));
  }
  if (await knex.schema.hasColumn('approvals', 'permission_level')) {
    await knex.schema.alterTable('approvals', (table) => table.dropColumn('permission_level'));
  }
}
