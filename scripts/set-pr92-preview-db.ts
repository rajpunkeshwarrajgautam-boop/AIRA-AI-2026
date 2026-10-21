import { execSync } from 'child_process';

const rawCs = execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
const branchName = 'feat/aira-commercial-platform-v1';
const projectId = 'prj_FZLU4vBIYSsBn28AI6drkpD5WfbH';

const envVars: Record<string, string> = {
  DATABASE_URL: rawCs,
  NEON_AUTH_BASE_URL: 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth',
  NEON_AUTH_JWKS_URL: 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json',
  VITE_NEON_AUTH_URL: 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth',
  AIRA_EXTERNAL_AUTH_ENABLED: 'true'
};

for (const [key, value] of Object.entries(envVars)) {
  console.log(`Setting preview env var: ${key}...`);
  try {
    const out = execSync(`npx vercel env add ${key} preview --git-branch "${branchName}" --project "${projectId}" --value "${value}" --yes --force --non-interactive`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log(`✓ Set ${key}:`, out.trim().split('\n').pop());
  } catch (err: any) {
    console.error(`Failed to set ${key}:`, err.message);
  }
}
console.log('ALL PREVIEW ENV VARS CONFIGURED SUCCESSFULLY!');
