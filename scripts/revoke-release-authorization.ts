import { execFileSync } from 'node:child_process';
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
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // ignore
    }
  }

  return { sha, reason, repo };
}

export async function revokeReleaseAuthorization(args: RevokeArgs): Promise<void> {
  // Validate SHA: strict 40-character lowercase hex string
  if (!args.sha || !/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new Error(`Invalid or missing commit SHA for revocation: "${args.sha}"`);
  }

  // Validate repo format: owner/repo
  if (!args.repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(args.repo)) {
    throw new Error(`Invalid repository identifier: "${args.repo}". Expected format: owner/repo`);
  }

  // Sanitize reason: strip control chars, newlines, carriage returns, limit to 80 chars
  const sanitizedReason = args.reason.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 80).trim();
  const description = `REVOKED: ${sanitizedReason || 'Authorization revoked by operator'}`;

  console.log(`[REVOKE_RELEASE_AUTH] Revoking GO LIVE status check for commit ${args.sha} on ${args.repo}...`);
  console.log(`[REVOKE_RELEASE_AUTH] Reason: "${sanitizedReason}"`);

  // Safe process argument array: no shell interpolation or metacharacter expansion
  const ghArgs = [
    'api',
    '--method', 'POST',
    `repos/${args.repo}/statuses/${args.sha}`,
    '-f', 'state=failure',
    '-f', `context=${GO_LIVE_STATUS_CONTEXT}`,
    '-f', `description=${description}`
  ];

  try {
    const resRaw = execFileSync('gh', ghArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
