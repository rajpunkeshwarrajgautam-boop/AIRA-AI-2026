/**
 * Resolve the application's deployment boundary from server-side platform
 * configuration. Never pass request data to this function.
 */
export type DeploymentEnvironment = 'production' | 'preview' | 'staging' | 'development';

export type TrustedEnvironmentConfig = Readonly<Record<string, string | undefined>>;

declare const process: { env?: Record<string, string | undefined> } | undefined;

const defaultEnv: TrustedEnvironmentConfig =
  typeof process !== 'undefined' && process && process.env ? process.env : {};

export function resolveDeploymentEnvironment(
  config: TrustedEnvironmentConfig = defaultEnv
): DeploymentEnvironment {
  const vercelEnvironment = config.VERCEL_ENV?.trim().toLowerCase();

  if (vercelEnvironment === 'production') return 'production';
  if (vercelEnvironment === 'preview') {
    return config.VERCEL_GIT_COMMIT_REF?.trim() === 'staging' ? 'staging' : 'preview';
  }
  if (vercelEnvironment === 'development') return 'development';
  if (vercelEnvironment) {
    throw new Error('Unsupported VERCEL_ENV deployment value.');
  }

  // For non-Vercel deployments NODE_ENV is trusted process configuration.
  // Vercel's explicit VERCEL_ENV always takes precedence (Preview uses NODE_ENV=production).
  return config.NODE_ENV === 'production' ? 'production' : 'development';
}

export function isProductionDeployment(config: TrustedEnvironmentConfig = defaultEnv): boolean {
  return resolveDeploymentEnvironment(config) === 'production';
}