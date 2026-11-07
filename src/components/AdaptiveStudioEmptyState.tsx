import React from 'react';
import { Layers, Network, X } from 'lucide-react';
import type { AgentExecutionGraph } from '../types/executionGraph';
import { AgentExecutionGraphView } from './AgentExecutionGraph';

interface AdaptiveStudioEmptyStateProps {
  executionGraph?: AgentExecutionGraph | null;
  onSelectArtifact?: (artifactId: string) => void;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onClose?: () => void;
}

/**
 * Compact, unified workspace empty state or active multi-agent execution graph view.
 */
export const AdaptiveStudioEmptyState: React.FC<AdaptiveStudioEmptyStateProps> = ({
  executionGraph,
  onSelectArtifact,
  onApproveTask,
  onClose,
}) => {
  if (executionGraph && Object.keys(executionGraph.nodes).length > 0) {
    return (
      <div
        className="w-full h-full flex flex-col min-h-0 overflow-hidden"
        aria-label="Agent Execution Studio"
        data-testid="adaptive-studio-graph-workspace"
      >
        {onClose && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-claude-border-light/60 dark:border-white/10 bg-claude-surface-light dark:bg-claude-surface-dark">
            <span className="text-xs font-medium text-claude-muted-light dark:text-claude-muted-dark flex items-center gap-1.5">
              <Network size={14} aria-hidden="true" /> Execution Graph
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-claude-muted-dark transition-colors"
              title="Close Workspace"
              aria-label="Close Workspace"
              data-testid="adaptive-studio-close"
            >
              <span className="sr-only" data-testid="workspace-close">Close</span>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
          <AgentExecutionGraphView
            graph={executionGraph}
            onSelectArtifact={onSelectArtifact}
            onApproveTask={onApproveTask}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center p-8 text-center"
      data-testid="unified-workspace-empty"
    >
      <div className="w-12 h-12 rounded-2xl bg-aira-blue/10 dark:bg-aira-blue/20 text-aira-blue flex items-center justify-center mb-3.5 shadow-sm">
        <Layers size={22} aria-hidden="true" />
      </div>
      <h3 className="font-semibold text-sm text-claude-text-light dark:text-white mb-1.5">
        Unified Workspace Ready
      </h3>
      <p className="text-xs text-claude-muted-light dark:text-slate-400 max-w-sm mb-4 leading-relaxed">
        Interactive artifact previews, multi-file codebases, and isolated sandbox execution will appear here as you chat.
      </p>
      <div className="flex items-center gap-2 text-[11px] text-claude-muted-light dark:text-slate-500 bg-black/[0.03] dark:bg-white/[0.04] px-3.5 py-1.5 rounded-lg border border-claude-border-light/60 dark:border-white/5 font-mono">
        <span>Ask AIRA to build a component, app, or artifact to get started.</span>
      </div>
    </div>
  );
};
