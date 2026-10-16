import { AgentDefinition, Run, StreamingEvent } from '../../contracts/src/index.js';
import { db } from '../../db/src/index.js';

export interface AgentRepository {
  saveAgent(agent: AgentDefinition, principalId?: string): Promise<void>;
  getAgent(id: string, principalId?: string): Promise<AgentDefinition | undefined>;
  listAgents(principalId?: string): Promise<AgentDefinition[]>;
  deleteAgent(id: string, principalId?: string): Promise<boolean>;
}

export interface RunRepository {
  saveRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  listRunsForPrincipal(principalId: string, limit?: number): Promise<Run[]>;
  searchRunsForPrincipal(principalId: string, query: string, limit?: number): Promise<Run[]>;
  getInterruptedRuns(): Promise<Run[]>;
  appendRunEvent(event: StreamingEvent): Promise<StreamingEvent>;
  getRunEvents(runId: string): Promise<StreamingEvent[]>;
  getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]>;
  getLatestEventSequence(runId: string): Promise<number>;
  claimInterruptedRun(runId: string, owner: string, ttlMs: number): Promise<boolean>;
}

export class PostgresAgentRepository implements AgentRepository {
  async saveAgent(agent: AgentDefinition, principalId?: string): Promise<void> {
    const owner = principalId || agent.principalId || null;
    await db('agents').insert({
      id: agent.id,
      principal_id: owner,
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

  async getAgent(id: string, principalId?: string): Promise<AgentDefinition | undefined> {
    const query = db('agents').where({ id });
    if (principalId) {
      query.andWhere((qb) => {
        qb.where({ principal_id: principalId }).orWhereNull('principal_id');
      });
    }
    const row = await query.first();
    if (!row) return undefined;
    return this.mapToAgent(row);
  }

  async listAgents(principalId?: string): Promise<AgentDefinition[]> {
    const query = db('agents').select('*');
    if (principalId) {
      query.where((qb) => {
        qb.where({ principal_id: principalId }).orWhereNull('principal_id');
      });
    }
    const rows = await query;
    return rows.map(this.mapToAgent);
  }

  async deleteAgent(id: string, principalId?: string): Promise<boolean> {
    const query = db('agents').where({ id });
    if (principalId) {
      query.andWhere({ principal_id: principalId });
    }
    const deleted = await query.delete();
    return deleted > 0;
  }

  private mapToAgent(row: any): AgentDefinition {
    return {
      id: row.id,
      principalId: row.principal_id || undefined,
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

export class InMemoryAgentRepository implements AgentRepository {
  private agents: Map<string, { agent: AgentDefinition; principalId?: string }> = new Map();

  async saveAgent(agent: AgentDefinition, principalId?: string): Promise<void> {
    const owner = principalId || agent.principalId;
    this.agents.set(agent.id, {
      agent: { ...agent, principalId: owner },
      principalId: owner
    });
  }

  async getAgent(id: string, principalId?: string): Promise<AgentDefinition | undefined> {
    const entry = this.agents.get(id);
    if (!entry) return undefined;
    if (principalId && entry.principalId && entry.principalId !== principalId) {
      return undefined;
    }
    return { ...entry.agent };
  }

  async listAgents(principalId?: string): Promise<AgentDefinition[]> {
    return Array.from(this.agents.values())
      .filter(e => !principalId || !e.principalId || e.principalId === principalId)
      .map(e => ({ ...e.agent }));
  }

  async deleteAgent(id: string, principalId?: string): Promise<boolean> {
    const entry = this.agents.get(id);
    if (!entry) return false;
    if (principalId && entry.principalId && entry.principalId !== principalId) {
      return false;
    }
    return this.agents.delete(id);
  }
}

export class PostgresRunRepository implements RunRepository {
  async saveRun(run: Run): Promise<void> {
    await db('runs').insert({
      id: run.id,
      principal_id: run.principalId,
      agent_id: run.agentId || null,
      session_id: run.sessionId,
      workspace_id: run.workspaceId || null,
      project_id: run.projectId || null,
      conversation_id: run.conversationId || null,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      intent: run.intent,
      status: run.state,
      state: run.state,
      modelPolicy: JSON.stringify(run.modelPolicy),
      context_data: JSON.stringify({
        ...(run.context || {}),
        provenance: run.provenance,
        principalScopes: run.principalScopes || []
      }),
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
      recovery_owner: run.recoveryOwner,
      recovery_claimed_at: run.recoveryClaimedAt,
      recovery_lease_until: run.recoveryLeaseUntil,
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

  async listRunsForPrincipal(principalId: string, limit = 50): Promise<Run[]> {
    const rows = await db('runs')
      .where({ principal_id: principalId })
      .orderBy('createdAt', 'desc')
      .limit(limit);
    return rows.map(this.mapToRun);
  }

  async searchRunsForPrincipal(principalId: string, query: string, limit = 5): Promise<Run[]> {
    const stopwords = new Set([
      'a', 'an', 'the', 'and', 'or', 'for', 'with', 'about', 'what', 'when', 'where',
      'that', 'this', 'have', 'from', 'you', 'remember', 'talked', 'discuss', 'discussed',
      'tell', 'me', 'our', 'conversation', 'chat', 'give'
    ]);
    const terms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !stopwords.has(t));

    let builder = db('runs')
      .where({ principal_id: principalId })
      .whereIn('state', ['COMPLETED', 'RUNNING'])
      .orderBy('createdAt', 'desc');

    if (terms.length > 0) {
      builder = builder.andWhere(function() {
        for (const term of terms.slice(0, 5)) {
          this.orWhere('prompt', 'ilike', `%${term}%`)
              .orWhere('content', 'ilike', `%${term}%`);
        }
      });
    }

    const rows = await builder.limit(limit);
    return rows.map(this.mapToRun);
  }

  async getInterruptedRuns(): Promise<Run[]> {
    const rows = await db('runs').whereIn('state', ['RUNNING', 'WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL']).orderBy('createdAt', 'asc');
    return rows.map(this.mapToRun);
  }

  async claimInterruptedRun(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const until = now + ttlMs;

    const result = await db('runs')
      .where({ id: runId })
      .andWhere(function() {
        this.whereNull('recovery_owner')
            .orWhere('recovery_lease_until', '<', now);
      })
      .update({
        recovery_owner: owner,
        recovery_claimed_at: now,
        recovery_lease_until: until,
        updatedAt: now
      });

    return result > 0;
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
    const context = parseJson(row.context_data, {});
    const routingDecision = context?.routingDecision || undefined;
    const principalScopes = context?.principalScopes || [];
    const provenance = context?.provenance || undefined;
    return {
      id: row.id,
      principalId: row.principal_id,
      principalScopes,
      agentId: row.agent_id || null,
      sessionId: row.session_id,
      workspaceId: row.workspace_id || null,
      projectId: row.project_id || null,
      conversationId: row.conversation_id || null,
      intent: row.intent as any,
      routingDecision,
      provenance,
      state: row.state as any,
      modelPolicy: parseJson(row.modelPolicy, {}),
      prompt: row.prompt,
      systemPrompt: row.systemPrompt || '',
      context,
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
      recoveryOwner: row.recovery_owner,
      recoveryClaimedAt: row.recovery_claimed_at ? parseInt(row.recovery_claimed_at, 10) : undefined,
      recoveryLeaseUntil: row.recovery_lease_until ? parseInt(row.recovery_lease_until, 10) : undefined,
      createdAt: parseInt(row.createdAt, 10),
      updatedAt: parseInt(row.updatedAt, 10),
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : undefined
    };
  }
}

export class InMemoryRunRepository implements RunRepository {
  private runs: Map<string, Run> = new Map();
  private events: Map<string, StreamingEvent[]> = new Map();
  private sequences: Map<string, number> = new Map();

  async saveRun(run: Run): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<Run | undefined> {
    const r = this.runs.get(id);
    return r ? { ...r } : undefined;
  }

  async listRuns(): Promise<Run[]> {
    return Array.from(this.runs.values());
  }

  async listRunsForPrincipal(principalId: string, limit = 50): Promise<Run[]> {
    return Array.from(this.runs.values())
      .filter(r => r.principalId === principalId)
      .slice(0, limit);
  }

  async searchRunsForPrincipal(principalId: string, query: string, limit = 5): Promise<Run[]> {
    const q = query.toLowerCase();
    return Array.from(this.runs.values())
      .filter(r => r.principalId === principalId && (r.prompt.toLowerCase().includes(q) || r.content.toLowerCase().includes(q)))
      .slice(0, limit);
  }

  async getInterruptedRuns(): Promise<Run[]> {
    return [];
  }

  async appendRunEvent(event: StreamingEvent): Promise<StreamingEvent> {
    const list = this.events.get(event.runId) || [];
    const seq = (this.sequences.get(event.runId) || 0) + 1;
    this.sequences.set(event.runId, seq);
    const assigned: StreamingEvent = { ...event, sequence: seq };
    list.push(assigned);
    this.events.set(event.runId, list);
    return assigned;
  }

  async getRunEvents(runId: string): Promise<StreamingEvent[]> {
    return this.events.get(runId) || [];
  }

  async getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]> {
    return (this.events.get(runId) || []).filter(e => (e.sequence || 0) > sequence);
  }

  async getLatestEventSequence(runId: string): Promise<number> {
    return this.sequences.get(runId) || 0;
  }

  async claimInterruptedRun(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    return true;
  }
}
