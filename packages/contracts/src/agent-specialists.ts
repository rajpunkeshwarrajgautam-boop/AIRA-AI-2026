import { z } from 'zod';
import { CapabilityCategorySchema, SideEffectLevelSchema } from './behavioral.js';

// ==========================================
// 1. SPECIALIST ROLES TAXONOMY (9 CANONICAL ROLES)
// ==========================================

export const SpecialistRoleSchema = z.enum([
  'planner',
  'researcher',
  'coder',
  'analyst',
  'document',
  'browser',
  'automation',
  'verifier',
  'synthesizer'
]);
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;

export const ALL_SPECIALIST_ROLES: readonly SpecialistRole[] = Object.freeze([
  'planner',
  'researcher',
  'coder',
  'analyst',
  'document',
  'browser',
  'automation',
  'verifier',
  'synthesizer'
]);

// ==========================================
// 2. SPECIALIST TASK OUTCOME (TASK-LEVEL ONLY)
// ==========================================

/**
 * Task-level execution outcomes for individual specialist work units.
 * Note: These do NOT alter or replace the durable persisted RunStateSchema.
 */
export const SpecialistTaskOutcomeSchema = z.enum([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'UNAVAILABLE'
]);
export type SpecialistTaskOutcome = z.infer<typeof SpecialistTaskOutcomeSchema>;

/**
 * Full lifecycle state machine states for durable specialist tasks.
 * Includes active scheduling, leasing, approval, and terminal states.
 */
export const SpecialistTaskStateSchema = z.enum([
  'QUEUED',
  'BLOCKED',
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'RETRY_WAIT',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'UNAVAILABLE'
]);
export type SpecialistTaskState = z.infer<typeof SpecialistTaskStateSchema>;

export const TERMINAL_SPECIALIST_STATES: readonly SpecialistTaskState[] = Object.freeze([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'UNAVAILABLE'
]);

export function isTerminalSpecialistState(state: SpecialistTaskState): boolean {
  return TERMINAL_SPECIALIST_STATES.includes(state);
}

export function toSpecialistTaskOutcome(state: SpecialistTaskState): SpecialistTaskOutcome | undefined {
  if (isTerminalSpecialistState(state)) {
    return state as SpecialistTaskOutcome;
  }
  return undefined;
}

// ==========================================
// 3. EXECUTION CONSTRAINTS & AUTHORIZATION
// ==========================================

export const SpecialistExecutionConstraintsSchema = z.object({
  sideEffectLevel: SideEffectLevelSchema.default('NONE'),
  allowedTools: z.array(z.string().min(1)).default([]),
  sandboxRequired: z.boolean().default(false),
  requireStrictJsonOutput: z.boolean().default(true)
}).default({});
export type SpecialistExecutionConstraints = z.infer<typeof SpecialistExecutionConstraintsSchema>;

export const SpecialistAuthorizationRequirementsSchema = z.object({
  requiresHumanApproval: z.boolean().default(false),
  requiredPermissions: z.array(z.string().min(1)).default([]),
  approvedBy: z.string().optional()
}).default({});
export type SpecialistAuthorizationRequirements = z.infer<typeof SpecialistAuthorizationRequirementsSchema>;

export const SpecialistBudgetLimitsSchema = z.object({
  maxTokens: z.number().int().positive().max(100000).default(8192),
  maxSpendUsd: z.number().nonnegative().optional()
}).default({ maxTokens: 8192 });
export type SpecialistBudgetLimits = z.infer<typeof SpecialistBudgetLimitsSchema>;

export const SpecialistTimeoutConfigSchema = z.object({
  stepTimeoutMs: z.number().int().min(1000).max(300000).default(60000)
}).default({ stepTimeoutMs: 60000 });
export type SpecialistTimeoutConfig = z.infer<typeof SpecialistTimeoutConfigSchema>;

export const SpecialistRetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(5).default(2),
  backoffMultiplier: z.number().min(1).max(5).default(1.5)
}).default({ maxRetries: 2, backoffMultiplier: 1.5 });
export type SpecialistRetryPolicy = z.infer<typeof SpecialistRetryPolicySchema>;

// ==========================================
// 4. SPECIALIST TASK CONTRACT
// ==========================================

