import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPOSITORY, FREEZE_ISSUE_TITLE, isUnattendedSafePath, validateCandidate,
  validateWorkflowEvidence, validateDeploymentEvidence, evaluateLiveCandidate,
  releaseCandidate, verifyProductionCommit
} from '../scripts/autonomous-release.mjs';

const sha = '1234567890abcdef1234567890abcdef12345678';
const deployedSha = 'fedcba9876543210fedcba9876543210fedcba98';
const candidate = {
  number: 151, state: 'open', draft: false,
  base: { ref: 'prod-release', repo: { full_name: REPOSITORY } },
  head: { sha, repo: { full_name: REPOSITORY } },
  user: { login: 'rajpunkeshwarrajgautam-boop' },
  labels: [], mergeable: true, mergeable_state: 'clean'
};
const files = [{ filename: 'src/index.css', status: 'modified', changes: 22 }];
const runs = [
  { id: 15, name: 'CI', head_sha: sha, event: 'pull_request', status: 'completed', conclusion: 'success' },
  { id: 16, name: 'Disposable PostgreSQL Certification', head_sha: sha, event: 'pull_request', status: 'completed', conclusion: 'success' }
];
const jobsById = {
  15: ['Fast CI', 'Semantic Search CI', 'Main / PR certification'].map((name, id) => ({ id, name, status: 'completed', conclusion: 'success' })),
  16: [{ id: 1, name: 'PostgreSQL', status: 'completed', conclusion: 'success' }]
};
const statuses = [{ id: 1, context: 'Vercel', state: 'success', target_url: 'https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/safePreview123' }];
const checks = [{ id: 1, name: 'GitGuardian Security Checks', status: 'completed', conclusion: 'success' }];

function response(payload, status = 200) {
  return { ok: status < 400, status, json: async () => structuredClone(payload) };
}

function fakeGithub({ pr = candidate, changedFiles = files, workflowRuns = runs,
  jobs = jobsById, vercel = statuses, security = checks, frozen = false } = {}) {
  const visited = [];
  const request = async (url, options) => {
    const route = new URL(url).pathname.replace(`/repos/${REPOSITORY}/`, '');
    visited.push([route, options.method]);
    if (route === `pulls/${pr.number}`) return response(pr);
    if (route === `pulls/${pr.number}/files`) return response(changedFiles);
    if (route === 'issues' && options.method === 'GET') return response(frozen ? [{ title: FREEZE_ISSUE_TITLE }] : []);
    if (route === 'issues' && options.method === 'POST') return response({ number: 500 }, 201);
    if (route === 'actions/runs') return response({ workflow_runs: workflowRuns });
    if (/^actions\/runs\/\d+\/jobs$/.test(route)) {
      const id = Number(route.split('/')[2]);
      return response({ jobs: jobs[id] ?? [], total_count: (jobs[id] ?? []).length });
    }
    if (route === `commits/${sha}/status`) return response({ statuses: vercel });
    if (route === `commits/${sha}/check-runs`) return response({ check_runs: security });
    if (route === `pulls/${pr.number}/merge` && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, sha, 'must merge only the checked SHA');
      return response({ merged: true, sha: deployedSha }, 200);
    }
    throw new Error('UNEXPECTED_REQUEST:' + route);
  };
  return { request, visited };
}

test('allowlist covers only static asset, documentation and CSS paths', () => {
  for (const path of ['README.md', 'docs/branding.md', 'public/favicon.svg', 'public/brand/logo.svg', 'src/index.css', 'src/components/Sidebar.css']) {
    assert.equal(isUnattendedSafePath(path), true, path);
  }
  for (const path of ['AGENTS.md', '.github/workflows/ci.yml', 'src/App.tsx', 'src/components/Login.tsx', 'src/utils/storage.ts', 'packages/db/src/schema.ts', 'apps/api/src/auth/bff-session.ts', 'vercel.json', 'public/script.js', 'docs/RELEASE_APPROVAL_POLICY.md', '../README.md']) {
    assert.equal(isUnattendedSafePath(path), false, path);
  }
});

