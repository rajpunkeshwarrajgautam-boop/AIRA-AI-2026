import { execSync } from 'child_process';
import knex, { Knex } from 'knex';
import {
  classifyDatabaseUrl,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID,
  STAGING_NEON_ENDPOINT_ID,
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_ENDPOINT_ID,
  COMMERCIAL_PR92_BRANCH_ID,
  COMMERCIAL_PR92_ENDPOINT_ID
} from '../packages/db/src/security/database-isolation-guard.js';

export interface ImportOptions {
  sourceConnectionString?: string;
  targetConnectionString?: string;
  dryRun?: boolean;
  allowPermanentStaging?: boolean;
  bypassToken?: string;
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

/**
 * Authoritative target database identity safety guard.
 * Validates target connection string against Neon project, branch, and endpoint metadata.
 */
export function validateAuthoritativeTargetSafety(
  connectionString: string,
  options: { allowPermanentStaging?: boolean } = {}
): void {
  const classification = classifyDatabaseUrl(connectionString);

  // 1. Unconditional Production Rejection
  if (classification.isProduction) {
    throw new Error(`[SECURITY FATAL] Direct execution against Production database (${PRODUCTION_NEON_PROJECT_ID}) is strictly prohibited.`);
  }

  // 2. Reject Commercial PR #92 as target (Source must never be written to)
  if (classification.isCommercialPr92) {
    throw new Error(`[SECURITY FATAL] Target cannot be the Commercial PR #92 source database (${COMMERCIAL_PR92_BRANCH_ID}). Writes prohibited.`);
  }

  // 3. Live Permanent Staging requires explicit owner authorization flag
  if (classification.isStagingPermanent) {
    const isAuthorized = options.allowPermanentStaging || process.env.AIRA_ALLOW_STAGING_LIVE_IMPORT === 'true';
    if (!isAuthorized) {
      throw new Error(`[SECURITY FATAL] Target is live Permanent Staging database (${STAGING_NEON_PROJECT_ID} / ${STAGING_NEON_BRANCH_ID}). Writes require explicit owner authorization flag: AIRA_ALLOW_STAGING_LIVE_IMPORT=true.`);
    }
  } else if (classification.category === 'isolated_neon_preview') {
    // Isolated preview / rehearsal branch: must be a verified Neon database endpoint in authorized staging project
    if (!classification.host.includes('.neon.tech')) {
      throw new Error(`[SECURITY FATAL] Target is not a verified Neon database endpoint: ${classification.sanitizedTarget}`);
    }
  } else if (!classification.isLocalOrCiTest) {
    // Reject all other write destinations fail-closed
    throw new Error(`[SECURITY FATAL] Write destination rejected: ${classification.sanitizedTarget}. Only authorized permanent staging (${STAGING_NEON_PROJECT_ID}) or isolated staging rehearsal branches are permitted.`);
  }
}

/**
 * Validates that connected target database metadata matches expected staging environment.
 * Queries Neon system settings (neon.project_id, neon.branch_id, neon.endpoint_id).
 */
export async function verifyConnectedTargetMetadata(
  targetClient: Knex,
  options: { allowPermanentStaging?: boolean; isNeonTarget?: boolean } = {}
): Promise<void> {
  const res = await targetClient.raw(`
    SELECT 
      current_database() as db_name, 
      current_user as db_user, 
      inet_server_addr() as server_ip,
      current_setting('neon.project_id', true) as neon_project_id,
      current_setting('neon.branch_id', true) as neon_branch_id,
      current_setting('neon.endpoint_id', true) as neon_endpoint_id
  `);
  const row = res.rows?.[0] || {};
  const { neon_project_id, neon_branch_id, neon_endpoint_id } = row;

  if (neon_project_id === PRODUCTION_NEON_PROJECT_ID || neon_endpoint_id === PRODUCTION_NEON_ENDPOINT_ID) {
    throw new Error(`[SECURITY FATAL] Connected target database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID})! Aborting immediately.`);
  }

  if (neon_branch_id === COMMERCIAL_PR92_BRANCH_ID || neon_endpoint_id === COMMERCIAL_PR92_ENDPOINT_ID) {
    throw new Error(`[SECURITY FATAL] Connected target database is Commercial PR #92 branch (${COMMERCIAL_PR92_BRANCH_ID})! Writes prohibited.`);
  }

  // If connected to Neon, require exact metadata and reject missing or mismatched identity
  const isNeon = options.isNeonTarget ?? Boolean(neon_project_id || neon_branch_id || neon_endpoint_id);
  if (isNeon) {
    if (!neon_project_id || !neon_branch_id || !neon_endpoint_id) {
      throw new Error('[SECURITY FATAL] Target database missing required Neon identity metadata (project_id, branch_id, or endpoint_id). Fail-closed.');
    }

    if (neon_project_id !== STAGING_NEON_PROJECT_ID) {
      throw new Error(`[SECURITY FATAL] Connected target Neon project (${neon_project_id}) does not match authorized Staging project (${STAGING_NEON_PROJECT_ID})!`);
    }

    if (neon_branch_id === STAGING_NEON_BRANCH_ID || neon_endpoint_id === STAGING_NEON_ENDPOINT_ID) {
      if (neon_branch_id !== STAGING_NEON_BRANCH_ID || neon_endpoint_id !== STAGING_NEON_ENDPOINT_ID) {
        throw new Error(`[SECURITY FATAL] Permanent staging metadata mismatch! branch: ${neon_branch_id} (expected ${STAGING_NEON_BRANCH_ID}), endpoint: ${neon_endpoint_id} (expected ${STAGING_NEON_ENDPOINT_ID}).`);
      }
      const isAuthorized = options.allowPermanentStaging || process.env.AIRA_ALLOW_STAGING_LIVE_IMPORT === 'true';
      if (!isAuthorized) {
        throw new Error(`[SECURITY FATAL] Connected target is live Permanent Staging main branch (${STAGING_NEON_BRANCH_ID}). Explicit owner authorization flag (AIRA_ALLOW_STAGING_LIVE_IMPORT=true) is required.`);
      }
    }
  }
}

/**
 * Validates source database connection, enforces proof that connection is read-only,
 * and checks exact Neon control-plane identity metadata.
 */
export async function validateAuthoritativeSourceSafety(
  connectionString: string,
  sourceClient?: Knex
): Promise<void> {
  const classification = classifyDatabaseUrl(connectionString);

  if (classification.isProduction) {
    throw new Error(`[SECURITY FATAL] Source database cannot be Production (${PRODUCTION_NEON_PROJECT_ID})! Aborting.`);
  }

  if (classification.isStagingPermanent) {
    throw new Error(`[SECURITY FATAL] Source database cannot be Permanent Staging (${STAGING_NEON_BRANCH_ID})!`);
  }

  if (!classification.isCommercialPr92 && !classification.isLocalOrCiTest) {
    throw new Error(`[SECURITY FATAL] Source database is not the authorized Commercial PR #92 database (${COMMERCIAL_PR92_BRANCH_ID})! Got: ${classification.sanitizedTarget}`);
  }

  if (sourceClient) {
    // 1. Enforce and prove read-only transaction state
    await sourceClient.raw('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;');
    await sourceClient.raw('SET TRANSACTION READ ONLY;');

    const roCheck = await sourceClient.raw('SHOW transaction_read_only;');
    const roVal = roCheck.rows?.[0]?.transaction_read_only ?? roCheck[0]?.transaction_read_only;
    if (roVal !== 'on') {
      throw new Error(`[SECURITY FATAL] Proof of read-only source connection failed! SHOW transaction_read_only is '${roVal}', expected 'on'.`);
    }
    console.log('[Source Guard] Verified proof that source database connection is strictly READ ONLY.');

    // 2. Query Neon GUC metadata on source
    const res = await sourceClient.raw(`
      SELECT 
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id,
        current_setting('neon.endpoint_id', true) as neon_endpoint_id
    `);
    const row = res.rows?.[0] || {};
    const { neon_project_id, neon_branch_id, neon_endpoint_id } = row;

    if (neon_project_id === PRODUCTION_NEON_PROJECT_ID || neon_endpoint_id === PRODUCTION_NEON_ENDPOINT_ID) {
      throw new Error(`[SECURITY FATAL] Source database connected to Production project (${PRODUCTION_NEON_PROJECT_ID})! Aborting.`);
    }

    const isNeonSource = classification.host.includes('.neon.tech') || Boolean(neon_project_id || neon_branch_id || neon_endpoint_id);
    if (isNeonSource) {
      if (!neon_project_id || !neon_branch_id || !neon_endpoint_id) {
        throw new Error('[SECURITY FATAL] Source database missing required Neon identity metadata (project_id, branch_id, or endpoint_id). Fail-closed.');
      }
      if (neon_project_id !== STAGING_NEON_PROJECT_ID) {
        throw new Error(`[SECURITY FATAL] Source database project (${neon_project_id}) does not match authorized Staging project (${STAGING_NEON_PROJECT_ID})!`);
      }
      if (neon_branch_id !== COMMERCIAL_PR92_BRANCH_ID) {
        throw new Error(`[SECURITY FATAL] Source database branch (${neon_branch_id}) does not match authorized Commercial PR #92 branch (${COMMERCIAL_PR92_BRANCH_ID})!`);
      }
      if (neon_endpoint_id !== COMMERCIAL_PR92_ENDPOINT_ID) {
        throw new Error(`[SECURITY FATAL] Source database endpoint (${neon_endpoint_id}) does not match authorized Commercial PR #92 endpoint (${COMMERCIAL_PR92_ENDPOINT_ID})!`);
      }
      console.log(`[Source Guard] Verified exact Commercial PR #92 control-plane identity: ${neon_project_id}/${neon_branch_id}/${neon_endpoint_id}`);
    }
  }
}

export function validateTargetSafety(connectionString: string, options: { allowPermanentStaging?: boolean } = {}): void {
  validateAuthoritativeTargetSafety(connectionString, options);
}

export async function importVerifiedCommercialIdentities(
  sourceClient: Knex,
  targetClient: Knex,
  optionsOrDryRun: boolean | ImportOptions = false
): Promise<ImportSummary> {
  const options: ImportOptions = typeof optionsOrDryRun === 'boolean'
    ? { dryRun: optionsOrDryRun }
    : optionsOrDryRun;
  const dryRun = Boolean(options.dryRun);

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

  // 1. Authoritative Safety Guards on connected clients
  await verifyConnectedTargetMetadata(targetClient, { allowPermanentStaging: options.allowPermanentStaging });

  // 2. Ensure source database session is strictly READ ONLY and prove it
  try {
    await sourceClient.raw('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;');
    await sourceClient.raw('SET TRANSACTION READ ONLY;');
    const roCheck = await sourceClient.raw('SHOW transaction_read_only;');
    const roVal = roCheck.rows?.[0]?.transaction_read_only ?? roCheck[0]?.transaction_read_only;
    if (roVal && roVal !== 'on') {
      throw new Error(`[SECURITY FATAL] Commercial source connection is NOT read-only! SHOW transaction_read_only returned: '${roVal}', expected 'on'.`);
    }
  } catch (err: any) {
    if (err.message.includes('[SECURITY FATAL]')) throw err;
  }

  // 3. Fail-closed table checks on source database
  const hasNeonAuthAccount = await sourceClient.schema.withSchema('neon_auth').hasTable('account');
  if (!hasNeonAuthAccount) {
    throw new Error('[RECONCILIATION_FATAL] Source database missing required neon_auth.account table. Aborting fail-closed.');
  }

  // 4. Retrieve candidate social accounts
  const socialAccounts = await sourceClient('neon_auth.account')
    .whereIn('providerId', ['google', 'github'])
    .select('id', 'userId', 'providerId', 'accountId', 'createdAt', 'updatedAt');

  if (!socialAccounts || socialAccounts.length === 0) {
    throw new Error('[RECONCILIATION_FATAL] Expected historical social OAuth accounts not found in neon_auth.account. Aborting fail-closed.');
  }

  // Verify provider account uniqueness in source
  const providerKeySet = new Set<string>();
  for (const oa of socialAccounts) {
    const key = `${oa.providerId}:${oa.accountId}`;
    if (providerKeySet.has(key)) {
      throw new Error(`[RECONCILIATION_FATAL] Duplicate provider account in source: ${key}`);
    }
    providerKeySet.add(key);
  }

  // 5. Identify genuine candidate users using fixture provenance rules
  const genuineUserIds = Array.from(new Set(socialAccounts.map(a => 'neon_user_' + a.userId)));

  const candidateUsers = await sourceClient('users')
    .whereIn('id', genuineUserIds)
    .whereNot('id', 'like', 'usr_%')
    .whereNot('id', 'like', 'test_%')
    .select('*');

  if (candidateUsers.length === 0) {
    throw new Error('[RECONCILIATION_FATAL] Zero genuine historical candidate users found in source database. Aborting fail-closed.');
  }

  if (candidateUsers.length < 2 || socialAccounts.length < 2) {
    throw new Error(`[RECONCILIATION_FATAL] Historical record count below expected threshold (${candidateUsers.length} users, ${socialAccounts.length} social accounts). Aborting fail-closed.`);
  }

  console.log(`[Import] Identified ${candidateUsers.length} genuine historical social users from source.`);

  const now = Date.now();

  const executeImportLogic = async (target: Knex | Knex.Transaction) => {
    for (const user of candidateUsers) {
      console.log(`[Import] Processing verified user ${sanitizeId(user.id)} (${sanitizeEmail(user.email)})`);

      if (!dryRun) {
        // 1. Insert User (matching exact id)
        const insertedUser = await target('users')
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
          const insOa = await target('oauth_accounts')
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
        let targetCustomerId = cust.id;
        if (!dryRun) {
          const existingCust = await target('billing_customers')
            .where('id', cust.id)
            .orWhere('principal_id', cust.principal_id)
            .first();

          if (!existingCust) {
            const insCust = await target('billing_customers')
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
            targetCustomerId = existingCust.id;
          }
        } else {
          summary.billingCustomersImported++;
        }

        // 4. Reconcile Credit Accounts (One wallet per customer invariant)
        const sourceCreditAccs = await sourceClient('credit_accounts')
          .where({ customer_id: cust.id })
          .select('*');

        if (sourceCreditAccs.length > 1) {
          throw new Error(`[RECONCILIATION_FATAL] Customer ${cust.id} has ${sourceCreditAccs.length} credit accounts in source. 1:1 invariant violated.`);
        }

        for (const ca of sourceCreditAccs) {
          let targetCreditAccountId = ca.id;
          if (!dryRun) {
            const existingWallet = await target('credit_accounts')
              .where('id', ca.id)
              .orWhere('customer_id', targetCustomerId)
              .first();

            if (!existingWallet) {
              const insCa = await target('credit_accounts')
                .insert({
                  id: ca.id,
                  customer_id: targetCustomerId,
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
              targetCreditAccountId = existingWallet.id;
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
              const insG = await target('credit_grants')
                .insert({
                  id: g.id,
                  account_id: targetCreditAccountId,
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
              const insTx = await target('credit_transactions')
                .insert({
                  id: tx.id,
                  account_id: targetCreditAccountId,
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
          const insConv = await target('conversations')
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
            const insM = await target('conversation_messages')
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

    // 8. In-transaction post-import reconciliation checks
    if (!dryRun) {
      const multiWalletCheck = await target('credit_accounts')
        .select('customer_id')
        .count('* as cnt')
        .groupBy('customer_id')
        .havingRaw('count(*) > 1');
      if (multiWalletCheck.length > 0) {
        throw new Error(`[RECONCILIATION_FATAL] Multi-wallet invariant violated in target for customer: ${multiWalletCheck[0].customer_id}`);
      }

      const orphanCheck = await target.raw(`
        SELECT c.id, c.principal_id
        FROM conversations c
        LEFT JOIN users u ON c.principal_id = u.id
        WHERE u.id IS NULL
      `);
      if (orphanCheck.rows.length > 0) {
        throw new Error(`[RECONCILIATION_FATAL] Referential integrity broken: ${orphanCheck.rows.length} orphaned conversations detected.`);
      }
    }
  };

  // Execute in atomic transaction if not dryRun
  if (!dryRun) {
    await targetClient.transaction(async (trx) => {
      const token = options.bypassToken || process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || process.env.STAGING_MAINTENANCE_TOKEN;
      if (token) {
        await trx.raw('SET LOCAL default_transaction_read_only = off;');
        await trx.raw("SELECT set_config('aira.privileged_token', :token, true);", { token });
      }
      await executeImportLogic(trx);
    });
  } else {
    await executeImportLogic(targetClient);
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

  const allowPermanentStaging = process.env.AIRA_ALLOW_STAGING_LIVE_IMPORT === 'true';

  validateAuthoritativeTargetSafety(targetCs, { allowPermanentStaging });
  await validateAuthoritativeSourceSafety(sourceCs);

  const sourceClient = knex({
    client: 'pg',
    connection: { connectionString: sourceCs, ssl: true }
  });

  const targetClient = knex({
    client: 'pg',
    connection: { connectionString: targetCs, ssl: true }
  });

  try {
    await verifyConnectedTargetMetadata(targetClient, { allowPermanentStaging });
    await validateAuthoritativeSourceSafety(sourceCs, sourceClient);

    console.log('Starting verified commercial identity import...');
    const result = await importVerifiedCommercialIdentities(sourceClient, targetClient, { allowPermanentStaging });
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

