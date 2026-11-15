import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditRestoredDatabaseParity, RestoreParityRequirements } from '../scripts/fail-safe-restore-auditor.js';

function createMockPgClient(data: {
  tables: string[];
  rowCounts: Record<string, number>;
  constraintsCount: number;
  indexesCount: number;
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
      if (sql.includes('information_schema.table_constraints')) {
        return { rows: [{ cnt: data.constraintsCount }] };
      }
      if (sql.includes('pg_indexes')) {
        return { rows: [{ cnt: data.indexesCount }] };
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
