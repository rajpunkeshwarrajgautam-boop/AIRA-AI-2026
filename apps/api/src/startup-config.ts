import { resolveDeploymentEnvironment, type TrustedEnvironmentConfig } from '../../../packages/contracts/src/deployment-environment.js';

export type StartupConfigurationResult = {
  environment: ReturnType<typeof resolveDeploymentEnvironment>;
  errors: string[];
  warnings: string[];
};

export const MAX_GUEST_V1_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY'] as const;
const PRODUCTION_MIGRATION_FLAGS = [
  'AIRA_SESSION_ACCEPT_LEGACY_V1',
  'AIRA_BFF_ACCEPT_LEGACY_COOKIE',
  'AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT',
] as const;
const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseCanonicalUtcTimestamp(value: string | undefined): number | null {
  if (!value || !STRICT_UTC_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

export function validateApiStartupConfiguration(
  env: TrustedEnvironmentConfig = process.env,
  nowMs: number = Date.now()
): StartupConfigurationResult {
  const environment = resolveDeploymentEnvironment(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const sessionSecret = env.AIRA_SESSION_SECRET?.trim() || '';
  if (environment !== 'development' && sessionSecret.length < 32) {
    errors.push('AIRA_SESSION_SECRET must be configured with at least 32 characters.');
  }

  if (environment === 'production') {
    for (const flag of PRODUCTION_MIGRATION_FLAGS) {
      if (env[flag] !== 'true' && env[flag] !== 'false') {
        errors.push(`Production must explicitly set ${flag} to the exact value true or false before startup.`);
      }
    }

    const guestV1Policy = env.AIRA_SESSION_ACCEPT_LEGACY_V1;
    const rawDeadline = env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL;
    const hasDeadline = Boolean(rawDeadline?.trim());
    if (guestV1Policy === 'true') {
      const deadline = parseCanonicalUtcTimestamp(rawDeadline);
      if (deadline === null) {
        errors.push('AIRA_SESSION_ACCEPT_LEGACY_V1=true requires AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL as a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).');
      } else if (deadline - nowMs > MAX_GUEST_V1_GRACE_MS) {
        errors.push('AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL may be no more than 7 days in the future.');
      } else if (deadline <= nowMs) {
        warnings.push('The guest-v1 compatibility deadline has passed; guest-v1 tokens are rejected even though the compatibility flag remains true.');
      }
    } else if (hasDeadline) {
      errors.push('AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL must be unset when AIRA_SESSION_ACCEPT_LEGACY_V1=false.');
    }

    if (
      env.AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT === 'true' &&
      env.AIRA_BFF_ACCEPT_LEGACY_COOKIE !== 'true'
    ) {
      errors.push('AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT=true requires AIRA_BFF_ACCEPT_LEGACY_COOKIE=true.');
    }

    if (env.AIRA_BUILDER_ACCEPT_LEGACY_V1 === 'true' && (env.AIRA_BUILDER_SIGNING_SECRET?.trim().length || 0) < 32) {
      errors.push('AIRA_BUILDER_ACCEPT_LEGACY_V1=true requires AIRA_BUILDER_SIGNING_SECRET with at least 32 characters.');
    }
  } else {
    for (const flag of PRODUCTION_MIGRATION_FLAGS) {
      const value = env[flag];
      if (value !== undefined && value !== '' && value !== 'true' && value !== 'false') {
        errors.push(`${flag} must be exactly true or false when configured.`);
      } else if (value === 'true') {
        errors.push(`${flag}=true is Production-only; non-Production deployments must reject legacy credentials.`);
      }
    }
    if (env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL?.trim()) {
      errors.push('AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL is Production-only and must be unset outside Production.');
    }
    if (env.AIRA_BUILDER_ACCEPT_LEGACY_V1 === 'true') {
      errors.push('AIRA_BUILDER_ACCEPT_LEGACY_V1=true is Production-only.');
    }
  }

  // Preserve the existing provider prerequisite for Production and staging.
  // Ordinary PR Preview is intentionally allowed to boot with no paid provider.
  if (environment === 'production' || environment === 'staging') {
    if (!PROVIDER_KEYS.some(key => Boolean(env[key]?.trim()))) {
      errors.push(`A ${environment} deployment requires at least one configured provider key (${PROVIDER_KEYS.join(', ')}).`);
    }
  }

  return { environment, errors, warnings };
}