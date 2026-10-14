import assert from 'node:assert/strict';
import { parseReminderRequest, isAutomationVerificationRequest } from '../packages/automation/src/reminder-parser.js';
import { AutomationEngine } from '../packages/automation/src/index.js';

const p = parseReminderRequest('remind me to add features in AIRA AI every day at 10am', 'Asia/Kolkata');
assert.equal(p.kind, 'ready');
if (p.kind === 'ready') {
  assert.equal(p.reminder.cronExpression, '0 10 * * *');
  assert.equal(p.reminder.timeZone, 'Asia/Kolkata');
  assert.match(p.reminder.name, /Add features in AIRA AI/i);
}
const weekly = parseReminderRequest('remind me to review PRs every Monday at 9:30 pm IST', 'UTC');
assert.equal(weekly.kind, 'ready');
if (weekly.kind === 'ready') {
  assert.equal(weekly.reminder.cronExpression, '30 21 * * 1');
  assert.equal(weekly.reminder.timeZone, 'Asia/Kolkata');
}
assert.equal(parseReminderRequest('remind me to submit invoices daily at 10am').kind, 'clarify');
assert.equal(parseReminderRequest('remind me to submit invoices daily at 27:20', 'UTC').kind, 'clarify');
assert.equal(parseReminderRequest('remind me to submit invoices', 'UTC').kind, 'clarify');
assert.equal(isAutomationVerificationRequest('are you sure you created it?', [
  { role: 'user', content: 'remind me every day at 10am' }
]), true);

async function runSchedulerSmoke() {
  const current = Date.now();
  let claims = 0, starts = 0, saved = 0;
  const runRepo: any = {
    async claimRun(automationId: string, scheduledFor: number) {
      claims++;
      return { id: 'test-claim-1', automationId, scheduledFor, status: 'CLAIMED', startedAt: current };
    },
    async saveRun() { saved++; }
  };
  const auto: any = {
    id: 'auto_test', name: 'Review tasks', enabled: true, agentId: 'agent-default',
    cronExpression: '* * * * *', objective: 'review tasks', principalId: 'test-user',
    conditions: { timeZone: 'UTC' }, trigger: 'CRON', lastRun: 0, createdAt: current - 120000
  };
  const autoRepo: any = {
    async getDueAutomations() { return [auto]; },
    async getAutomation() { return auto; },
    async updateLastRun(_id: string, when: number) { auto.lastRun = when; },
    async createOrFindMatching(input: any) { return { automation: input, created: true }; }
  };
  const runtime: any = {
    async createRun() { return { id: 'run_test' }; },
    async startRun() { starts++; },
    async getRun() { return { state: 'COMPLETED' }; }
  };
  const engine = new AutomationEngine(runtime, autoRepo, runRepo);
  const first = await engine.runScheduledCronCycle();
  assert.equal(first.triggered.length, 1, 'due scheduled run must trigger');
  assert.equal(claims, 1, 'must claim once, not twice');
  assert.equal(starts, 1);
  assert.ok(saved >= 2);
  const again = await engine.runScheduledCronCycle();
  assert.equal(again.triggered.length, 0, 'repeated cron tick is idempotent');
  assert.equal(claims, 1);

  auto.lastRun = 0;
  auto.createdAt = current;
  const justCreated = await engine.runScheduledCronCycle();
  assert.equal(justCreated.triggered.length, 0, 'new schedule does not fire previous occurrence');
}
runSchedulerSmoke().then(() => console.log('Automation parser and single-claim scheduler PASS')).catch(e => {
  console.error(e);
  process.exitCode = 1;
});
