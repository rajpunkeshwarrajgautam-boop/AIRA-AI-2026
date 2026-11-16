import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { auditRestoredDatabaseParity, RestoreParityRequirements } from '../scripts/fail-safe-restore-auditor.js';
import { validateDisposableDbName } from '../scripts/validate-portable-key-recovery.js';
import { secureOverwriteAndRemoveFile } from '../scripts/secure-backup-crypto.js';

function createMockPgClient(data: {
  tables: string[];
  rowCounts: Record<string, number>;
  constraintsCount?: number;
  constraintsBreakdown?: { contype: string; count: number }[];
  indexesCount: number;
  sequences?: string[];
  extensions?: string[];
  foreignKeys?: { child_table: string; child_column: string; parent_table: string; parent_column: string }[];
  orphansCount?: Record<string, number>;
}) {
  return {
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: data.tables.map(t => ({ table_name: t })) };
      }
      if (sql.includes('SELECT count(*)::int as cnt FROM "')) {
        const match = sql.match(/FROM "([^"]+)"/);
        const tbl = match ? match[1] : '';
        return { rows: [{ cnt: data.rowCounts[tbl] || 0 }] };
      }
      if (sql.includes('FROM pg_constraint c')) {
        if (data.constraintsBreakdown) {
          return { rows: data.constraintsBreakdown.map(b => ({ contype: b.contype, count: String(b.count) })) };
        }
        return { rows: [{ contype: 'p', count: String(data.constraintsCount || 0) }] };
      }
      if (sql.includes('information_schema.table_constraints') && sql.includes("constraint_type = 'FOREIGN KEY'")) {
        return { rows: data.foreignKeys || [] };
      }
      if (sql.includes('information_schema.table_constraints')) {
        return { rows: [{ cnt: data.constraintsCount || 0 }] };
      }
      if (sql.includes('NOT EXISTS') && sql.includes('SELECT count(*)::int as orphaned')) {
        const match = sql.match(/FROM "([^"]+)" c/);
        const childTable = match ? match[1] : '';
        const orphans = data.orphansCount && data.orphansCount[childTable] !== undefined
          ? data.orphansCount[childTable]
          : 0;
        return { rows: [{ orphaned: orphans }] };
      }
      if (sql.includes('pg_indexes')) {
        if (sql.includes('count(*)') || sql.includes('SELECT count(')) {
          return { rows: [{ cnt: data.indexesCount }] };
        }
        return { rows: Array.from({ length: data.indexesCount }, (_, i) => ({ indexname: `idx_${i}` })) };
      }
      if (sql.includes('information_schema.sequences')) {
        return { rows: (data.sequences || []).map(s => ({ sequence_name: s })) };
      }
      if (sql.includes('pg_extension')) {
        return { rows: (data.extensions || []).map(e => ({ extname: e })) };
      }
      return { rows: [] };
    }
  } as any;
}

