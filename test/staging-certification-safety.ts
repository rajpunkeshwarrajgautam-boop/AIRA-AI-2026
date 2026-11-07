/** Fail-closed safeguards shared by live certification scripts. */
export function assertIsolatedAuthEndpoint(
  baseUrl: string,
  jwksUrl: string,
  verifiedDatabaseEndpointId: string
): void {
  if (!baseUrl || !jwksUrl || !verifiedDatabaseEndpointId) {
    throw new Error('A verified database endpoint and explicit branch-scoped Auth URLs are required');
  }

  const url = new URL(baseUrl);
  if (
    url.protocol !== 'https:' || url.port || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/neondb/auth' ||
    !url.hostname.endsWith('.aws.neon.tech') ||
    !url.hostname.includes('.neonauth.') ||
    url.hostname.split('.')[0] !== verifiedDatabaseEndpointId
  ) {
    throw new Error('Neon Auth endpoint does not match the verified isolated database compute');
  }

  if (jwksUrl !== `${url.origin}${url.pathname}/.well-known/jwks.json`) {
    throw new Error('Neon Auth JWKS URL must belong to the same isolated Auth endpoint');
  }
}

export function assertCertificationFixtureWriteOptIn(value: string | undefined): void {
  if (value !== 'true') {
    throw new Error('Live certification fixture writes require an explicit true opt-in');
  }
}
