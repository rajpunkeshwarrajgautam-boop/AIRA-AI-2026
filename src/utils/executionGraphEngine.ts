import type { 
  AgentExecutionGraph, 
  GraphTaskNode, 
  SpecialistRole
} from '../types/executionGraph';

export const CANONICAL_SPECIALIST_ROLES: readonly SpecialistRole[] = Object.freeze([
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

function isKnownRole(role: unknown): role is SpecialistRole {
  return typeof role === 'string' && CANONICAL_SPECIALIST_ROLES.includes(role as SpecialistRole);
}

/**
 * Sanitizes user-facing output text, removing raw secrets, tokens, CoT, and unbounded dumps.
 */
export function sanitizeUserFacingText(value: unknown, fallback = '', maxLen = 300): string {
  if (value === null || value === undefined) return fallback;
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // Redact potential bearer tokens, api keys, or hex passwords
  text = text.replace(/(?:bearer\s+[a-zA-Z0-9_.-]+|api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_-]+['"]?|secret\s*[:=]\s*['"]?[a-zA-Z0-9_-]+['"]?)/gi, '[REDACTED_CREDENTIAL]');
  // Clean whitespace
  text = text.trim().slice(0, maxLen);
  return text || fallback;
}

function safeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 64);
  return clean || fallback;
}

/**
 * Computes deterministic topological waves using Kahn's algorithm.
 * Tasks with inDegree 0 run concurrently in Wave 0, their dependents in Wave 1, etc.
 */
export function computeExecutionWaves(nodes: Record<string, { id: string; dependsOn: string[] }>): string[][] {
  const nodeKeys = Object.keys(nodes);
  if (nodeKeys.length === 0) return [];

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const id of nodeKeys) {
    inDegree.set(id, 0);
    outgoing.set(id, []);
  }

  for (const id of nodeKeys) {
    const deps = nodes[id]?.dependsOn || [];
    let validDepCount = 0;
    for (const depId of deps) {
      if (nodes[depId] && depId !== id) {
        outgoing.get(depId)!.push(id);
        validDepCount++;
      }
    }
    inDegree.set(id, validDepCount);
  }

  const waves: string[][] = [];
  let remainingCount = nodeKeys.length;
  const processed = new Set<string>();

  while (remainingCount > 0) {
    const currentWave = Array.from(inDegree.entries())
      .filter(([id, deg]) => deg === 0 && !processed.has(id))
      .map(([id]) => id)
      .sort(); // Deterministic alphabetical sort

    if (currentWave.length === 0) {
      // Cycle or broken dependency detected: break cycle and place remaining into a final wave
      const unresolved = nodeKeys.filter(id => !processed.has(id)).sort();
      waves.push(unresolved);
      break;
    }

    waves.push(currentWave);
    for (const id of currentWave) {
      processed.add(id);
      remainingCount--;
      for (const nextId of outgoing.get(id) || []) {
        const currentDeg = inDegree.get(nextId) || 0;
        inDegree.set(nextId, Math.max(0, currentDeg - 1));
      }
    }
  }

  return waves;
}

export interface TaskSeedConfig {
  id: string;
  name: string;
  role?: SpecialistRole;
  dependsOn?: string[];
  objective?: string;
  sideEffectLevel?: 'NONE' | 'READ' | 'MUTATION' | 'DESTRUCTIVE';
  approvalRequired?: boolean;
  maxAttempts?: number;
  associatedArtifactId?: string;
  associatedArtifactTitle?: string;
}

/**
 * Creates an initial AgentExecutionGraph from a collection of tasks.
 */
