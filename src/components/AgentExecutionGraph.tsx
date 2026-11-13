import React, { useState, useMemo } from 'react';
import {
  Workflow,
  Search,
  Code2,
  BarChart2,
  FileText,
  Globe,
  Zap,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  AlertCircle,
  Loader2,
  Clock,
  Layers,
  ExternalLink,
  ListFilter,
  Network,
  RotateCw,
} from 'lucide-react';
import type { 
  AgentExecutionGraph, 
  GraphTaskNode, 
  SpecialistRole 
} from '../types/executionGraph';

interface AgentExecutionGraphProps {
  graph: AgentExecutionGraph;
  selectedArtifactId?: string;
  onSelectArtifact?: (artifactId: string) => void;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  compact?: boolean;
}

const ROLE_METADATA: Record<SpecialistRole, { label: string; icon: React.FC<{ size?: number; className?: string }> }> = {
  planner: { label: 'Planner', icon: Workflow },
  researcher: { label: 'Researcher', icon: Search },
  coder: { label: 'Engineer', icon: Code2 },
  analyst: { label: 'Analyst', icon: BarChart2 },
  document: { label: 'Documenter', icon: FileText },
  browser: { label: 'Web Navigator', icon: Globe },
  automation: { label: 'Automation', icon: Zap },
  verifier: { label: 'Quality & Security', icon: ShieldCheck },
  synthesizer: { label: 'Synthesizer', icon: Layers }
};

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const AgentExecutionGraphView: React.FC<AgentExecutionGraphProps> = ({
  graph,
  selectedArtifactId,
  onSelectArtifact,
  onApproveTask,
  compact = false
}) => {
  const [userSelectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'dag' | 'timeline'>(compact ? 'timeline' : 'dag');
  const [approvingTaskIds, setApprovingTaskIds] = useState<Record<string, boolean>>({});

  const nodeMap = useMemo<Record<string, GraphTaskNode>>(() => (Array.isArray(graph.nodes)
    ? Object.fromEntries((graph.nodes as GraphTaskNode[]).map(n => [n.id, n]))
    : graph.nodes) || {}, [graph.nodes]);
  const waves = useMemo<string[][]>(() => (graph.waves && Array.isArray(graph.waves) && graph.waves.length > 0)
    ? graph.waves
    : [Object.keys(nodeMap)], [graph.waves, nodeMap]);
  const selectedNodeId = userSelectedNodeId || (selectedArtifactId
    ? Object.values(nodeMap).find(n => n.associatedArtifactId === selectedArtifactId)?.id || null
    : null);
  const selectedNode = selectedNodeId ? nodeMap[selectedNodeId] : null;

  const handleDecision = async (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => {
    if (approvingTaskIds[taskId]) return;
    setApprovingTaskIds(prev => ({ ...prev, [taskId]: true }));
    try {
      await onApproveTask?.(taskId, approvalId, decision);
    } finally {
      setApprovingTaskIds(prev => ({ ...prev, [taskId]: false }));
    }
  };

  // Node position calculation for SVG DAG layout
  const nodeLayout = useMemo(() => {
    const layout: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const columnWidth = 260;
    const columnGap = 80;
    const nodeHeight = 110;
    const nodeGap = 24;
    const startX = 30;
    const startY = 30;

    let maxX = 0;
    let maxY = 0;

    (waves || []).forEach((wave, waveIdx) => {
      const x = startX + waveIdx * (columnWidth + columnGap);
      (wave || []).forEach((nodeId, nodeIdx) => {
        const y = startY + nodeIdx * (nodeHeight + nodeGap);
        layout[nodeId] = { x, y, width: columnWidth, height: nodeHeight };
        if (x + columnWidth > maxX) maxX = x + columnWidth;
        if (y + nodeHeight > maxY) maxY = y + nodeHeight;
      });
    });

    return { layout, width: Math.max(maxX + 60, 600), height: Math.max(maxY + 60, 400) };
  }, [waves]);

  // Generate SVG Bezier curve connections
  const svgConnections = useMemo(() => {
    const connections: Array<{
      id: string;
      fromId: string;
      toId: string;
      d: string;
      isActive: boolean;
      isCompleted: boolean;
    }> = [];

    Object.values(nodeMap).forEach(targetNode => {
      (targetNode.dependsOn || (targetNode as any).dependencies || []).forEach(sourceId => {
        const sourceBox = nodeLayout.layout[sourceId];
        const targetBox = nodeLayout.layout[targetNode.id];
        if (sourceBox && targetBox) {
          const startX = sourceBox.x + sourceBox.width;
          const startY = sourceBox.y + sourceBox.height / 2;
          const endX = targetBox.x;
          const endY = targetBox.y + targetBox.height / 2;
          const midX = (startX + endX) / 2;
          const d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;

          const isCompleted = nodeMap[sourceId]?.state === 'COMPLETED';
          const isActive = isCompleted && targetNode.state === 'RUNNING';

          connections.push({
            id: `${sourceId}->${targetNode.id}`,
            fromId: sourceId,
            toId: targetNode.id,
            d,
            isActive,
            isCompleted
          });
        }
      });
    });

    return connections;
  }, [nodeMap, nodeLayout]);

  const renderStatusBadge = (node: GraphTaskNode) => {
    switch (node.state) {
      case 'COMPLETED':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
            <CheckCircle2 size={12} className="text-emerald-500" /> Done
          </span>
        );
      case 'RUNNING':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
            <Loader2 size={12} className="animate-spin text-amber-500" /> Active
          </span>
        );
      case 'WAITING_FOR_APPROVAL':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full animate-pulse">
            <AlertTriangle size={12} className="text-amber-500" /> Approval
          </span>
        );
      case 'RETRY_WAIT':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-orange-600 dark:text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">
            <RotateCw size={12} className="animate-spin text-orange-500" /> Retry
          </span>
        );
      case 'FAILED':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-full">
            <XCircle size={12} className="text-rose-500" /> Failed
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-500/10 px-2 py-0.5 rounded-full">
            <AlertCircle size={12} /> Cancelled
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 text-[11px] font-medium text-slate-400 dark:text-slate-500 bg-slate-500/10 px-2 py-0.5 rounded-full">
            <Clock size={12} /> {node.state === 'BLOCKED' ? 'Blocked' : 'Queued'}
          </span>
        );
    }
  };

  return (
    <section 
      className="flex flex-col h-full w-full bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark overflow-hidden"
      aria-label="Multi-Agent Execution Graph"
      data-testid="agent-execution-graph"
    >
      {/* Graph Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark">
        <div className="flex items-center gap-2">
          <Workflow size={18} className="text-claude-accentInk" />
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {graph.title}
          </h3>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-claude-terracotta/10 text-claude-accentInk">
            <span className="font-mono">{graph.completedTasks}/{graph.totalTasks}</span> Tasks
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-white/10 p-0.5 bg-slate-100 dark:bg-white/[0.04]">
            <button
              onClick={() => setViewMode('dag')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                viewMode === 'dag' 
                  ? 'bg-white dark:bg-white/15 text-slate-900 dark:text-white shadow-sm' 
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
              title="Interactive DAG canvas"
              data-testid="graph-view-dag-btn"
            >
              <Network size={13} />
              <span className="hidden sm:inline">DAG</span>
            </button>
            <button
              onClick={() => setViewMode('timeline')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                viewMode === 'timeline' 
                  ? 'bg-white dark:bg-white/15 text-slate-900 dark:text-white shadow-sm' 
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
              title="Execution timeline list"
              data-testid="graph-view-timeline-btn"
            >
              <ListFilter size={13} />
              <span className="hidden sm:inline">Timeline</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main View Area */}
      <div className="flex-1 overflow-auto relative">
        {viewMode === 'dag' ? (
          <div 
            className="relative min-w-full min-h-full p-4" 
            style={{ width: nodeLayout.width, height: nodeLayout.height }}
            data-testid="dag-canvas-container"
          >
            {/* SVG Connector Layer */}
            <svg 
              className="absolute inset-0 pointer-events-none" 
              width={nodeLayout.width} 
              height={nodeLayout.height}
            >
              <defs>
                <linearGradient id="connGradActive" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#10b981" />
                  <stop offset="100%" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
              {svgConnections.map(conn => (
                <path
                  key={conn.id}
                  d={conn.d}
                  fill="none"
                  stroke={conn.isActive ? 'url(#connGradActive)' : conn.isCompleted ? '#10b981' : '#94a3b8'}
                  strokeWidth={conn.isActive ? 2.5 : 1.5}
                  strokeDasharray={conn.isActive ? '5,5' : 'none'}
                  strokeOpacity={conn.isCompleted ? 0.7 : 0.3}
                  className={conn.isActive ? 'animate-pulse' : ''}
                />
              ))}
            </svg>

            {/* Render Nodes by Waves */}
            {Object.values(nodeMap).map(node => {
              const pos = nodeLayout.layout[node.id];
              if (!pos) return null;
              const roleMeta = ROLE_METADATA[node.role] || ROLE_METADATA.planner;
              const RoleIcon = roleMeta.icon;
              const isSelected = selectedNodeId === node.id;
              const hasLinkedArtifact = Boolean(node.associatedArtifactId);
              const isArtifactActive = Boolean(selectedArtifactId && node.associatedArtifactId === selectedArtifactId);

              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  tabIndex={0}
                  role="button"
                  aria-selected={isSelected}
                  aria-label={`Task ${node.name}: ${node.state}`}
                  style={{
                    position: 'absolute',
                    left: `${pos.x}px`,
                    top: `${pos.y}px`,
                    width: `${pos.width}px`,
                    minHeight: `${pos.height}px`
                  }}
                  className={`rounded-xl border p-3 cursor-pointer transition-colors duration-150 ${
                    isSelected 
                      ? 'border-claude-terracotta ring-2 ring-claude-terracotta/20 shadow-md bg-claude-surface-light dark:bg-claude-surface-dark'
                      : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-white/80 dark:bg-slate-900/80'
                  } ${isArtifactActive ? 'ring-2 ring-emerald-500/40' : ''}`}
                  data-testid={`graph-node-${node.id}`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                      <RoleIcon size={14} className="text-claude-accentInk shrink-0" />
                      <span className="truncate">{roleMeta.label}</span>
                    </div>
                    {renderStatusBadge(node)}
                  </div>

                  <p className="text-xs font-medium text-slate-900 dark:text-white line-clamp-1 mb-1">
                    {node.name}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mt-2">
                    <span className="font-mono">{node.id}</span>
                    {node.durationMs ? (
                      <span className="font-mono">{formatDuration(node.durationMs)}</span>
                    ) : node.state === 'RUNNING' && node.startedAt ? (
                      <span className="font-medium text-amber-500">running…</span>
                    ) : null}
                  </div>

                  {/* Active Tool telemetry */}
                  {node.activeTool && (
                    <div className="mt-2 pt-1.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between text-[10px]">
                      <span className="text-amber-500 flex items-center gap-1 truncate font-mono">
                        <Zap size={10} /> {node.activeTool.name}
                      </span>
                      <span className="text-slate-400 font-medium">in progress</span>
                    </div>
                  )}

                  {/* Associated Artifact Link */}
                  {hasLinkedArtifact && (
                    <div className="mt-2 pt-1.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between">
                      <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1 truncate">
                        <Layers size={10} /> {node.associatedArtifactTitle || 'Artifact'}
                      </span>
                      {onSelectArtifact && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectArtifact(node.associatedArtifactId!);
                          }}
                          className="text-[10px] text-claude-accentInk hover:underline flex items-center gap-0.5"
                          data-testid={`node-view-artifact-${node.id}`}
                        >
                          View <ExternalLink size={10} />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Pending Approval Callout */}
                  {node.state === 'WAITING_FOR_APPROVAL' && node.approvalId && (
                    <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] space-y-1.5">
                      <p className="text-amber-700 dark:text-amber-300 font-medium">
                        Approval Required
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={approvingTaskIds[node.id]}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDecision(node.id, node.approvalId!, 'APPROVE');
                          }}
                          className="flex-1 py-1 px-2 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-[10px] transition-colors disabled:opacity-50"
                          data-testid={`node-approve-btn-${node.id}`}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={approvingTaskIds[node.id]}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDecision(node.id, node.approvalId!, 'REJECT');
                          }}
                          className="flex-1 py-1 px-2 rounded bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-slate-200 font-medium text-[10px] transition-colors disabled:opacity-50"
                          data-testid={`node-reject-btn-${node.id}`}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Mobile / Timeline View */
          <div className="p-4 space-y-4 max-w-xl mx-auto" data-testid="timeline-view-container">
            {waves.map((wave, waveIdx) => (
              <div key={`wave-${waveIdx}`} className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <span>Wave {waveIdx + 1}</span>
                  <div className="flex-1 h-px bg-slate-200 dark:bg-white/10" />
                </div>

                <div className="space-y-2">
                  {wave.map(nodeId => {
                    const node = nodeMap[nodeId];
                    if (!node) return null;
                    const roleMeta = ROLE_METADATA[node.role] || ROLE_METADATA.planner;
                    const RoleIcon = roleMeta.icon;
                    const isSelected = selectedNodeId === node.id;
                    const isArtifactActive = Boolean(selectedArtifactId && node.associatedArtifactId === selectedArtifactId);

                    return (
                      <div
                        key={node.id}
                        onClick={() => setSelectedNodeId(node.id)}
                        className={`p-3 rounded-xl border transition-colors duration-150 ${
                          isSelected 
                            ? 'border-claude-terracotta bg-claude-surface-light dark:bg-claude-surface-dark shadow-sm'
                            : 'border-slate-200 dark:border-white/10 bg-white/70 dark:bg-slate-900/70'
                        } ${isArtifactActive ? 'ring-2 ring-emerald-500/30' : ''}`}
                        data-testid={`timeline-node-${node.id}`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                            <RoleIcon size={14} className="text-claude-accentInk shrink-0" />
                            <span>{roleMeta.label}</span>
                          </div>
                          {renderStatusBadge(node)}
                        </div>

                        <p className="text-xs font-medium text-slate-900 dark:text-white mb-1">
                          {node.name}
                        </p>

                        {node.objective && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 line-clamp-2">
                            {node.objective}
                          </p>
                        )}

                        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                          <span className="font-mono">{node.id}</span>
                          {node.durationMs && (
                            <span className="font-mono">{formatDuration(node.durationMs)}</span>
                          )}
                        </div>

                        {node.associatedArtifactId && (
                          <div className="mt-2 pt-1.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between">
                            <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <Layers size={10} /> {node.associatedArtifactTitle || 'Artifact'}
                            </span>
                            {onSelectArtifact && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectArtifact(node.associatedArtifactId!);
                                }}
                                className="text-[10px] text-claude-accentInk hover:underline flex items-center gap-0.5"
                              >
                                View <ExternalLink size={10} />
                              </button>
                            )}
                          </div>
                        )}

                        {node.state === 'WAITING_FOR_APPROVAL' && node.approvalId && (
                          <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] space-y-1.5">
                            <p className="text-amber-700 dark:text-amber-300 font-medium">
                              Approval Required: {node.approvalReason || 'Tool Execution'}
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={approvingTaskIds[node.id]}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDecision(node.id, node.approvalId!, 'APPROVE');
                                }}
                                className="flex-1 py-1.5 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-[11px] transition-colors disabled:opacity-50"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={approvingTaskIds[node.id]}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDecision(node.id, node.approvalId!, 'REJECT');
                                }}
                                className="flex-1 py-1.5 px-3 rounded bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-slate-200 font-medium text-[11px] transition-colors disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Selected Node Details Inspector Drawer */}
      {selectedNode && (
        <div 
          className="border-t border-slate-200 dark:border-white/10 bg-white dark:bg-slate-950 p-3 text-xs space-y-2 shrink-0 max-h-48 overflow-y-auto"
          data-testid="node-inspector-drawer"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900 dark:text-white">
                {selectedNode.name}
              </span>
              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                ({selectedNode.id})
              </span>
            </div>
            <button
              onClick={() => setSelectedNodeId(null)}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs"
            >
              Close
            </button>
          </div>

          {selectedNode.objective && (
            <p className="text-slate-600 dark:text-slate-300 text-[11px]">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Objective:</span> {selectedNode.objective}
            </p>
          )}

          {selectedNode.outputSummary && (
            <div className="p-2 rounded bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/5 text-[11px]">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Output Summary:</span> {selectedNode.outputSummary}
            </div>
          )}

          {selectedNode.error && (
            <div className="p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-[11px]">
              <span className="font-semibold">Error:</span> {selectedNode.error}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-slate-500 dark:text-slate-400">
              Role: <span className="font-medium text-slate-700 dark:text-slate-300">{selectedNode.role}</span> | Side-Effect: <span className="font-medium">{selectedNode.sideEffectLevel || 'NONE'}</span>
            </span>

            {selectedNode.associatedArtifactId && onSelectArtifact && (
              <button
                type="button"
                onClick={() => onSelectArtifact(selectedNode.associatedArtifactId!)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-aira-blue hover:opacity-90 text-white font-medium text-[11px] transition-colors"
                data-testid="inspector-open-artifact-btn"
              >
                <Layers size={12} /> Open Artifact in Studio
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
