import { STAGING_NEON_BRANCH_ID } from '../packages/db/src/security/database-isolation-guard.js';

export interface StagingLiveAcceptanceConfig {
  previewUrl: string;
  bypassSecret: string;
  isolatedBranchId: string;
  stagingDatabaseUrl: string;
  userAEmail: string;
  userAPassword: string;
  userBEmail: string;
  userBPassword: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} must be set explicitly for live authenticated acceptance`);
  return value;
}

/** Fail closed before issuing requests or writing test fixtures to a remote database. */
export function resolveStagingLiveAcceptanceConfig(env: NodeJS.ProcessEnv): StagingLiveAcceptanceConfig {
  const previewUrl = required(env, 'AIRA_PREVIEW_URL');
  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    throw new Error('AIRA_PREVIEW_URL must be an immutable HTTPS Vercel preview URL');
  }
  if (parsed.protocol !== 'https:' ||
      !/^aira-ai-2026-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/.test(parsed.hostname) ||
      parsed.username || parsed.password || parsed.port) {
    throw new Error('AIRA_PREVIEW_URL must be an immutable HTTPS AIRA preview, never production or staging alias');
  }

  const isolatedBranchId = required(env, 'STAGING_ISOLATED_NEON_BRANCH_ID');
  if (!/^br-[a-z0-9-]+$/.test(isolatedBranchId) || isolatedBranchId === STAGING_NEON_BRANCH_ID) {
    throw new Error('STAGING_ISOLATED_NEON_BRANCH_ID must identify a disposable non-default staging project branch');
  }

  const stagingDatabaseUrl = required(env, 'STAGING_DATABASE_URL');
  let dbUrl: URL;
  try {
    dbUrl = new URL(stagingDatabaseUrl);
  } catch {
    throw new Error('STAGING_DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || !dbUrl.hostname) {
    throw new Error('STAGING_DATABASE_URL must be a PostgreSQL URL');
  }

  const userAEmail = required(env, 'STAGING_AUTH_TEST_USER_A_EMAIL');
  const userAPassword = required(env, 'STAGING_AUTH_TEST_USER_A_PASSWORD');
  const userBEmail = required(env, 'STAGING_AUTH_TEST_USER_B_EMAIL');
  const userBPassword = required(env, 'STAGING_AUTH_TEST_USER_B_PASSWORD');
  if (userAEmail.toLowerCase() === userBEmail.toLowerCase()) {
    throw new Error('Live acceptance requires two distinct test account emails');
  }

  return {
    previewUrl: parsed.origin,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? '',
    isolatedBranchId,
    stagingDatabaseUrl,
    userAEmail,
    userAPassword,
    userBEmail,
    userBPassword
  };
}