export function createExecutionGraph(config: {
  graphId: string;
  runId: string;
  title: string;
  tasks: TaskSeedConfig[];
}): AgentExecutionGraph {
  const nodes: Record<string, GraphTaskNode> = {};

  for (const t of config.tasks) {
    const id = safeId(t.id, 'task');
    const role: SpecialistRole = isKnownRole(t.role) ? t.role : 'planner';
    const dependsOn = (t.dependsOn || []).map(d => safeId(d, '')).filter(Boolean);
    const hasInitialDeps = dependsOn.length > 0;

    nodes[id] = {
      id,
      name: sanitizeUserFacingText(t.name, id, 100),
      role,
      state: hasInitialDeps ? 'BLOCKED' : 'QUEUED',
      dependsOn,
      objective: t.objective ? sanitizeUserFacingText(t.objective, '', 200) : undefined,
      attempt: 0,
      maxAttempts: t.maxAttempts ?? 2,
      approvalRequired: Boolean(t.approvalRequired),
      sideEffectLevel: t.sideEffectLevel || 'NONE',
      associatedArtifactId: t.associatedArtifactId,
      associatedArtifactTitle: t.associatedArtifactTitle
    };
  }

  const waves = computeExecutionWaves(nodes);
  const totalTasks = Object.keys(nodes).length;

  return {
    graphId: safeId(config.graphId, 'graph_default'),
    runId: safeId(config.runId, 'run_default'),
    title: sanitizeUserFacingText(config.title, 'Agent Multi-Step Execution', 80),
    nodes,
    waves,
    state: totalTasks > 0 ? 'RUNNING' : 'IDLE',
    startedAt: Date.now(),
    totalTasks,
    completedTasks: 0,
    failedTasks: 0
  };
}

/**
 * Applies incoming SSE events to the execution graph with out-of-order and idempotent safety.
 */
