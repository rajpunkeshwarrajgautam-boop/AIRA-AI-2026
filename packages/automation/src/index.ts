import * as crypto from 'crypto';
import { AutomationDefinition, AutomationRun } from '../../contracts/src/index.js';
import { AgentRuntime } from '../../agent-runtime/src/index.js';
import { AutomationRepository, AutomationRunRepository } from './repositories.js';
import { CronExpressionParser } from 'cron-parser';
import { validTimeZone } from './reminder-intent.js';

export class AutomationEngine {
  private timerHandle: NodeJS.Timeout | null = null;

  constructor(
    private agentRuntime: AgentRuntime, 
    private autoRepo: AutomationRepository,
    private runRepo: AutomationRunRepository
  ) {}

  public async listAutomations(principalId?: string): Promise<AutomationDefinition[]> {
    return this.autoRepo.listAutomations(principalId);
  }

  public async getAutomation(id: string, principalId?: string): Promise<AutomationDefinition | undefined> {
    const item = await this.autoRepo.getAutomation(id);
    if (!item) return undefined;
    if (principalId && item.principalId !== principalId) {
      throw new Error(`ACCESS_DENIED: Automation "${id}" belongs to another user.`);
    }
    return item;
  }

  public async createAutomationWithReceipt(input: Omit<AutomationDefinition, 'id'>): Promise<{ automation: AutomationDefinition; created: boolean }> {
    if (!input.principalId) throw new Error('An authenticated principal is required.');
    if (input.trigger === 'CRON') {
      if (!input.cronExpression) throw new Error('A recurring automation requires a cron expression.');
      const timeZone = validTimeZone(input.conditions?.timeZone);
      if (!timeZone) throw new Error('A valid IANA timezone is required for recurring schedules.');
      CronExpressionParser.parse(input.cronExpression, { tz: timeZone }).next();
    }
    if (this.autoRepo.createIfMissing) return this.autoRepo.createIfMissing(input);
    const existing = (await this.autoRepo.listAutomations(input.principalId)).find(item =>
      item.enabled && item.objective === input.objective &&
      item.cronExpression === input.cronExpression &&
      item.conditions?.timeZone === input.conditions?.timeZone
    );
    if (existing) return { automation: existing, created: false };
    const automation: AutomationDefinition = { ...input, id: `auto_${crypto.randomUUID().slice(0, 12)}` };
    await this.autoRepo.saveAutomation(automation);
    return { automation, created: true };
  }

  public async createAutomation(input: Omit<AutomationDefinition, 'id'>): Promise<AutomationDefinition> {
    return (await this.createAutomationWithReceipt(input)).automation;
  }

  public async toggleAutomation(id: string, enabled: boolean, principalId?: string): Promise<AutomationDefinition> {
    const item = await this.getAutomation(id, principalId);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    item.enabled = enabled;
    await this.autoRepo.saveAutomation(item);
    return item;
  }

  public async patchAutomation(id: string, updates: Partial<AutomationDefinition>, principalId?: string): Promise<AutomationDefinition> {
    const item = await this.getAutomation(id, principalId);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    const updated = { ...item, ...updates, id, principalId: item.principalId };
    await this.autoRepo.saveAutomation(updated);
    return updated;
  }

  public async deleteAutomation(id: string, principalId?: string): Promise<boolean> {
    const item = await this.getAutomation(id, principalId);
    if (!item) {
      return false;
    }
    return this.autoRepo.deleteAutomation(id);
  }

  public async getAutomationRuns(id: string, principalId?: string): Promise<AutomationRun[]> {
    await this.getAutomation(id, principalId);
    return this.runRepo.getRunsForAutomation(id);
  }

  public async triggerNow(
    id: string, 
    scheduledForOrPrincipal?: number | string, 
    explicitPrincipalId?: string
  ): Promise<string> {
    let scheduledFor = Date.now();
    let principalId: string | undefined = explicitPrincipalId;

    if (typeof scheduledForOrPrincipal === 'number') {
      scheduledFor = scheduledForOrPrincipal;
    } else if (typeof scheduledForOrPrincipal === 'string') {
      principalId = scheduledForOrPrincipal;
    }

    const item = await this.getAutomation(id, principalId);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }

