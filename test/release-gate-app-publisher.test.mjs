import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_REPO, APPROVAL_WORKFLOW, APPROVAL_WORKFLOW_PATH, STATUS_CONTEXT,
  parseApprovalTitle, validateCompletedApproval, verifyApprovalFromGitHub, publishApprovedStatus
} from '../scripts/release-gate-app-publisher.mjs';

const sha = 'bbf02ea572f4f710bec185890b8b86c45da15057';
const approvedAt = '2026-10-14T22:00:00Z';
const now = Date.parse('2026-10-14T22:03:00Z');
const runId = 9900123;
const title = `Release Authorization: PR #68 [${sha}] [GO LIVE ${sha}]`;
function run(overrides = {}) {
  return {
    id: runId, name: APPROVAL_WORKFLOW, path: APPROVAL_WORKFLOW_PATH + '@refs/heads/prod-release',
    event: 'workflow_dispatch', head_branch: 'prod-release',
    head_sha: 'b1635e132544d0772358cb463131d1e6cd4d40a9',
    head_repository: { full_name: RELEASE_REPO }, repository: { full_name: RELEASE_REPO },
    actor: { login: 'rajpunkeshwarrajgautam-boop' },
    triggering_actor: { login: 'rajpunkeshwarrajgautam-boop' },
    status: 'completed', conclusion: 'success', created_at: approvedAt, updated_at: approvedAt,
    display_title: title, ...overrides
  };
}
function pr(overrides = {}) {
  return { number: 68, state: 'open', draft: false, head: { sha, repo: { full_name: RELEASE_REPO } },
    base: { ref: 'prod-release', repo: { full_name: RELEASE_REPO } }, ...overrides };
}
function rejectRun(field, invalid, code) {
  const result = run({ [field]: invalid });
  assert.throws(() => validateCompletedApproval(result, pr(), { now, expectedRunId: runId }), { message: code });
}
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
const calls = [];
const request = async (url, init) => {
  calls.push({ url, method: init.method, auth: init.headers.Authorization, payload: init.body ? JSON.parse(init.body) : null });
  if (url.endsWith('/actions/runs/' + runId)) return response(run());
  if (url.endsWith('/pulls/68')) return response(pr());
  if (url.endsWith('/commits/' + sha + '/statuses?per_page=100')) return response([]);
  if (url.endsWith('/statuses/' + sha)) return response({ state: 'success', context: STATUS_CONTEXT });
  return response({ message: 'not found' }, 404);
};

test('valid protected-branch owner approval is bound to exact PR and SHA', () => {
  assert.deepEqual(validateCompletedApproval(run(), pr(), { now, expectedRunId: runId }),
    { prNumber: 68, candidateSha: sha, approvalRunId: runId });
});
test('parse attestation title rejects wrong PR, missing SHA and mismatched GO LIVE phrase', () => {
  assert.deepEqual(parseApprovalTitle(title), { prNumber: 68, candidateSha: sha });
  for (const s of ['Release Authorization: PR #68', `Release Authorization: PR #68 [${sha}] [GO LIVE ${'a'.repeat(40)}]`, 'GO LIVE']) {
    assert.throws(() => parseApprovalTitle(s), { message: 'INVALID_ATTESTATION_TITLE' });
  }
});
test('workflow must have completed successfully before any status may publish', () => {
  rejectRun('status', 'in_progress', 'ATTESTATION_NOT_COMPLETED_SUCCESS');
  rejectRun('conclusion', 'cancelled', 'ATTESTATION_NOT_COMPLETED_SUCCESS');
  rejectRun('conclusion', 'failure', 'ATTESTATION_NOT_COMPLETED_SUCCESS');
});
test('other workflows, source branch and trigger event fail closed', () => {
  rejectRun('name', 'CI', 'WORKFLOW_NAME_MISMATCH');
  rejectRun('path', '.github/workflows/other.yml', 'WORKFLOW_PATH_MISMATCH');
  rejectRun('head_branch', 'feature/untrusted', 'UNTRUSTED_EXECUTION_BRANCH');
  rejectRun('event', 'pull_request', 'WORKFLOW_EVENT_MISMATCH');
});
test('only owner actor and owner re-run trigger actor can authorize', () => {
  rejectRun('actor', { login: 'intruder' }, 'UNAUTHORIZED_ACTOR');
  rejectRun('triggering_actor', { login: 'intruder' }, 'UNAUTHORIZED_TRIGGERING_ACTOR');
});
test('stale, malformed or future timestamps are rejected', () => {
  rejectRun('created_at', '2026-10-14T21:00:00Z', 'ATTESTATION_STALE_OR_INVALID');
  rejectRun('created_at', 'not-a-date', 'ATTESTATION_STALE_OR_INVALID');
  rejectRun('created_at', '2026-10-14T22:04:00Z', 'ATTESTATION_STALE_OR_INVALID');
  rejectRun('updated_at', '', 'COMPLETION_TIMESTAMP_INVALID');
});
test('untrusted or missing repository attribution is rejected', () => {
  rejectRun('head_repository', undefined, 'RUN_REPOSITORY_MISMATCH');
  rejectRun('repository', { full_name: 'attacker/other' }, 'RUN_REPOSITORY_MISMATCH');
});
test('only live ready PR targeting protected release with exactly matching HEAD can publish', () => {
  for (const bad of [
    pr({ state: 'closed' }), pr({ draft: true }), pr({ number: 69 }),
    pr({ head: { sha: 'a'.repeat(40), repo: { full_name: RELEASE_REPO } } }),
    pr({ base: { ref: 'staging', repo: { full_name: RELEASE_REPO } } }),
    pr({ head: { sha, repo: { full_name: 'attacker/fork' } } })
  ]) assert.throws(() => validateCompletedApproval(run(), bad, { now }), /PR_/);
});
test('trusted app publisher verifies real API records, then posts success using only App token', async () => {
  calls.length = 0;
  const verified = await verifyApprovalFromGitHub({ runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', request });
  assert.equal(verified.candidateSha, sha);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.method === 'GET' && c.auth === 'Bearer READ_ONLY_TOKEN_EXAMPLE'));
  calls.length = 0;
  await publishApprovedStatus({ runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: 'APP_INSTALLATION_TOKEN', request });
  assert.equal(calls.length, 4);
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[3].method, 'POST');
  assert.equal(calls[3].auth, 'Bearer APP_INSTALLATION_TOKEN');
  assert.equal(calls[3].payload.context, STATUS_CONTEXT);
  assert.equal(calls[3].payload.state, 'success');
  assert.equal(calls[3].payload.target_url, 'https://github.com/' + RELEASE_REPO + '/actions/runs/' + runId);
});
test('publisher must not emit any status on failed candidate verification', async () => {
  const badRequest = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/actions/runs/' + runId)) return response(run());
    if (url.endsWith('/pulls/68')) return response(pr({ draft: true }));
    return response({ state: 'success', context: STATUS_CONTEXT });
  };
  calls.length = 0;
  await assert.rejects(() => publishApprovedStatus({ runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: 'APP_INSTALLATION_TOKEN', request: badRequest }), /PR_NOT_READY/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});
