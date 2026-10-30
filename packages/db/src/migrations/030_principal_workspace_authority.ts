import { execFileSync } from 'node:child_process';
import type { Knex } from 'knex';

/**
 * Persist server-owned, revocable personal-workspace authority bound to a trusted
 * principal ID. Existing users are provisioned lazily after trusted server-side
 * authentication; legacy run/task workspace values are deliberately not backfilled
 * because older values may have been client-selected and are not authorization.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('principal_workspace_authorities')) {
    throw new Error(
      'principal_workspace_authorities already exists without migration 030 being recorded; inspect and reconcile the schema before continuing.'
    );
  }

  await knex.schema.createTable('principal_workspace_authorities', (table) => {
    // A principal may own only one personal workspace; one workspace may have
    // only one principal owner. Guest/session-backed principals are supported,
    // so this intentionally has no FK to the users table.
    table.string('principal_id', 255).primary();
    table.string('workspace_id', 255).notNullable().unique();
    table.string('state', 16).notNullable().defaultTo('ACTIVE');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.bigInteger('revoked_at').nullable();
    table.check("state IN ('ACTIVE', 'REVOKED')", [], 'chk_workspace_authority_state');
    table.check(
      "(state = 'ACTIVE' AND revoked_at IS NULL) OR (state = 'REVOKED' AND revoked_at IS NOT NULL)",
      [],
      'chk_workspace_authority_revocation_state'
    );
    table.index(['workspace_id', 'state'], 'idx_workspace_authority_workspace_state');
  });
}

/**
 * Destructive: dropping this table erases principal/workspace bindings and
 * revocation tombstones. It is safe only in a disposable database or after an
 * explicitly approved recovery plan; see docs/security-hardening/workspace-authority-lifecycle.md.
 */
export async function down(knex: Knex): Promise<void> {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.CI_DISPOSABLE_DATABASE !== 'true' ||
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL
  ) {
    throw new Error('Refusing to drop workspace authority: verified disposable PostgreSQL certification is required.');
  }

  // Environment markers alone are not proof of isolation; verify the live server,
  // run-scoped role/database, and Docker network before deleting revocation data.
  execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
  await knex.schema.dropTableIfExists('principal_workspace_authorities');
}
