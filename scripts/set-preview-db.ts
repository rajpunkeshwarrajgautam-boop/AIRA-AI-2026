import { execSync } from 'child_process';
import * as fs from 'fs';

const envContent = fs.readFileSync('.env', 'utf8');
let dbUrl = '';
for (const line of envContent.split('\n')) {
  if (line.startsWith('STAGING_DATABASE_URL=') || line.startsWith('DATABASE_URL=')) {
    dbUrl = line.split('=')[1].trim();
    break;
  }
}

if (!dbUrl) {
  throw new Error('No DATABASE_URL found in .env');
}

console.log('Adding DATABASE_URL to Vercel Preview for branch fix/p1-5-db-critical-path-20261017...');
execSync(`npx vercel env add DATABASE_URL preview --git-branch fix/p1-5-db-critical-path-20261017 --value "${dbUrl}" --yes --force`, {
  stdio: 'inherit'
});

console.log('Also adding DATABASE_URL to general Preview environment...');
try {
  execSync(`npx vercel env add DATABASE_URL preview --value "${dbUrl}" --yes`, {
    stdio: 'inherit'
  });
} catch {
  console.log('Already exists or skipped.');
}

console.log('Done.');
