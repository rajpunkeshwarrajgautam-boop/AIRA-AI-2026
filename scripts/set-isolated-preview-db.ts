import { execSync } from 'child_process';

// Get connection string from neonctl
const rawCs = execSync('npx neonctl connection-string pr90-p1-6-7-preview-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();

console.log('Got isolated Neon connection string for mute-frost-50372225 (branch: pr90-p1-6-7-preview-isolated).');

const branchName = 'fix/p1-6-7-production-ttft-routing-verification-20261018';
const projectId = 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH';

console.log(`Setting DATABASE_URL on Vercel Preview for branch: ${branchName}...`);

execSync(`npx vercel env add DATABASE_URL preview --git-branch "${branchName}" --project "${projectId}" --value "${rawCs}" --yes --force`, {
  stdio: 'inherit'
});

console.log('Successfully set isolated DATABASE_URL on Vercel Preview for PR #90 branch!');
