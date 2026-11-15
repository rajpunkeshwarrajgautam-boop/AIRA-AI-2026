import assert from 'node:assert/strict';
import test from 'node:test';
import type { Knex } from 'knex';
import { up, down } from '../packages/db/src/migrations/032_reconcile_workflow_run_artifacts.js';

function fakeDb(tableExists: boolean, columnExists: boolean) {
  const operations: Array<{ kind: string; table?: string; column?: string; defaultValue?: unknown }> = [];
  const schema = {
    hasTable: async (name: string) => {
      operations.push({ kind: 'check-table', table: name });
      assert.equal(name, 'workflow_runs');
      return tableExists;
    },
    hasColumn: async (table: string, column: string) => {
      operations.push({ kind: 'check-column', table, column });
      assert.equal(table, 'workflow_runs');
      assert.equal(column, 'artifacts');
      return columnExists;
    },
    alterTable: async (table: string, callback: (builder: any) => void) => {
      assert.equal(table, 'workflow_runs');
      callback({
        jsonb: (column: string) => ({
          defaultTo: (defaultValue: unknown) => {
            operations.push({ kind: 'add-jsonb', table, column, defaultValue });
          }
        })
      });
    }
  };
  return { knex: { schema } as unknown as Knex, operations };
}

test('recreates only the missing JSONB column and original migration 010 default', async () => {
  const { knex, operations } = fakeDb(true, false);
  await up(knex);
  assert.deepEqual(operations, [
    { kind: 'check-table', table: 'workflow_runs' },
    { kind: 'check-column', table: 'workflow_runs', column: 'artifacts' },
    { kind: 'add-jsonb', table: 'workflow_runs', column: 'artifacts', defaultValue: '[]' }
  ]);
});

test('preserves already-compatible staging and previously repaired databases', async () => {
  const { knex, operations } = fakeDb(true, true);
  await up(knex);
  assert.deepEqual(operations, [
    { kind: 'check-table', table: 'workflow_runs' },
    { kind: 'check-column', table: 'workflow_runs', column: 'artifacts' }
  ]);
});

test('fails closed without workflow_runs and makes no schema changes', async () => {
  const { knex, operations } = fakeDb(false, false);
  await assert.rejects(up(knex), /workflow_runs is absent/);
  assert.deepEqual(operations, [{ kind: 'check-table', table: 'workflow_runs' }]);
});

test('down refuses to delete workflow artifacts', async () => {
  await assert.rejects(down({} as Knex), /expand-only/);
});
