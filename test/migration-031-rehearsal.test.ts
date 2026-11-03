import test from 'node:test';
import assert from 'node:assert/strict';
import { up, down } from '../packages/db/src/migrations/031_autonomous_agent_tasks.js';

test('AIRA AI 2026 — Migration 031 Rehearsal & Safety Barrier Suite', async (suite) => {
  await suite.test('Rollback Safety Barrier: Blocks down() when user records exist', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    const originalTestEnv = process.env.AIRA_TEST_ENVIRONMENT;

    process.env.NODE_ENV = 'staging';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    delete process.env.AIRA_TEST_ENVIRONMENT;

    let droppedTables: string[] = [];

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: '42' })
      })
    });

    mockKnex.schema = {
      hasTable: async (tbl: string) => tbl === 'autonomous_agent_tasks',
      dropTableIfExists: async (tbl: string) => {
        droppedTables.push(tbl);
      }
    };

    try {
      await assert.rejects(
        async () => {
          await down(mockKnex);
        },
        (err: any) => {
          assert.match(err.message, /\[MIGRATION SAFETY BARRIER\]/);
          assert.match(err.message, /autonomous_agent_tasks.*contains 42 user record\(s\)/);
          return true;
        }
      );
      assert.equal(droppedTables.length, 0, 'No tables should be dropped when safety barrier triggers');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      if (originalTestEnv !== undefined) process.env.AIRA_TEST_ENVIRONMENT = originalTestEnv;
    }
  });

  await suite.test('Rollback Permitted: down() succeeds when table is empty', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    const originalTestEnv = process.env.AIRA_TEST_ENVIRONMENT;

    process.env.NODE_ENV = 'staging';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    delete process.env.AIRA_TEST_ENVIRONMENT;

    let droppedTables: string[] = [];

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: '0' })
      })
    });

    mockKnex.schema = {
      hasTable: async (tbl: string) => tbl === 'autonomous_agent_tasks',
      dropTableIfExists: async (tbl: string) => {
        droppedTables.push(tbl);
      }
    };

    try {
      await down(mockKnex);
      assert.deepEqual(droppedTables, ['durable_browser_sessions', 'autonomous_agent_tasks']);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      if (originalTestEnv !== undefined) process.env.AIRA_TEST_ENVIRONMENT = originalTestEnv;
    }
  });

  await suite.test('Rollback Override: down() succeeds with explicit AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'staging';
    process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = 'true';

    let droppedTables: string[] = [];

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: '99' })
      })
    });

    mockKnex.schema = {
      hasTable: async () => true,
      dropTableIfExists: async (tbl: string) => {
        droppedTables.push(tbl);
      }
    };

    try {
      await down(mockKnex);
      assert.deepEqual(droppedTables, ['durable_browser_sessions', 'autonomous_agent_tasks']);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    }
  });

  await suite.test('Forward Migration: up() idempotently checks for tables and alters existing columns', async () => {
    const createdTables: string[] = [];
    const alteredTables: string[] = [];
    const createdColumns: string[] = [];

    const mockKnex: any = {
      schema: {
        hasTable: async (tbl: string) => tbl === 'autonomous_agent_tasks', // already exists
        hasColumn: async (tbl: string, col: string) => col === 'working_memory',
        createTable: async (tbl: string, cb: any) => {
          createdTables.push(tbl);
        },
        alterTable: async (tbl: string, cb: any) => {
          alteredTables.push(tbl);
        }
      },
      raw: async () => ({ rows: [{ exists: 1 }] })
    };

    await up(mockKnex);

    // Because autonomous_agent_tasks exists, it checks columns and creates durable_browser_sessions
    assert.ok(createdTables.includes('durable_browser_sessions'));
  });
});
