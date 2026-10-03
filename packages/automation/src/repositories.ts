import { AutomationDefinition } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface AutomationRepository {
  saveAutomation(automation: AutomationDefinition): Promise<void>;
  getAutomation(id: string): Promise<AutomationDefinition | undefined>;
  listAutomations(): Promise<AutomationDefinition[]>;
  getDueAutomations(): Promise<AutomationDefinition[]>;
  updateLastRun(id: string, lastRun: number): Promise<void>;
  tryClaimAutomationRun(id: string, dueThreshold: number, newLastRun: number): Promise<boolean>;
  deleteAutomation(id: string): Promise<boolean>;
}

export class PostgresAutomationRepository implements AutomationRepository {
  async saveAutomation(automation: AutomationDefinition): Promise<void> {
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
        failureState: automation.failureState
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

  async listAutomations(): Promise<AutomationDefinition[]> {
    const rows = await db('automations').select('*');
    return rows.map(this.mapToAutomation);
  }

  async getDueAutomations(): Promise<AutomationDefinition[]> {
    // We return enabled cron automations; time evaluations will happen in memory for now.
    const rows = await db('automations')
      .where('enabled', true)
      .whereNot('cron_expression', '');
    return rows.map(this.mapToAutomation);
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
    const params = typeof row.triggerParams === 'string' ? JSON.parse(row.triggerParams) : row.triggerParams;
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      agentId: row.agent_id,
      cronExpression: row.cron_expression,
      lastRun: parseInt(row.last_run, 10),
      trigger: params?.trigger || 'CRON',
      conditions: params?.conditions || {},
      objective: params?.objective || '',
      approvalPolicy: params?.approvalPolicy || 'autonomous',
      failureState: params?.failureState
    };
  }
}
