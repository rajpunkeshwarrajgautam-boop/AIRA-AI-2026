const pooledHost = 'ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech';
const directHost = 'ep-shiny-bird-b3xundyt.c-4.ap-southeast-1.aws.neon.tech';

function parseStagingUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.pathname !== '/neondb' || !allowedHosts.includes(url.hostname) ||
        (url.port && url.port !== '5432') || !url.username || !url.password ||
        !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) {
      throw new Error();
    }
    return url;
  } catch {
    // Never include a connection string in an exception or log.
    throw new Error('STAGING_DB_GUARD: invalid isolated staging database configuration');
  }
}

export function stagingMigrationUrl(env) {
  if (env.VERCEL_ENV !== 'preview') {
    throw new Error('STAGING_DB_GUARD: Vercel environment must be Preview');
  }
  if (env.VERCEL_GIT_COMMIT_REF !== 'staging') {
    throw new Error('STAGING_DB_GUARD: branch must be staging');
  }
  const runtime = parseStagingUrl(env.DATABASE_URL, [pooledHost, directHost]);
  const direct = env.DATABASE_URL_UNPOOLED
    ? parseStagingUrl(env.DATABASE_URL_UNPOOLED, [directHost])
    : new URL(runtime);
  direct.hostname = directHost;
  return direct.toString();
}
