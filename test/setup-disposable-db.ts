import { spawn } from 'node:child_process';

// Prevent WSL idle-shutdown on Windows while running disposable PostgreSQL tests
if (process.platform === 'win32') {
  try {
    const wsl = spawn('wsl', ['-d', 'Ubuntu-24.04', 'sleep', '300'], { stdio: 'ignore' });
    wsl.unref();
  } catch {}
}

// Explicitly targets the approved disposable test database when no explicit URL is provided
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://aira:aira@127.0.0.1:5432/aira_test_db';
}
if (!process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION) {
  process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION = '1';
}
