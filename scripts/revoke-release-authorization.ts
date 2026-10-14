import { execSync } from 'node:child_process';
import {
  AUTHORIZED_REPOSITORY_OWNER,
  GO_LIVE_STATUS_CONTEXT
} from '../src/security/release-authorization-validator.js';

interface RevokeArgs {
  sha: string;
  reason: string;
  repo: string;
}

function parseArgs(): RevokeArgs {
  const args = process.argv.slice(2);
  let sha = process.env.CANDIDATE_SHA || '';
  let reason = 'Authorization expired or revoked by operator';
  let repo = process.env.GITHUB_REPOSITORY || `${AUTHORIZED_REPOSITORY_OWNER}/AIRA-AI-2026`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sha' && args[i + 1]) {
      sha = args[++i].trim();
    } else if (args[i] === '--reason' && args[i + 1]) {
      reason = args[++i].trim();
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[++i].trim();
    }
  }

  if (!sha) {
    try {
      sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      // ignore
    }
  }

  return { sha, reason, repo };
}

export async function revokeReleaseAuthorization(args: RevokeArgs): Promise<void> {
  if (!args.sha || !/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new Error(`Invalid or missing commit SHA for revocation: "${args.sha}"`);
  }

  console.log(`[REVOKE_RELEASE_AUTH] Revoking GO LIVE status check for commit ${args.sha} on ${args.repo}...`);
  console.log(`[REVOKE_RELEASE_AUTH] Reason: "${args.reason}"`);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : '';

  const cmd = `gh api ${authHeader} --method POST "repos/${args.repo}/statuses/${args.sha}" -f state="failure" -f context="${GO_LIVE_STATUS_CONTEXT}" -f description="REVOKED: ${args.reason.slice(0, 80)}"`;

  try {
    const resRaw = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const res = JSON.parse(resRaw);
    console.log(`[REVOKE_RELEASE_AUTH] Successfully posted status failure for context "${GO_LIVE_STATUS_CONTEXT}".`);
    console.log(`[REVOKE_RELEASE_AUTH] Status ID: ${res.id}, State: ${res.state}`);
    console.log(`[REVOKE_RELEASE_AUTH] PR merge gating is now BLOCKED on candidate ${args.sha}.`);
  } catch (err: any) {
    const stderr = err?.stderr?.toString() || err?.message || String(err);
    throw new Error(`Failed to revoke release status check via GitHub API: ${stderr}`);
  }
}

async function main() {
  const args = parseArgs();
  await revokeReleaseAuthorization(args);
}

if (process.argv[1]?.includes('revoke-release-authorization')) {
  main().catch(err => {
    console.error('[REVOKE_RELEASE_AUTH] Fatal error:', err);
    process.exit(1);
  });
}
