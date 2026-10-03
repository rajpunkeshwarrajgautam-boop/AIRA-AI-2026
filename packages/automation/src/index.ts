import * as crypto from 'crypto';
import { AutomationDefinition } from '../../contracts/src/index.js';
import { AgentRuntime } from '../../agent-runtime/src/index.js';

export class AutomationEngine {
  private automations: Map<string, AutomationDefinition> = new Map();
  private timerHandle: NodeJS.Timeout | null = null;

  constructor(private agentRuntime: AgentRuntime) {
    this.seedDefaultAutomations();
  }

  public listAutomations(): AutomationDefinition[] {
    return Array.from(this.automations.values());
  }

  public getAutomation(id: string): AutomationDefinition | undefined {
    return this.automations.get(id);
  }

  public createAutomation(input: Omit<AutomationDefinition, 'id'>): AutomationDefinition {
    const id = `auto_${crypto.randomUUID().slice(0, 8)}`;
    const automation: AutomationDefinition = {
      ...input,
      id
    };
    this.automations.set(id, automation);
    return automation;
  }

  public toggleAutomation(id: string, enabled: boolean): AutomationDefinition {
    const item = this.automations.get(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    item.enabled = enabled;
    return item;
  }

  public patchAutomation(id: string, updates: Partial<AutomationDefinition>): AutomationDefinition {
    const item = this.automations.get(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }
    const updated = { ...item, ...updates, id }; // Ensure ID cannot be overridden
    this.automations.set(id, updated);
    return updated;
  }

  public deleteAutomation(id: string): boolean {
    return this.automations.delete(id);
  }

  public async triggerNow(id: string): Promise<string> {
    const item = this.automations.get(id);
    if (!item) {
      throw new Error(`Automation with id "${id}" not found.`);
    }

    const run = await this.agentRuntime.createAndExecuteRun({
      intent: 'AGENT_MISSION',
      prompt: `[Automated Trigger: ${item.name}]\nObjective: ${item.objective}`,
      systemPrompt: 'Execute scheduled automation according to strict operational criteria.',
      modelPolicy: { model: 'mock-deterministic' }
    });

    item.lastRun = Date.now();
    return run.id;
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

  private evaluateSchedules(): void {
    // In local dev, triggers can be executed manually or on schedule
  }

  private seedDefaultAutomations(): void {
    this.createAutomation({
      name: 'System Health Check & Knowledge Refresh',
      enabled: false,
      trigger: 'CRON',
      cronExpression: '0 0 * * *',
      conditions: {},
      agentId: 'agent_sys_monitor',
      objective: 'Audit workspace telemetry, check MCP node freshness, and report health metrics.',
      approvalPolicy: 'autonomous'
    });
  }
}