export function applyExecutionGraphEvent(
  graph: AgentExecutionGraph,
  eventType: string,
  rawPayload: unknown,
  occurredAt: number = Date.now()
): AgentExecutionGraph {
  const data = (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
    ? (rawPayload as Record<string, any>)
    : {};

  const nextNodes: Record<string, GraphTaskNode> = { ...graph.nodes };
  let nextState = graph.state;

  const targetStepId = safeId(data.stepId ?? data.taskId ?? data.id, '');

  switch (eventType) {
    case 'workflow.created':
    case 'workflow.started':
    case 'workflow_started': {
      if (Array.isArray(data.steps) && data.steps.length > 0) {
        return createExecutionGraph({
          graphId: safeId(data.workflowId ?? data.dagId ?? graph.graphId, graph.graphId),
          runId: safeId(data.runId ?? graph.runId, graph.runId),
          title: sanitizeUserFacingText(data.name ?? data.title ?? graph.title, 'Workflow Run', 80),
          tasks: data.steps.map((s: any) => ({
            id: s.stepId ?? s.taskId ?? s.id,
            name: s.name ?? s.title ?? s.stepId ?? 'Step',
            role: s.role,
            dependsOn: s.dependsOn ?? s.dependencies ?? [],
            objective: s.objective ?? s.input?.prompt,
            approvalRequired: Boolean(s.approvalRequired),
            sideEffectLevel: s.sideEffectLevel,
            maxAttempts: s.retry?.maxAttempts ?? s.retryPolicy?.maxRetries ?? 2,
            associatedArtifactId: s.associatedArtifactId ?? s.artifactId,
            associatedArtifactTitle: s.associatedArtifactTitle
          }))
        });
      }
      break;
    }

    case 'workflow.step.started':
    case 'workflow_step_started': {
      if (targetStepId && nextNodes[targetStepId]) {
        const current = nextNodes[targetStepId];
        // Idempotency: Don't reopen completed/cancelled steps with late start events
        if (current.state !== 'COMPLETED' && current.state !== 'CANCELLED') {
          nextNodes[targetStepId] = {
            ...current,
            state: 'RUNNING',
            startedAt: current.startedAt || occurredAt,
            attempt: (data.attempt !== undefined && typeof data.attempt === 'number') ? data.attempt : (current.attempt + 1),
            activeTool: data.toolName ? {
              name: sanitizeUserFacingText(data.toolName, 'tool', 40),
              status: 'running',
              startedAt: occurredAt
            } : current.activeTool
          };
        }
      }
      break;
    }

    case 'workflow.step.progress':
    case 'workflow_step_progress': {
      if (targetStepId && nextNodes[targetStepId]) {
        const current = nextNodes[targetStepId];
        if (current.state === 'RUNNING' || current.state === 'QUEUED') {
          const progressVal = typeof data.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : undefined;
          nextNodes[targetStepId] = {
            ...current,
            progress: progressVal ?? current.progress
          };
        }
      }
      break;
    }

    case 'tool.started':
    case 'tool_started': {
      const toolName = sanitizeUserFacingText(data.name ?? data.toolName, 'tool', 40);
      const callId = safeId(data.callId ?? data.toolId, '');
      const stepId = targetStepId || Object.keys(nextNodes).find(id => nextNodes[id].state === 'RUNNING');
      if (stepId && nextNodes[stepId]) {
        nextNodes[stepId] = {
          ...nextNodes[stepId],
          activeTool: {
            name: toolName,
            callId: callId || undefined,
            status: 'running',
            startedAt: occurredAt
          }
        };
      }
      break;
    }

    case 'tool.completed':
    case 'tool_completed': {
      const stepId = targetStepId || Object.keys(nextNodes).find(id => nextNodes[id].state === 'RUNNING');
      if (stepId && nextNodes[stepId] && nextNodes[stepId].activeTool) {
        nextNodes[stepId] = {
          ...nextNodes[stepId],
          activeTool: {
            ...nextNodes[stepId].activeTool!,
            status: 'completed'
          }
        };
      }
      break;
    }

    case 'approval.required':
    case 'tool.approval_required':
    case 'approval_required': {
      const stepId = targetStepId || Object.keys(nextNodes).find(id => nextNodes[id].state === 'RUNNING') || Object.keys(nextNodes)[0];
      if (stepId && nextNodes[stepId]) {
        const approvalReason = sanitizeUserFacingText(data.reason ?? data.prompt, 'Approval required for execution', 200);
        nextNodes[stepId] = {
          ...nextNodes[stepId],
          state: 'WAITING_FOR_APPROVAL',
          approvalRequired: true,
          // Backend requests use requestId (or id for approval.required).
          // Never invent an actionable approval ID if an event omits one.
          approvalId: safeId(data.requestId ?? data.approvalId ?? data.id, '') || undefined,
          approvalReason
        };
        nextState = 'WAITING_FOR_APPROVAL';
      }
      break;
    }

    case 'approval.resolved': {
      const stepId = targetStepId || Object.keys(nextNodes).find(id => nextNodes[id].state === 'WAITING_FOR_APPROVAL');
      if (stepId && nextNodes[stepId]) {
        const isApproved = data.decision === 'APPROVED' || data.decision === 'APPROVE';
        nextNodes[stepId] = {
          ...nextNodes[stepId],
          state: isApproved ? 'RUNNING' : 'CANCELLED',
          startedAt: isApproved ? (nextNodes[stepId].startedAt || occurredAt) : nextNodes[stepId].startedAt
        };
        // Re-evaluate overall graph state
        const hasOtherWaiting = Object.values(nextNodes).some(n => n.state === 'WAITING_FOR_APPROVAL');
        if (!hasOtherWaiting && nextState === 'WAITING_FOR_APPROVAL') {
          nextState = 'RUNNING';
        }
      }
      break;
    }

    case 'workflow.step.completed':
    case 'workflow_step_completed': {
      if (targetStepId) {
        const current = nextNodes[targetStepId];
        const startedAt = current?.startedAt || (occurredAt - 500);
        const durationMs = Math.max(0, occurredAt - startedAt);
        const artifactId = safeId(data.artifactId ?? data.associatedArtifactId ?? current?.associatedArtifactId, '');

        nextNodes[targetStepId] = {
          ...(current || {
            id: targetStepId,
            name: targetStepId,
            role: 'planner',
            dependsOn: [],
            attempt: 1,
            maxAttempts: 2
          }),
          state: 'COMPLETED',
          startedAt,
          completedAt: occurredAt,
          durationMs,
          progress: 100,
          outputSummary: sanitizeUserFacingText(data.output ?? data.summary, '', 200),
          associatedArtifactId: artifactId || undefined,
          associatedArtifactTitle: data.artifactTitle ?? current?.associatedArtifactTitle,
          activeTool: undefined
        };

        // Unblock dependent nodes whose all dependencies are now COMPLETED
        for (const [id, node] of Object.entries(nextNodes)) {
          if (node.state === 'BLOCKED') {
            const allDepsSatisfied = node.dependsOn.every(depId => nextNodes[depId]?.state === 'COMPLETED');
            if (allDepsSatisfied) {
              nextNodes[id] = { ...node, state: 'QUEUED' };
            }
          }
        }
      }
      break;
    }

    case 'workflow.step.failed':
    case 'workflow_step_failed': {
      if (targetStepId && nextNodes[targetStepId]) {
        const current = nextNodes[targetStepId];
        const errorMsg = sanitizeUserFacingText(data.error ?? data.message, 'Step execution failed', 200);
        const isRetryable = Boolean(data.retryable ?? false);
        const canRetry = isRetryable && current.attempt < current.maxAttempts;

        nextNodes[targetStepId] = {
          ...current,
          state: canRetry ? 'RETRY_WAIT' : 'FAILED',
          error: errorMsg,
          activeTool: undefined
        };

        // If permanently failed, block dependent nodes
        if (!canRetry) {
          for (const [id, node] of Object.entries(nextNodes)) {
            if (node.dependsOn.includes(targetStepId) && (node.state === 'QUEUED' || node.state === 'BLOCKED')) {
              nextNodes[id] = { ...node, state: 'BLOCKED', error: `Blocked by failed dependency: ${targetStepId}` };
            }
          }
        }
      }
      break;
    }

    case 'workflow.cancelled':
    case 'run.cancelled':
    case 'run_cancelled': {
      nextState = 'CANCELLED';
      for (const [id, node] of Object.entries(nextNodes)) {
        if (node.state === 'RUNNING' || node.state === 'QUEUED' || node.state === 'BLOCKED' || node.state === 'WAITING_FOR_APPROVAL' || node.state === 'RETRY_WAIT') {
          nextNodes[id] = { ...node, state: 'CANCELLED', completedAt: occurredAt };
        }
      }
      break;
    }

    case 'artifact.created':
    case 'artifact_open':
    case 'artifact_close': {
      const artId = safeId(data.id ?? data.artifactId, '');
      const artTitle = sanitizeUserFacingText(data.title, 'Artifact', 80);
      if (artId) {
        // Find step explicitly identified, or step currently running
        const stepId = targetStepId || Object.keys(nextNodes).find(id => nextNodes[id].state === 'RUNNING');
        if (stepId && nextNodes[stepId]) {
          nextNodes[stepId] = {
            ...nextNodes[stepId],
            associatedArtifactId: artId,
            associatedArtifactTitle: artTitle
          };
        }
      }
      break;
    }

    case 'run.completed':
    case 'workflow.completed': {
      nextState = 'COMPLETED';
      break;
    }

    case 'run.failed':
    case 'workflow.failed': {
      nextState = 'FAILED';
      break;
    }

    default:
      break;
  }

  // Recalculate completion metrics
  const nodeValues = Object.values(nextNodes);
  const totalTasks = nodeValues.length;
  const completedTasks = nodeValues.filter(n => n.state === 'COMPLETED').length;
  const failedTasks = nodeValues.filter(n => n.state === 'FAILED').length;
  const hasRunning = nodeValues.some(n => n.state === 'RUNNING' || n.state === 'QUEUED' || n.state === 'RETRY_WAIT');
  const hasWaiting = nodeValues.some(n => n.state === 'WAITING_FOR_APPROVAL');

  if (nextState !== 'CANCELLED') {
    if (hasWaiting) {
      nextState = 'WAITING_FOR_APPROVAL';
    } else if (hasRunning) {
      nextState = 'RUNNING';
    } else if (totalTasks > 0 && completedTasks === totalTasks) {
      nextState = 'COMPLETED';
    } else if (failedTasks > 0 && !hasRunning) {
      nextState = 'FAILED';
    }
  }

  return {
    ...graph,
    nodes: nextNodes,
    state: nextState,
    completedAt: (nextState === 'COMPLETED' || nextState === 'CANCELLED' || nextState === 'FAILED') ? (graph.completedAt || occurredAt) : undefined,
    totalTasks,
    completedTasks,
    failedTasks
  };
}
