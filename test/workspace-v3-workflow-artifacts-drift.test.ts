import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Knex } from 'knex';
import { up } from '../packages/db/src/migrations/032_workspace_experience.js';

const stop = new Error('reached unrelated onboarding migration');
type Operation = { type: string; column?: string; defaultValue?: unknown };

function migrationHarness(columnPresent: boolean, baseTablePresent = true) {
  const operations: Operation[] = [];
  const schema = {
    hasTable: async (table: string) => {
      if (table === 'workflow_runs') return baseTablePresent;
      // Tests isolate the schema compatibility prelude. No other table writes
      // or guest/onboarding changes are permitted in this fake transaction.
      throw stop;
    },
    hasColumn: async (table: string, column: string) => {
      assert.equal(table, 'workflow_runs');
      assert.equal(column, 'artifacts');
      return columnPresent;
    },
    alterTable: async (table: string, callback: (builder: any) => void) => {
      assert.equal(table, 'workflow_runs');
      const builder = {
        jsonb: (column: string) => ({
          defaultTo: (defaultValue: unknown) => {
            operations.push({ type: 'add-jsonb', column, defaultValue });
            return builder;
          },
        }),
      };
      callback(builder);
    },
  };
  return { client: { schema } as unknown as Knex, operations };
}

describe('migration 032 production schema drift repair', () => {
  it('adds only the missing workflow artifacts JSONB with the original migration 010 default', async () => {
    const { client, operations } = migrationHarness(false);
    await assert.rejects(up(client), (error: unknown) => error === stop);
    assert.deepEqual(operations, [{ type: 'add-jsonb', column: 'artifacts', defaultValue: '[]' }]);
  });

  it('leaves already-correct staging schemas untouched', async () => {
    const { client, operations } = migrationHarness(true);
    await assert.rejects(up(client), (error: unknown) => error === stop);
    assert.deepEqual(operations, []);
  });

  it('fails closed if the base workflow table is absent', async () => {
    const { client, operations } = migrationHarness(false, false);
    await assert.rejects(up(client), /workflow_runs table missing/);
    assert.deepEqual(operations, []);
  });
});
