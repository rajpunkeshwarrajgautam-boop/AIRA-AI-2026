import * as crypto from 'crypto';
import { AutomationDefinition, AutomationRun } from '../../contracts/src/index.js';
import { AgentRuntime } from '../../agent-runtime/src/index.js';
import { AutomationRepository, AutomationRunRepository } from './repositories.js';
import parser from 'cron-parser';

function parseCronExpression(expression: string, options?: any) {
  const p: any = parser;
  if (typeof p.parseExpression === 'function') {
    return p.parseExpression(expression, options);
  }
  if (p.CronExpressionParser && typeof p.CronExpressionParser.parse === 'function') {
    return p.CronExpressionParser.parse(expression, options);
  }
  if (p.default?.parseExpression) {
    return p.default.parseExpression(expression, options);
  }
  if (p.default?.CronExpressionParser?.parse) {
    return p.default.CronExpressionParser.parse(expression, options);
  }
  throw new Error('cron-parser: parseExpression or CronExpressionParser.parse not found');
}

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

  public async createAutomation(
    input: Omit<AutomationDefinition, 'id'>, 
    clientOperationId?: string
  ): Promise<AutomationDefinition> {
    // Server-side principal-scoped idempotency check
    if (clientOperationId && input.principalId && this.autoRepo.getAutomationByClientOperationId) {
      const existing = await this.autoRepo.getAutomationByClientOperationId(input.principalId, clientOperationId);
      if (existing) {
        // Verify payload compatibility
        const isMatch = existing.name === input.name &&
          existing.objective === input.objective &&
          existing.trigger === input.trigger &&
          (existing.cronExpression || '') === (input.cronExpression || '') &&
          (existing.targetRunAt || 0) === (input.targetRunAt || 0);

        if (!isMatch) {
          const conflictErr: any = new Error(`IDEMPOTENCY_CONFLICT: Operation ID "${clientOperationId}" already exists with different payload.`);
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
        return existing;
      }
    }

    const id = `auto_${crypto.randomUUID().slice(0, 8)}`;
    const automation: AutomationDefinition = {
      ...input,
      id
    };
    await this.autoRepo.saveAutomation(automation, clientOperationId);
    return automation;
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
    explicitPrincipalId?: string,
    existingClaim?: AutomationRun
  ): Promise<string> {
    let scheduledFor = Date.now();
    let principalId: string | undefined = explicitPrincipalId;

    if (typeof scheduledForOrPrincipal === 'number') {
      scheduledFor = scheduledForOrPrincipal;
    } else if (typeof scheduledForOrPrincipal === 'string') {
      principalId = scheduledForOrPrincipal;
    }

    if (existingClaim) {
      scheduledFor = existingClaim.scheduledFor;
    }

    const item = await this.getAutomation(id, principalId);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }

    // Single Authoritative Transactional Claim:
    // If an accepted claim is passed from evaluateSchedules(), reuse it directly.
    // If triggered manually without a prior claim, claim now atomically.
    let claim = existingClaim;
    if (!claim) {
      claim = await this.runRepo.claimRun(id, scheduledFor);
      if (!claim) {
        throw new Error(`Automation run already claimed for ${scheduledFor}`);
      }
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

      item.lastRun = Date.now();
      
      // ONE_TIME LIFECYCLE: Mark one-time automation completed or disabled to ensure at-most-once execution
      if (item.trigger === 'ONE_TIME') {
        item.enabled = false;
        item.failureState = finishedRun?.state === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
      }

      await this.autoRepo.saveAutomation(item);
      return run.id;
    } catch (err: any) {
      claim.status = 'FAILED';
      claim.error = err.message;
      claim.completedAt = Date.now();
      await this.runRepo.saveRun(claim);

      if (item.trigger === 'ONE_TIME') {
        item.enabled = false;
        item.failureState = 'FAILED';
        await this.autoRepo.saveAutomation(item).catch(() => {});
      }

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

  public async recoverStaleRuns(staleThresholdMs = 15 * 60 * 1000): Promise<number> {
    if (this.runRepo.recoverStaleRuns) {
      return this.runRepo.recoverStaleRuns(staleThresholdMs);
    }
    return 0;
  }

  public async runScheduledCronCycle(): Promise<{ evaluated: number; triggered: string[] }> {
    return this.evaluateSchedules();
  }

  private async evaluateSchedules(): Promise<{ evaluated: number; triggered: string[] }> {
    const triggered: string[] = [];
    try {
      // Crash recovery: mark timed-out or abandoned runs as FAILED so schedule continues
      await this.recoverStaleRuns().catch((err: any) => {
        console.warn(`[AutomationEngine] Crash recovery warning:`, err?.message);
      });

      const dueAutomations = await this.autoRepo.getDueAutomations();
      const now = Date.now();

      for (const auto of dueAutomations) {
        // Handle genuine ONE_TIME automation
        if (auto.trigger === 'ONE_TIME') {
          if (auto.targetRunAt && now >= auto.targetRunAt && (!auto.lastRun || auto.lastRun === 0)) {
            try {
              // Authoritative transactional claim: passed directly into execution
              const claim = await this.runRepo.claimRun(auto.id, auto.targetRunAt);
              if (claim) {
                console.log(`[AutomationEngine] Triggering one-time automation: ${auto.name}`);
                const runId = await this.triggerNow(auto.id, auto.targetRunAt, undefined, claim);
                triggered.push(runId);
              }
            } catch (e: any) {
              console.error(`[AutomationEngine] Failed to process one-time automation ${auto.id}:`, e.message);
            }
          }
          continue;
        }

        // Handle recurring CRON automation
        if (!auto.cronExpression) continue;
        try {
          // Timezone-aware schedule calculation with IANA timezone
          const interval = parseCronExpression(auto.cronExpression, { tz: auto.timezone || 'UTC' });
          const prevRunTime = interval.prev().getTime();

          if (!auto.lastRun || auto.lastRun < prevRunTime) {
            // Authoritative transactional claim: passed directly into execution
            const claim = await this.runRepo.claimRun(auto.id, prevRunTime);
            if (claim) {
              console.log(`[AutomationEngine] Triggering cron automation: ${auto.name}`);
              const runId = await this.triggerNow(auto.id, prevRunTime, undefined, claim);
              triggered.push(runId);
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
