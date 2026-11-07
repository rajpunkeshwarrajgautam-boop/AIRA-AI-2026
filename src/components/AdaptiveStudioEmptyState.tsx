import React from 'react';
import { Code2, Layers3, ShieldCheck, X } from 'lucide-react';
import { AiraMark } from './AiraMark';
import type { AgentExecutionGraph } from '../types/executionGraph';
import { AgentExecutionGraphView } from './AgentExecutionGraph';

interface AdaptiveStudioEmptyStateProps {
  executionGraph?: AgentExecutionGraph | null;
  onSelectArtifact?: (artifactId: string) => void;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onClose?: () => void;
}

/**
 * Empty or active multi-agent execution workspace for the opt-in Adaptive Studio layout.
 * Real artifacts continue to render in the existing sandboxed ArtifactStudio.
 */
export const AdaptiveStudioEmptyState: React.FC<AdaptiveStudioEmptyStateProps> = ({
  executionGraph,
  onSelectArtifact,
  onApproveTask,
  onClose,
}) => {
  if (executionGraph && Object.keys(executionGraph.nodes).length > 0) {
    return (
      <aside
        className="aira-adaptive-empty-studio !p-0 overflow-hidden flex flex-col"
        aria-label="Agent Execution Studio"
        data-testid="adaptive-studio-graph-workspace"
      >

        {onClose && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-claude-border-light/60 dark:border-white/10 bg-claude-surface-light dark:bg-claude-surface-dark">
            <span className="text-xs font-medium text-claude-muted-light dark:text-claude-muted-dark flex items-center gap-1.5">
              <Layers3 size={15} aria-hidden="true" /> Execution Graph
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-claude-muted-dark transition-colors"
              title="Close Artifact Studio"
              aria-label="Close Artifact Studio"
              data-testid="adaptive-studio-close"
            >
              <span className="sr-only" data-testid="workspace-close" />
              <X size={16} aria-hidden="true" />
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
      </aside>
    );
  }

  return (
    <aside
      className="aira-adaptive-empty-studio"
      aria-label="Artifact Studio"
      data-testid="adaptive-studio-empty"
    >

      <div className="aira-adaptive-empty-header flex items-center justify-between w-full">
        <div className="flex items-center gap-3">
          <Layers3 size={22} aria-hidden="true" />
          <h2>Artifact Studio</h2>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-claude-muted-dark transition-colors"
            title="Close Artifact Studio"
            aria-label="Close Artifact Studio"
            data-testid="adaptive-studio-close"
          >
            <span className="sr-only" data-testid="workspace-close" />
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="aira-adaptive-empty-tabs" aria-hidden="true">
        <span className="aira-adaptive-empty-tab-active">Preview</span>
        <span>Code</span>
      </div>
      <div className="aira-adaptive-empty-body">
        <AiraMark size="lg" isAnimated={false} />
        <h3>Your next creation starts here.</h3>
        <p>Ask Aira to build an artifact, or open one from a conversation. Its real preview will appear in this workspace.</p>
        <div className="aira-adaptive-empty-hint">
          <Code2 size={18} aria-hidden="true" />
          HTML, code, SVG, and supported interactive artifacts
        </div>
      </div>
      <div className="aira-adaptive-empty-footer">
        <ShieldCheck size={18} aria-hidden="true" />
        Generated content stays in Aira's existing isolated preview runtime.
      </div>
    </aside>
  );
};
