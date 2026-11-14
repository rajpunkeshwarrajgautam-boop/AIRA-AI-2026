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

/**
 * A configured PostgreSQL URL does not establish that the database is
 * reachable. Probe SELECT 1 with a bounded wait; never expose raw driver
 * exceptions, hostnames, or credentials through public readiness responses.
 * Short caching and in-flight de-duplication bound load from health polling.
 */
export function createDatabaseReadinessProbe(
  check: () => Promise<unknown>,
  options: { cacheMs?: number; timeoutMs?: number } = {}
): () => Promise<boolean> {
  const cacheMs = options.cacheMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 4_000;
  let lastChecked = Number.NEGATIVE_INFINITY;
  let lastReady = false;
  let inFlight: Promise<boolean> | null = null;
  return async () => {
    if (inFlight) return inFlight;
    if (Date.now() - lastChecked < cacheMs) return lastReady;
    inFlight = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timer = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('DATABASE_PROBE_TIMEOUT')), timeoutMs);
        });
        await Promise.race([Promise.resolve().then(check), timer]);
        lastReady = true;
      } catch {
        lastReady = false;
      } finally {
        if (timeout) clearTimeout(timeout);
        lastChecked = Date.now();
      }
      return lastReady;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