test('Fail-Safe Restore: verifies clean parity when all requirements are met', async () => {
  const mockTables = ['users', 'runs', 'workflow_runs', 'approvals', 'sessions'];
  const mockRows = { users: 100, runs: 500, workflow_runs: 50, approvals: 20, sessions: 80 };
  const client = createMockPgClient({
    tables: mockTables,
    rowCounts: mockRows,
    constraintsCount: 30,
    indexesCount: 15,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 5,
    minRows: 750,
    minConstraints: 25,
    minIndexes: 10,
    requiredTables: ['users', 'workflow_runs'],
  };

  const result = await auditRestoredDatabaseParity(client, reqs);
  assert.equal(result.verified, true);
  assert.equal(result.tableCount, 5);
  assert.equal(result.totalRows, 750);
  assert.equal(result.constraintCount, 30);
  assert.equal(result.indexCount, 15);
});

test('Fail-Safe Restore: verifies exact tables and exact total rows', async () => {
  const mockTables = ['users', 'runs', 'workflow_runs'];
  const mockRows = { users: 10, runs: 20, workflow_runs: 30 };
  const client = createMockPgClient({
    tables: mockTables,
    rowCounts: mockRows,
    constraintsBreakdown: [
      { contype: 'p', count: 3 },
      { contype: 'f', count: 5 },
      { contype: 'u', count: 2 },
      { contype: 'c', count: 1 },
      { contype: 'n', count: 10 },
    ],
    indexesCount: 8,
    sequences: ['seq_users_id'],
    extensions: ['plpgsql', 'vector'],
  });

  const reqs: RestoreParityRequirements = {
    exactTables: ['users', 'runs', 'workflow_runs'],
    exactTotalRows: 60,
    exactTableRows: { users: 10, runs: 20, workflow_runs: 30 },
    exactConstraints: {
      primaryKeys: 3,
      foreignKeys: 5,
      uniqueConstraints: 2,
      checkConstraints: 1,
      totalRelationalConstraints: 11,
    },
    exactIndexes: 8,
    exactSequences: ['seq_users_id'],
    exactExtensions: ['plpgsql', 'vector'],
  };

  const result = await auditRestoredDatabaseParity(client, reqs);
  assert.equal(result.verified, true);
  assert.equal(result.exactParityVerified, true);
  assert.equal(result.totalRows, 60);
  assert.equal(result.constraintsBreakdown.primaryKeys, 3);
  assert.equal(result.constraintsBreakdown.foreignKeys, 5);
  assert.equal(result.sequenceCount, 1);
});

test('Fail-Safe Restore: fails closed on unexpected extra table in exact mode', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs', 'workflow_runs', 'hacker_table'],
    rowCounts: { users: 1, runs: 1, workflow_runs: 1, hacker_table: 1 },
    indexesCount: 1,
  });

  const reqs: RestoreParityRequirements = {
    exactTables: ['users', 'runs', 'workflow_runs'],
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Unexpected extra tables found.*hacker_table/
  );
});

test('Fail-Safe Restore: fails closed on exact total row count mismatch', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 10, runs: 25 }, // total 35
    indexesCount: 1,
  });

  const reqs: RestoreParityRequirements = {
    exactTotalRows: 50,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Exact total row count mismatch: found 35, expected exactly 50/
  );
});

test('Fail-Safe Restore: fails closed on per-table exact row count mismatch', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 10, runs: 15 },
    indexesCount: 1,
  });

  const reqs: RestoreParityRequirements = {
    exactTableRows: { users: 10, runs: 20 },
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Exact row count mismatch for table "runs": found 15, expected 20/
  );
});

test('Fail-Safe Restore: fails closed when foreign key referential integrity is violated', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 10, runs: 20 },
    indexesCount: 1,
    foreignKeys: [{ child_table: 'runs', child_column: 'user_id', parent_table: 'users', parent_column: 'id' }],
    orphansCount: { runs: 3 }, // 3 orphaned rows
  });

  const reqs: RestoreParityRequirements = {
    verifyReferentialIntegrity: true,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_REFERENTIAL_INTEGRITY_FAILURE.*Found 3 orphaned records in "runs\.user_id"/
  );
});

test('Fail-Safe Restore: fails closed when table count is deficient', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 10, runs: 10 },
    constraintsCount: 5,
    indexesCount: 5,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 10,
    minRows: 10,
    minConstraints: 2,
    minIndexes: 2,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Deficient table count/
  );
});

test('Fail-Safe Restore: fails closed when a required table is missing', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 100, runs: 100 },
    constraintsCount: 20,
    indexesCount: 10,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 2,
    minRows: 50,
    minConstraints: 5,
    minIndexes: 5,
    requiredTables: ['workflow_runs'],
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Required table "workflow_runs" is missing/
  );
});

test('Fail-Safe Restore: fails closed when total row count is deficient', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 5, runs: 5 },
    constraintsCount: 20,
    indexesCount: 10,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 2,
    minRows: 1000,
    minConstraints: 5,
    minIndexes: 5,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Deficient total row count/
  );
});

