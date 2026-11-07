import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Code,
  Play,
  Square,
  Copy,
  Check,
  Download,
  Maximize2,
  Minimize2,
  X,
  RotateCw,
  Terminal,
  ExternalLink,
  Monitor,
  Tablet,
  Smartphone,
  FolderTree,
  Network,
  ShieldCheck,
  Users,
  Sliders,
  Loader2,
  Wrench,
  CheckCircle2,
  Layers,
} from 'lucide-react';
import type { Artifact, ModelId } from '../types';
import type { AgentExecutionGraph } from '../types/executionGraph';
import type { MultiFileArtifactBundle, ArtifactProjectFile, ArtifactFileKind } from '../types/multiFileArtifact';
import { AgentExecutionGraphView } from './AgentExecutionGraph';
import { WorkspaceFileExplorer } from './WorkspaceFileExplorer';
import { MultiModalAssetViewer } from './MultiModalAssetViewer';
import { AgentsView } from './AgentsView';
import { generateMultiFileArtifactSandboxHtml } from '../utils/multiFileSandbox';
import { adaptSingleFileArtifactToBundle } from '../utils/artifactBundleEngine';
import { generateProjectZipArchive } from '../utils/artifactZipExporter';
import { syncBundleToWorkspace } from '../utils/artifactWorkspaceSync';
import { generateArtifactSandboxHtml } from '../utils/artifactSandbox';
import { type ArtifactRuntimeError } from '../utils/artifactRuntimeError';
import {
  streamBuilder,
  cancelBuilder,
  downloadBuilderFile,
  builderStatus,
  type BuilderEvent,
  type BuilderStatus,
} from '../utils/builderClient';

export interface ToolStep {
  id: string;
  name: string;
  label: string;
  state: 'running' | 'done' | 'error';
  output?: unknown;
}

export interface FileResult {
  title: string;
  path: string;
  bytes: number;
  url: string;
  expiresAt: number;
}

export type UnifiedWorkspaceTab =
  | 'preview'
  | 'code'
  | 'files'
  | 'activity'
  | 'graph'
  | 'approvals'
  | 'agents';

function newSandboxNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

export interface UnifiedWorkspaceProps {
  isOpen: boolean;
  onClose: () => void;
  // Artifact properties
  artifact: Artifact | null;
  onUpdateArtifact?: (updated: Artifact) => void;
  onRepairArtifact?: (error: ArtifactRuntimeError, title: string) => void;
  allArtifacts?: Artifact[];
  onSelectArtifact?: (artifact: Artifact) => void;
  activeProjectName?: string;
  onSaveToProject?: (artifact: Artifact) => void;
  bundle?: MultiFileArtifactBundle | null;
  onSelectFile?: (filePath: string) => void;

  // Execution Graph
  executionGraph?: AgentExecutionGraph | null;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;

  // Agent Builder & Sandbox state handoff
  activeAgentPrompt?: string;
  onActivePromptConsumed?: () => void;
  model?: ModelId;
  builderStatus?: BuilderStatus | null;
  builderPreviewUrl?: string;
  builderFiles?: FileResult[];
  builderSteps?: ToolStep[];
  builderBusy?: boolean;
  builderExpired?: boolean;
  onCancelExecution?: () => void;
  onExecutionCancelled?: () => void;
  onPreviewAvailable?: (url: string) => void;
  onToolStepUpdate?: (step: ToolStep) => void;
  onBusyChange?: (busy: boolean) => void;

  // Tab control
  initialTab?: UnifiedWorkspaceTab;
  workspaceMode?: 'chat' | 'agent';
}

