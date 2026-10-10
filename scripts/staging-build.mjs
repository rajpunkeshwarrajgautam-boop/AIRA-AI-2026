import { spawnSync } from 'node:child_process';
import { stagingMigrationUrl } from './staging-db-policy.mjs';

// Validate every target before starting any child process. This staging branch
// remains deliberately unsuitable for production or arbitrary PR migrations.
const migrationUrl = stagingMigrationUrl(process.env);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const script of ['db:migrate', 'db:verify:deploy', 'build']) {
  const result = spawnSync(npm, ['run', script], {
    stdio: 'inherit',
    env: script === 'db:migrate'
      ? { ...process.env, DATABASE_URL: migrationUrl }
      : process.env,
  });
  if (result.error) throw new Error('STAGING_BUILD: unable to start ' + script);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