export const SpecialistTaskContractSchema = z.object({
  taskId: z.string().min(1, 'taskId is required').max(128).regex(/^[a-zA-Z0-9_-]+$/, 'taskId must be alphanumeric with underscores or dashes'),
  runId: z.string().min(1, 'runId is required').max(128),
  role: SpecialistRoleSchema,
  objective: z.string().min(1, 'objective is required').max(2000),
  requiredCapabilities: z.array(CapabilityCategorySchema).default([]),
  dependencies: z.array(z.string().min(1)).max(10, 'A task cannot have more than 10 dependencies').default([]),
  inputContract: z.record(z.string(), z.any()).default({}),
  expectedOutputContract: z.record(z.string(), z.any()).default({}),
  executionConstraints: SpecialistExecutionConstraintsSchema,
  authorizationRequirements: SpecialistAuthorizationRequirementsSchema,
  budgetLimits: SpecialistBudgetLimitsSchema,
  timeoutConfig: SpecialistTimeoutConfigSchema,
  retryPolicy: SpecialistRetryPolicySchema
});
export type SpecialistTaskContract = z.infer<typeof SpecialistTaskContractSchema>;

// ==========================================
// 5. SPECIALIST TASK RESULT & PROVENANCE
// ==========================================

export const SpecialistEvidenceReferenceSchema = z.object({
  source: z.string().min(1),
  url: z.string().url().optional(),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1).optional()
});
export type SpecialistEvidenceReference = z.infer<typeof SpecialistEvidenceReferenceSchema>;

export const SpecialistUsageSchema = z.object({
  tokensUsed: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  model: z.string().optional(),
  provider: z.string().optional()
});
export type SpecialistUsage = z.infer<typeof SpecialistUsageSchema>;

/**
 * Structural execution telemetry metadata.
 *
 * NOTE ON PROVENANCE CLASSIFICATION:
 * In Milestone 1, this structure captures standard operational telemetry metadata
 * (worker identifier, prompt profile reference) for tracing and logging.
 * It is NOT a cryptographically verified execution receipt or hardware worker attestation.
 * Do not fabricate cryptographic signatures or claim tamper-proof provenance
 * where asymmetric signing is not implemented.
 */
export const SpecialistProvenanceSchema = z.object({
  workerId: z.string().min(1).describe('Operational identifier of the worker runtime (runtime telemetry, not cryptographic attestation)'),
  executionSignature: z.string().optional().describe('Optional correlation signature for tracking; not a cryptographic receipt in M1'),
  promptProfileId: z.string().optional().describe('Identifier of the prompt profile used for execution context')
});
export type SpecialistProvenance = z.infer<typeof SpecialistProvenanceSchema>;

export const SpecialistErrorDetailsSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false)
});
export type SpecialistErrorDetails = z.infer<typeof SpecialistErrorDetailsSchema>;

export const SpecialistTimingSchema = z.object({
  startedAt: z.number().int().positive(),
  completedAt: z.number().int().positive()
});
export type SpecialistTiming = z.infer<typeof SpecialistTimingSchema>;

export const SpecialistTaskResultSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  role: SpecialistRoleSchema,
  outcome: SpecialistTaskOutcomeSchema,
  output: z.any().optional(),
  evidenceReferences: z.array(SpecialistEvidenceReferenceSchema).default([]),
  usage: SpecialistUsageSchema,
  provenance: SpecialistProvenanceSchema,
  error: SpecialistErrorDetailsSchema.optional(),
  timing: SpecialistTimingSchema
});
export type SpecialistTaskResult = z.infer<typeof SpecialistTaskResultSchema>;

// ==========================================
// 6. TASK DAG SCHEMA
// ==========================================

export const TaskDAGSchema = z.object({
  dagId: z.string().min(1, 'dagId is required').max(128),
  runId: z.string().min(1, 'runId is required').max(128),
  tasks: z.array(SpecialistTaskContractSchema).min(1, 'DAG must contain at least 1 task').max(50, 'DAG cannot exceed 50 tasks'),
  maxConcurrency: z.number().int().min(1).max(10).default(3),
  totalBudget: z.object({
    maxTotalTokens: z.number().int().positive().max(500000).default(100000),
    maxTotalSpendUsd: z.number().nonnegative().optional()
  }).default({ maxTotalTokens: 100000 })
});
export type TaskDAG = z.infer<typeof TaskDAGSchema>;

// ==========================================
// 7. DAG VALIDATION INTERFACE & FUNCTION
// ==========================================

export interface TaskDAGValidationResult {
  valid: boolean;
  error?: string;
  topologicalOrder?: string[];
  executionWaves?: string[][];
  cycleNodes?: string[];
  unresolvedDependencies?: Array<{ taskId: string; missingDepId: string }>;
  duplicateTaskIds?: string[];
  stats?: {
    totalTasks: number;
    leafTasks: number;
    rootTasks: number;
    maxDepth: number;
  };
}