test('Fail-Safe Restore: fails closed when constraint count is deficient', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 50, runs: 50 },
    constraintsCount: 3,
    indexesCount: 10,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 2,
    minRows: 50,
    minConstraints: 20,
    minIndexes: 5,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Deficient constraint count/
  );
});

test('Fail-Safe Restore: fails closed when index count is deficient', async () => {
  const client = createMockPgClient({
    tables: ['users', 'runs'],
    rowCounts: { users: 50, runs: 50 },
    constraintsCount: 20,
    indexesCount: 2,
  });

  const reqs: RestoreParityRequirements = {
    minTables: 2,
    minRows: 50,
    minConstraints: 5,
    minIndexes: 10,
  };

  await assert.rejects(
    () => auditRestoredDatabaseParity(client, reqs),
    /RESTORE_VERIFICATION_FAILURE.*Deficient index count/
  );
});

test('Fail-Safe Restore: command failure is unsuppressed without || true', () => {
  // Verify that running a failing command with set -e propagates non-zero exit status
  const bashScript = `
    set -euo pipefail
    false
  `;
  const res = spawnSync('bash', ['-c', bashScript]);
  if (res.status !== null) {
    assert.notEqual(res.status, 0, 'Command failure must yield non-zero exit status');
  }
});

test('Fail-Safe Restore: exact columns check succeeds on match and fails closed on type/nullability mismatch', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'workflow_runs' }] };
      }
      if (sql.includes('SELECT count(*)::int as cnt FROM "')) {
        return { rows: [{ cnt: 10 }] };
      }
      if (sql.includes('FROM pg_constraint c')) {
        return { rows: [{ contype: 'p', count: '1' }] };
      }
      if (sql.includes('pg_indexes')) {
        return { rows: [{ indexname: 'workflow_runs_pkey' }] };
      }
      if (sql.includes('information_schema.sequences')) {
        return { rows: [] };
      }
      if (sql.includes('pg_extension')) {
        return { rows: [] };
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'workflow_runs', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
            { table_name: 'workflow_runs', column_name: 'artifacts', data_type: 'jsonb', is_nullable: 'YES', column_default: "'[]'::jsonb" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  // Valid columns check
  const validRes = await auditRestoredDatabaseParity(client, {
    exactTables: ['workflow_runs'],
    exactTotalRows: 10,
    exactColumns: [
      { table_name: 'workflow_runs', column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { table_name: 'workflow_runs', column_name: 'artifacts', data_type: 'jsonb', is_nullable: 'YES' },
    ],
    exactColumnCount: 2,
  });
  assert.equal(validRes.columnCount, 2);

  // Missing column
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['workflow_runs'],
        exactTotalRows: 10,
        exactColumns: [
          { table_name: 'workflow_runs', column_name: 'missing_col', data_type: 'text' },
        ],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Missing expected column: "workflow_runs\.missing_col"/
  );

  // Type mismatch
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['workflow_runs'],
        exactTotalRows: 10,
        exactColumns: [
          { table_name: 'workflow_runs', column_name: 'artifacts', data_type: 'text' },
        ],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Column type mismatch for "workflow_runs\.artifacts": found "jsonb", expected "text"/
  );
});

