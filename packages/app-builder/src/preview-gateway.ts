import 'dotenv/config';
import { createServer } from 'node:http';
import { objectStoreFromEnvironment } from './object-store.js';
import { PostgresObjectRefStore } from './object-ref-store.js';
import { PreviewGrantStore } from './preview-grants.js';
import { artifactMime, parseCompiledArchive } from './compiled-archive.js';

export interface PreviewGatewayConfig {
  origin: string; appOrigin: string; port: number;
}
export function validatePreviewGatewayConfig(config: PreviewGatewayConfig): void {
  const gateway = new URL(config.origin);
  const app = new URL(config.appOrigin);
  if (gateway.protocol !== 'https:' || app.protocol !== 'https:' ||
      gateway.username || app.username || gateway.password || app.password ||
      gateway.search || app.search || gateway.hash || app.hash ||
      gateway.pathname !== '/' || app.pathname !== '/' ||
      gateway.hostname === app.hostname ||
      gateway.hostname.split('.').slice(-2).join('.') === app.hostname.split('.').slice(-2).join('.') ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('UNSAFE_PREVIEW_ORIGIN_CONFIGURATION');
  }
}

export function createPreviewGateway(config: PreviewGatewayConfig) {
  validatePreviewGatewayConfig(config);
  const objects = objectStoreFromEnvironment();
  if (!objects) throw new Error('PREVIEW_OBJECT_STORAGE_NOT_CONFIGURED');
  const grants = new PreviewGrantStore();
  const refs = new PostgresObjectRefStore();
  return createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        'frame-ancestors ' + config.appOrigin
      ].join('; ')
    };
    const fail = (code: number) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Preview unavailable');
    };
    if (req.method !== 'GET' || req.headers.host !== new URL(config.origin).host ||
        !req.url || req.url.includes('?') || req.url.includes('%') ||
        req.headers.cookie || req.headers.authorization) return fail(404);
    const match = req.url.match(/^\/p\/([a-f0-9]{64})\/([A-Za-z0-9_./-]{1,100})$/);
    if (!match || match[2].split('/').some(s => !s || s.startsWith('.'))) return fail(404);
    const mime = artifactMime(match[2]);
    if (!mime) return fail(404);
    try {
      const grant = await grants.resolve(match[1]);
      if (!grant) return fail(404);
      const compiled = await refs.get(grant.queueJobId, grant.ownerId, 'compiled');
      if (!compiled || compiled.sha256 !== grant.compiledSha256) return fail(404);
      const archive = await objects.get(compiled);
      const assets = parseCompiledArchive(archive);
      const content = assets.get(match[2]);
      if (!content) return fail(404);
      res.writeHead(200, { ...headers, 'Content-Type': mime });
      return res.end(content);
    } catch (error) {
      console.error('[preview-gateway] asset unavailable',
        error instanceof Error ? error.message.replace(/[^\w-]/g, '_').slice(0, 80) : 'unknown');
      return fail(503);
    }
  });
}
if (process.argv[1]?.endsWith('/preview-gateway.ts') ||
    process.argv[1]?.endsWith('\\preview-gateway.ts')) {
  const config = {
    origin: process.env.AIRA_PREVIEW_GATEWAY_ORIGIN || '',
    appOrigin: process.env.AIRA_PREVIEW_APP_ORIGIN || '',
    port: Number(process.env.AIRA_PREVIEW_GATEWAY_PORT || 4402)
  };
  createPreviewGateway(config).listen(config.port, '127.0.0.1', () => {
    console.log('[aira-preview-gateway] loopback ready behind dedicated HTTPS proxy');
  });
}