/**
 * Validates an arbitrary task DAG structure with exhaustive graph invariants.
 *
 * Verifies:
 * 1. Zod schema validity (types, limits, bounds).
 * 2. Task ID uniqueness (no duplicate IDs).
 * 3. Existence of all declared dependencies (no dangling refs).
 * 4. Self-dependency prohibition (a task cannot depend on itself).
 * 5. Cycle detection via Kahn's algorithm (no circular loops).
 * 6. Deterministic topological ordering and parallel execution wave compilation.
 * 7. Structural metrics (root tasks, leaf tasks, critical-path max depth).
 */
export function validateTaskDAG(rawDag: unknown): TaskDAGValidationResult {
  const parseResult = TaskDAGSchema.safeParse(rawDag);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const pathStr = firstIssue ? firstIssue.path.join('.') : '';
    const msg = firstIssue ? firstIssue.message : 'Invalid task DAG schema';
    return {
      valid: false,
      error: pathStr ? `Schema validation error at "${pathStr}": ${msg}` : msg
    };
  }

  const dag = parseResult.data;
  const taskMap = new Map<string, SpecialistTaskContract>();
  const duplicateIds: string[] = [];

  for (const task of dag.tasks) {
    if (taskMap.has(task.taskId)) {
      duplicateIds.push(task.taskId);
    } else {
      taskMap.set(task.taskId, task);
    }
  }

  if (duplicateIds.length > 0) {
    return {
      valid: false,
      error: `Duplicate task IDs detected: ${duplicateIds.map(id => `"${id}"`).join(', ')}`,
      duplicateTaskIds: duplicateIds
    };
  }

  const unresolvedDeps: Array<{ taskId: string; missingDepId: string }> = [];

  for (const task of dag.tasks) {
    for (const depId of task.dependencies) {
      if (depId === task.taskId) {
        return {
          valid: false,
          error: `Task "${task.taskId}" cannot depend on itself (self-dependency prohibited).`
        };
      }
      if (!taskMap.has(depId)) {
        unresolvedDeps.push({ taskId: task.taskId, missingDepId: depId });
      }
    }
  }

  if (unresolvedDeps.length > 0) {
    const descriptions = unresolvedDeps.map(d => `Task "${d.taskId}" depends on missing task "${d.missingDepId}"`);
    return {
      valid: false,
      error: `Unresolved dependencies detected: ${descriptions.join('; ')}`,
      unresolvedDependencies: unresolvedDeps
    };
  }

  // Kahn's algorithm for topological ordering and cycle detection
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const task of dag.tasks) {
    inDegree.set(task.taskId, task.dependencies.length);
    outgoing.set(task.taskId, []);
  }

  for (const task of dag.tasks) {
    for (const depId of task.dependencies) {
      outgoing.get(depId)!.push(task.taskId);
    }
  }

  const waves: string[][] = [];
  const topologicalOrder: string[] = [];
  let remainingCount = dag.tasks.length;

  while (remainingCount > 0) {
    // Collect all tasks with inDegree === 0, sorted deterministically
    const currentWave = Array.from(inDegree.entries())
      .filter(([_, deg]) => deg === 0)
      .map(([id]) => id)
      .sort(); // Deterministic alphabetical ordering

    if (currentWave.length === 0) {
      // Cycle detected: remaining tasks with inDegree > 0 are part of or blocked by cycles
      const cycleNodes = Array.from(inDegree.entries())
        .filter(([_, deg]) => deg > 0)
        .map(([id]) => id)
        .sort();
      return {
        valid: false,
        error: `Cycle detected in task dependency graph involving nodes: ${cycleNodes.join(', ')}`,
        cycleNodes
      };
    }

    waves.push(currentWave);
    topologicalOrder.push(...currentWave);

    for (const id of currentWave) {
      inDegree.set(id, -1); // Mark processed
      remainingCount--;
      for (const nextId of outgoing.get(id)!) {
        const d = inDegree.get(nextId)!;
        inDegree.set(nextId, d - 1);
      }
    }
  }

  // Calculate stats
  const rootTasks = dag.tasks.filter(t => t.dependencies.length === 0).length;
  const leafTasks = dag.tasks.filter(t => outgoing.get(t.taskId)!.length === 0).length;
  const maxDepth = waves.length;

  return {
    valid: true,
    topologicalOrder,
    executionWaves: waves,
    stats: {
      totalTasks: dag.tasks.length,
      rootTasks,
      leafTasks,
      maxDepth
    }
  };
}
