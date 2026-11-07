import React from 'react';
import { Code2, Layers3, ShieldCheck } from 'lucide-react';
import { AiraMark } from './AiraMark';
import type { AgentExecutionGraph } from '../types/executionGraph';
import { AgentExecutionGraphView } from './AgentExecutionGraph';

interface AdaptiveStudioEmptyStateProps {
  executionGraph?: AgentExecutionGraph | null;
  onSelectArtifact?: (artifactId: string) => void;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
}

/**
 * Empty or active multi-agent execution workspace for the opt-in Adaptive Studio layout.
 * Real artifacts continue to render in the existing sandboxed ArtifactStudio.
 */
export const AdaptiveStudioEmptyState: React.FC<AdaptiveStudioEmptyStateProps> = ({
  executionGraph,
  onSelectArtifact,
  onApproveTask,
}) => {
  if (executionGraph && Object.keys(executionGraph.nodes).length > 0) {
    return (
      <aside
        className="aira-adaptive-empty-studio !p-0 overflow-hidden flex flex-col"
        aria-label="Agent Execution Studio"
        data-testid="adaptive-studio-graph-workspace"
      >
        <AgentExecutionGraphView
          graph={executionGraph}
          onSelectArtifact={onSelectArtifact}
          onApproveTask={onApproveTask}
        />
      </aside>
    );
  }

  return (
    <aside className="aira-adaptive-empty-studio" aria-label="Artifact Studio" data-testid="adaptive-studio-empty">
      <div className="aira-adaptive-empty-header">
        <Layers3 size={22} aria-hidden="true" />
        <h2>Artifact Studio</h2>
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
