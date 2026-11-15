export const CERTIFIED_STAGING_ORIGIN = 'https://staging.virexaaiventures.com';

/** Reject production, preview, lookalike hosts and credential-bearing URLs before any network call. */
export function assertPr178StagingDestination(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PR178_CERTIFICATION_DESTINATION_REJECTED: invalid staging URL');
  }
  if (url.origin !== CERTIFIED_STAGING_ORIGIN ||
      url.protocol !== 'https:' ||
      url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('PR178_CERTIFICATION_DESTINATION_REJECTED: only the certified staging origin is allowed');
  }
}
