import {
  AutonomousAgentTask,
  AutonomousTaskState,
  AgentObservation,
  canAutonomousStateTransition
} from '../../../contracts/src/index.js';

export interface IAutonomousTaskRepository {
  createTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask>;
  getTask(taskId: string): Promise<AutonomousAgentTask | null>;
  listTasksByPrincipal(principalId: string, limit?: number): Promise<AutonomousAgentTask[]>;
  updateTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask>;
  updateState(taskId: string, newState: AutonomousTaskState, reason?: string, checkpoint?: string): Promise<AutonomousAgentTask>;
  addObservation(taskId: string, observation: AgentObservation): Promise<void>;
  addArtifact(taskId: string, artifact: AutonomousAgentTask['artifacts'][0]): Promise<void>;
}

export class InMemoryAutonomousTaskRepository implements IAutonomousTaskRepository {
  private tasks: Map<string, AutonomousAgentTask> = new Map();

  async createTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    const clone = JSON.parse(JSON.stringify(task));
    this.tasks.set(task.taskId, clone);
    return clone;
  }

  async getTask(taskId: string): Promise<AutonomousAgentTask | null> {
    const found = this.tasks.get(taskId);
    if (!found) return null;
    return JSON.parse(JSON.stringify(found));
  }

  async listTasksByPrincipal(principalId: string, limit = 20): Promise<AutonomousAgentTask[]> {
    const results: AutonomousAgentTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.principal.userId === principalId) {
        results.push(JSON.parse(JSON.stringify(t)));
      }
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, limit);
  }

  async updateTask(task: AutonomousAgentTask): Promise<AutonomousAgentTask> {
    const existing = this.tasks.get(task.taskId);
    if (!existing) {
      throw new Error(`Task with id ${task.taskId} not found.`);
    }
    const mergedObservations = task.observations.length >= existing.observations.length
      ? task.observations
      : existing.observations;

    const updated: AutonomousAgentTask = {
      ...JSON.parse(JSON.stringify(task)),
      state: existing.state,
      executionHistory: existing.executionHistory,
      observations: mergedObservations,
      updatedAt: Date.now()
    };
    this.tasks.set(task.taskId, updated);
    return updated;
  }

  async updateState(
    taskId: string,
    newState: AutonomousTaskState,
    reason?: string,
    checkpoint?: string
  ): Promise<AutonomousAgentTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }

    if (!canAutonomousStateTransition(task.state, newState)) {
      throw new Error(`Illegal autonomous state transition from "${task.state}" to "${newState}".`);
    }

    const now = Date.now();
    task.state = newState;
    task.updatedAt = now;
    if (newState === 'COMPLETED' || newState === 'FAILED' || newState === 'CANCELLED' || newState === 'TIMED_OUT') {
      task.completedAt = now;
    }

    task.executionHistory.push({
      state: newState,
      timestamp: now,
      reason,
      checkpoint
    });

    this.tasks.set(taskId, task);
    return JSON.parse(JSON.stringify(task));
  }

  async addObservation(taskId: string, observation: AgentObservation): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }
    task.observations.push(JSON.parse(JSON.stringify(observation)));
    task.updatedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  async addArtifact(taskId: string, artifact: AutonomousAgentTask['artifacts'][0]): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id ${taskId} not found.`);
    }
    task.artifacts.push(JSON.parse(JSON.stringify(artifact)));
    task.updatedAt = Date.now();
    this.tasks.set(taskId, task);
  }
}
