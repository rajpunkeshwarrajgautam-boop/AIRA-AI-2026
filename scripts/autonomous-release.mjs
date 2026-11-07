/**
 * AIRA's deliberately narrow, unattended production release operator.
 *
 * It runs from the protected prod-release branch, never checks out PR code,
 * and lets GitHub enforce all branch protections at the final exact-SHA merge.
 * Executable, security-sensitive and infrastructure changes are excluded.
 */
export const REPOSITORY = 'rajpunkeshwarrajgautam-boop/AIRA-AI-2026';
export const PRODUCTION_BRANCH = 'prod-release';
export const PRODUCTION_URL = 'https://aira-ai-2026.vercel.app';
export const FREEZE_ISSUE_TITLE = '[AUTO-RELEASE-FREEZE] Production verification failed';
export const REQUIRED_WORKFLOWS = Object.freeze({
  CI: ['Fast CI', 'Semantic Search CI', 'Main / PR certification'],
  'Disposable PostgreSQL Certification': []
});
const SHA = /^[a-f0-9]{40}$/;
const ACCEPTED_STATIC_ASSET = /\.(?:svg|png|jpe?g|webp|gif|ico|woff2?)$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Only non-executable, non-policy edits are eligible for unattended release. */
export function isUnattendedSafePath(path) {
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/')) return false;
  if (path === 'README.md') return true;
  if (/^docs\/(?!.*(?:release|security|auth|migration|deployment|incident|secret|agent|governance|policy)).+\.md$/i.test(path)) return true;
  if (/^src\/(?:styles\/[^/]+\/)?[^/]+\.css$/i.test(path)) return true;
  if (/^src\/components\/(?!.*(?:auth|security|permission|consent|billing|sandbox|agent|workspace))[^/]+\.css$/i.test(path)) return true;
  if (/^public\/(?:assets\/|brand\/|icons\/)?[^/]+$/i.test(path) && ACCEPTED_STATIC_ASSET.test(path)) return true;
  return false;
}

export function validateCandidate(pr, files, { frozen = false } = {}) {
  if (frozen) return 'RELEASE_FREEZE_ACTIVE';
  if (!pr || pr.state !== 'open' || pr.draft || !Number.isSafeInteger(pr.number)) return 'PR_NOT_OPEN_AND_READY';
  if (pr.base?.ref !== PRODUCTION_BRANCH || pr.base?.repo?.full_name !== REPOSITORY) return 'WRONG_RELEASE_TARGET';
  if (pr.head?.repo?.full_name !== REPOSITORY || !SHA.test(pr.head?.sha || '')) return 'FORK_OR_INVALID_HEAD';
  if (pr.user?.login !== 'rajpunkeshwarrajgautam-boop') return 'UNTRUSTED_PR_AUTHOR';
  if ((pr.labels || []).some(label => /^(?:release:hold|do-not-merge|security:hold)$/i.test(label.name || ''))) return 'RELEASE_HOLD_LABEL';
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return 'PR_NOT_CLEAN_AND_CURRENT';
  if (!Array.isArray(files) || files.length < 1 || files.length > 30) return 'INVALID_CHANGE_SCOPE';
  if (files.some(file => file.status !== 'modified' && file.status !== 'added')) return 'UNATTENDED_DELETION_OR_RENAME';
  if (files.some(file => !isUnattendedSafePath(file.filename))) return 'EXECUTABLE_OR_PROTECTED_CHANGE';
  if (files.reduce((sum, file) => sum + (file.changes || 0), 0) > 500) return 'CHANGE_BUDGET_EXCEEDED';
  return null;
}