test('publisher refuses absent App installation credential', async () => {
  calls.length = 0;
  await assert.rejects(() => publishApprovedStatus({ runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: '', request }), /APP_TOKEN_REQUIRED/);
  assert.equal(calls.length, 0);
});

test('older owner approval cannot overwrite a later App-issued revocation', async () => {
  const statusHistory = [{ context: STATUS_CONTEXT, state: 'failure',
    description: 'REVOKED by owner for PR #68', created_at: '2026-10-14T22:01:00Z' }];
  const observed = [];
  const revokedRequest = async (url, init) => {
    observed.push({ url, method: init.method });
    if (url.endsWith('/actions/runs/' + runId)) return response(run());
    if (url.endsWith('/pulls/68')) return response(pr());
    if (url.endsWith('/commits/' + sha + '/statuses?per_page=100')) return response(statusHistory);
    throw new Error('Unexpected status publication after revocation');
  };
  await assert.rejects(() => publishApprovedStatus({
    runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: 'APP_INSTALLATION_TOKEN', request: revokedRequest
  }), /PRIOR_APPROVAL_REVOKED/);
  assert.equal(observed.filter(c => c.method === 'POST').length, 0);
});

test('subsequent error status or future failure timestamp prevents approval publication', async () => {
  const errorStatusHistory = [{ context: STATUS_CONTEXT, state: 'error',
    description: 'System error during gating check', created_at: '2026-10-14T22:01:00Z' }];
  const observed = [];
  const errorRequest = async (url, init) => {
    observed.push({ url, method: init.method });
    if (url.endsWith('/actions/runs/' + runId)) return response(run());
    if (url.endsWith('/pulls/68')) return response(pr());
    if (url.endsWith('/commits/' + sha + '/statuses?per_page=100')) return response(errorStatusHistory);
    throw new Error('Unexpected status publication after error status');
  };
  await assert.rejects(() => publishApprovedStatus({
    runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: 'APP_INSTALLATION_TOKEN', request: errorRequest
  }), /PRIOR_APPROVAL_REVOKED/);
  assert.equal(observed.filter(c => c.method === 'POST').length, 0);

  // Future failure timestamp rejected
  const futureFailureHistory = [{ context: STATUS_CONTEXT, state: 'failure',
    description: 'REVOKED by owner', created_at: '2026-10-14T22:10:00Z' }];
  const futureRequest = async (url) => {
    if (url.endsWith('/actions/runs/' + runId)) return response(run());
    if (url.endsWith('/pulls/68')) return response(pr());
    if (url.endsWith('/commits/' + sha + '/statuses?per_page=100')) return response(futureFailureHistory);
    throw new Error('Unexpected status publication with future timestamp');
  };
  await assert.rejects(() => publishApprovedStatus({
    runId, now, readToken: 'READ_ONLY_TOKEN_EXAMPLE', appToken: 'APP_INSTALLATION_TOKEN', request: futureRequest
  }), /REVOCATION_TIMESTAMP_INVALID/);
});

test('future completion timestamp updated_at is rejected', () => {
  rejectRun('updated_at', '2026-10-14T22:10:00Z', 'COMPLETION_TIMESTAMP_INVALID');
});

