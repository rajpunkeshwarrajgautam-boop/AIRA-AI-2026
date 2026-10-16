import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export const DEFAULT_HEALTH_HOST = '127.0.0.1';
export const ALLOWED_HEALTH_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost']);

export interface WorkerHealthOptions {
  workerId: string;
  checkDatabase?: () => Promise<void>;
  uptime?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  logger?: {
    error: (msg: string) => void;
    info?: (msg: string) => void;
  };
}

/**
 * Validates and resolves the network interface to bind the health probe server.
 * Defaults strictly to loopback (127.0.0.1) for native systemd and host deployments.
 * Binding to 0.0.0.0 is permitted ONLY when explicitly authorized via WORKER_HEALTH_ALLOW_EXTERNAL=true
 * or container environment flags, preventing accidental public exposure on multi-homed hosts.
 */
export function resolveWorkerHealthHost(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.WORKER_HEALTH_HOST || env.HEALTH_HOST || '').trim();
  if (!configured) {
    return DEFAULT_HEALTH_HOST;
  }

  if (!ALLOWED_HEALTH_HOSTS.has(configured)) {
    throw new Error(
      `INVALID_WORKER_HEALTH_HOST: Binding address '${configured}' is prohibited. Only '127.0.0.1', '::1', 'localhost', or '0.0.0.0' (with explicit WORKER_HEALTH_ALLOW_EXTERNAL=true) are supported.`
    );
  }

  const normalized = configured === 'localhost' ? '127.0.0.1' : configured;

  if (normalized === '0.0.0.0') {
    const isExplicitlyAllowed =
      env.WORKER_HEALTH_ALLOW_EXTERNAL === 'true' ||
      env.AIRA_WORKER_CONTAINER === 'true' ||
      env.DOCKER_CONTAINER === 'true';

    if (!isExplicitlyAllowed) {
      throw new Error(
        'SPECIALIST_WORKER_HEALTH_PUBLIC_BINDING_FORBIDDEN: Binding health probe to 0.0.0.0 requires explicit WORKER_HEALTH_ALLOW_EXTERNAL=true to prevent accidental public network exposure.'
      );
    }
  }

  return normalized;
}

/**
 * Creates the HTTP Liveness & Readiness Probe Server for AIRA Specialist Worker.
 *
 * Security Controls:
 * - /ready catches database failures and returns a generic, sanitized response.
 * - Under NO circumstances are PostgreSQL connection strings, credentials, internal SQL queries,
 *   server hostnames, or stack traces disclosed to external HTTP callers.
 * - Diagnostic details (such as sanitized error codes) are restricted strictly to server-side logging.
 */
export function createWorkerHealthServer(options: WorkerHealthOptions): Server {
  const {
    workerId,
    checkDatabase,
    uptime = () => process.uptime(),
    leaseMs = 30000,
    heartbeatMs = 5000,
    logger = console
  } = options;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Liveness probe endpoints
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/live' || req.url === '/')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(
        JSON.stringify({
          status: 'HEALTHY',
          kind: 'specialist-worker',
          workerId,
          uptime: uptime(),
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    // Readiness probe endpoint
    if (req.method === 'GET' && req.url === '/ready') {
      try {
        if (checkDatabase) {
          await checkDatabase();
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(
          JSON.stringify({
            status: 'READY',
            kind: 'specialist-worker',
            workerId,
            leaseMs,
            heartbeatMs,
            database: 'CONNECTED',
            timestamp: new Date().toISOString()
          })
        );
      } catch (err: any) {
        // Restricted diagnostic logging - sanitize error details, never log passwords or credentials
        const safeCode = typeof err?.code === 'string' && /^[A-Z0-9_-]+$/i.test(err.code) ? err.code : 'DATABASE_ERROR';
        logger.error(
          JSON.stringify({
            level: 'error',
            event: 'SPECIALIST_WORKER_READINESS_CHECK_FAILED',
            workerId,
            code: safeCode,
            timestamp: new Date().toISOString()
          })
        );

        // Generic, non-disclosing 503 response.
        // Prohibits raw exception messages, internal queries, hostnames, or credentials.
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(
          JSON.stringify({
            status: 'NOT_READY',
            error: 'DATABASE_UNREACHABLE',
            message: 'Database readiness check failed'
          })
        );
      }
      return;
    }

    // 404 for all other paths
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
}
