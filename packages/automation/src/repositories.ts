import { AutomationDefinition, AutomationRun } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface AutomationRepository {
  saveAutomation(automation: AutomationDefinition, clientOperationId?: string): Promise<void>;
  getAutomation(id: string): Promise<AutomationDefinition | undefined>;
  getAutomationByClientOperationId?(principalId: string, clientOperationId: string): Promise<AutomationDefinition | undefined>;
  listAutomations(principalId?: string): Promise<AutomationDefinition[]>;
  getDueAutomations(): Promise<AutomationDefinition[]>;
  updateLastRun(id: string, lastRun: number): Promise<void>;
  tryClaimAutomationRun(id: string, dueThreshold: number, newLastRun: number): Promise<boolean>;
  deleteAutomation(id: string): Promise<boolean>;
}

export interface AutomationRunRepository {
  saveRun(run: AutomationRun): Promise<void>;
  getRun(id: string): Promise<AutomationRun | undefined>;
  getRunsForAutomation(automationId: string): Promise<AutomationRun[]>;
  claimRun(automationId: string, scheduledFor: number): Promise<AutomationRun | undefined>;
}

export class PostgresAutomationRunRepository implements AutomationRunRepository {
  async saveRun(run: AutomationRun): Promise<void> {
    await db('automation_runs').insert({
      id: run.id,
      automation_id: run.automationId,
      run_id: run.runId,
      scheduled_for: run.scheduledFor,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      attempt: run.attempt,
      status: run.status,
      error: run.error,
      claimed_at: run.claimedAt
    }).onConflict('id').merge();
  }

  async getRun(id: string): Promise<AutomationRun | undefined> {
    const row = await db('automation_runs').where({ id }).first();
    if (!row) return undefined;
    return this.mapToRun(row);
  }

  async getRunsForAutomation(automationId: string): Promise<AutomationRun[]> {
    const rows = await db('automation_runs')
      .where({ automation_id: automationId })
      .orderBy('scheduled_for', 'desc');
    return rows.map(this.mapToRun);
  }

  async claimRun(automationId: string, scheduledFor: number): Promise<AutomationRun | undefined> {
    return db.transaction(async (trx) => {
      // 1. Check if it already exists
      const existing = await trx('automation_runs')
        .where({ automation_id: automationId, scheduled_for: scheduledFor })
        .first();

      if (existing) return undefined; // Already claimed

      // 2. Insert as CLAIMED
      const runId = `autorun_${Date.now()}_${Math.floor(Math.random()*1000)}`;
      const now = Date.now();
      
      try {
        await trx('automation_runs').insert({
          id: runId,
          automation_id: automationId,
          scheduled_for: scheduledFor,
          started_at: now,
          status: 'CLAIMED',
          attempt: 1,
          claimed_at: now
        });
        
        return {
          id: runId,
          automationId,
          scheduledFor,
          startedAt: now,
          status: 'CLAIMED',
          attempt: 1,
          claimedAt: now
        };
      } catch (err: any) {
        // Unique constraint violation
        if (err.code === '23505') {
          return undefined;
        }
        throw err;
      }
    });
  }

  private mapToRun(row: any): AutomationRun {
    return {
      id: row.id,
      automationId: row.automation_id,
      runId: row.run_id,
      scheduledFor: parseInt(row.scheduled_for, 10),
      startedAt: parseInt(row.started_at, 10),
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : undefined,
      attempt: row.attempt,
      status: row.status,
      error: row.error,
      claimedAt: row.claimed_at ? parseInt(row.claimed_at, 10) : undefined
    };
  }
}

