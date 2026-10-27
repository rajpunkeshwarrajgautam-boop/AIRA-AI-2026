import { execSync } from 'node:child_process';

// Dynamically fetch and set the approved isolated Neon preview branch URL before db module initializes
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost')) {
  try {
    let connStr = execSync('neon connection-string br-muddy-wave-b3zxhkqf --project-id mute-frost-50372225', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!connStr.includes('sslmode=')) {
      connStr += (connStr.includes('?') ? '&' : '?') + 'sslmode=require';
    }
    process.env.DATABASE_URL = connStr;
  } catch (e) {
    console.warn('[setup-isolated-neon] Unable to fetch neon connection string automatically:', e);
  }
}
process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION = '1';
