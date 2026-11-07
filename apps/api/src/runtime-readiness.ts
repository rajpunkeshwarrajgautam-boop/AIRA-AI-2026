/** Persistent Agent execution cannot be certified without its database. */
export function evaluateRuntimeReadiness(
  appState: 'STARTING' | 'RECOVERING' | 'HEALTHY' | 'FAILED',
  env: { DATABASE_URL?: string; NODE_ENV?: string; VERCEL?: string }
): { ready: boolean; status: string; reason?: string } {
  const deployed = Boolean(env.VERCEL) || env.NODE_ENV === 'production';
  if (deployed && !env.DATABASE_URL?.trim()) {
    return { ready: false, status: 'NOT_READY', reason: 'AGENT_DATABASE_NOT_CONFIGURED' };
  }
  if (appState !== 'HEALTHY') {
    return { ready: false, status: appState };
  }
  return { ready: true, status: 'READY' };
}
