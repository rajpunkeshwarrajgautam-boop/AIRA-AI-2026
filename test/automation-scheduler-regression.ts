import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AutomationEngine } from '../packages/automation/src/index.js';
import { PostgresAutomationRepository, PostgresAutomationRunRepository } from '../packages/automation/src/repositories.js';
import { db, closeDb } from '../packages/db/src/index.js';
import { requireCronAuthorization } from '../apps/api/src/auth/cron-auth.js';

// Real PostgreSQL claim/persistence regression with a deterministic child-run
// fixture. This does not certify deployed model calls or a platform scheduler.
const repo = new PostgresAutomationRepository();
const runs = new PostgresAutomationRunRepository();
const id = `auto_cert_${randomUUID()}`;
const owner = `scheduler_cert_${randomUUID()}`;
let executions = 0;
const runtime = {
  createRun: async (_request: unknown, principal: any) => {
    assert.equal(principal.userId, owner);
    return { id: `scheduler_child_${randomUUID()}` };
  },
  startRun: async () => { executions++; },
  getRun: async () => ({ state: 'COMPLETED' }),
};
const engine = new AutomationEngine(runtime as any, repo, runs);
const cycleTime = Date.UTC(2026, 9, 10, 12, 34, 15);
try {
  await repo.saveAutomation({ id, principalId: owner, name: 'Scheduler certification fixture', enabled: true, trigger: 'CRON', cronExpression: '* * * * *', conditions: {}, agentId: 'agent-default', objective: 'Fixture only', approvalPolicy: 'autonomous' });
  const first = await engine.runScheduledCronCycle(cycleTime);
  assert.equal(first.triggered.length, 1, 'one due schedule must execute');
  assert.equal(executions, 1);
  const records = await runs.getRunsForAutomation(id);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'COMPLETED');
  // Reset only our fixture's watermark to simulate a competing stale worker.
  await repo.updateLastRun(id, 0);
  await Promise.all([engine.runScheduledCronCycle(cycleTime), engine.runScheduledCronCycle(cycleTime)]);
  assert.equal(executions, 1, 'atomic claim must prevent duplicate execution');
  assert.equal((await runs.getRunsForAutomation(id)).length, 1);
  const oldSecret = process.env.CRON_SECRET;
  try {
    function authorize(header?: string) {
      let status = 0, next = false;
      const res = { status(code: number) { status = code; return this; }, json() { return this; } };
      requireCronAuthorization({ headers: { authorization: header } } as any, res as any, () => { next = true; });
      return { status, next };
    }
    delete process.env.CRON_SECRET;
    assert.equal(authorize().status, 503);
    process.env.CRON_SECRET = 'scheduler-regression-only-0123456789abcdef';
    assert.equal(authorize().status, 401);
    assert.equal(authorize('Bearer invalid').status, 401);
    assert.equal(authorize(`Bearer ${process.env.CRON_SECRET}`).next, true);
  } finally {
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }
  console.log('PASS: scheduled execution, duplicate fencing and cron authorization');
} finally {
  await db('automation_runs').where({ automation_id: id }).delete();
  await db('automations').where({ id }).delete();
  await closeDb();
}
