/**
 * AIRA AI 2026 — Express Staging Maintenance Middleware
 * 
 * Intercepts incoming HTTP requests to permanent staging when maintenance is active.
 * 
 * Coverage:
 * 1. Blocks all mutating HTTP methods (POST, PUT, PATCH, DELETE).
 * 2. Blocks mutating GET endpoints (OAuth start, callbacks, account link initiation).
 * 3. Exempts public health checks (/api/health, /api/ready/*) and CORS OPTIONS preflights.
 * 4. Permits authorized release orchestrators passing the verified bypass token
 *    via `X-Aira-Maintenance-Token` header.
 * 5. Returns clean HTTP 503 Service Unavailable with standard Retry-After headers.
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export interface MaintenanceConfig {
  enabled?: boolean;
  bypassToken?: string;
  bypassTokenHash?: string;
  customMessage?: string;
}

// Mutating GET paths that trigger state transitions, OAuth sessions, or account linking
export const MUTATING_GET_PATHS = [
  '/api/auth/oauth/google/callback',
  '/api/auth/oauth/github/callback',
  '/api/auth/oauth/google/start',
  '/api/auth/oauth/github/start',
  '/api/auth/oauth/google/link',
  '/api/auth/oauth/github/link'
];

let globalMaintenanceActive = process.env.STAGING_MAINTENANCE_MODE === 'true';

export function setStagingMaintenanceState(active: boolean): void {
  globalMaintenanceActive = active;
}

export function isStagingMaintenanceActive(): boolean {
  return globalMaintenanceActive || process.env.STAGING_MAINTENANCE_MODE === 'true';
}

/**
 * Creates Express middleware that intercepts requests when staging maintenance is enabled.
 * 
 * Strict Security Policy:
 * Inbound HTTP requests can NEVER bypass maintenance via HTTP headers.
 * All privileged maintenance operations (migrations, historical identity import)
 * must be executed strictly out-of-band via direct database connections.
 */
export function createStagingMaintenanceMiddleware(config: MaintenanceConfig = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isMaintenance = config.enabled ?? isStagingMaintenanceActive();
    if (!isMaintenance) {
      return next();
    }

    const path = req.path.toLowerCase();
    const method = req.method.toUpperCase();

    // 1. Unconditional Pass: Health and Liveness Probes
    if (
      path === '/api/health' ||
      path === '/api/healthz' ||
      path === '/health' ||
      path.startsWith('/api/ready') ||
      method === 'OPTIONS'
    ) {
      return next();
    }

    // 2. Inspect if method or route is a mutating path
    const isMutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const isMutatingGet = method === 'GET' && MUTATING_GET_PATHS.some(prefix => path.startsWith(prefix));

    if (isMutatingMethod || isMutatingGet) {
      res.setHeader('Retry-After', '60');
      res.setHeader('X-Aira-Maintenance', 'active');
      res.status(503).json({
        error: 'STAGING_MAINTENANCE_ACTIVE',
        code: 'STAGING_MAINTENANCE_ACTIVE',
        message: config.customMessage || 'Permanent staging environment is temporarily undergoing maintenance for PR #96 cutover. Writes are disabled.',
        retryAfter: 60,
        route: req.originalUrl || req.url,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Read-only GET / HEAD requests are permitted through
    next();
  };
}