/** Require the newest matching PR workflow run and each named required job. */
export function validateWorkflowEvidence(runs, jobsById, candidateSha) {
  if (!SHA.test(candidateSha) || !Array.isArray(runs)) return 'INVALID_WORKFLOW_EVIDENCE';
  for (const [workflowName, jobNames] of Object.entries(REQUIRED_WORKFLOWS)) {
    const matches = runs.filter(run => run.name === workflowName && run.head_sha === candidateSha && run.event === 'pull_request');
    matches.sort((a, b) => b.id - a.id);
    const latest = matches[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') return `WORKFLOW_NOT_GREEN:${workflowName}`;
    const jobs = jobsById[latest.id];
    if (!Array.isArray(jobs)) return `WORKFLOW_JOBS_MISSING:${workflowName}`;
    for (const name of jobNames) {
      const matching = jobs.filter(job => job.name === name).sort((a, b) => b.id - a.id)[0];
      if (!matching || matching.status !== 'completed' || matching.conclusion !== 'success') return `JOB_NOT_GREEN:${name}`;
    }
  }
  return null;
}

export function validateDeploymentEvidence(statuses, checks) {
  const vercel = (statuses || []).filter(status => status.context === 'Vercel').sort((a, b) => b.id - a.id)[0];
  if (!vercel || vercel.state === 'pending') return 'VERCEL_PREVIEW_PENDING';
  if (vercel.state !== 'success' || !/^https:\/\/vercel\.com\/rajpunkeshwarrajgautam-boops-projects\/aira-ai-2026\/[\w-]+$/.test(vercel.target_url || '')) return 'VERCEL_PREVIEW_NOT_READY';
  const security = (checks || []).filter(check => /gitguardian/i.test(check.name || '')).sort((a, b) => b.id - a.id)[0];
  if (!security || security.status !== 'completed') return 'GITGUARDIAN_PENDING';
  if (security.conclusion !== 'success') return 'GITGUARDIAN_NOT_GREEN';
  return null;
}

export async function github(path, token, { method = 'GET', body, request = fetch } = {}) {
  assert(typeof token === 'string' && token.length > 10, 'GITHUB_TOKEN_MISSING');
  const response = await request(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}:${path.split('?')[0]}`);
  return response.status === 204 ? null : response.json();
}

async function getAllPages(path, token, request, maxPages = 5) {
  const result = [];
  for (let page = 1; page <= maxPages; page++) {
    const entries = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token, { request });
    assert(Array.isArray(entries), 'PAGINATED_RESPONSE_INVALID');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error('PAGINATION_LIMIT_EXCEEDED');
}

async function checkFreeze(token, request) {
  const issues = await getAllPages('issues?state=open', token, request, 2);
  return issues.some(issue => issue.title === FREEZE_ISSUE_TITLE && !issue.pull_request);
}

export async function evaluateLiveCandidate({ prNumber, token, request = fetch }) {
  assert(Number.isSafeInteger(prNumber) && prNumber > 0, 'INVALID_PR_NUMBER');
  const [pr, files, frozen] = await Promise.all([
    github(`pulls/${prNumber}`, token, { request }),
    getAllPages(`pulls/${prNumber}/files`, token, request, 1),
    checkFreeze(token, request)
  ]);
  const scopeDenial = validateCandidate(pr, files, { frozen });
  if (scopeDenial) return { allowed: false, reason: scopeDenial, sha: pr.head?.sha };

  const sha = pr.head.sha;
  const [workflowData, statusData, checkData] = await Promise.all([
    github(`actions/runs?head_sha=${sha}&per_page=100`, token, { request }),
    github(`commits/${sha}/status`, token, { request }),
    github(`commits/${sha}/check-runs?per_page=100`, token, { request })
  ]);
  const runs = workflowData.workflow_runs || [];
  const jobsById = {};
  for (const workflow of Object.keys(REQUIRED_WORKFLOWS)) {
    const matching = runs.filter(run => run.name === workflow && run.head_sha === sha && run.event === 'pull_request').sort((a, b) => b.id - a.id)[0];
    if (matching) {
      const jobsData = await github(`actions/runs/${matching.id}/jobs?per_page=100`, token, { request });
      assert(Array.isArray(jobsData.jobs) && jobsData.total_count === jobsData.jobs.length, 'WORKFLOW_JOBS_INCOMPLETE');
      jobsById[matching.id] = jobsData.jobs;
    }
  }
  const workflowDenial = validateWorkflowEvidence(runs, jobsById, sha);
  if (workflowDenial) return { allowed: false, reason: workflowDenial, sha };
  const deploymentDenial = validateDeploymentEvidence(statusData.statuses, checkData.check_runs);
  if (deploymentDenial) return { allowed: false, reason: deploymentDenial, sha };
  return { allowed: true, reason: 'CERTIFIED_STATIC_RELEASE', sha };
}

export async function verifyProductionCommit({ sha, request = fetch, attempts = 32, delayMs = 15000 }) {
  assert(SHA.test(sha), 'INVALID_MERGE_SHA');
  for (let i = 0; i < attempts; i++) {
    try {
      const [versionResponse, healthResponse] = await Promise.all([
        request(`${PRODUCTION_URL}/api/version?auto_release=${i}`, { cache: 'no-store', redirect: 'error' }),
        request(`${PRODUCTION_URL}/api/health?auto_release=${i}`, { cache: 'no-store', redirect: 'error' })
      ]);
      if (versionResponse.ok && healthResponse.ok) {
        const version = await versionResponse.json();
        const health = await healthResponse.json();
        if (version.commitSha === sha && version.status === 'ok' &&
            health.status === 'HEALTHY' && health.appState === 'HEALTHY' &&
            health.subsystems?.agentRuntime === 'ONLINE' &&
            health.productionMockFallback === 'DISABLED') return true;
      }
    } catch { /* transient propagation failure; retry until deadline */ }
    if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

export async function releaseCandidate({ prNumber, token, request = fetch, verify = verifyProductionCommit,
  preflightAttempts = 13, preflightDelayMs = 15000 }) {
  let candidate;
  for (let attempt = 0; attempt < preflightAttempts; attempt++) {
    candidate = await evaluateLiveCandidate({ prNumber, token, request });
    if (!['VERCEL_PREVIEW_PENDING', 'GITGUARDIAN_PENDING'].includes(candidate.reason)) break;
    if (attempt + 1 < preflightAttempts) await new Promise(resolve => setTimeout(resolve, preflightDelayMs));
  }
  if (!candidate.allowed) return { ...candidate, merged: false };
  // Exact-SHA merge is the production mutation. GitHub enforces the protected-branch ruleset.
  const merged = await github(`pulls/${prNumber}/merge`, token, {
    method: 'PUT',
    body: { sha: candidate.sha, merge_method: 'squash', commit_title: `release: autonomously certify PR #${prNumber}` },
    request
  });
  assert(merged.merged === true && SHA.test(merged.sha || ''), 'MERGE_NOT_CONFIRMED');
  const healthy = await verify({ sha: merged.sha, request });
  if (!healthy) {
    await github('issues', token, {
      method: 'POST',
      body: {
        title: FREEZE_ISSUE_TITLE,
        body: `Automatic releases are frozen after PR #${prNumber} merged at ${merged.sha}. Production /api/version and /api/health did not certify the exact deployed SHA within the bounded window. Diagnose and recover before closing this incident.`,
      },
      request
    });
    throw new Error('PRODUCTION_VERIFICATION_FAILED_RELEASE_FROZEN');
  }
  return { allowed: true, merged: true, prNumber, headSha: candidate.sha, productionSha: merged.sha };
}

async function main() {
  assert(process.env.GITHUB_REPOSITORY === REPOSITORY, 'REPOSITORY_MISMATCH');
  assert(process.env.GITHUB_REF === `refs/heads/${PRODUCTION_BRANCH}`, 'UNTRUSTED_WORKFLOW_REF');
  const token = process.env.GH_AUTONOMOUS_RELEASE_TOKEN;
  const { readFileSync } = await import('node:fs');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = event.workflow_run?.head_sha;
  // Only the completed CI run for an in-repository PR may trigger an unattended release.
  assert(event.workflow_run?.event === 'pull_request' && event.workflow_run?.conclusion === 'success', 'UNTRUSTED_TRIGGER');
  assert(event.workflow_run?.head_repository?.full_name === REPOSITORY && SHA.test(sha || ''), 'UNTRUSTED_HEAD');
  const pulls = await getAllPages(`pulls?state=open&base=${PRODUCTION_BRANCH}`, token, fetch, 2);
  for (const pr of pulls.filter(item => item.head?.sha === sha)) {
    const result = await releaseCandidate({ prNumber: pr.number, token });
    console.log(JSON.stringify({ pr: pr.number, ...result }));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error('AUTO_RELEASE_DENIED:', error.message); process.exitCode = 1; });
}
