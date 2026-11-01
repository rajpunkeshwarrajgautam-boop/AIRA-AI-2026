import { z } from 'zod';
import { ExecutionPrincipalSchema } from './principal.js';
import { CapabilityCategorySchema, SideEffectLevelSchema } from './behavioral.js';
import { SpecialistRoleSchema, TaskDAGSchema } from './agent-specialists.js';

// ==========================================
// 1. AUTONOMOUS AGENT TASK STATE MACHINE
// ==========================================

export const AutonomousTaskStateSchema = z.enum([
  'CREATED',
  'PLANNING',
  'READY',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'PAUSED',
  'RESUMING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
]);
export type AutonomousTaskState = z.infer<typeof AutonomousTaskStateSchema>;

export const TERMINAL_AUTONOMOUS_STATES: readonly AutonomousTaskState[] = Object.freeze([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
]);

export function isTerminalAutonomousState(state: AutonomousTaskState): boolean {
  return TERMINAL_AUTONOMOUS_STATES.includes(state);
}

/**
 * Valid transitions for autonomous agent task state machine.
 */
export const AUTONOMOUS_STATE_TRANSITIONS: Readonly<Record<AutonomousTaskState, ReadonlySet<AutonomousTaskState>>> = {
  CREATED: new Set<AutonomousTaskState>(['PLANNING', 'READY', 'FAILED', 'CANCELLED']),
  PLANNING: new Set<AutonomousTaskState>(['READY', 'RUNNING', 'FAILED', 'CANCELLED']),
  READY: new Set<AutonomousTaskState>(['RUNNING', 'PAUSED', 'FAILED', 'CANCELLED']),
  RUNNING: new Set<AutonomousTaskState>([
    'WAITING_FOR_APPROVAL',
    'PAUSED',
    'VERIFYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT'
  ]),
  WAITING_FOR_APPROVAL: new Set<AutonomousTaskState>(['RESUMING', 'RUNNING', 'PAUSED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  PAUSED: new Set<AutonomousTaskState>(['RESUMING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCELLED', 'FAILED']),
  RESUMING: new Set<AutonomousTaskState>(['RUNNING', 'VERIFYING', 'FAILED', 'CANCELLED']),
  VERIFYING: new Set<AutonomousTaskState>(['COMPLETED', 'PLANNING', 'RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  // Terminal states cannot transition to any other state
  COMPLETED: new Set<AutonomousTaskState>(),
  FAILED: new Set<AutonomousTaskState>(),
  CANCELLED: new Set<AutonomousTaskState>(),
  TIMED_OUT: new Set<AutonomousTaskState>()
};

export function canAutonomousStateTransition(from: AutonomousTaskState, to: AutonomousTaskState): boolean {
  if (from === to) return true; // Idempotent same-state
  if (isTerminalAutonomousState(from)) return false;
  const allowed = AUTONOMOUS_STATE_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

// ==========================================
// 2. AGENT OBJECTIVE, DECOMPOSITION & PLAN
// ==========================================

export const AgentPlanStepSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  role: SpecialistRoleSchema.default('general_reasoning' as any).optional(),
  assignedSpecialist: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  suggestedTools: z.array(z.string()).default([]),
  sideEffectLevel: SideEffectLevelSchema.default('NONE'),
  status: z.enum(['PENDING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'SKIPPED']).default('PENDING'),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional()
});
export type AgentPlanStep = z.infer<typeof AgentPlanStepSchema>;

export const AgentObjectivePlanSchema = z.object({
  planId: z.string().min(1),
  objective: z.string().min(1),
  steps: z.array(AgentPlanStepSchema).min(1),
  estimatedWaves: z.number().int().positive().default(1),
  maxBudgetTokens: z.number().int().positive().default(32000),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
});
export type AgentObjectivePlan = z.infer<typeof AgentObjectivePlanSchema>;

// ==========================================
// 3. EXECUTION OBSERVATION & TELEMETRY
// ==========================================

export const AgentObservationSchema = z.object({
  observationId: z.string().min(1),
  stepId: z.string().optional(),
  source: z.enum(['tool', 'specialist', 'browser', 'python', 'memory', 'user_input']),
  sourceName: z.string(),
  summary: z.string(),
  untrustedData: z.unknown().optional(),
  isError: z.boolean().default(false),
  timestamp: z.number().default(() => Date.now())
});
export type AgentObservation = z.infer<typeof AgentObservationSchema>;

// ==========================================
// 4. AUTONOMOUS AGENT TASK EXECUTION CONTRACT
// ==========================================

export const AutonomousAgentTaskSchema = z.object({
  taskId: z.string().min(1),
  principal: ExecutionPrincipalSchema,
  objective: z.string().min(1),
  state: AutonomousTaskStateSchema.default('CREATED'),
  plan: AgentObjectivePlanSchema.optional(),
  activeStepId: z.string().optional(),
  dag: TaskDAGSchema.optional(),
  observations: z.array(AgentObservationSchema).default([]),
  artifacts: z.array(z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    language: z.string().optional(),
    content: z.string(),
    version: z.number().default(1)
  })).default([]),
  approvalRequestId: z.string().optional(),
  deliverableSummary: z.string().optional(),
  error: z.string().optional(),
  executionHistory: z.array(z.object({
    state: AutonomousTaskStateSchema,
    timestamp: z.number(),
    reason: z.string().optional(),
    checkpoint: z.string().optional()
  })).default([]),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  completedAt: z.number().optional()
});
export type AutonomousAgentTask = z.infer<typeof AutonomousAgentTaskSchema>;
