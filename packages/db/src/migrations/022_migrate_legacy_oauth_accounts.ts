import type { Knex } from 'knex';

/**
 * Migration 022: Safely migrate verified legacy Google & GitHub account mappings
 * from neon_auth.account to the first-party oauth_accounts identity table.
 *
 * Guarantees zero data loss and exact identity continuity for verified
 * historical social users:
 * - GitHub 253642432 -> neon_user_e215766f-e719-431f-ad08-154a28ef83b4
 * - Google 109885171219226843992 -> neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
 * - Google 101889904540027754835 -> neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7
 */
export async function up(knex: Knex): Promise<void> {
  const hasNeonAuthAccount = await knex.schema.withSchema('neon_auth').hasTable('account');
  const hasOAuthAccounts = await knex.schema.hasTable('oauth_accounts');
  const hasUsers = await knex.schema.hasTable('users');

  if (!hasNeonAuthAccount || !hasOAuthAccounts || !hasUsers) {
    console.warn('[Migration 022] Prerequisites not met, skipping legacy social migration.');
    return;
  }

  const legacyAccounts = await knex('neon_auth.account')
    .whereIn('providerId', ['google', 'github'])
    .select('id', 'userId', 'providerId', 'accountId', 'createdAt', 'updatedAt');

  const now = Date.now();

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

export async function down(knex: Knex): Promise<void> {
  const hasOAuthAccounts = await knex.schema.hasTable('oauth_accounts');
  if (hasOAuthAccounts) {
    await knex('oauth_accounts').where('id', 'like', 'oa_legacy_%').delete();
  }
}
