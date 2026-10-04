import * as crypto from 'crypto';
import { AutomationDefinition, AutomationRun } from '../../contracts/src/index.js';
import { AgentRuntime } from '../../agent-runtime/src/index.js';
import { AutomationRepository, AutomationRunRepository } from './repositories.js';
import parser from 'cron-parser';

export class AutomationEngine {
  private timerHandle: NodeJS.Timeout | null = null;

  constructor(
    private agentRuntime: AgentRuntime, 
    private autoRepo: AutomationRepository,
    private runRepo: AutomationRunRepository
  ) {}

  public async listAutomations(): Promise<AutomationDefinition[]> {
    return this.autoRepo.listAutomations();
  }

  public async getAutomation(id: string): Promise<AutomationDefinition | undefined> {
    return this.autoRepo.getAutomation(id);
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

  public async toggleAutomation(id: string, enabled: boolean): Promise<AutomationDefinition> {
    const item = await this.autoRepo.getAutomation(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    item.enabled = enabled;
    await this.autoRepo.saveAutomation(item);
    return item;
  }

  public async patchAutomation(id: string, updates: Partial<AutomationDefinition>): Promise<AutomationDefinition> {
    const item = await this.autoRepo.getAutomation(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    const updated = { ...item, ...updates, id }; // Ensure ID cannot be overridden
    await this.autoRepo.saveAutomation(updated);
    return updated;
  }

  public async deleteAutomation(id: string): Promise<boolean> {
    return this.autoRepo.deleteAutomation(id);
  }

  public async getAutomationRuns(id: string): Promise<AutomationRun[]> {
    return this.runRepo.getRunsForAutomation(id);
  }

  public async triggerNow(id: string, scheduledFor: number = Date.now()): Promise<string> {
    const item = await this.autoRepo.getAutomation(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }

    const claim = await this.runRepo.claimRun(id, scheduledFor);
    if (!claim) {
      throw new Error(`Automation run already claimed for ${scheduledFor}`);
    }

    try {
      const run = await this.agentRuntime.createAndExecuteRun({
        intent: 'AGENT_MISSION',
        prompt: `[Automated Trigger: ${item.name}]\nObjective: ${item.objective}`,
        systemPrompt: 'Execute scheduled automation according to strict operational criteria.',
        modelPolicy: { 
          model: 'aira-auto',
          temperature: 0.2
        } as any
      }, {
        userId: 'system-automation',
        sessionId: 'automation-session'
      });

      claim.runId = run.id;
      claim.status = 'COMPLETED';
      claim.completedAt = Date.now();
      await this.runRepo.saveRun(claim);

      item.lastRun = Date.now();
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
    if (this.timerHandle) return;
    this.timerHandle = setInterval(() => {
      this.evaluateSchedules();
    }, 60000);
  }

  public stop(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private async evaluateSchedules(): Promise<void> {
    try {
      const dueAutomations = await this.autoRepo.getDueAutomations();
      const now = Date.now();

      for (const auto of dueAutomations) {
        if (!auto.cronExpression) continue;
        try {
          const interval = parser.parseExpression(auto.cronExpression);
          const nextRunTime = interval.next().getTime();
          const prevRunTime = interval.prev().getTime(); // previous theoretically scheduled time

          // If the previous scheduled time is strictly greater than the last time we ran it (with some tolerance)
          // it means it is due. Alternatively, we can check if now >= nextRun from last execution.
          // Simplest approximation: if we haven't run it within the current cron period.
          
          if (!auto.lastRun || auto.lastRun < prevRunTime) {
             const claim = await this.runRepo.claimRun(auto.id, prevRunTime);
             if (claim) {
               console.log(`[AutomationEngine] Triggering cron automation: ${auto.name}`);
               this.triggerNow(auto.id, prevRunTime).catch(e => {
                 console.error(`[AutomationEngine] Execution failed for ${auto.id}:`, e);
               });
             }
          }
        } catch (e: any) {
          console.error(`[AutomationEngine] Failed to process cron for ${auto.id}:`, e.message);
        }
      }
    } catch (err: any) {
      console.error(`[AutomationEngine] Schedule evaluation failed:`, err.message);
    }
  }
}
