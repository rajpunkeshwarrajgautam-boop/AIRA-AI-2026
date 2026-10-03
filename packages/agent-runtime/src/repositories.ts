import { AgentDefinition, Run, StreamingEvent } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface AgentRepository {
  saveAgent(agent: AgentDefinition): Promise<void>;
  getAgent(id: string): Promise<AgentDefinition | undefined>;
  listAgents(): Promise<AgentDefinition[]>;
  deleteAgent(id: string): Promise<boolean>;
}

export interface RunRepository {
  saveRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  getInterruptedRuns(): Promise<Run[]>;
  appendRunEvent(event: StreamingEvent): Promise<void>;
  getRunEvents(runId: string): Promise<StreamingEvent[]>;
}

export class PostgresAgentRepository implements AgentRepository {
  async saveAgent(agent: AgentDefinition): Promise<void> {
    await db('agents').insert({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      instructions: agent.instructions,
      modelPolicy: JSON.stringify(agent.modelPolicy),
      tools: JSON.stringify(agent.tools),
      memoryScopes: JSON.stringify(agent.memoryScopes),
      approvalPolicy: agent.approvalPolicy,
      maxSteps: agent.maxSteps,
      timeoutPolicy: JSON.stringify({ maxMs: agent.timeoutMs }),
      createdAt: agent.createdAt || Date.now(),
      updatedAt: Date.now()
    }).onConflict('id').merge();
  }

  async getAgent(id: string): Promise<AgentDefinition | undefined> {
    const row = await db('agents').where({ id }).first();
    if (!row) return undefined;
    return this.mapToAgent(row);
  }

  async listAgents(): Promise<AgentDefinition[]> {
    const rows = await db('agents').select('*');
    return rows.map(this.mapToAgent);
  }

  async deleteAgent(id: string): Promise<boolean> {
    const deleted = await db('agents').where({ id }).delete();
    return deleted > 0;
  }

  private mapToAgent(row: any): AgentDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      instructions: row.instructions,
      modelPolicy: typeof row.modelPolicy === 'string' ? JSON.parse(row.modelPolicy) : row.modelPolicy,
      tools: typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools,
      memoryScopes: typeof row.memoryScopes === 'string' ? JSON.parse(row.memoryScopes) : row.memoryScopes,
      approvalPolicy: row.approvalPolicy,
      maxSteps: row.maxSteps,
      timeoutMs: typeof row.timeoutPolicy === 'string' ? JSON.parse(row.timeoutPolicy)?.maxMs : row.timeoutPolicy?.maxMs
    };
  }
}

export class PostgresRunRepository implements RunRepository {
  async saveRun(run: Run): Promise<void> {
    await db('runs').insert({
      id: run.id,
      agent_id: run.userId,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      intent: run.intent,
      status: run.state,
      state: run.state,
      modelPolicy: JSON.stringify(run.modelPolicy),
      toolsUsed: JSON.stringify(run.toolsUsed),
      toolCalls: JSON.stringify(run.toolCalls),
      toolResults: JSON.stringify(run.toolResults),
      citations: JSON.stringify(run.citations),
      stepCount: run.stepCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }).onConflict('id').merge();
  }

  async getRun(id: string): Promise<Run | undefined> {
    const row = await db('runs').where({ id }).first();
    if (!row) return undefined;
    return this.mapToRun(row);
  }

  async listRuns(): Promise<Run[]> {
    const rows = await db('runs').select('*').orderBy('createdAt', 'desc');
    return rows.map(this.mapToRun);
  }

  async getInterruptedRuns(): Promise<Run[]> {
    const rows = await db('runs').whereIn('state', ['RUNNING', 'WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL']);
    return rows.map(this.mapToRun);
  }

  async appendRunEvent(event: StreamingEvent): Promise<void> {
    await db('run_events').insert({
      id: event.eventId,
      run_id: event.runId,
      type: event.type,
      payload: JSON.stringify(event.data),
      createdAt: event.timestamp
    });
  }

  async getRunEvents(runId: string): Promise<StreamingEvent[]> {
    const rows = await db('run_events').where({ run_id: runId }).orderBy('createdAt', 'asc');
    return rows.map((row: any) => ({
      eventId: row.id,
      runId: row.run_id,
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }

  private mapToRun(row: any): Run {
    const parseJson = (val: any, def: any) => {
      if (!val) return def;
      return typeof val === 'string' ? JSON.parse(val) : val;
    };
    return {
      id: row.id,
      userId: row.agent_id || 'user-default',
      intent: row.intent as any,
      state: row.state as any,
      modelPolicy: parseJson(row.modelPolicy, {}),
      prompt: row.prompt,
      systemPrompt: row.systemPrompt || '',
      context: {},
      content: '',
      thinking: '',
      toolsUsed: parseJson(row.toolsUsed, []),
      toolCalls: parseJson(row.toolCalls, []),
      toolResults: parseJson(row.toolResults, []),
      artifacts: parseJson(row.artifacts, []),
      citations: parseJson(row.citations, []),
      stepCount: row.stepCount || 0,
      maxSteps: 10,
      createdAt: parseInt(row.createdAt, 10),
      updatedAt: parseInt(row.updatedAt, 10)
    };
  }
}
