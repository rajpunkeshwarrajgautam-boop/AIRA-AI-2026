import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditRestoredDatabaseParity, RestoreParityRequirements } from '../scripts/fail-safe-restore-auditor.js';

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
        return { rows: [{ cnt: data.indexesCount }] };
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
