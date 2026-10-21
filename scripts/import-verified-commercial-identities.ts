import { execSync } from 'child_process';
import knex, { Knex } from 'knex';

export interface ImportOptions {
  sourceConnectionString?: string;
  targetConnectionString?: string;
  dryRun?: boolean;
}

export interface ImportSummary {
  usersImported: number;
  oauthAccountsImported: number;
  billingCustomersImported: number;
  creditAccountsImported: number;
  creditGrantsImported: number;
  creditTransactionsImported: number;
  conversationsImported: number;
  messagesImported: number;
}

function sanitizeEmail(email: string | null): string {
  if (!email) return 'null';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const maskedLocal = local.length > 2 ? `${local[0]}***${local[local.length - 1]}` : `${local[0]}***`;
  const domainParts = domain.split('.');
  const maskedDomain = domainParts.map(p => (p.length > 2 ? `${p[0]}***` : p)).join('.');
  return `${maskedLocal}@${maskedDomain}`;
}

function sanitizeId(id: string | null): string {
  if (!id) return 'null';
  if (id.length <= 8) return `${id.slice(0, 2)}***`;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

export function validateTargetSafety(connectionString: string): void {
  const lower = connectionString.toLowerCase();
  if (lower.includes('old-sky-50952395') || lower.includes('prod-release') || lower.includes('aira-ai.in') || lower.includes('aira-ai-live')) {
    throw new Error('[SECURITY FATAL] Direct execution against Production database is strictly prohibited.');
  }
}

export async function importVerifiedCommercialIdentities(
  sourceClient: Knex,
  targetClient: Knex,
  dryRun = false
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    usersImported: 0,
    oauthAccountsImported: 0,
    billingCustomersImported: 0,
    creditAccountsImported: 0,
    creditGrantsImported: 0,
    creditTransactionsImported: 0,
    conversationsImported: 0,
    messagesImported: 0
  };

  // 1. Identify genuine users using fixture provenance
  // Fixture provenance rules:
  // - Exclude users where ID starts with 'usr_' or 'test_' (synthetic test fixtures)
  // - Require corresponding entry in neon_auth.account with providerId in ('google', 'github')
  // - Exclude users with providerId = 'credential' (local mock password test accounts)
  const hasNeonAuthAccount = await sourceClient.schema.withSchema('neon_auth').hasTable('account');
  if (!hasNeonAuthAccount) {
    console.warn('[Import] Source database does not have neon_auth.account table. Aborting.');
    return summary;
  }

  const socialAccounts = await sourceClient('neon_auth.account')
    .whereIn('providerId', ['google', 'github'])
    .select('id', 'userId', 'providerId', 'accountId', 'createdAt', 'updatedAt');

  const genuineUserIds = Array.from(new Set(socialAccounts.map(a => 'neon_user_' + a.userId)));

  const candidateUsers = await sourceClient('users')
    .whereIn('id', genuineUserIds)
    .whereNot('id', 'like', 'usr_%')
    .whereNot('id', 'like', 'test_%')
    .select('*');

  console.log(`[Import] Identified ${candidateUsers.length} genuine historical social users from source.`);

  const now = Date.now();

  for (const user of candidateUsers) {
    console.log(`[Import] Processing verified user ${sanitizeId(user.id)} (${sanitizeEmail(user.email)})`);

    if (!dryRun) {
      // 1. Insert User
      const insertedUser = await targetClient('users')
        .insert({
          id: user.id,
          name: user.name,
          email: user.email,
          email_verified: user.email_verified,
          image: user.image,
          created_at: user.created_at || now,
          updated_at: user.updated_at || now
        })
        .onConflict('id')
        .ignore();
      if (insertedUser.rowCount && insertedUser.rowCount > 0) {
        summary.usersImported += insertedUser.rowCount;
      }
    } else {
      summary.usersImported++;
    }

    // 2. Insert OAuth Accounts for this user
    const userLegacyId = user.id.replace('neon_user_', '');
    const userOAs = socialAccounts.filter(a => a.userId === userLegacyId);

    for (const oa of userOAs) {
      if (!dryRun) {
        const insOa = await targetClient('oauth_accounts')
          .insert({
            id: 'oa_legacy_' + oa.id,
            user_id: user.id,
            provider: oa.providerId,
            provider_account_id: oa.accountId,
            email: user.email,
            profile_data: JSON.stringify({
              migratedFrom: 'commercial_pr92_verified',
              migratedAt: now
            }),
            created_at: oa.createdAt ? new Date(oa.createdAt).getTime() : now,
            updated_at: oa.updatedAt ? new Date(oa.updatedAt).getTime() : now
          })
          .onConflict(['provider', 'provider_account_id'])
          .ignore();
        if (insOa.rowCount && insOa.rowCount > 0) {
          summary.oauthAccountsImported += insOa.rowCount;
        }
      } else {
        summary.oauthAccountsImported++;
      }
    }

    // 3. Reconcile Billing Customers
    const sourceCustomers = await sourceClient('billing_customers')
      .where({ principal_id: user.id })
      .select('*');

    for (const cust of sourceCustomers) {
      if (!dryRun) {
        const insCust = await targetClient('billing_customers')
          .insert({
            id: cust.id,
            principal_id: cust.principal_id,
            email: cust.email,
            name: cust.name,
            default_currency: cust.default_currency || 'INR',
            country_code: cust.country_code || 'IN',
            razorpay_customer_id: cust.razorpay_customer_id || null,
            cashfree_customer_id: cust.cashfree_customer_id || null,
            tax_info: typeof cust.tax_info === 'string' ? cust.tax_info : JSON.stringify(cust.tax_info || {}),
            created_at: cust.created_at || now,
            updated_at: cust.updated_at || now
          })
          .onConflict('id')
          .ignore();
        if (insCust.rowCount && insCust.rowCount > 0) {
          summary.billingCustomersImported += insCust.rowCount;
        }
      } else {
        summary.billingCustomersImported++;
      }

      // 4. Reconcile Credit Accounts (One wallet per customer)
      const sourceCreditAccs = await sourceClient('credit_accounts')
        .where({ customer_id: cust.id })
        .select('*');

      for (const ca of sourceCreditAccs) {
        if (!dryRun) {
          const insCa = await targetClient('credit_accounts')
            .insert({
              id: ca.id,
              customer_id: ca.customer_id,
              balance_credits: ca.balance_credits,
              reserved_credits: ca.reserved_credits,
              lifetime_granted_credits: ca.lifetime_granted_credits,
              lifetime_spent_credits: ca.lifetime_spent_credits,
              created_at: ca.created_at || now,
              updated_at: ca.updated_at || now
            })
            .onConflict('id')
            .ignore();
          if (insCa.rowCount && insCa.rowCount > 0) {
            summary.creditAccountsImported += insCa.rowCount;
          }
        } else {
          summary.creditAccountsImported++;
        }

        // 5. Reconcile Credit Grants
        const sourceGrants = await sourceClient('credit_grants')
          .where({ account_id: ca.id })
          .select('*');

        for (const g of sourceGrants) {
          if (!dryRun) {
            const insG = await targetClient('credit_grants')
              .insert({
                id: g.id,
                account_id: g.account_id,
                amount_credits: g.amount_credits,
                remaining_credits: g.remaining_credits ?? g.amount_credits,
                grant_type: g.grant_type,
                expires_at: g.expires_at || null,
                rollover_capped: g.rollover_capped || false,
                metadata: typeof g.metadata === 'string' ? g.metadata : JSON.stringify(g.metadata || {}),
                created_at: g.created_at || now
              })
              .onConflict('id')
              .ignore();
            if (insG.rowCount && insG.rowCount > 0) {
              summary.creditGrantsImported += insG.rowCount;
            }
          } else {
            summary.creditGrantsImported++;
          }
        }

        // 6. Reconcile Credit Transactions
        const sourceTxs = await sourceClient('credit_transactions')
          .where({ account_id: ca.id })
          .select('*');

        for (const tx of sourceTxs) {
          if (!dryRun) {
            const insTx = await targetClient('credit_transactions')
              .insert({
                id: tx.id,
                account_id: tx.account_id,
                reservation_id: tx.reservation_id || null,
                transaction_type: tx.transaction_type || tx.type || 'GRANT',
                amount_credits: tx.amount_credits,
                balance_before: tx.balance_before ?? 0,
                balance_after: tx.balance_after ?? tx.amount_credits,
                idempotency_key: tx.idempotency_key || `ctx_import_${tx.id}`,
                description: tx.description || 'Imported historical transaction',
                metadata: typeof tx.metadata === 'string' ? tx.metadata : JSON.stringify(tx.metadata || {}),
                created_at: tx.created_at || now
              })
              .onConflict('id')
              .ignore();
            if (insTx.rowCount && insTx.rowCount > 0) {
              summary.creditTransactionsImported += insTx.rowCount;
            }
          } else {
            summary.creditTransactionsImported++;
          }
        }
      }
    }

    // 7. Reconcile Genuine Historical Conversations & Messages
    const sourceConvs = await sourceClient('conversations')
      .where({ principal_id: user.id })
      .select('*');

    for (const c of sourceConvs) {
      if (!dryRun) {
        const insConv = await targetClient('conversations')
          .insert({
            id: c.id,
            principal_id: c.principal_id,
            client_id: c.client_id,
            title: c.title,
            created_at: c.created_at || now,
            updated_at: c.updated_at || now
          })
          .onConflict('id')
          .ignore();
        if (insConv.rowCount && insConv.rowCount > 0) {
          summary.conversationsImported += insConv.rowCount;
        }

        // Import conversation_messages
        const sourceMsgs = await sourceClient('conversation_messages')
          .where({ conversation_id: c.id })
          .select('*');

        for (const m of sourceMsgs) {
          const insM = await targetClient('conversation_messages')
            .insert({
              id: m.id,
              conversation_id: m.conversation_id,
              principal_id: m.principal_id || user.id,
              client_message_id: m.client_message_id || m.id,
              run_id: m.run_id || null,
              role: m.role,
              content: m.content || '',
              metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata || {}),
              created_at: m.created_at || now,
              updated_at: m.updated_at || now
            })
            .onConflict('id')
            .ignore();
          if (insM.rowCount && insM.rowCount > 0) {
            summary.messagesImported += insM.rowCount;
          }
        }
      } else {
        summary.conversationsImported++;
      }
    }
  }

  return summary;
}

async function main() {
  const sourceCs = process.env.SOURCE_DB_URL || execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const targetCs = process.env.TARGET_DB_URL || process.argv[2];

  if (!targetCs) {
    console.error('Usage: npx tsx scripts/import-verified-commercial-identities.ts <TARGET_DB_URL>');
    process.exit(1);
  }

  validateTargetSafety(targetCs);

  const sourceClient = knex({
    client: 'pg',
    connection: { connectionString: sourceCs, ssl: true }
  });

  const targetClient = knex({
    client: 'pg',
    connection: { connectionString: targetCs, ssl: true }
  });

  try {
    console.log('Starting verified commercial identity import...');
    const result = await importVerifiedCommercialIdentities(sourceClient, targetClient);
    console.log('[Import] Summary:', JSON.stringify(result, null, 2));
    console.log('[Import] Completed successfully.');
  } finally {
    await sourceClient.destroy();
    await targetClient.destroy();
  }
}

if (process.argv[1] && process.argv[1].includes('import-verified-commercial-identities')) {
  main().catch(err => {
    console.error('[Import] Error:', err.message);
    process.exit(1);
  });
}
