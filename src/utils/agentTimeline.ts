import type { AgentTimelineEvent } from '../types';

type EventPayload = Record<string, unknown>;

const MAX_TIMELINE_EVENTS = 80;

function record(value: unknown): EventPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as EventPayload : {};
}

// The timeline only displays identifiers from server events; no arbitrary progress,
// tool input/output, stack traces, or hidden model reasoning cross into the UI.
function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 64);
  return clean || fallback;
}

export function normalizeAgentTimelineEvent(
  type: string,
  raw: unknown,
  occurredAt = Date.now(),
): AgentTimelineEvent | null {
  const data = record(raw);
  const step = safeIdentifier(data.stepId, 'step');
  const tool = safeIdentifier(data.name ?? data.toolName, 'tool');
  const toolCall = safeIdentifier(data.callId ?? data.toolId ?? data.id, tool);
  const make = (
    id: string,
    kind: AgentTimelineEvent['kind'],
    label: string,
    status: AgentTimelineEvent['status'],
  ): AgentTimelineEvent => ({ id, kind, label, status, occurredAt });

  // The chat stream uses underscore event names; the durable run SSE stream
  // emits dotted contract names. Both represent existing server events.
  switch (type) {
    case 'run.started':
    case 'run_started': return make('run', 'run', 'Agent run', 'running');
    case 'run.cancelled':
    case 'run.failed':
    case 'run_cancelled': return make('run', 'run', 'Agent run', 'failed');
    case 'run.completed': return make('run', 'run', 'Agent run', 'completed');
    case 'workflow.started':
    case 'workflow_started': return make('workflow', 'workflow', 'Multi-step workflow', 'running');
    case 'workflow.completed':
    case 'workflow_completed': return make('workflow', 'workflow', 'Multi-step workflow', 'completed');
    case 'workflow.failed': return make('workflow', 'workflow', 'Multi-step workflow', 'failed');
    case 'workflow.step.started':
    case 'workflow.step.progress':
    case 'workflow_step_started':
    case 'workflow_step_progress': return make(`step:${step}`, 'step', `Step ${step}`, 'running');
    case 'workflow.step.completed':
    case 'workflow_step_completed': return make(`step:${step}`, 'step', `Step ${step}`, 'completed');
    case 'workflow.step.failed':
    case 'workflow_step_failed': return make(`step:${step}`, 'step', `Step ${step}`, 'failed');
    case 'tool.started':
    case 'tool_started': return make(`tool:${toolCall}`, 'tool', `Tool ${tool}`, 'running');
    case 'tool.completed':
    case 'tool_completed': return make(`tool:${toolCall}`, 'tool', `Tool ${tool}`, 'completed');
    case 'tool.failed':
    case 'tool.cancelled': return make(`tool:${toolCall}`, 'tool', `Tool ${tool}`, 'failed');
    case 'tool.approval_required':
    case 'approval.required':
    case 'approval_required': return make('approval', 'approval', 'Approval required', 'waiting');
    case 'approval.resolved': return make('approval', 'approval', 'Approval resolved', 'completed');
    default: return null;
  }
}

export function appendAgentTimelineEvent(
  events: readonly AgentTimelineEvent[],
  incoming: AgentTimelineEvent,
): AgentTimelineEvent[] {
  const previousIndex = events.findIndex(event => event.id === incoming.id);
  if (previousIndex >= 0) {
    const next = [...events];
    // Late progress must not reopen a step already finalized by the backend.
    if (next[previousIndex].status !== 'running' && incoming.status === 'running') return next;
    next[previousIndex] = incoming;
    return next;
  }
  return [...events, incoming].slice(-MAX_TIMELINE_EVENTS);
}
