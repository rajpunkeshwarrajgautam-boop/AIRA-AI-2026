import { stagingMigrationUrl } from './staging-db-policy.mjs';

stagingMigrationUrl(process.env);
console.log('STAGING_DB_GUARD: preview environment and isolated staging database verified.');
