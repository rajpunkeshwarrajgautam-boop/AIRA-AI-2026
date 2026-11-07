/**
 * Domain types for AIRA Multi-Agent Orchestration & Execution Graph (Phase 3).
 *
 * Implements authoritative alignment with:
 * - packages/contracts/src/agent-specialists.ts (9 Specialist Roles, Task States)
 * - packages/agent-runtime/src/workflow-engine.ts (Workflow Definition, DAG Waves)
 * - src/types/index.ts (AgentTimelineEvent, Artifact synchronization)
 */

export type SpecialistRole = 
  | 'planner'
  | 'researcher'
  | 'coder'
  | 'analyst'
  | 'document'
  | 'browser'
  | 'automation'
  | 'verifier'
  | 'synthesizer';

export type SpecialistTaskState = 
  | 'QUEUED'
  | 'BLOCKED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'WAITING_FOR_APPROVAL'
  | 'RETRY_WAIT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'UNAVAILABLE';

export interface GraphActiveTool {
  name: string;
  callId?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: number;
}

export interface GraphTaskNode {
  id: string;
  name: string;
  role: SpecialistRole;
  state: SpecialistTaskState;
  dependsOn: string[];
  objective?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  progress?: number; // 0 - 100
  attempt: number;
  maxAttempts: number;
  activeTool?: GraphActiveTool;
  approvalRequired?: boolean;
  approvalId?: string;
  approvalReason?: string;
  sideEffectLevel?: 'NONE' | 'READ' | 'MUTATION' | 'DESTRUCTIVE';
  associatedArtifactId?: string;
  associatedArtifactTitle?: string;
  error?: string;
  outputSummary?: string;
}

export interface AgentExecutionGraph {
  graphId: string;
  runId: string;
  title: string;
  nodes: Record<string, GraphTaskNode>;
  /** Topological execution waves. Tasks in the same wave can run concurrently. */
  waves: string[][];
  state: 'IDLE' | 'RUNNING' | 'WAITING_FOR_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt?: number;
  completedAt?: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
}
