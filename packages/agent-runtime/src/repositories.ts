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
  appendRunEvent(event: StreamingEvent): Promise<StreamingEvent>;
  getRunEvents(runId: string): Promise<StreamingEvent[]>;
  getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]>;
  getLatestEventSequence(runId: string): Promise<number>;
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
      principal_id: run.userId, // We need to decouple this eventually, but using userId for now
      project_id: run.projectId,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      intent: run.intent,
      status: run.state,
      state: run.state,
      modelPolicy: JSON.stringify(run.modelPolicy),
      context_data: JSON.stringify(run.context),
      content: run.content,
      thinking: run.thinking,
      error: run.error,
      toolsUsed: JSON.stringify(run.toolsUsed),
      toolCalls: JSON.stringify(run.toolCalls),
      toolResults: JSON.stringify(run.toolResults),
      citations: JSON.stringify(run.citations),
      artifacts: JSON.stringify(run.artifacts),
      pending_approval: run.pendingApproval ? JSON.stringify(run.pendingApproval) : null,
      stepCount: run.stepCount,
      max_steps: run.maxSteps,
      execution_checkpoint: run.executionCheckpoint,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completed_at: run.completedAt
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

  async appendRunEvent(event: StreamingEvent): Promise<StreamingEvent> {
    const rows = await db('run_events').insert({
      id: event.eventId,
      run_id: event.runId,
      type: event.type,
      payload: JSON.stringify(event.data),
      createdAt: event.timestamp
    }).returning('*');
    
    const row = rows[0];
    return {
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    };
  }

  async getRunEvents(runId: string): Promise<StreamingEvent[]> {
    const rows = await db('run_events').where({ run_id: runId }).orderBy('sequence', 'asc');
    return rows.map((row: any) => ({
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }

  async getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]> {
    const rows = await db('run_events')
      .where({ run_id: runId })
      .andWhere('sequence', '>', sequence)
      .orderBy('sequence', 'asc');
    
    return rows.map((row: any) => ({
      eventId: row.id,
      runId: row.run_id,
      sequence: parseInt(row.sequence, 10),
      type: row.type as any,
      timestamp: parseInt(row.createdAt, 10),
      data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }

  async getLatestEventSequence(runId: string): Promise<number> {
    const row = await db('run_events')
      .where({ run_id: runId })
      .max('sequence as max_seq')
      .first();
    return row && row.max_seq ? parseInt(row.max_seq, 10) : 0;
  }

  private mapToRun(row: any): Run {
    const parseJson = (val: any, def: any) => {
      if (!val) return def;
      return typeof val === 'string' ? JSON.parse(val) : val;
    };
    return {
      id: row.id,
      userId: row.agent_id || 'user-default', // userId currently serves as agent ID
      projectId: row.project_id,
      intent: row.intent as any,
      state: row.state as any,
      modelPolicy: parseJson(row.modelPolicy, {}),
      prompt: row.prompt,
      systemPrompt: row.systemPrompt || '',
      context: parseJson(row.context_data, {}),
      content: row.content || '',
      thinking: row.thinking || '',
      error: row.error,
      toolsUsed: parseJson(row.toolsUsed, []),
      toolCalls: parseJson(row.toolCalls, []),
      toolResults: parseJson(row.toolResults, []),
      pendingApproval: row.pending_approval ? parseJson(row.pending_approval, undefined) : undefined,
      artifacts: parseJson(row.artifacts, []),
      citations: parseJson(row.citations, []),
      stepCount: row.stepCount || 0,
      maxSteps: row.max_steps || 10,
      executionCheckpoint: row.execution_checkpoint,
      createdAt: parseInt(row.createdAt, 10),
      updatedAt: parseInt(row.updatedAt, 10),
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : undefined
    };
  }
}