export class PostgresAutomationRepository implements AutomationRepository {
  async saveAutomation(automation: AutomationDefinition, clientOperationId?: string): Promise<void> {
    await db('automations').insert({
      id: automation.id,
      name: automation.name,
      agent_id: automation.agentId,
      cron_expression: automation.cronExpression || '',
      enabled: automation.enabled,
      triggerParams: JSON.stringify({
        trigger: automation.trigger,
        conditions: automation.conditions,
        objective: automation.objective,
        approvalPolicy: automation.approvalPolicy,
        failureState: automation.failureState,
        principalId: automation.principalId,
        targetRunAt: automation.targetRunAt,
        timezone: automation.timezone,
        clientOperationId: clientOperationId || (automation as any).clientOperationId
      }),
      last_run: automation.lastRun || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).onConflict('id').merge();
  }

  async getAutomation(id: string): Promise<AutomationDefinition | undefined> {
    const row = await db('automations').where({ id }).first();
    if (!row) return undefined;
    return this.mapToAutomation(row);
  }

  async getAutomationByClientOperationId(principalId: string, clientOperationId: string): Promise<AutomationDefinition | undefined> {
    const rows = await db('automations').select('*');
    for (const row of rows) {
      const rawParams = row.triggerParams ?? row.triggerparams;
      const params = typeof rawParams === 'string' ? JSON.parse(rawParams) : rawParams;
      if (params?.principalId === principalId && params?.clientOperationId === clientOperationId) {
        return this.mapToAutomation(row);
      }
    }
    return undefined;
  }

  async listAutomations(principalId?: string): Promise<AutomationDefinition[]> {
    const rows = await db('automations').select('*');
    const items = rows.map(this.mapToAutomation);
    if (principalId) {
      return items.filter(i => i.principalId === principalId);
    }
    return items;
  }

  async getDueAutomations(): Promise<AutomationDefinition[]> {
    // Return enabled automations (both recurring cron and un-run one-time tasks)
    const rows = await db('automations')
      .where('enabled', true);
    const items = rows.map(this.mapToAutomation);
    return items.filter(auto => {
      if (auto.trigger === 'ONE_TIME') {
        return (!auto.lastRun || auto.lastRun === 0) && !!auto.targetRunAt;
      }
      return !!auto.cronExpression && auto.cronExpression.trim().length > 0;
    });
  }

  async updateLastRun(id: string, lastRun: number): Promise<void> {
    await db('automations').where({ id }).update({ last_run: lastRun, updatedAt: Date.now() });
  }
  
  async tryClaimAutomationRun(id: string, dueThreshold: number, newLastRun: number): Promise<boolean> {
    return db.transaction(async (trx) => {
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = (hash << 5) - hash + id.charCodeAt(i);
        hash |= 0;
      }
      const lockRes = await trx.raw('SELECT pg_try_advisory_xact_lock(?) as locked', [hash]);
      if (!lockRes.rows[0].locked) return false;

      const row = await trx('automations').where({ id }).select('last_run').first();
      if (!row) return false;

      if (parseInt(row.last_run, 10) >= dueThreshold) {
        return false;
      }

      await trx('automations').where({ id }).update({ last_run: newLastRun, updatedAt: Date.now() });
      return true;
    });
  }

  async deleteAutomation(id: string): Promise<boolean> {
      const deleted = await db('automations').where({ id }).delete();
      return deleted > 0;
  }

  private mapToAutomation(row: any): AutomationDefinition {
    const rawParams = row.triggerParams ?? row.triggerparams;
    const params = typeof rawParams === 'string' ? JSON.parse(rawParams) : rawParams;
    return {
      id: row.id,
      principalId: params?.principalId || row.principal_id || undefined,
      name: row.name,
      enabled: row.enabled,
      agentId: row.agent_id,
      cronExpression: row.cron_expression || undefined,
      targetRunAt: params?.targetRunAt ? parseInt(params.targetRunAt, 10) : undefined,
      timezone: params?.timezone || undefined,
      lastRun: parseInt(row.last_run || 0, 10),
      trigger: params?.trigger || 'CRON',
      conditions: params?.conditions || {},
      objective: params?.objective || '',
      approvalPolicy: params?.approvalPolicy || 'autonomous',
      failureState: params?.failureState
    };
  }
}
