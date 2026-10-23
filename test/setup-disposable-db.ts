// Explicitly targets the approved disposable test database when no explicit URL is provided
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://aira:aira@localhost:5432/aira_test_db';
}
if (!process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION) {
  process.env.ALLOW_DESTRUCTIVE_TEST_MIGRATION = '1';
}
