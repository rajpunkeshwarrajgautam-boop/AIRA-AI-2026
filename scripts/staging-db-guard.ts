/**
 * Non-production staging ONLY. Never execute migrations against a production
 * database or for a Production deployment. This file only exists on staging.
 */
const knownStagingHost = 'ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech';
const env = process.env.VERCEL_ENV;
const branch = process.env.VERCEL_GIT_COMMIT_REF;
const connection = process.env.DATABASE_URL;

if (env !== 'preview') {
  throw new Error('STAGING_DB_GUARD: Vercel environment must be Preview');
}
if (branch && branch !== 'staging') {
  throw new Error('STAGING_DB_GUARD: branch must be staging');
}
if (!connection) {
  throw new Error('STAGING_DB_GUARD: branch-scoped DATABASE_URL is missing');
}
let hostname: string;
try {
  const url = new URL(connection);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error('Invalid database protocol');
  }
  hostname = url.hostname;
  if (url.pathname !== '/neondb') throw new Error('Unexpected database name');
} catch {
  throw new Error('STAGING_DB_GUARD: invalid staging DATABASE_URL');
}
if (hostname !== knownStagingHost) {
  throw new Error('STAGING_DB_GUARD: database is not the independently provisioned staging project');
}
console.log('STAGING_DB_GUARD: preview environment and isolated staging database verified.');
