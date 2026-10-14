import assert from 'node:assert/strict';
import { parseReminderIntent } from '../packages/automation/src/reminder-intent.js';
import { AutomationEngine } from '../packages/automation/src/index.js';
import type { AutomationDefinition, AutomationRun } from '../packages/contracts/src/index.js';

const create = (prompt: string, tz: string, now = Date.parse('2026-10-14T03:00:00Z')) => {
  const parsed = parseReminderIntent(prompt, tz, now);
  assert.equal(parsed.kind, 'create', prompt);
  if (parsed.kind !== 'create') throw new Error(parsed.message);
  return parsed;
};

const daily = create('remind me to add features in aira ai every day at 10am', 'Asia/Kolkata');
assert.equal(daily.objective, 'add features in aira ai');
assert.equal(daily.cronExpression, '0 10 * * *');
assert.equal(daily.timeZone, 'Asia/Calcutta');
assert.match(daily.summary, /10:00 AM/);
assert.equal(new Date(daily.nextRun).toISOString(), '2026-10-14T04:30:00.000Z');

const weekdays = create('Remind me to review the backlog every weekday at 9:15 AM', 'America/New_York');
assert.equal(weekdays.cronExpression, '15 9 * * 1-5');
const monday = create('Remind me to write code every Monday at 6:30 pm', 'UTC');
assert.equal(monday.cronExpression, '30 18 * * 1');
assert.equal(parseReminderIntent('Remind me to ship every day', 'UTC').kind, 'clarify');
assert.equal(parseReminderIntent('Remind me to ship every day at 10 AM').kind, 'clarify');
assert.equal(parseReminderIntent('Remind me to ship every day at 10 AM', 'Invalid/Time').kind, 'clarify');
assert.equal(parseReminderIntent('Remind me to ship every day at 99 AM', 'UTC').kind, 'clarify');
assert.equal(parseReminderIntent('are you sure it is scheduled?', 'UTC').kind, 'clarify');

// Fall-through must never manufacture a default 9 AM recurring automation.
assert.equal(parseReminderIntent('schedule an automation', 'UTC').kind, 'clarify');

const automations = new Map<string, AutomationDefinition>();
const runs = new Map<string, AutomationRun>();
const notifications: Array<{ principalId: string; automationRunId: string; message: string }> = [];
const autoRepo: any = {
  async listAutomations(principalId?: string) {
    return [...automations.values()].filter(a => !principalId || a.principalId === principalId);
  },
  async getAutomation(id: string) { return automations.get(id); },
  async saveAutomation(item: AutomationDefinition) { automations.set(item.id, item); },
  async deleteAutomation(id: string) { return automations.delete(id); },
  async getDueAutomations() { return [...automations.values()].filter(a => a.enabled); },
  async updateLastRun(id: string, lastRun: number) {
    const item = automations.get(id)!; item.lastRun = lastRun;
  }
};
const runRepo: any = {
  async claimRun(automationId: string, scheduledFor: number) {
    const key = `${automationId}:${scheduledFor}`;
    if (runs.has(key)) return undefined;
    const claim: AutomationRun = {
      id: `claim_${runs.size + 1}`, automationId, scheduledFor,
      startedAt: Date.now(), status: 'CLAIMED', attempt: 1
    };
    runs.set(key, claim); return claim;
  },
  async saveRun(run: AutomationRun) { runs.set(`${run.automationId}:${run.scheduledFor}`, run); },
  async publishNotification(input: { principalId: string; automationRunId: string; message: string }) {
    notifications.push(input);
  },
  async getRunsForAutomation(id: string) { return [...runs.values()].filter(r => r.automationId === id); }
};
const fakeRuntime: any = {
  async createRun() { throw new Error('Reminder delivery must not generate fake agent runs'); }
};
const engine = new AutomationEngine(fakeRuntime, autoRepo, runRepo);
const now = Date.parse('2026-10-14T04:30:15Z'); // 10:00:15 Asia/Kolkata
const initial = Date.now;
try {
  Date.now = () => now;
  const input: Omit<AutomationDefinition, 'id'> = {
    name: daily.name, principalId: 'user_A',
    enabled: true, trigger: 'CRON', cronExpression: daily.cronExpression,
    agentId: 'agent-default', objective: daily.objective,
    conditions: { kind: 'REMINDER', timeZone: daily.timeZone, notBefore: now - 60_000 },
    approvalPolicy: 'risky_only'
  };
  const once = await engine.createAutomationWithReceipt(input);
  assert.equal(once.created, true);
  const twice = await engine.createAutomationWithReceipt(input);
  assert.equal(twice.created, false);
  assert.equal(once.automation.id, twice.automation.id);
  await engine.createAutomationWithReceipt({ ...input, principalId: 'user_B' });
  assert.equal(automations.size, 2, 'Different principals require separate schedules');
  const firstCycle = await engine.runScheduledCronCycle();
  assert.equal(firstCycle.triggered.length, 2);
  assert.equal(notifications.length, 2, 'Two different principals receive separate durable reminders');
  const secondCycle = await engine.runScheduledCronCycle();
  assert.equal(secondCycle.triggered.length, 0);
  assert.equal(notifications.length, 2, 'A due slot must not deliver twice');
  await assert.rejects(engine.triggerNow(once.automation.id, now - 15_000), /already claimed/);
  assert.equal(notifications[0].message, 'add features in aira ai');
} finally {
  Date.now = initial;
}
console.log('PASS: reminder parsing, timezones, strict clarification, per-user dedupe, due execution and once-only inbox delivery.');
