import assert from 'node:assert/strict';

const base = process.env.STAGING_BASE_URL ?? '';
const token = process.env.VERCEL_TOKEN ?? '';
const expected = process.env.EXPECTED_SHA ?? '';
const teamId = process.env.VERCEL_TEAM_ID ?? '';
assert.ok(base, 'AIRA_STAGING_BASE_URL GitHub repository variable is required');
assert.ok(token, 'VERCEL_TOKEN GitHub repository secret is required');
assert.match(expected, /^[a-f0-9]{40}$/, 'Expected exact staging Git SHA');
const url = new URL(base);
assert.equal(url.protocol, 'https:', 'Only HTTPS Preview URLs are accepted');
assert.ok(url.hostname.endsWith('.vercel.app'), 'Must use an immutable Vercel Preview deployment');
assert.notEqual(url.hostname, 'aira-ai-2026.vercel.app', 'Production URL prohibited');
assert.ok(/^aira-ai-2026-[a-z0-9]+-/.test(url.hostname),
  'Expected immutable deployment URL, not a movable branch alias');

const endpoint = new URL('https://api.vercel.com/v13/deployments/' + encodeURIComponent(url.hostname));
if (teamId) endpoint.searchParams.set('teamId', teamId);
const response = await fetch(endpoint, {
  headers: { Authorization: 'Bearer ' + token }
});
if (!response.ok) throw new Error('Vercel deployment attestation returned HTTP ' + response.status);
const deployment = await response.json() as {
  id?:string; projectId?:string; target?:string|null;
  state?:string; readyState?:string; meta?:{githubCommitSha?:string,githubCommitRef?:string}
};
assert.equal(deployment.projectId, 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH', 'Wrong project');
assert.equal(deployment.meta?.githubCommitRef, 'staging', 'Not a staging branch deployment');
assert.equal(deployment.meta?.githubCommitSha, expected, 'Deployment is not exact staging HEAD');
assert.notEqual(deployment.target, 'production', 'Never certify the production deployment as staging');
assert.equal(deployment.readyState ?? deployment.state, 'READY', 'Vercel Preview is not READY');
console.log('PASS: exact Vercel Preview deployment verified against staging SHA ' + expected);
