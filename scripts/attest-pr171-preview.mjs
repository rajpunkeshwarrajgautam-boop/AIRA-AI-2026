import assert from 'node:assert/strict';
import fs from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY || '';
const pullNumber = Number(process.env.PR_NUMBER);
const expectedSha = process.env.EXPECTED_SHA || '';
const token = process.env.GITHUB_TOKEN || '';
const outputFile = 'artifacts/pr171-preview-acceptance.json';
const evidence = {
  repository, pullNumber, expectedSha,
  observedAt: new Date().toISOString(),
  preview: null, version: null, health: null, ready: null,
  anonymousMcp: null, headers: null, failures: []
};

async function request(url, headers = {}) {
  const response = await fetch(url, {
    headers, redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(25_000)
  });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { response, json };
}
function record(ok, reason) {
  if (!ok) evidence.failures.push(reason);
}
try {
  assert.equal(repository, 'rajpunkeshwarrajgautam-boop/AIRA-AI-2026', 'Unexpected repository');
  assert.equal(pullNumber, 171, 'Unexpected pull request');
  assert.match(expectedSha, /^[a-f0-9]{40}$/, 'Missing full candidate SHA');
  assert.ok(token, 'GitHub read-only token required');

  const commentsResponse = await request(
    'https://api.github.com/repos/' + repository + '/issues/' + pullNumber + '/comments?per_page=100',
    {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'aira-pr171-preview-certification'
    }
  );
  assert.equal(commentsResponse.response.status, 200, 'GitHub comments lookup failed');
  assert.ok(Array.isArray(commentsResponse.json), 'GitHub comments were not an array');
  const bot = [...commentsResponse.json].reverse().find(comment =>
    comment.user?.login === 'vercel[bot]' &&
    /\[Preview\]\(https:\/\//.test(comment.body || '')
  );
  assert.ok(bot, 'Vercel bot did not publish a preview for PR 171');
  const previewText = bot.body.match(/\[Preview\]\((https:\/\/[^\s)]+)\)/)?.[1];
  assert.ok(previewText, 'Vercel preview link missing');
  const preview = new URL(previewText);
  assert.equal(preview.protocol, 'https:');
  assert.equal(preview.pathname, '/');
  assert.equal(preview.search, '');
  assert.equal(preview.username, '');
  assert.equal(preview.password, '');
  assert.equal(preview.port, '');
  assert.match(preview.hostname,
    /^aira-ai-2026-git-[a-z0-9-]+-rajpunkeshwarrajgautam-boops-projects\.vercel\.app$/,
    'Preview is not the expected project branch alias');
  evidence.preview = preview.origin;

  // Vercel's branch alias may still serve the previous build immediately
  // after a PR push. Poll the actual deployment identity instead of failing
  // on the expected, short-lived build/alias propagation race.
  let version;
  for (let attempt = 0; attempt < 18; attempt++) {
    version = await request(new URL('/api/version', preview));
    if (version.response.status === 200 && version.json?.commitSha === expectedSha) break;
    if (attempt < 17) await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  evidence.version = { httpStatus: version.response.status, commitSha: version.json?.commitSha || null };
  assert.equal(version.response.status, 200, 'Preview version endpoint failed');
  assert.equal(version.json?.commitSha, expectedSha, 'Preview SHA mismatch');

  // Never run browser tests on a URL before proving its exact candidate SHA.
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, 'STAGING_BASE_URL=' + preview.origin + '/\n');
  }
  const immutable = new URL(version.json.deploymentUrl || '');
  assert.equal(immutable.protocol, 'https:');
  assert.match(immutable.hostname,
    /^aira-ai-2026-[a-z0-9]+-rajpunkeshwarrajgautam-boops-projects\.vercel\.app$/);
  assert.notEqual(immutable.hostname, 'aira-ai-2026.vercel.app');
  evidence.immutableDeployment = immutable.origin;

  const health = await request(new URL('/api/health', preview));
  evidence.health = {
    httpStatus: health.response.status,
    status: health.json?.status || null,
    readiness: health.json?.readiness || null,
    reason: health.json?.readinessReason || null
  };
  record(health.response.status === 200 &&
    health.json?.status === 'HEALTHY' && health.json?.readiness === 'READY',
    'BACKEND_HEALTH_NOT_READY');

  const ready = await request(new URL('/api/ready', preview));
  evidence.ready = {
    httpStatus: ready.response.status,
    status: ready.json?.status || null,
    reason: ready.json?.reason || null
  };
  record(ready.response.status === 200 && ready.json?.status === 'READY',
    'BACKEND_READINESS_FAILED');

  const mcp = await request(new URL('/api/mcp/servers', preview));
  evidence.anonymousMcp = { httpStatus: mcp.response.status, error: mcp.json?.error || null };
  // A Vercel protection-wall 401 is not proof that AIRA denied MCP access.
  record(mcp.response.status === 401 && mcp.json?.error === 'AUTHENTICATION_REQUIRED',
    'ANONYMOUS_MCP_ACCESS_NOT_DENIED');

  const headers = {
    csp: Boolean(version.response.headers.get('content-security-policy')),
    hsts: Boolean(version.response.headers.get('strict-transport-security')),
    nosniff: version.response.headers.get('x-content-type-options') === 'nosniff',
    frameDenied: version.response.headers.get('x-frame-options') === 'DENY',
    apiNoStore: /no-store/i.test(version.response.headers.get('cache-control') || '')
  };
  evidence.headers = headers;
  record(Object.values(headers).every(Boolean), 'SECURITY_HEADERS_INCOMPLETE');
} catch (error) {
  evidence.failures.push('ATTESTATION_ERROR:' +
    (error instanceof Error ? error.message : 'unknown error'));
} finally {
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log('PR 171 deployed acceptance evidence:', JSON.stringify(evidence, null, 2));
}
if (evidence.failures.length) {
  console.error('PR 171 deployed acceptance failed closed:', evidence.failures.join(', '));
  process.exitCode = 1;
} else {
  console.log('Deployed anonymous and header gates passed at exact SHA:', expectedSha);
}
