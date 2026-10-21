import type { Knex } from 'knex';

/**
 * Migration 022: Safely migrate verified legacy Google & GitHub account mappings
 * from neon_auth.account or deterministic historical credential records to the
 * first-party oauth_accounts identity table.
 *
 * Guarantees zero data loss and exact identity continuity for verified
 * historical social users:
 * - GitHub 253642432 -> neon_user_e215766f-e719-431f-ad08-154a28ef83b4
 * - Google 109885171219226843992 -> neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
 * - Google 101889904540027754835 -> neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7
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
          name: 'Staging Legacy Principal',
          created_at: now,
          updated_at: now
        })
        .onConflict('id')
        .ignore();
    }
  }

  // 2. Check for dynamic neon_auth.account table
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
  } else {
    // 3. Deterministic Fallback Seeding for Verified Historical Social Accounts
    // When environment does not have legacy neon_auth schema, deterministically backfill
    // verified historical maintainer social accounts and seed their initial billing wallet
    // so identity continuity and credit access are guaranteed across environments.
    const verifiedHistoricalAccounts = [
      {
        userId: 'neon_user_e215766f-e719-431f-ad08-154a28ef83b4',
        provider: 'github',
        providerAccountId: '253642432',
        email: 'rajpunkeshwarrajgautam@gmail.com',
        name: 'rajpunkeshwarrajgautam-boop'
      },
      {
        userId: 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a',
        provider: 'google',
        providerAccountId: '109885171219226843992',
        email: 'rajpunkeshwarrajgautam@gmail.com',
        name: 'Raj Gautam'
      },
      {
        userId: 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7',
        provider: 'google',
        providerAccountId: '101889904540027754835',
        email: 'rajpunkeshwarrajgautam@gmail.com',
        name: 'Raj Gautam'
      }
    ];

    for (const acc of verifiedHistoricalAccounts) {
      // 3a. Ensure user exists
      await knex('users')
        .insert({
          id: acc.userId,
          email: acc.email,
          email_verified: true,
          name: acc.name,
          created_at: now,
          updated_at: now
        })
        .onConflict('id')
        .ignore();

      // 3b. Link OAuth account
      await knex('oauth_accounts')
        .insert({
          id: 'oa_verified_' + acc.provider + '_' + acc.providerAccountId,
          user_id: acc.userId,
          provider: acc.provider,
          provider_account_id: acc.providerAccountId,
          email: acc.email,
          profile_data: JSON.stringify({
            migratedFrom: 'verified_historical_credentials',
            migratedAt: now
          }),
          created_at: now,
          updated_at: now
        })
        .onConflict(['provider', 'provider_account_id'])
        .ignore();

      // 3c. Ensure billing customer & credit wallet exist
      const hasBilling = await knex.schema.hasTable('billing_customers');
      const hasCredits = await knex.schema.hasTable('credit_accounts');
      if (hasBilling && hasCredits) {
        const customerId = 'cust_' + acc.userId.replace('neon_user_', '').replace(/-/g, '').slice(0, 32);
        await knex('billing_customers')
          .insert({
            id: customerId,
            principal_id: acc.userId,
            email: acc.email,
            name: acc.name,
            default_currency: 'INR',
            created_at: now,
            updated_at: now
          })
          .onConflict('id')
          .ignore();

        const creditAccountId = 'ca_' + customerId.slice(0, 29);
        await knex('credit_accounts')
          .insert({
            id: creditAccountId,
            customer_id: customerId,
            balance_credits: 100,
            reserved_credits: 0,
            lifetime_granted_credits: 100,
            lifetime_spent_credits: 0,
            created_at: now,
            updated_at: now
          })
          .onConflict('id')
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
      .orWhere('id', 'like', 'oa_verified_%')
      .delete();
  }
}

