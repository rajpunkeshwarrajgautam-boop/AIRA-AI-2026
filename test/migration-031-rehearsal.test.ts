import test from 'node:test';
import assert from 'node:assert/strict';
import { up, down } from '../packages/db/src/migrations/031_autonomous_agent_tasks.js';

test('AIRA AI 2026 — Migration 031 Rehearsal & Safety Barrier Suite', async (suite) => {
  await suite.test('1. Rollback Safety Barrier: Blocks down() when autonomous_agent_tasks has records', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'staging';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    let droppedTables: string[] = [];

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: table === 'autonomous_agent_tasks' ? '42' : '0' })
      })
    });

    mockKnex.schema = {
      hasTable: async () => true,
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
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    }
  });

  await suite.test('2. Rollback Safety Barrier: Blocks down() when durable_browser_sessions has records', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'staging';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    let droppedTables: string[] = [];

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: table === 'durable_browser_sessions' ? '18' : '0' })
      })
    });

    mockKnex.schema = {
      hasTable: async () => true,
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
          assert.match(err.message, /durable_browser_sessions.*contains 18 user record\(s\)/);
          return true;
        }
      );
      assert.equal(droppedTables.length, 0, 'No tables should be dropped when durable_browser_sessions has records');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    }
  });

  await suite.test('3. Environment Protection: Blocks down() in staging/prod even if tables are empty', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'production';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    let droppedTables: string[] = [];

    const mockKnex: any = () => ({
      count: () => ({
        first: async () => ({ count: '0' })
      })
    });

    mockKnex.schema = {
      hasTable: async () => true,
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
          assert.match(err.message, /Destructive DDL is forbidden/);
          return true;
        }
      );
      assert.equal(droppedTables.length, 0, 'Empty tables must not be dropped in production without explicit authorization');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    }
  });

  await suite.test('4. Partial Migration Toleration: Handles missing table scenario safely', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'staging';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    const mockKnex: any = (table: string) => ({
      count: () => ({
        first: async () => ({ count: table === 'durable_browser_sessions' ? '7' : '0' })
      })
    });

    // autonomous_agent_tasks is missing, but durable_browser_sessions exists with records
    mockKnex.schema = {
      hasTable: async (tbl: string) => tbl === 'durable_browser_sessions',
      dropTableIfExists: async () => {}
    };

    try {
      await assert.rejects(
        async () => {
          await down(mockKnex);
        },
        (err: any) => {
          assert.match(err.message, /durable_browser_sessions.*contains 7 user record\(s\)/);
          return true;
        }
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalDestructive !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = originalDestructive;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    }
  });

  await suite.test('5. Disposable Test DB: down() permitted when tables empty and verified disposable', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalCiDisposable = process.env.CI_DISPOSABLE_DATABASE;
    const originalDbUrl = process.env.DATABASE_URL;
    const originalTestUrl = process.env.ISOLATED_TEST_DATABASE_URL;

    process.env.NODE_ENV = 'test';
    process.env.CI_DISPOSABLE_DATABASE = 'true';
    process.env.DATABASE_URL = 'postgresql://aira:aira@127.0.0.1:5432/disposable_test';
    process.env.ISOLATED_TEST_DATABASE_URL = 'postgresql://aira:aira@127.0.0.1:5432/disposable_test';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    let droppedTables: string[] = [];

    const mockKnex: any = () => ({
      count: () => ({
        first: async () => ({ count: '0' })
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
      if (originalCiDisposable !== undefined) process.env.CI_DISPOSABLE_DATABASE = originalCiDisposable;
      else delete process.env.CI_DISPOSABLE_DATABASE;
      if (originalDbUrl !== undefined) process.env.DATABASE_URL = originalDbUrl;
      else delete process.env.DATABASE_URL;
      if (originalTestUrl !== undefined) process.env.ISOLATED_TEST_DATABASE_URL = originalTestUrl;
      else delete process.env.ISOLATED_TEST_DATABASE_URL;
    }
  });

  await suite.test('6. Rollback Override: down() succeeds with explicit AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDestructive = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    process.env.NODE_ENV = 'production';
    process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = 'true';

    let droppedTables: string[] = [];

    const mockKnex: any = () => ({
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

  await suite.test('7. Forward Migration: up() idempotently checks tables and adds missing columns/indexes', async () => {
    const createdTables: string[] = [];
    const alteredTables: string[] = [];

    const mockKnex: any = {
      schema: {
        hasTable: async (tbl: string) => tbl === 'autonomous_agent_tasks', // already exists
        hasColumn: async (tbl: string, col: string) => col === 'working_memory',
        createTable: async (tbl: string) => {
          createdTables.push(tbl);
        },
        alterTable: async (tbl: string) => {
          alteredTables.push(tbl);
        }
      },
      raw: async () => ({ rows: [{ exists: 1 }] })
    };

    await up(mockKnex);

    assert.ok(createdTables.includes('durable_browser_sessions'), 'Creates durable_browser_sessions if missing');
  });
});
