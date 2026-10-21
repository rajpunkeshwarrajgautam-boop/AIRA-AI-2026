import type { Knex } from 'knex';

/**
 * Migration 022: Reconcile legacy session principals and migrate
 * neon_auth.account records to oauth_accounts if present.
 *
 * This migration is environment-agnostic and schema-safe:
 * 1. Reconciles existing conversation principals into the first-party users
 *    table (with email: null) to ensure referential integrity and avoid orphaned records.
 * 2. If the legacy neon_auth.account table exists in the current database, it
 *    migrates account mappings to the first-party oauth_accounts table.
 * 3. Contains ZERO hardcoded personal identities, email addresses, or synthetic wallets.
 *    Any historical data imports are executed via controlled, authorized import procedures.
 */
export async function up(knex: Knex): Promise<void> {
  const hasOAuthAccounts = await knex.schema.hasTable('oauth_accounts');
  const hasUsers = await knex.schema.hasTable('users');

  if (!hasOAuthAccounts || !hasUsers) {
    console.warn('[Migration 022] Prerequisites not met, skipping legacy social migration.');
    return;
  }

  const now = Date.now();

  // 1. Reconcile existing conversation principals (prevents foreign-key orphaning)
  const hasConversations = await knex.schema.hasTable('conversations');
  if (hasConversations) {
    const existingPrincipals = await knex('conversations')
      .distinct('principal_id')
      .whereNotNull('principal_id');

    for (const p of existingPrincipals) {
      const pid = p.principal_id;
      await knex('users')
        .insert({
          id: pid,
          email: null,
          email_verified: false,
          name: 'Legacy Session Principal',
          created_at: now,
          updated_at: now
        })
        .onConflict('id')
        .ignore();
    }
  }

  // 2. Check for dynamic neon_auth.account table (present when migrating from neon_auth)
  const hasNeonAuthAccount = await knex.schema.withSchema('neon_auth').hasTable('account');

  if (hasNeonAuthAccount) {
    const legacyAccounts = await knex('neon_auth.account')
      .whereIn('providerId', ['google', 'github'])
      .select('id', 'userId', 'providerId', 'accountId', 'createdAt', 'updatedAt');

    for (const acc of legacyAccounts) {
      const principalId = 'neon_user_' + acc.userId;
      const userExists = await knex('users').where({ id: principalId }).first();

      if (userExists) {
        const createdAt = acc.createdAt ? new Date(acc.createdAt).getTime() : now;
        const updatedAt = acc.updatedAt ? new Date(acc.updatedAt).getTime() : now;

        await knex('oauth_accounts')
          .insert({
            id: 'oa_legacy_' + acc.id,
            user_id: principalId,
            provider: acc.providerId,
            provider_account_id: acc.accountId,
            email: userExists.email || null,
            profile_data: JSON.stringify({
              migratedFrom: 'neon_auth.account',
              migratedAt: now,
              legacyUserId: acc.userId
            }),
            created_at: createdAt,
            updated_at: updatedAt
          })
          .onConflict(['provider', 'provider_account_id'])
          .ignore();
      }
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasOAuthAccounts = await knex.schema.hasTable('oauth_accounts');
  if (hasOAuthAccounts) {
    await knex('oauth_accounts')
      .where('id', 'like', 'oa_legacy_%')
      .delete();
  }
}
