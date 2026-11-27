import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCode2,
  Loader2,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { GenUIComponentRenderer } from './types';

function StatusPill({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const cls =
    normalized === 'COMPLETED' || normalized === 'DONE' || normalized === 'ALLOW_ONCE' || normalized === 'ALLOW_SESSION' || normalized === 'ALLOW_ALWAYS_FOR_TOOL'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25'
      : normalized === 'FAILED' || normalized === 'ERROR' || normalized === 'REJECT' || normalized === 'CANCELLED'
        ? 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/25'
        : normalized === 'WAITING_FOR_APPROVAL' || normalized === 'WAITING'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25'
          : 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export const MissionSummaryRenderer: GenUIComponentRenderer<'mission_summary'> = ({ component }) => {
  const { title, status, intent, stepCount, completedSteps, summary, modelLabel } = component.props;
  return (
    <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/85 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/85">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-claude-subtext-light dark:text-claude-subtext-dark">
              {intent.replace(/_/g, ' ')}
            </span>
            {modelLabel && (
              <span className="font-mono text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">
                • {modelLabel}
              </span>
            )}
          </div>
          <h4 className="mt-0.5 text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">{title}</h4>
        </div>
        <StatusPill status={status} />
      </div>
      {summary && (
        <p className="mt-2 text-xs leading-relaxed text-claude-subtext-light dark:text-claude-subtext-dark">
          {summary}
        </p>
      )}
      {stepCount > 0 && (
        <div className="mt-2.5 text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
          Progress: <span className="font-mono font-medium">{completedSteps}/{stepCount}</span> steps completed
        </div>
      )}
    </div>
  );
};

export const TaskStatusRenderer: GenUIComponentRenderer<'task_status'> = ({ component }) => {
  const { taskName, status, detail, durationMs } = component.props;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-claude-border-light/80 px-3 py-2 text-xs dark:border-claude-border-dark/80">
      <div className="min-w-0">
        <div className="font-medium text-claude-text-light dark:text-claude-text-dark">{taskName}</div>
        {detail && <div className="mt-0.5 text-claude-subtext-light dark:text-claude-subtext-dark">{detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {durationMs !== undefined && (
          <span className="font-mono text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">
            {Math.round(durationMs)}ms
          </span>
        )}
        <StatusPill status={status} />
      </div>
    </div>
  );
};

export const ExecutionTimelineRenderer: GenUIComponentRenderer<'execution_timeline'> = ({ component }) => (
  <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/70">
    <h4 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-claude-subtext-light dark:text-claude-subtext-dark">
      <Clock className="h-3.5 w-3.5" />
      {component.props.title}
    </h4>
    <ol className="space-y-2">
      {component.props.entries.map((entry) => (
        <li key={entry.id} className="flex items-start gap-2.5 text-xs">
          <span className="mt-0.5 shrink-0">
            {entry.status === 'done' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            ) : entry.status === 'error' ? (
              <XCircle className="h-3.5 w-3.5 text-red-500" />
            ) : entry.status === 'active' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#c25938]" />
            ) : entry.status === 'waiting' ? (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <Clock className="h-3.5 w-3.5 text-stone-400" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-claude-text-light dark:text-claude-text-dark">{entry.label}</span>
              {entry.timestampLabel && (
                <span className="font-mono text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">
                  {entry.timestampLabel}
                </span>
              )}
            </div>
            {entry.detail && (
              <p className="mt-0.5 text-claude-subtext-light dark:text-claude-subtext-dark">{entry.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  </div>
);

export const ToolExecutionSummaryRenderer: GenUIComponentRenderer<'tool_execution_summary'> = ({ component }) => (
  <div className="rounded-xl border border-claude-border-light bg-claude-surface-light/70 p-3.5 dark:border-claude-border-dark dark:bg-claude-surface-dark/70">
    <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-claude-subtext-light dark:text-claude-subtext-dark">
      <Wrench className="h-3.5 w-3.5" />
      {component.props.title}
    </h4>
    <div className="space-y-1.5">
      {component.props.calls.map((c, idx) => (
        <div
          key={c.toolName + idx}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/[0.02] px-2.5 py-1.5 text-xs dark:bg-white/[0.03]"
        >
          <div className="min-w-0">
            <span className="font-mono font-medium text-claude-text-light dark:text-claude-text-dark">
              {c.toolName}
            </span>
            {c.summary && (
              <span className="ml-2 text-claude-subtext-light dark:text-claude-subtext-dark">{c.summary}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {c.durationMs !== undefined && (
              <span className="font-mono text-[11px] text-claude-subtext-light dark:text-claude-subtext-dark">
                {Math.round(c.durationMs)}ms
              </span>
            )}
            <StatusPill status={c.status} />
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const ArtifactReferenceRenderer: GenUIComponentRenderer<'artifact_reference'> = ({ component, ctx }) => {
  const { artifactId, title, artifactType, version, actionId } = component.props;
  return (
    <button
      type="button"
      onClick={() => {
        if (ctx.onOpenArtifact) ctx.onOpenArtifact(artifactId);
        if (actionId) ctx.onTriggerAction(component.id, actionId);
      }}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-claude-border-light bg-claude-surface-light px-3.5 py-2.5 text-left transition hover:border-[#c25938]/60 dark:border-claude-border-dark dark:bg-claude-surface-dark"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <FileCode2 className="h-4 w-4 shrink-0 text-[#c25938]" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-claude-text-light dark:text-claude-text-dark">{title}</div>
          <div className="text-xs text-claude-subtext-light dark:text-claude-subtext-dark">
            {artifactType} • v{version}
          </div>
        </div>
      </div>
      <span className="shrink-0 text-xs font-medium text-[#c25938]">Open</span>
    </button>
  );
};

export const ApprovalRequestRenderer: GenUIComponentRenderer<'approval_request'> = ({ component, ctx }) => {
  const { approvalId, runId, toolName, risk, reason, decision } = component.props;
  const isPending = decision === 'PENDING';
  const canAct = isPending && Boolean(ctx.onResolveApproval) && !ctx.disabled;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
            Approval Required: <code className="font-mono text-xs">{toolName}</code>
          </span>
        </div>
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium uppercase text-amber-700 dark:text-amber-300">
          {risk} risk
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-claude-subtext-light dark:text-claude-subtext-dark">{reason}</p>
      {isPending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canAct}
            onClick={() => ctx.onResolveApproval?.(approvalId, runId, 'ALLOW_ONCE')}
            className="rounded-lg bg-[#b84b29] px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-[#9f3f21] disabled:opacity-50"
          >
            Approve Once
          </button>
          <button
            type="button"
            disabled={!canAct}
            onClick={() => ctx.onResolveApproval?.(approvalId, runId, 'ALLOW_SESSION')}
            className="rounded-lg border border-claude-border-light bg-claude-surface-light px-3 py-1.5 text-xs font-medium text-claude-text-light transition hover:bg-black/5 disabled:opacity-50 dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark"
          >
            Allow Session
          </button>
          <button
            type="button"
            disabled={!canAct}
            onClick={() => ctx.onResolveApproval?.(approvalId, runId, 'REJECT')}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="mt-2.5">
          <StatusPill status={decision} />
        </div>
      )}
    </div>
  );
};

export const ErrorRecoveryRenderer: GenUIComponentRenderer<'error_recovery'> = ({ component, ctx }) => {
  const { title, message, code, recoverable, retryActionId } = component.props;
  return (
    <div className="rounded-xl border border-red-500/35 bg-red-500/[0.06] p-3.5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">{title}</span>
            {code && (
              <span className="font-mono text-[11px] text-red-700 dark:text-red-300">{code}</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-claude-subtext-light dark:text-claude-subtext-dark">
            {message}
          </p>
          {recoverable && retryActionId && (
            <button
              type="button"
              disabled={ctx.disabled}
              onClick={() => ctx.onTriggerAction(component.id, retryActionId)}
              className="mt-2.5 rounded-lg border border-claude-border-light bg-claude-surface-light px-3 py-1 text-xs font-medium text-claude-text-light hover:bg-black/5 dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-text-dark"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