test('PR scope rejects risky paths, forks, stale branches, holds and renames', () => {
  assert.equal(validateCandidate(candidate, files), null);
  assert.equal(validateCandidate(candidate, files, { frozen: true }), 'RELEASE_FREEZE_ACTIVE');
  assert.equal(validateCandidate({ ...candidate, mergeable_state: 'behind' }, files), 'PR_NOT_CLEAN_AND_CURRENT');
  assert.equal(validateCandidate({ ...candidate, head: { ...candidate.head, repo: { full_name: 'attacker/fork' } } }, files), 'FORK_OR_INVALID_HEAD');
  assert.equal(validateCandidate({ ...candidate, labels: [{ name: 'release:hold' }] }, files), 'RELEASE_HOLD_LABEL');
  assert.equal(validateCandidate(candidate, [{ ...files[0], status: 'renamed' }]), 'UNATTENDED_DELETION_OR_RENAME');
  assert.equal(validateCandidate(candidate, [{ ...files[0], filename: 'src/App.tsx' }]), 'EXECUTABLE_OR_PROTECTED_CHANGE');
});

test('workflow attestation requires the newest exact-SHA run and every named job', () => {
  assert.equal(validateWorkflowEvidence(runs, jobsById, sha), null);
  assert.match(validateWorkflowEvidence([{ ...runs[0], conclusion: 'failure', id: 30 }, ...runs], jobsById, sha), /^WORKFLOW_NOT_GREEN/);
  assert.match(validateWorkflowEvidence(runs, { ...jobsById, 15: [{ ...jobsById[15][0], conclusion: 'skipped' }] }, sha), /^JOB_NOT_GREEN/);
  assert.match(validateWorkflowEvidence(runs.map(run => ({ ...run, head_sha: deployedSha })), jobsById, sha), /^WORKFLOW_NOT_GREEN/);
});

test('deployment proof fails closed on missing Vercel or missing security check', () => {
  assert.equal(validateDeploymentEvidence(statuses, checks), null);
  assert.equal(validateDeploymentEvidence([{ ...statuses[0], state: 'pending' }], checks), 'VERCEL_PREVIEW_NOT_READY');
  assert.equal(validateDeploymentEvidence(statuses, []), 'GITGUARDIAN_NOT_GREEN');
  assert.equal(validateDeploymentEvidence([{ ...statuses[0], target_url: 'https://attacker.example/' }], checks), 'VERCEL_PREVIEW_NOT_READY');
});

test('live evaluator validates GitHub API evidence without executing the PR checkout', async () => {
  const { request, visited } = fakeGithub();
  assert.deepEqual(await evaluateLiveCandidate({ prNumber: 151, token: 'mock-github-token', request }), {
    allowed: true, reason: 'CERTIFIED_STATIC_RELEASE', sha
  });
  assert.equal(visited.some(([route]) => route === 'pulls/151/merge'), false);
});

test('unsafe changes never reach the GitHub merge endpoint', async () => {
  const { request, visited } = fakeGithub({ changedFiles: [{ filename: 'src/App.tsx', status: 'modified', changes: 1 }] });
  const result = await releaseCandidate({ prNumber: 151, token: 'mock-github-token', request });
  assert.equal(result.merged, false);
  assert.equal(result.reason, 'EXECUTABLE_OR_PROTECTED_CHANGE');
  assert.equal(visited.some(([route]) => route.endsWith('/merge')), false);
});

test('eligible release merges only the verified SHA and verifies the production merge SHA', async () => {
  const { request, visited } = fakeGithub();
  let checkedSha;
  const result = await releaseCandidate({ prNumber: 151, token: 'mock-github-token', request,
    verify: async ({ sha: deployed }) => { checkedSha = deployed; return true; } });
  assert.equal(result.merged, true);
  assert.equal(checkedSha, deployedSha);
  assert.equal(visited.filter(([route]) => route === 'pulls/151/merge').length, 1);
});

test('failed production verification creates a release-freeze incident', async () => {
  const { request, visited } = fakeGithub();
  await assert.rejects(releaseCandidate({ prNumber: 151, token: 'mock-github-token', request, verify: async () => false }), /PRODUCTION_VERIFICATION_FAILED_RELEASE_FROZEN/);
  assert.ok(visited.some(([route, method]) => route === 'issues' && method === 'POST'));
});

test('exact deployed SHA and healthy API are mandatory after merge', async () => {
  const request = async url => {
    if (url.includes('/api/version')) return response({ status: 'ok', commitSha: deployedSha });
    if (url.includes('/api/health')) return response({ status: 'HEALTHY', appState: 'HEALTHY', subsystems: { agentRuntime: 'ONLINE' }, productionMockFallback: 'DISABLED' });
    throw new Error('Unexpected URL');
  };
  assert.equal(await verifyProductionCommit({ sha: deployedSha, request, attempts: 1 }), true);
  assert.equal(await verifyProductionCommit({ sha, request, attempts: 1 }), false);
});
