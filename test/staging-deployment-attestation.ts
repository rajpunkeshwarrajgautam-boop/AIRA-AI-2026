import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

const token = process.env.VERCEL_TOKEN ?? '';
const expected = process.env.EXPECTED_SHA ?? '';
const teamId = process.env.VERCEL_TEAM_ID || 'team_0IZkX9o2Ab319UsAPW9oq1SL';
const projectId = 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH';

assert.ok(token, 'VERCEL_TOKEN repository secret is required for Vercel attestation');
assert.match(expected, /^[a-f0-9]{40}$/, 'Expected exact staging SHA');

type Deployment = {
  id?: string;
  url?: string;
  projectId?: string;
  target?: string | null;
  state?: string;
  readyState?: string;
  meta?: { githubCommitSha?: string; githubCommitRef?: string };
};

async function requestVercel<T>(url: URL): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Vercel deployment metadata request returned HTTP ' + response.status);
  return response.json() as Promise<T>;
}

// Discover the immutable URL from the current exact Git SHA.
// A moving Git branch alias or manually maintained URL is never accepted.
const listUrl = new URL('https://api.vercel.com/v6/deployments');
listUrl.searchParams.set('teamId', teamId);
listUrl.searchParams.set('projectId', projectId);
listUrl.searchParams.set('limit', '100');

let matched: Deployment | undefined;
for (let attempt = 0; attempt < 20; attempt++) {
  const listing = await requestVercel<{deployments?: Deployment[]}>(listUrl);
  const sameCommit = (listing.deployments ?? []).filter(d =>
    d.meta?.githubCommitSha === expected &&
    d.meta?.githubCommitRef === 'staging' &&
    d.projectId === projectId &&
    d.target !== 'production'
  );
  matched = sameCommit.find(d => (d.readyState ?? d.state) === 'READY' && d.id && d.url);
  if (matched) break;
  if (sameCommit.some(d => ['ERROR','CANCELED'].includes(d.readyState ?? d.state ?? ''))) {
    throw new Error('The matching Vercel Preview failed to build: staging release blocked');
  }
  await new Promise(resolve => setTimeout(resolve, 12000));
}
assert.ok(matched?.id && matched?.url, 'No READY Vercel Preview exists for exact staging SHA');
const immutable = 'https://' + matched.url + '/';
const parsed = new URL(immutable);
assert.equal(parsed.protocol,'https:');
assert.ok(/^aira-ai-2026-[a-z0-9]+-/.test(parsed.hostname) && parsed.hostname.endsWith('.vercel.app'),
  'Rejected non-immutable or non-project Vercel URL');
assert.notEqual(parsed.hostname,'aira-ai-2026.vercel.app');

const inspectUrl = new URL('https://api.vercel.com/v13/deployments/' + encodeURIComponent(matched.id));
inspectUrl.searchParams.set('teamId', teamId);
const detail = await requestVercel<Deployment>(inspectUrl);
assert.equal(detail.projectId, projectId,'Wrong Vercel project');
assert.equal(detail.meta?.githubCommitRef,'staging','Wrong Git branch');
assert.equal(detail.meta?.githubCommitSha, expected,'Preview is not at exact staging commit');
assert.notEqual(detail.target,'production','Production deployment cannot satisfy the staging gate');
assert.equal(detail.readyState ?? detail.state,'READY','Preview is not READY');
assert.equal(detail.url, matched.url,'Preview URL mismatch');

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, 'STAGING_BASE_URL=' + immutable + '\n');
}
console.log('PASS: immutable Vercel Preview ' + matched.id + ' attested at staging SHA ' + expected);
