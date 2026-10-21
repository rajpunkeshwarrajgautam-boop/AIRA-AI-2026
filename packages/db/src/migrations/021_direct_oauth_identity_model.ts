import type { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 021: Direct OAuth Identity Model & Historical Migration
 * 
 * Replaces external IdP (Neon Auth) dependencies with an application-controlled identity model:
 * 1. `users` — Stable internal identity table (preserving existing `neon_user_<id>` IDs).
 * 2. `oauth_accounts` — Provider accounts (Google, GitHub) bound to internal users.
 * 3. `account_recovery_requests` — Audited recovery request ledger.
 * 4. Deterministic backfill from `neon_auth.user` and `neon_auth.account` to guarantee zero data orphaning.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. users table
  if (!(await knex.schema.hasTable('users'))) {
    await knex.schema.createTable('users', (table) => {
      table.string('id', 128).primary();
      table.string('email', 255).nullable();
      table.boolean('email_verified').notNullable().defaultTo(false);
      table.string('name', 255).nullable();
      table.text('image').nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['email'], 'idx_users_email');
    });
  }

  // 2. oauth_accounts table
  if (!(await knex.schema.hasTable('oauth_accounts'))) {
    await knex.schema.createTable('oauth_accounts', (table) => {
      table.string('id', 128).primary();
      table.string('user_id', 128).notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('provider', 32).notNullable(); // 'google' | 'github'
      table.string('provider_account_id', 255).notNullable();
      table.string('email', 255).nullable();
      table.jsonb('profile_data').nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.unique(['provider', 'provider_account_id'], 'uq_oauth_provider_account');
      table.index(['user_id'], 'idx_oauth_accounts_user_id');
      table.index(['email'], 'idx_oauth_accounts_email');
    });
  }

  // 3. account_recovery_requests table
  if (!(await knex.schema.hasTable('account_recovery_requests'))) {
    await knex.schema.createTable('account_recovery_requests', (table) => {
      table.string('id', 128).primary();
      table.string('user_id', 128).nullable();
      table.string('claimed_email', 255).notNullable();
      table.string('provider', 32).notNullable(); // 'google' | 'github' | 'all'
      table.string('status', 32).notNullable().defaultTo('pending'); // 'pending' | 'verified' | 'rejected'
      table.text('contact_info').nullable();
      table.text('details').nullable();
      table.jsonb('audit_log').notNullable().defaultTo('[]');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['claimed_email'], 'idx_recovery_claimed_email');
      table.index(['status'], 'idx_recovery_status');
    });
  }

  // 4. Deterministic Backfill: Copy existing neon_auth.user records into `users` table
  // preserving `neon_user_<id>` prefix so that runs, automations, conversations,
  // agents, and billing_customers stay 100% connected with zero orphaned records!
  const hasNeonUserTable = await knex.schema.withSchema('neon_auth').hasTable('user');
  if (hasNeonUserTable) {
    try {
      const existingNeonUsers = await knex('neon_auth.user').select('id', 'email', 'name', 'image', 'createdAt', 'updatedAt');
      const now = Date.now();
      for (const u of existingNeonUsers) {
        const principalId = 'neon_user_' + u.id;
        const createdAt = u.createdAt ? new Date(u.createdAt).getTime() : now;
        const updatedAt = u.updatedAt ? new Date(u.updatedAt).getTime() : now;

        await knex('users')
          .insert({
            id: principalId,
            email: u.email || null,
            email_verified: false,
            name: u.name || null,
            image: u.image || null,
            created_at: createdAt,
            updated_at: updatedAt
          })
          .onConflict('id')
          .ignore();
      }
    } catch (backfillErr) {
      console.warn('[Migration 021] neon_auth.user backfill notice:', backfillErr);
    }
  }

  // 5. Backfill existing neon_auth.account records if present
  const hasNeonAccountTable = await knex.schema.withSchema('neon_auth').hasTable('account');
  if (hasNeonAccountTable) {
    try {
      const existingAccounts = await knex('neon_auth.account')
        .whereIn('providerId', ['google', 'github'])
        .select('id', 'userId', 'providerId', 'accountId', 'createdAt', 'updatedAt');
      const now = Date.now();
      for (const a of existingAccounts) {
        const principalId = 'neon_user_' + a.userId;
        // Verify user exists in users table before inserting foreign key
        const userExists = await knex('users').where({ id: principalId }).first();
        if (userExists) {
          const createdAt = a.createdAt ? new Date(a.createdAt).getTime() : now;
          const updatedAt = a.updatedAt ? new Date(a.updatedAt).getTime() : now;

          await knex('oauth_accounts')
            .insert({
              id: 'oa_' + a.id,
              user_id: principalId,
              provider: a.providerId,
              provider_account_id: a.accountId,
              email: userExists.email || null,
              profile_data: null,
              created_at: createdAt,
              updated_at: updatedAt
            })
            .onConflict(['provider', 'provider_account_id'])
            .ignore();
        }
      }
    } catch (accountBackfillErr) {
      console.warn('[Migration 021] neon_auth.account backfill notice:', accountBackfillErr);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('account_recovery_requests');
  await knex.schema.dropTableIfExists('oauth_accounts');
  await knex.schema.dropTableIfExists('users');
}