    const claim = await this.runRepo.claimRun(id, scheduledFor);
    if (!claim) {
      throw new Error(`Automation run already claimed for ${scheduledFor}`);
    }

    try {
      if (item.conditions?.kind === 'REMINDER') {
        if (!item.principalId || !this.runRepo.publishNotification) {
          throw new Error('REMINDER_DELIVERY_NOT_CONFIGURED');
        }
        await this.runRepo.publishNotification({
          automationRunId: claim.id,
          automationId: item.id,
          principalId: item.principalId,
          title: item.name,
          message: item.objective,
          scheduledFor
        });
        claim.status = 'COMPLETED';
        claim.completedAt = Date.now();
        await this.runRepo.saveRun(claim);
        await this.autoRepo.updateLastRun(item.id, scheduledFor);
        return claim.id; // durable automation run, not a model-run ID
      }
      const run = await this.agentRuntime.createRun({
        intent: 'AGENT_MISSION',
        prompt: `[Automated Trigger: ${item.name}]\nObjective: ${item.objective}`,
        systemPrompt: 'Execute scheduled automation according to strict operational criteria.',
        modelPolicy: { 
          model: 'aira-auto',
          temperature: 0.2
        } as any
      }, {
        userId: item.principalId || 'system-automation',
        sessionId: `automation-session-${item.id}`
      });

      claim.runId = run.id;
      claim.status = 'RUNNING';
      await this.runRepo.saveRun(claim);

      // Await real execution loop to terminal outcome
      await this.agentRuntime.startRun(run.id);

      const finishedRun = await this.agentRuntime.getRun(run.id);
      if (finishedRun?.state === 'COMPLETED') {
        claim.status = 'COMPLETED';
        claim.completedAt = Date.now();
      } else {
        claim.status = 'FAILED';
        claim.error = finishedRun?.error || 'Automation child run failed.';
        claim.completedAt = Date.now();
      }
      await this.runRepo.saveRun(claim);

      item.lastRun = scheduledFor;
      await this.autoRepo.updateLastRun(item.id, item.lastRun);
      return run.id;
    } catch (err: any) {
      claim.status = 'FAILED';
      claim.error = err.message;
      claim.completedAt = Date.now();
      await this.runRepo.saveRun(claim);
      throw err;
    }
  }

  public start(): void {
    if (process.env.VERCEL) {
      // In Vercel serverless environment, background setInterval is unsafe and frozen.
      // Scheduled automations must be triggered via authenticated /api/automations/cron/execute endpoint.
      return;
    }
    if (this.timerHandle) return;
    this.timerHandle = setInterval(() => {
      this.evaluateSchedules().catch(console.error);
    }, 60000);
  }

  public stop(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  public async runScheduledCronCycle(): Promise<{ evaluated: number; triggered: string[] }> {
    return this.evaluateSchedules();
  }

  private async evaluateSchedules(): Promise<{ evaluated: number; triggered: string[] }> {
    const triggered: string[] = [];
    try {
      const dueAutomations = await this.autoRepo.getDueAutomations();

      for (const auto of dueAutomations) {
        if (!auto.cronExpression) continue;
        try {
          const timeZone = validTimeZone(auto.conditions?.timeZone);
          if (!timeZone) throw new Error('Missing or invalid automation timezone');
          const now = Date.now();
          const prevRunTime = CronExpressionParser.parse(auto.cronExpression, {
            currentDate: new Date(now + 1000),
            tz: timeZone
          }).prev().getTime();
          const notBefore = Number(auto.conditions?.notBefore || 0);
          // Ignore prior slots before creation; process a recently due slot once.
          if (prevRunTime <= notBefore || prevRunTime > now || now - prevRunTime > 5 * 60_000) continue;
          if (!auto.lastRun || auto.lastRun < prevRunTime) {
            try {
              const runId = await this.triggerNow(auto.id, prevRunTime);
              triggered.push(runId);
            } catch (error: any) {
              if (!String(error?.message).includes('already claimed')) throw error;
            }
          }
        } catch (e: any) {
          console.error(`[AutomationEngine] Failed to process cron for ${auto.id}:`, e.message);
        }
      }
      return { evaluated: dueAutomations.length, triggered };
    } catch (err: any) {
      console.error(`[AutomationEngine] Schedule evaluation failed:`, err.message);
      return { evaluated: 0, triggered };
    }
  }
}
