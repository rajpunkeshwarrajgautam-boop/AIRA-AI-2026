import React from 'react';
import { Code2, ShieldCheck } from 'lucide-react';
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
 * Compact, polished empty-state component for the Unified Contextual Workspace.
 * Conforms to Section 2 requirements:
 * - Single non-nested layout container with data-testid="unified-workspace-empty"
 * - No fake Preview/Code tab strip
 * - No redundant h2 or duplicate visible close button
 * - Preserves execution telemetry, builder authorization, and cancellation callbacks
 * - Strictly follows design.md visual language
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
        className="w-full h-full min-h-0 flex flex-col overflow-hidden"
        aria-label="Agent Execution Studio"
        data-testid="adaptive-studio-graph-workspace"
      >
        <AgentExecutionGraphView
          graph={executionGraph}
          onSelectArtifact={onSelectArtifact}
          onApproveTask={onApproveTask}
        />
      </div>
    );
  }

  return (
    <div
      className="w-full h-full min-h-0 flex flex-col items-center justify-center p-6 sm:p-8 text-center select-none"
      aria-label="Artifact Studio"
      data-testid="unified-workspace-empty"
    >
      {/* Compatibility alias marker */}
      <div data-testid="adaptive-studio-empty" className="sr-only" aria-hidden="true" />

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="sr-only"
          aria-label="Close Artifact Studio"
          data-testid="adaptive-studio-close"
        >
          <span className="sr-only" data-testid="workspace-close" />
        </button>
      )}

      <div className="flex flex-col items-center max-w-sm mx-auto space-y-4">
        <AiraMark size="lg" isAnimated={false} />

        <div className="space-y-2">
          <h3 className="font-serif text-xl sm:text-2xl font-normal text-claude-text-light dark:text-white tracking-tight">
            Your next creation starts here.
          </h3>
          <p className="text-xs sm:text-sm text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
            Ask Aira to build an artifact, or open one from a conversation. Its real preview will appear in this workspace.
          </p>
        </div>

        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-white/10 text-xs text-claude-muted-light dark:text-claude-muted-dark">
          <Code2 size={14} className="text-claude-accentInk" aria-hidden="true" />
          <span>HTML, code, SVG, and supported interactive artifacts</span>
        </div>

        <div className="flex items-center gap-1.5 pt-2 text-[11px] text-claude-muted-light/80 dark:text-claude-muted-dark/80">
          <ShieldCheck size={13} className="text-emerald-500/80" aria-hidden="true" />
          <span>Generated content stays in Aira’s existing isolated preview runtime.</span>
        </div>
      </div>
    </div>
  );
};
