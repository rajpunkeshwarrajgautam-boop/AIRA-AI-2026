import {
  SpecialistRole,
  CapabilityCategory,
  TaskDAG,
  TaskDAGSchema,
  validateTaskDAG
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class PlannerSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'planner';
  public readonly name = 'Planner Specialist';
  public readonly description = 'Decomposes complex natural language user objectives into structured TaskDAG execution plans with dependency waves.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'agent_planning',
    'general_reasoning'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const objective = typeof rawPayload.objective === 'string'
      ? rawPayload.objective
      : (typeof rawPayload.prompt === 'string' ? rawPayload.prompt : 'Decompose user objective');

    // Deterministically generate a structured 3-wave plan
    const runId = context.runId;
    const dag: TaskDAG = TaskDAGSchema.parse({
      dagId: `dag_${context.taskId}`,
      runId,
      tasks: [
        {
          taskId: `${context.taskId}_step_research`,
          runId,
          role: 'researcher',
          objective: `Gather primary evidence and context for: ${objective.slice(0, 80)}`,
          dependencies: []
        },
        {
          taskId: `${context.taskId}_step_analysis`,
          runId,
          role: 'analyst',
          objective: `Analyze data points and structure parameters for: ${objective.slice(0, 80)}`,
          dependencies: []
        },
        {
          taskId: `${context.taskId}_step_synthesis`,
          runId,
          role: 'synthesizer',
          objective: `Synthesize findings into complete deliverable`,
          dependencies: [`${context.taskId}_step_research`, `${context.taskId}_step_analysis`]
        },
        {
          taskId: `${context.taskId}_step_verify`,
          runId,
          role: 'verifier',
          objective: `Verify final deliverable against requirements`,
          dependencies: [`${context.taskId}_step_synthesis`]
        }
      ]
    });

    const validation = validateTaskDAG(dag);
    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      validation.valid ? 'COMPLETED' : 'FAILED',
      {
        objective,
        dag,
        executionWaves: validation.executionWaves,
        totalTasks: dag.tasks.length
      },
      startedAt,
      validation.valid ? undefined : {
        code: 'DAG_VALIDATION_ERROR',
        message: validation.error || 'Failed to construct valid TaskDAG.',
        retryable: false
      },
      {
        tokensUsed: 40,
        durationMs
      }
    );
  }
}