export const UnifiedWorkspace: React.FC<UnifiedWorkspaceProps> = ({
  isOpen,
  onClose,
  artifact,
  onUpdateArtifact,
  onRepairArtifact,
  allArtifacts,
  onSelectArtifact,
  activeProjectName,
  onSaveToProject,
  executionGraph,
  bundle: explicitBundle,
  onSelectFile,
  onApproveTask,
  activeAgentPrompt,
  onActivePromptConsumed,
  model,
  builderStatus: initialBuilderStatus,
  builderPreviewUrl,
  builderFiles = [],
  builderSteps = [],
  builderBusy = false,
  builderExpired = false,
  onCancelExecution,
  onExecutionCancelled,
  onPreviewAvailable,
  onToolStepUpdate,
  onBusyChange,
  initialTab = 'preview',
  workspaceMode = 'chat',
}) => {
  // Live Builder Execution Engine State
  const [prompt, setPrompt] = useState(activeAgentPrompt || '');
  const [allowExecution, setAllowExecution] = useState(true);
  const [allowInternet, setAllowInternet] = useState(false);
  const [allowPreview, setAllowPreview] = useState(true);

  const [liveBusy, setLiveBusy] = useState(false);
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([]);
  const [liveFiles, setLiveFiles] = useState<FileResult[]>([]);
  const [livePreviewUrl, setLivePreviewUrl] = useState('');
  const [liveSummary, setLiveSummary] = useState('');
  const [liveError, setLiveError] = useState('');
  const [liveActivity, setLiveActivity] = useState('');
  const [liveStatus, setLiveStatus] = useState<BuilderStatus | null>(initialBuilderStatus || null);
  const [liveExpires, setLiveExpires] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const ticketRef = useRef('');
  const activeRef = useRef(false);
  const mountedRef = useRef(true);

  // Active Tab & Presentation State
  const [activeTab, setActiveTab] = useState<UnifiedWorkspaceTab>(initialTab);
  const [selectedVersion, setSelectedVersion] = useState<number>(1);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [devicePreset, setDevicePreset] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [isSyncingWorkspace, setIsSyncingWorkspace] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [activeNonce, setActiveNonce] = useState<string>(newSandboxNonce);

  // Mount & Builder Status Polling
  useEffect(() => {
    mountedRef.current = true;
    if (!liveStatus) {
      builderStatus()
        .then(s => { if (mountedRef.current) setLiveStatus(s); })
        .catch(() => {});
    }
    return () => {
      mountedRef.current = false;
      if (activeRef.current) controllerRef.current?.abort();
      if (ticketRef.current) void cancelBuilder(ticketRef.current, true).catch(() => {});
    };
  }, []);

  // Sync activeAgentPrompt into internal builder state
  useEffect(() => {
    if (activeAgentPrompt && activeAgentPrompt.trim() && !liveBusy) {
      setPrompt(activeAgentPrompt);
      setActiveTab('activity');
      onActivePromptConsumed?.();
    }
  }, [activeAgentPrompt, liveBusy, onActivePromptConsumed]);

  // Combined Files & Steps (merging props + live execution)
  const allFiles = useMemo(() => {
    const combined = [...builderFiles];
    for (const lf of liveFiles) {
      if (!combined.some(f => f.path === lf.path)) {
        combined.push(lf);
      }
    }
    return combined;
  }, [builderFiles, liveFiles]);

  const allSteps = useMemo(() => {
    const combined = [...builderSteps];
    for (const ls of liveSteps) {
      const idx = combined.findIndex(s => s.id === ls.id);
      if (idx >= 0) {
        combined[idx] = ls;
      } else {
        combined.push(ls);
      }
    }
    return combined;
  }, [builderSteps, liveSteps]);

  const effectivePreviewUrl = livePreviewUrl || builderPreviewUrl || '';
  const effectiveBusy = liveBusy || builderBusy;

  // Artifact Multi-file and Bundle helpers
  const activeBundle = useMemo<MultiFileArtifactBundle | null>(() => {
    if (explicitBundle) return explicitBundle;
    if (!artifact) return null;
    if (artifact.bundle) return artifact.bundle;
    return adaptSingleFileArtifactToBundle(artifact);
  }, [explicitBundle, artifact]);

  const defaultEntryPath = activeBundle ? (activeBundle.entryPoint || Object.keys(activeBundle.files)[0] || '') : '';
  const [userSelectedFilePath, setUserSelectedFilePath] = useState<string | null>(null);
  const selectedFilePath = (userSelectedFilePath && activeBundle?.files[userSelectedFilePath])
    ? userSelectedFilePath
    : defaultEntryPath;

  useEffect(() => {
    if (artifact) {
      setSelectedVersion(artifact.version);
      setUserSelectedFilePath(null);
      setActiveNonce(newSandboxNonce());
    }
  }, [artifact?.id, artifact?.version]);

  const isMultiFile = Boolean(activeBundle && Object.keys(activeBundle.files).length > 1);
  const currentContent = useMemo(() => {
    if (!artifact) return '';
    if (artifact.versions && artifact.versions.length > 0) {
      const found = artifact.versions.find(v => v.version === selectedVersion);
      if (found) return found.content;
    }
    return artifact.content;
  }, [artifact, selectedVersion]);

  const isMultiModal = Boolean(
    artifact && (
      artifact.type.startsWith('image/') ||
      artifact.type.startsWith('audio/') ||
      artifact.type.startsWith('video/') ||
      artifact.type === 'application/pdf'
    )
  );

  const assetFile = useMemo<ArtifactProjectFile | null>(() => {
    if (!artifact) return null;
    const kind: ArtifactFileKind = artifact.type.startsWith('image/')
      ? (artifact.type === 'image/svg+xml' ? 'svg' : 'image')
      : artifact.type.startsWith('audio/')
      ? 'audio'
      : artifact.type.startsWith('video/')
      ? 'video'
      : artifact.type === 'application/pdf'
      ? 'pdf'
      : 'asset';
    const filename = `asset.${artifact.type.split('/')[1] || 'bin'}`;
    return {
      id: `file_${artifact.id}`,
      name: filename,
      path: filename,
      version: artifact.version || 1,
      content: currentContent,
      lastModified: Date.now(),
      sizeBytes: new Blob([currentContent]).size,
      kind,
      mimeType: artifact.type,
    };
  }, [artifact, currentContent]);

  // Contextual Tabs Calculation: ONLY EXPOSE TABS WHEN RELEVANT CONTENT EXISTS
  const availableTabs = useMemo(() => {
    const tabs: Array<{ id: UnifiedWorkspaceTab; label: string; icon: any; count?: number; badge?: string }> = [];

    // 1. Preview Tab: ONLY present if real previewable artifact or builder preview exists!
    const hasArtifactPreview = Boolean(
      artifact && (
        artifact.type === 'application/vnd.ant.code' ||
        artifact.type === 'application/vnd.ant.react' ||
        artifact.type === 'text/html' ||
        artifact.type === 'image/svg+xml' ||
        isMultiModal
      )
    );
    const hasLivePreview = Boolean(effectivePreviewUrl);

    if (hasArtifactPreview || hasLivePreview) {
      tabs.push({
        id: 'preview',
        label: 'Preview',
        icon: Play,
        badge: hasLivePreview ? 'Live' : (effectiveBusy ? 'Building' : undefined),
      });
    }

    // 2. Code Tab: ONLY present if artifact exists and is not purely multimodal asset
    if (artifact && !isMultiModal) {
      tabs.push({
        id: 'code',
        label: 'Code',
        icon: Code,
        badge: artifact.language || undefined,
      });
    }

    // 3. Files Tab: ONLY present if multi-file bundle exists OR builder files exist!
    const totalFiles = (isMultiFile && activeBundle ? Object.keys(activeBundle.files).length : 0) + allFiles.length;
    if (isMultiFile || allFiles.length > 0) {
      tabs.push({
        id: 'files',
        label: 'Files',
        icon: FolderTree,
        count: totalFiles,
      });
    }

    // 4. Activity Tab: present if builder steps exist, or execution is active, or an active agent task was handed off!
    const hasActivity = allSteps.length > 0 || effectiveBusy || Boolean(prompt.trim()) || Boolean(activeAgentPrompt);
    if (hasActivity) {
      tabs.push({
        id: 'activity',
        label: 'Activity',
        icon: Terminal,
        count: allSteps.length > 0 ? allSteps.length : undefined,
        badge: effectiveBusy ? 'Active' : undefined,
      });
    }

    // 5. Execution Graph Tab: ONLY present if execution graph has nodes
    if (executionGraph && Object.keys(executionGraph.nodes).length > 0) {
      tabs.push({
        id: 'graph',
        label: 'Graph',
        icon: Network,
      });
    }

    // 6. Approvals Tab: ONLY present if pending approvals exist
    const hasPendingApprovals = Boolean(
      executionGraph?.nodes &&
      Object.values(executionGraph.nodes).some(n => n.approvalRequired && n.state === 'WAITING_FOR_APPROVAL')
    );
    if (hasPendingApprovals) {
      tabs.push({
        id: 'approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        badge: 'Required',
      });
    }

    return tabs;
  }, [
    artifact,
    isMultiModal,
    effectivePreviewUrl,
    effectiveBusy,
    isMultiFile,
    activeBundle,
    allFiles.length,
    allSteps.length,
    prompt,
    activeAgentPrompt,
    executionGraph,
  ]);

  // Ensure active tab is valid; default to first available tab
  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.some(t => t.id === activeTab)) {
      setActiveTab(availableTabs[0].id);
    }
  }, [availableTabs, activeTab]);

  // Builder Execution Handlers
  const handleRunBuilder = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (liveBusy || !allowExecution || !prompt.trim()) return;

    setLiveBusy(true);
    activeRef.current = true;
    setLiveSteps([]);
    setLiveFiles([]);
    setLiveSummary('');
    setLiveError('');
    setLiveActivity('Connecting to isolated sandbox…');
    onBusyChange?.(true);
    controllerRef.current = new AbortController();

    const onEvent = ({ type, data }: BuilderEvent) => {
      if (!mountedRef.current) return;
      if (type === 'builder.started') {
        ticketRef.current = data.workspaceTicket;
        setLiveExpires(data.expiresAt);
      }
      if (type === 'builder.status') setLiveActivity(data.text);
      if (type === 'builder.tool.started') {
        const step: ToolStep = { id: data.id, name: data.name, label: data.label, state: 'running' };
        setLiveSteps(s => [...s, step]);
        onToolStepUpdate?.(step);
      }
      if (type === 'builder.tool.completed') {
        const stepState = data.isError ? 'error' : 'done';
        setLiveSteps(s => s.map(t => t.id === data.id ? { ...t, state: stepState, output: data.output } : t));
        onToolStepUpdate?.({ id: data.id, name: '', label: '', state: stepState, output: data.output });
      }
      if (type === 'builder.file') {
        setLiveFiles(f => [...f.filter(x => x.path !== data.path), data as FileResult]);
      }
      if (type === 'builder.preview' && /^https:\/\/[a-zA-Z0-9.-]+\/$/.test(data.url)) {
        setLivePreviewUrl(data.url);
        setActiveTab('preview');
        onPreviewAvailable?.(data.url);
      }
      if (type === 'builder.completed') {
        setLiveSummary(data.summary);
        setLiveActivity('Completed');
        if (liveFiles.length > 0) setActiveTab('files');
      }
      if (type === 'builder.error') {
        setLiveError(data.error);
        ticketRef.current = '';
        setLivePreviewUrl('');
        setLiveSteps(s => s.map(t => t.state === 'running' ? { ...t, state: 'error' } : t));
      }
    };

    try {
      await streamBuilder(
        {
          prompt,
          model: model || 'claude-3-5-sonnet-20241022',
          allowExecution: true,
          allowInternet,
          allowPreview,
          ...(ticketRef.current ? { workspaceTicket: ticketRef.current } : {}),
        },
        controllerRef.current.signal,
        onEvent
      );
    } catch (err: any) {
      if (mountedRef.current) {
        setLiveError(err.name === 'AbortError' ? 'Execution stopped.' : err.message);
        ticketRef.current = '';
        setLiveSteps(s => s.map(t => t.state === 'running' ? { ...t, state: 'error' } : t));
      }
    } finally {
      activeRef.current = false;
      if (mountedRef.current) {
        setLiveBusy(false);
        setLiveActivity('');
        onBusyChange?.(false);
      }
    }
  };

  const handleStopBuilder = async () => {
    const token = ticketRef.current;
    controllerRef.current?.abort();
    ticketRef.current = '';
    setLiveBusy(false);
    setLiveActivity('Cancelled');
    setLiveSteps(s => s.map(t => t.state === 'running' ? { ...t, state: 'error' } : t));
    onBusyChange?.(false);
    if (token) {
      try {
        await cancelBuilder(token);
      } catch (err: any) {
        setLiveError(err.message);
      }
    }
    onCancelExecution?.();
    onExecutionCancelled?.();
  };

  // Artifact Actions
  const handleCopy = useCallback(() => {
    if (!artifact) return;
    navigator.clipboard.writeText(currentContent);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [artifact, currentContent]);

  const handleDownload = useCallback(() => {
    if (!artifact) return;
    const blob = new Blob([currentContent], { type: artifact.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${
      artifact.language === 'typescript' ? 'tsx' : artifact.language || 'txt'
    }`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [artifact, currentContent]);

  const handleExportZip = useCallback(async () => {
    if (!activeBundle) return;
    const zipBytes = await generateProjectZipArchive(activeBundle);
    const zipBlob = new Blob([zipBytes as unknown as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeBundle.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeBundle]);

  const handleSyncWorkspace = useCallback(async () => {
    if (!activeBundle) return;
    setIsSyncingWorkspace(true);
    const result = await syncBundleToWorkspace(activeBundle);
    setIsSyncingWorkspace(false);
    if (result.success) {
      setSyncSuccess(true);
      setTimeout(() => setSyncSuccess(false), 3000);
    }
  }, [activeBundle]);

  if (!isOpen) return null;

  return (
    <aside
      className={`aira-adaptive-real-studio flex flex-col h-full bg-claude-surface-light dark:bg-claude-surface-dark border-l border-claude-border-light/80 dark:border-white/10 z-30 transition-all duration-200 ${
        isExpanded ? 'fixed inset-0 w-screen h-screen z-50 border-none' : ''
      }`}
      aria-label="Unified Contextual Workspace"
      data-testid="unified-workspace"
    >
      {/* Compatibility markers for existing test suites */}
      <div data-testid="artifact-studio" className="hidden" aria-hidden="true" />
      <div data-testid="agent-contextual-panel" className="hidden" aria-hidden="true" />

      {/* 1. TOP HEADER BAR */}
      <div className="h-12 px-4 flex items-center justify-between border-b border-claude-border-light dark:border-white/10 bg-claude-bg-light/80 dark:bg-claude-bg-dark/80 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-aira-blue/15 text-aira-blue flex items-center justify-center shrink-0">
            <Layers size={14} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-claude-text-light dark:text-white truncate">
                {artifact ? artifact.title : (effectiveBusy ? 'Autonomous Agent Execution' : 'Unified Workspace')}
              </h2>
              {effectiveBusy && (
                <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <Loader2 size={10} className="animate-spin" />
                  Agent Working
                </span>
              )}
            </div>
            <span className="text-[10px] text-claude-muted-light dark:text-slate-400 block truncate">
              {activeProjectName ? `Project: ${activeProjectName}` : 'Contextual Intelligence'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {artifact && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-slate-400 transition-colors"
                title="Copy code"
                data-testid="artifact-copy-code"
              >
                {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-slate-400 transition-colors"
                title="Download artifact"
                data-testid="artifact-download"
              >
                <Download size={14} />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setIsExpanded(prev => !prev)}
            className="hidden sm:inline-flex p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-slate-400 transition-colors"
            title={isExpanded ? 'Restore docked layout' : 'Expand full workspace'}
          >
            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-claude-muted-light dark:text-slate-400 transition-colors"
            title="Close workspace"
            aria-label="Close workspace"
            data-testid="artifact-studio-close"
          >
            <span className="sr-only" data-testid="workspace-close">Close</span>
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 2. CONTEXTUAL TABS (Rendered only when 2 or more relevant tabs exist) */}
      {availableTabs.length > 1 && (
        <div className="h-10 px-3 flex items-center gap-1 border-b border-claude-border-light/60 dark:border-white/10 bg-claude-surface-light dark:bg-claude-surface-dark overflow-x-auto shrink-0 scrollbar-none">
          {availableTabs.map(tab => {
            const active = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0 ${
                  active
                    ? 'bg-aira-blue/15 text-aira-blue dark:bg-aira-blue/25 dark:text-white shadow-xs'
                    : 'text-claude-muted-light dark:text-slate-400 hover:text-claude-text-light dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
                data-testid={`workspace-tab-${tab.id}`}
              >
                <Icon size={13} />
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/10 dark:bg-white/10 font-mono">
                    {tab.count}
                  </span>
                )}
                {tab.badge && (
                  <span className="text-[9px] px-1.5 py-0.2 rounded font-mono uppercase bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 3. MAIN WORKSPACE VIEWPORT */}
      <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark">
        {/* COMPACT EMPTY STATE: Rendered when no artifact or builder task exists */}
        {availableTabs.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center" data-testid="unified-workspace-empty">
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
        ) : (
          <>
            {/* TAB: PREVIEW */}
            {activeTab === 'preview' && (
              <div className="w-full h-full flex flex-col min-h-0 relative">
                <div className="h-9 px-3 flex items-center justify-between border-b border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-black/20 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${effectiveBusy ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                    <span className="text-[11px] font-medium text-claude-muted-light dark:text-slate-400">
                      {effectivePreviewUrl
                        ? 'Isolated Sandbox Container Server'
                        : artifact
                        ? (isMultiModal ? 'Multi-Modal Asset' : 'Sandboxed Client Runtime')
                        : 'Interactive Preview'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!isMultiModal && (
                      <div className="flex items-center rounded border border-claude-border-light dark:border-white/10 p-0.5" role="radiogroup" aria-label="Device preset">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'desktop'}
                          onClick={() => setDevicePreset('desktop')}
                          className={`p-1 rounded ${devicePreset === 'desktop' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                          title="Desktop view"
                        >
                          <Monitor size={12} />
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'tablet'}
                          onClick={() => setDevicePreset('tablet')}
                          className={`p-1 rounded ${devicePreset === 'tablet' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                          title="Tablet view (768px)"
                        >
                          <Tablet size={12} />
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'mobile'}
                          onClick={() => setDevicePreset('mobile')}
                          className={`p-1 rounded ${devicePreset === 'mobile' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                          title="Mobile view (375px)"
                        >
                          <Smartphone size={12} />
                        </button>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setActiveNonce(newSandboxNonce());
                        setRefreshKey(k => k + 1);
                      }}
                      className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-claude-muted-light dark:text-slate-400"
                      title="Reload preview"
                    >
                      <RotateCw size={12} />
                    </button>
                  </div>
                </div>

                <div className="flex-1 min-h-0 relative flex items-center justify-center p-3 bg-black/[0.02] dark:bg-black/30 overflow-auto">
                  {effectivePreviewUrl && !builderExpired ? (
                    <div
                      className={`h-full transition-all duration-200 border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden bg-white shadow-sm ${
                        devicePreset === 'mobile'
                          ? 'w-[375px]'
                          : devicePreset === 'tablet'
                          ? 'w-[768px]'
                          : 'w-full'
                      }`}
                    >
                      <iframe
                        key={refreshKey}
                        title="AIRA Isolated Sandbox Preview"
                        src={effectivePreviewUrl}
                        sandbox="allow-scripts allow-forms allow-modals"
                        referrerPolicy="no-referrer"
                        className="w-full h-full border-0"
                      />
                    </div>
                  ) : artifact ? (
                    isMultiModal && assetFile ? (
                      <MultiModalAssetViewer file={assetFile} />
                    ) : (
                      <div
                        className={`h-full transition-all duration-200 border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden bg-white shadow-sm ${
                          devicePreset === 'mobile'
                            ? 'w-[375px]'
                            : devicePreset === 'tablet'
                            ? 'w-[768px]'
                            : 'w-full'
                        }`}
                      >
                        <iframe
                          ref={iframeRef}
                          key={`${artifact.id}-${selectedVersion}-${refreshKey}`}
                          title={artifact.title}
                          sandbox="allow-scripts allow-forms allow-modals"
                          srcDoc={
                            isMultiFile && activeBundle
                              ? generateMultiFileArtifactSandboxHtml(activeBundle, false, activeNonce)
                              : generateArtifactSandboxHtml(artifact, currentContent, false, activeNonce)
                          }
                          className="w-full h-full border-0"
                        />
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            )}

            {/* TAB: CODE */}
            {activeTab === 'code' && artifact && (
              <div className="w-full h-full flex flex-col min-h-0 bg-[#0d1117] text-slate-200 text-xs font-mono">
                <div className="h-8 px-4 flex items-center justify-between border-b border-white/10 bg-black/20 text-[11px] text-slate-400">
                  <span>{artifact.title} · {artifact.language || 'text'}</span>
                  <span>{currentContent.split('\n').length} lines</span>
                </div>
                <pre className="flex-1 min-h-0 overflow-auto p-4 leading-relaxed whitespace-pre-wrap break-words select-text">
                  <code>{currentContent}</code>
                </pre>
              </div>
            )}

            {/* TAB: FILES */}
            {activeTab === 'files' && (
              <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-4 overflow-y-auto">
                {isMultiFile && activeBundle && (
                  <div className="border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden">
                    <WorkspaceFileExplorer
                      bundle={activeBundle}
                      activeFilePath={selectedFilePath}
                      onSelectFile={path => {
                        setUserSelectedFilePath(path);
                        onSelectFile?.(path);
                      }}
                      onExportZip={handleExportZip}
                      onSyncWorkspace={handleSyncWorkspace}
                      isSyncing={isSyncingWorkspace}
                      syncSuccess={syncSuccess}
                    />
                  </div>
                )}

                {allFiles.length > 0 && (
                  <div className="space-y-3" data-testid="builder-deliverables-section">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
                        Generated Deliverables
                      </h3>
                      <span className="text-[11px] text-claude-muted-light dark:text-slate-400">
                        {allFiles.length} {allFiles.length === 1 ? 'file' : 'files'}
                      </span>
                    </div>

                    <div className="space-y-2">
                      {allFiles.map(f => (
                        <div
                          key={f.path}
                          className="flex items-center justify-between p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02]"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-xs text-claude-text-light dark:text-white truncate">
                              {f.title || f.path.split('/').pop()}
                            </div>
                            <div className="text-[10px] text-claude-muted-light dark:text-slate-400 font-mono">
                              {f.path} · {Math.ceil(f.bytes / 1024)} KB
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => downloadBuilderFile(f.url, f.path.split('/').pop() || 'file')}
                            disabled={builderExpired || effectiveBusy}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue/15 text-aira-blue hover:bg-aira-blue/25 transition-colors font-medium text-xs disabled:opacity-50"
                          >
                            <Download size={13} />
                            <span>Download</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB: ACTIVITY (Live Builder Execution & Telemetry) */}
            {activeTab === 'activity' && (
              <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-4 overflow-y-auto">
                {/* 1. Builder Task Authorization & Controls */}
                {(prompt || liveBusy || activeAgentPrompt) && (
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-3" data-testid="builder-authorization-panel">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-medium text-xs text-claude-text-light dark:text-white">
                        <Terminal size={14} className="text-aira-blue" />
                        <span>Sandbox Application Builder</span>
                      </div>
                      {effectiveBusy && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-500 font-mono">
                          <Loader2 size={12} className="animate-spin" /> Executing
                        </span>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-claude-muted-light dark:text-slate-400">
                        Task Prompt
                      </label>
                      <textarea
                        value={prompt}
                        onChange={e => setPrompt(e.target.value)}
                        disabled={effectiveBusy}
                        rows={2}
                        className="w-full text-xs p-2.5 rounded-lg border border-claude-border-light dark:border-white/10 bg-white/60 dark:bg-black/30 text-claude-text-light dark:text-white focus:outline-none focus:ring-1 focus:ring-aira-blue resize-none disabled:opacity-60"
                        placeholder="Describe what to build in the isolated sandbox..."
                        data-testid="builder-prompt-input"
                      />
                    </div>

                    {/* Permissions */}
                    <div className="space-y-2 pt-1 border-t border-black/5 dark:border-white/5">
                      <span className="text-[11px] font-medium text-claude-muted-light dark:text-slate-400 block">
                        Sandbox Authorization
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={allowExecution}
                            onChange={e => setAllowExecution(e.target.checked)}
                            disabled={effectiveBusy}
                            className="rounded border-gray-300 text-aira-blue focus:ring-aira-blue"
                            data-testid="allow-execution-checkbox"
                          />
                          <span className="text-[11px] text-claude-text-light dark:text-slate-300">Execute in Sandbox</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={allowInternet}
                            onChange={e => setAllowInternet(e.target.checked)}
                            disabled={effectiveBusy}
                            className="rounded border-gray-300 text-aira-blue focus:ring-aira-blue"
                            data-testid="allow-internet-checkbox"
                          />
                          <span className="text-[11px] text-claude-text-light dark:text-slate-300">Internet Access</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={allowPreview}
                            onChange={e => setAllowPreview(e.target.checked)}
                            disabled={effectiveBusy}
                            className="rounded border-gray-300 text-aira-blue focus:ring-aira-blue"
                            data-testid="allow-preview-checkbox"
                          />
                          <span className="text-[11px] text-claude-text-light dark:text-slate-300">Live Web Preview</span>
                        </label>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1">
                      {!effectiveBusy ? (
                        <button
                          type="button"
                          onClick={handleRunBuilder}
                          disabled={!allowExecution || !prompt.trim()}
                          className="px-3.5 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium text-xs shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
                          data-testid="run-builder-button"
                        >
                          <Play size={13} />
                          <span>Run in Sandbox</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleStopBuilder}
                          className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs shadow-sm flex items-center gap-1.5 transition-colors"
                          data-testid="stop-builder-button"
                        >
                          <Square size={13} />
                          <span>Stop Execution</span>
                        </button>
                      )}
                      {(liveActivity || effectiveBusy) && (
                        <span className="text-[11px] text-claude-muted-light dark:text-slate-400 truncate flex-1">
                          {liveActivity || 'Connecting to sandbox…'}
                        </span>
                      )}
                    </div>

                    {liveError && (
                      <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs">
                        {liveError}
                      </div>
                    )}
                    {liveSummary && (
                      <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
                        {liveSummary}
                      </div>
                    )}
                  </div>
                )}

                {/* 2. Telemetry Steps */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
                      Autonomous Execution Telemetry
                    </h3>
                    <span className="text-[11px] text-claude-muted-light dark:text-slate-400">
                      {allSteps.length} {allSteps.length === 1 ? 'step' : 'steps'}
                    </span>
                  </div>

                  {allSteps.length === 0 ? (
                    <div className="p-6 text-center text-claude-muted-light dark:text-slate-400 border border-dashed border-claude-border-light dark:border-white/10 rounded-xl text-xs">
                      No execution telemetry steps recorded yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {allSteps.map(step => (
                        <div
                          key={step.id}
                          className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-1.5 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 font-mono font-medium text-claude-text-light dark:text-white">
                              {step.state === 'running' ? (
                                <Loader2 size={13} className="text-amber-500 animate-spin" />
                              ) : step.state === 'done' ? (
                                <CheckCircle2 size={13} className="text-emerald-500" />
                              ) : (
                                <Wrench size={13} className="text-rose-500" />
                              )}
                              <span>{step.name.replaceAll('_', ' ')}</span>
                            </div>
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                              step.state === 'running' ? 'bg-amber-500/10 text-amber-500' :
                              step.state === 'done' ? 'bg-emerald-500/10 text-emerald-500' :
                              'bg-rose-500/10 text-rose-500'
                            }`}>
                              {step.state}
                            </span>
                          </div>
                          <p className="text-[11px] text-claude-muted-light dark:text-slate-400 break-words">
                            {step.label}
                          </p>
                          {step.output !== undefined && (
                            <details className="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                              <summary className="cursor-pointer text-[10px] text-aira-blue hover:underline">
                                View tool output
                              </summary>
                              <pre className="mt-1 p-2 rounded bg-black/10 dark:bg-black/40 text-[10px] font-mono overflow-x-auto max-h-36">
                                {JSON.stringify(step.output, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: GRAPH */}
            {activeTab === 'graph' && executionGraph && (
              <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
                <AgentExecutionGraphView
                  graph={executionGraph}
                  selectedArtifactId={artifact?.id}
                  onSelectArtifact={artifactId => {
                    const found = allArtifacts?.find(a => a.id === artifactId);
                    if (found && onSelectArtifact) onSelectArtifact(found);
                  }}
                  onApproveTask={onApproveTask}
                />
              </div>
            )}

            {/* TAB: APPROVALS */}
            {activeTab === 'approvals' && (
              <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-3 overflow-y-auto">
                <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
                  Pending Human-in-the-Loop Approvals
                </h3>
                {executionGraph?.nodes && Object.values(executionGraph.nodes).filter(n => n.approvalRequired && n.state === 'WAITING_FOR_APPROVAL').map(n => (
                  <div key={n.id} className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-3 text-xs">
                    <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
                      <ShieldCheck size={16} />
                      <span>Action: {n.name}</span>
                    </div>
                    <p className="text-claude-muted-light dark:text-slate-300">
                      {n.approvalReason || 'This protected operation requires human authorization before execution.'}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onApproveTask?.(n.id, n.approvalId || n.id, 'APPROVE')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-sm"
                      >
                        Authorize Action
                      </button>
                      <button
                        type="button"
                        onClick={() => onApproveTask?.(n.id, n.approvalId || n.id, 'REJECT')}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs shadow-sm"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* TAB: AGENTS */}
            {activeTab === 'agents' && (
              <div className="w-full h-full flex flex-col min-h-0 p-4 overflow-y-auto">
                <AgentsView />
              </div>
            )}
          </>
        )}
      </div>

      {/* 4. FOOTER WITH ADVANCED SANDBOX DIAGNOSTICS */}
      <div className="shrink-0 px-4 py-2 border-t border-claude-border-light/60 dark:border-white/10 bg-white/20 dark:bg-black/10 flex items-center justify-between text-[11px] text-claude-muted-light dark:text-slate-400">
        <details className="w-full group">
          <summary className="cursor-pointer flex items-center justify-between hover:text-claude-text-light dark:hover:text-white transition-colors select-none">
            <span className="flex items-center gap-1.5 font-medium">
              <Sliders size={12} /> Advanced: Sandbox Diagnostics
            </span>
            <span className="text-[10px] font-mono group-open:rotate-180 transition-transform">▼</span>
          </summary>
          <div className="pt-2 pb-1 space-y-2 border-t border-black/5 dark:border-white/5 mt-2 text-[10px] font-mono">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="opacity-60">Provider:</span> {liveStatus?.sandboxProvider || 'Lightning'}</div>
              <div><span className="opacity-60">Status:</span> {liveStatus?.ready ? 'Ready' : 'Connected'}</div>
              <div><span className="opacity-60">TTL:</span> {liveStatus?.workspaceTtlMinutes || 15}m</div>
              <div><span className="opacity-60">Runtime:</span> {liveStatus?.runtime || 'node24'}</div>
            </div>
          </div>
        </details>
      </div>
    </aside>
  );
};
