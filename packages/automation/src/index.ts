import * as crypto from 'crypto';
import { AutomationDefinition, AutomationRun } from '../../contracts/src/index.js';
import { AgentRuntime } from '../../agent-runtime/src/index.js';
import { AutomationRepository, AutomationRunRepository } from './repositories.js';
import { CronExpressionParser } from 'cron-parser';

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

  public async createAutomation(input: Omit<AutomationDefinition, 'id'>): Promise<AutomationDefinition> {
    const id = `auto_${crypto.randomUUID().slice(0, 8)}`;
    const automation: AutomationDefinition = {
      ...input,
      id
    };
    await this.autoRepo.saveAutomation(automation);
    return automation;
  }

  /** Create once for each principal/objective/local schedule, even during concurrent retries. */
  public async createOrFindMatchingAutomation(input: Omit<AutomationDefinition, 'id'>): Promise<{ automation: AutomationDefinition; created: boolean }> {
    if (!input.principalId) throw new Error('AUTOMATION_PRINCIPAL_REQUIRED');
    if (input.trigger === 'CRON') {
      if (!input.cronExpression) throw new Error('AUTOMATION_CRON_REQUIRED');
      const timeZone = input.conditions?.timeZone;
      if (typeof timeZone !== 'string') throw new Error('AUTOMATION_TIMEZONE_REQUIRED');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        CronExpressionParser.parse(input.cronExpression, { tz: timeZone });
      } catch { throw new Error('AUTOMATION_SCHEDULE_INVALID'); }
    }
    return this.autoRepo.createOrFindMatching({
      ...input,
      id: `auto_${crypto.randomUUID().slice(0, 8)}`,
    });
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
      await this.autoRepo.updateLastRun(item.id, scheduledFor);
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
          const timeZone = typeof auto.conditions?.timeZone === 'string' ? auto.conditions.timeZone : 'UTC';
          const interval = CronExpressionParser.parse(auto.cronExpression, { tz: timeZone });
          const prevRunTime = interval.prev().getTime();

          // Newly created schedules must not run a past occurrence immediately.
          if (auto.createdAt && auto.createdAt > prevRunTime) continue;
          if (!auto.lastRun || auto.lastRun < prevRunTime) {
            // triggerNow owns the single transactional claim. Never claim twice.
            // Contention is expected in parallel serverless invocations.
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
