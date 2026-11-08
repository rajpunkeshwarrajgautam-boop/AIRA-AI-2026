import React from 'react';
import { AlertTriangle } from 'lucide-react';

export interface PendingToolApproval {
  id: string;
  runId: string;
  toolName?: string;
  reason?: string;
}

interface ExecutionApprovalBannerProps {
  approval: PendingToolApproval;
  isSubmitting: boolean;
  onDecision: (decision: 'APPROVE' | 'REJECT') => void;
}

/** Presentation only: the parent owns authorization and request dispatch. */
export function ExecutionApprovalBanner({ approval, isSubmitting, onDecision }: ExecutionApprovalBannerProps) {
  return (
    <div className="max-w-2xl mx-auto px-4 mb-3">
      <div className="p-4 bg-amber-500/10 dark:bg-amber-950/40 border border-amber-500/30 rounded-xl backdrop-blur-md text-sm text-claude-text-light dark:text-claude-text-dark shadow-lg">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <span>Tool Execution Approval Required</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono">
            {approval.toolName || 'system_action'}
          </span>
        </div>
        <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mb-3">
          {approval.reason || 'This tool execution produces state changes or destructive side effects that require explicit user authorization.'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecision('APPROVE')}
            disabled={isSubmitting}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-sm transition disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting...' : 'Approve Execution'}
          </button>
          <button
            onClick={() => onDecision('REJECT')}
            disabled={isSubmitting}
            className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 dark:text-rose-400 font-medium text-xs transition disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