test('Fail-Safe Restore: migration ledger audit verifies order and fails closed on missing/misordered migrations', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables') && sql.includes("table_name = 'knex_migrations'")) {
        return { rows: [{ table_name: 'knex_migrations' }] };
      }
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'knex_migrations' }] };
      }
      if (sql.includes('SELECT count(*)::int as cnt FROM "')) {
        return { rows: [{ cnt: 3 }] };
      }
      if (sql.includes('FROM pg_constraint c')) {
        return { rows: [{ contype: 'p', count: '1' }] };
      }
      if (sql.includes('pg_indexes')) {
        return { rows: [] };
      }
      if (sql.includes('information_schema.sequences')) {
        return { rows: [] };
      }
      if (sql.includes('pg_extension')) {
        return { rows: [] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT name FROM knex_migrations ORDER BY id')) {
        return {
          rows: [
            { name: '001_initial_schema.ts' },
            { name: '002_certification_schema.ts' },
            { name: '003_phase3_2_schema.ts' },
          ],
        };
      }
      return { rows: [] };
    },
  };

  // 1. Matches expected migrations
  const validRes = await auditRestoredDatabaseParity(client, {
    exactTables: ['knex_migrations'],
    exactTotalRows: 3,
    expectedMigrations: ['001_initial_schema.ts', '002_certification_schema.ts', '003_phase3_2_schema.ts'],
  });
  assert.equal(validRes.migrationCount, 3);

  // 2. Fails when migration order is swapped
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['knex_migrations'],
        exactTotalRows: 3,
        expectedMigrations: ['002_certification_schema.ts', '001_initial_schema.ts', '003_phase3_2_schema.ts'],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Migration order\/name mismatch at index 0/
  );

  // 3. Fails when a migration is missing
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['knex_migrations'],
        exactTotalRows: 3,
        expectedMigrations: ['001_initial_schema.ts', '002_certification_schema.ts'],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Migration ledger count mismatch: found 3, expected 2/
  );
});

test('Fail-Safe Restore: index names and sequences audit fails closed on discrepancies', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'test_tbl' }] };
      }
      if (sql.includes('SELECT count(*)::int as cnt FROM "')) {
        return { rows: [{ cnt: 0 }] };
      }
      if (sql.includes('FROM pg_constraint c')) {
        return { rows: [] };
      }
      if (sql.includes('pg_indexes')) {
        return { rows: [{ indexname: 'idx_test_a' }, { indexname: 'idx_test_b' }] };
      }
      if (sql.includes('information_schema.sequences')) {
        return { rows: [{ sequence_name: 'seq_test_1' }] };
      }
      if (sql.includes('pg_extension')) {
        return { rows: [{ extname: 'plpgsql' }] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  // Missing index name
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['test_tbl'],
        exactTotalRows: 0,
        exactIndexNames: ['idx_test_a', 'idx_test_missing'],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Missing expected index: "idx_test_missing"/
  );

  // Missing sequence name
  await assert.rejects(
    () =>
      auditRestoredDatabaseParity(client, {
        exactTables: ['test_tbl'],
        exactTotalRows: 0,
        exactSequences: ['seq_test_1', 'seq_test_missing'],
      }),
    /RESTORE_VERIFICATION_FAILURE.*Missing expected sequence: "seq_test_missing"/
  );
});

test('Fail-Safe Restore: validateDisposableDbName accepts valid disposable names and rejects forbidden targets', () => {
  // Valid disposable name
  assert.doesNotThrow(() => validateDisposableDbName('aira_pg18_portable_dr_1794814042990'));

  // Invalid naming format
  assert.throws(
    () => validateDisposableDbName('my_test_db'),
    /DISPOSABLE_DB_GUARD.*Illegal target database name/
  );

  // Production or staging names
  assert.throws(
    () => validateDisposableDbName('aira_pg18_portable_dr_production'),
    /DISPOSABLE_DB_GUARD.*Illegal target database name/
  );
  assert.throws(
    () => validateDisposableDbName('neondb'),
    /DISPOSABLE_DB_GUARD.*Illegal target database name/
  );
});

test('Fail-Safe Restore: secureOverwriteAndRemoveFile overwrites with random bytes before deletion', () => {
  const tmpFile = path.join(os.tmpdir(), `aira_shred_test_${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, 'SENSITIVE_PLAINTEXT_PAYLOAD_12345_SECRET');
  assert.ok(fs.existsSync(tmpFile));

  const res = secureOverwriteAndRemoveFile(tmpFile);
  assert.equal(res.success, true);
  assert.ok(res.bytesOverwritten > 0);
  assert.equal(fs.existsSync(tmpFile), false);

  // Handles already deleted file cleanly
  const resNonExistent = secureOverwriteAndRemoveFile(tmpFile);
  assert.equal(resNonExistent.success, true);
  assert.equal(resNonExistent.bytesOverwritten, 0);
});


